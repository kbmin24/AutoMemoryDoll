import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPrismaClient } from '../db/prisma.js';
import { queueName } from '../jobs/queue.js';
import { FileSystemStorage } from '../storage/filesystem-storage.js';
import { validateId } from '../storage/paths.js';
import { loadWorkerConfig, requireCompilerIdentity } from './config.js';
import { ContainerPdfGenerator } from './container-runner.js';
import { JobProcessor, reconcileFailedDeliveries } from './jobs.worker.js';

const config = loadWorkerConfig(process.env);
requireCompilerIdentity();
const db = createPrismaClient(config.databaseUrl);
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection });
const generator = new ContainerPdfGenerator(config);
const processor = new JobProcessor(
  db,
  new FileSystemStorage(config.storageRoot),
  generator,
  config.wallTimeMs,
);
let reconciliation: Promise<void> | undefined;
function reconcile(): Promise<void> {
  reconciliation ??= (async () => {
    await reconcileFailedDeliveries(db, queue);
    await processor.reconcile();
  })()
    .catch((error) => {
      console.error('Worker reconciliation failed', error);
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
worker.on('error', (error) => console.error('Queue consumer error', error));
worker.on('failed', (job, error) => console.error('Queue delivery failed', job?.id, error));
const timer = setInterval(() => {
  void reconcile();
}, 30_000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await worker.close();
  await reconciliation;
  await queue.close();
  await db.$disconnect();
  connection.disconnect();
}
process.on('SIGTERM', () => {
  void shutdown().catch(console.error);
});
process.on('SIGINT', () => {
  void shutdown().catch(console.error);
});
