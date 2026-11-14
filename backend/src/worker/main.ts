import { closeLogger, runService, safeError } from '../logging/logger.js';
import { loadEnvironment } from '../env.js';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../db/prisma.js';
import { queueName } from '../jobs/queue.js';
import { FileSystemStorage } from '../storage/filesystem-storage.js';
import { validateId } from '../storage/paths.js';
import { loadWorkerConfig } from './config.js';
import { ContainerPdfGenerator } from './container-runner.js';
import { JobProcessor, reconcileFailedDeliveries } from './jobs.worker.js';

loadEnvironment();

await runService('consumer', async (logger) => {
  const config = loadWorkerConfig(process.env);
  const db = createPrismaClient(config.databaseUrl);
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error) =>
    logger.error('queue.error', safeError(error)),
  );
  const queue = new Queue(queueName, { connection });
  queue.on('error', (error) => logger.error('queue.error', safeError(error)));
  const generator = new ContainerPdfGenerator(config, undefined, logger);
  const processor = new JobProcessor(
    db,
    new FileSystemStorage(config.storageRoot),
    generator,
    config.wallTimeMs,
    logger,
  );
  let reconciliation: Promise<void> | undefined;
  function reconcile(): Promise<void> {
    reconciliation ??= (async () => {
      await reconcileFailedDeliveries(db, queue, logger);
      await processor.reconcile();
    })()
      .catch((error) => {
        logger.error('queue.reconciliation_failed', safeError(error));
      })
      .finally(() => {
        reconciliation = undefined;
      });
    return reconciliation;
  }
  await reconcile();
  const worker = new Worker(
    queueName,
    async (job) => {
      if (
        !job.data ||
        typeof job.data !== 'object' ||
        Object.keys(job.data).length !== 1 ||
        typeof job.data.jobId !== 'string'
      ) {
        throw new Error('Invalid queue payload');
      }
      await processor.processJob(validateId(job.data.jobId));
    },
    { connection, concurrency: 1, maxStalledCount: 0 },
  );
  worker.on('error', (error) => logger.error('queue.error', safeError(error)));
  worker.on('failed', (job, error) =>
    logger.error('queue.delivery_failed', {
      deliveryId: job?.id,
      ...safeError(error),
    }),
  );
  logger.info('service.ready');
  const timer = setInterval(() => {
    void reconcile();
  }, 30_000);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    logger.info('service.stopping');
    clearInterval(timer);
    try {
      await worker.close();
      await reconciliation;
      await queue.close();
      await db.$disconnect();
      connection.disconnect();
      logger.info('service.stopped');
    } catch (error) {
      logger.error('service.shutdown_failed', safeError(error));
      process.exitCode = 1;
    } finally {
      await closeLogger(logger);
    }
  }
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
});
