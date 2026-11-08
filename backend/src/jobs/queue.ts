import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { QueuePublisher } from './jobs.service.js';

export const queueName = 'pdf-generation';

export class BullMqPublisher implements QueuePublisher {
  constructor(private readonly queue: Pick<Queue, 'add'>) {}

  add(jobId: string): Promise<unknown> {
    return this.queue.add(
      queueName,
      { jobId },
      {
        jobId: `job-${jobId}`,
        attempts: 1,
      },
    );
  }
}

export function createJobQueue(redisUrl: string, logger: Logger = silentLogger) {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  connection.on('error', (error) => logger.error('queue.error', safeError(error)));
  const queue = new Queue(queueName, { connection });
  queue.on('error', (error) => logger.error('queue.error', safeError(error)));
  return {
    publisher: new BullMqPublisher(queue),
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
