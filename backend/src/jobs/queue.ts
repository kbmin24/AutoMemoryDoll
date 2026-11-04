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

export function createJobQueue(redisUrl: string) {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  const queue = new Queue(queueName, { connection });
  return {
    publisher: new BullMqPublisher(queue),
    async close() {
      await queue.close();
      connection.disconnect();
    },
  };
}
