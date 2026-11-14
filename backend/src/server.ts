import { loadEnvironment } from './env.js';
import { createPrismaClient } from './db/prisma.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { FileSystemStorage } from './storage/filesystem-storage.js';
import { createJobQueue } from './jobs/queue.js';
import { reconcileQueuedJobs } from './jobs/jobs.service.js';
import { closeLogger, runService, safeError } from './logging/logger.js';

loadEnvironment();

await runService('api', async (logger, loggingConfig) => {
  const config = loadConfig(process.env);
  if (!config.redisUrl) throw new Error('REDIS_URL is required');
  const db = createPrismaClient(config.databaseUrl);
  const storage = new FileSystemStorage(process.env.STORAGE_ROOT ?? './data');
  const jobQueue = createJobQueue(config.redisUrl, logger);
  const app = createApp(
    db,
    {
      jwtSecret: config.jwtSecret,
      cookieHours: config.cookieHours,
      cookieSecure: config.cookieSecure,
    },
    storage,
    jobQueue.publisher,
    logger,
    loggingConfig.trustedProxies,
    jobQueue.publisher,
  );
  const server = app.listen(config.port);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('error', (error) => logger.error('http.failed', safeError(error)));
  logger.info('service.ready', { port: config.port });
  let reconciliation: Promise<void> | undefined;
  const reconcile = () => {
    reconciliation ??= reconcileQueuedJobs(
      db,
      storage,
      jobQueue.publisher,
      logger,
    )
      .catch((error) => {
        logger.error('queue.reconciliation_failed', safeError(error));
      })
      .finally(() => {
        reconciliation = undefined;
      });
  };
  reconcile();
  const reconciliationTimer = setInterval(reconcile, 30_000);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('service.stopping');
    clearInterval(reconciliationTimer);
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await reconciliation;
      await Promise.all([db.$disconnect(), jobQueue.close()]);
      logger.info('service.stopped');
    } catch (error) {
      logger.error('service.shutdown_failed', safeError(error));
      process.exitCode = 1;
    } finally {
      await closeLogger(logger);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
});
