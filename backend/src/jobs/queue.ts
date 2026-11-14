import { randomUUID } from 'node:crypto';
import { validateId } from '../storage/paths.js';
import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { QueuePublisher } from './jobs.service.js';

export const queueName = 'pdf-generation';

export class BullMqPublisher implements QueuePublisher {
  constructor(private readonly queue: Pick<Queue, 'add'>) {}

  async schedule(templateId: string): Promise<void> {
    await this.addPreview(templateId, true);
  }

  async scheduleIfIdle(templateId: string): Promise<void> {
    await this.addPreview(templateId, false);
  }

  private addPreview(templateId: string, replace: boolean): Promise<unknown> {
    validateId(templateId);
    const id = `template-preview-${templateId}`;
    return this.queue.add(
      'template-preview',
      { templateId },
      {
        jobId: `preview-${randomUUID()}`,
        delay: 30_000,
        priority: 10,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        deduplication: replace
          ? { id, replace: true, keepLastIfActive: true }
          : { id },
      },
    );
  }

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

export function createJobQueue(
  redisUrl: string,
  logger: Logger = silentLogger,
) {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  connection.on('error', (error) =>
    logger.error('queue.error', safeError(error)),
  );
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
