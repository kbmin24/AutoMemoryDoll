import { createPrismaClient } from './db/prisma.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { FileSystemStorage } from './storage/filesystem-storage.js';
import { createJobQueue } from './jobs/queue.js';
import { reconcileQueuedJobs } from './jobs/jobs.service.js';

const config = loadConfig(process.env);
if (!config.redisUrl) throw new Error('REDIS_URL is required');
const db = createPrismaClient(config.databaseUrl);
const storage = new FileSystemStorage(process.env.STORAGE_ROOT ?? './data');
const jobQueue = createJobQueue(config.redisUrl);
const app = createApp(
  db,
  { jwtSecret: config.jwtSecret, cookieHours: config.cookieHours },
  storage,
  jobQueue.publisher,
);
const server = app.listen(config.port, () => console.log(`API listening on ${config.port}`));
const reconcile = () => {
  void reconcileQueuedJobs(db, storage, jobQueue.publisher).catch((error) => {
    console.error('Queued-job reconciliation failed', error);
  });
};
reconcile();
const reconciliationTimer = setInterval(reconcile, 30_000);
process.on('SIGTERM', () => {
  clearInterval(reconciliationTimer);
  server.close(() => {
    void Promise.all([db.$disconnect(), jobQueue.close()]);
  });
});
