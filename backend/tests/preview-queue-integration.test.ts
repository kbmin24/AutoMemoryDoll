import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { BullMqPublisher } from '../src/jobs/queue.js';
const url = process.env.TEST_REDIS_URL;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => Promise<boolean>, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Queue condition timed out');
    await delay(50);
  }
}
describe.skipIf(!url)('real Redis preview debounce', () => {
  it('replaces delayed updates, protects them from backfill and persists across worker startup', async () => {
    const connection = new Redis(url!, { maxRetriesPerRequest: null });
    const name = `preview-test-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const publisher = new BullMqPublisher(queue);
    const templateId = randomUUID();
    let worker: Worker | undefined;
    const times: number[] = [];
    try {
      await publisher.schedule(templateId);
      await delay(200);
      const lastSave = Date.now();
      await publisher.schedule(templateId);
      const before = await queue.getDeduplicationJobId(
        `template-preview-${templateId}`,
      );
      await publisher.scheduleIfIdle(templateId);
      expect(
        await queue.getDeduplicationJobId(`template-preview-${templateId}`),
      ).toBe(before);
      worker = new Worker(
        name,
        async () => {
          times.push(Date.now());
        },
        { connection, concurrency: 1, maxStalledCount: 0 },
      );
      await until(async () => times.length === 1);
      expect(times[0] - lastSave).toBeGreaterThanOrEqual(29500);
      await until(async () => (await queue.getJob(before!)) === undefined);
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  }, 60000);
  it('keeps a single active follow-up, lets documents go first, and never retries failed previews', async () => {
    const connection = new Redis(url!, { maxRetriesPerRequest: null });
    const name = `preview-test-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const publisher = new BullMqPublisher(queue);
    const templateId = randomUUID();
    const entered = deferred();
    const release = deferred();
    const seen: string[] = [];
    let previewCount = 0;
    const worker = new Worker(
      name,
      async (job) => {
        seen.push(job.name);
        if (job.name === 'template-preview') {
          previewCount++;
          if (previewCount === 1) {
            entered.resolve();
            await release.promise;
            throw new Error('expected failed attempt');
          }
        }
      },
      { connection, concurrency: 1, maxStalledCount: 0 },
    );
    worker.on('error', () => {});
    try {
      await publisher.schedule(templateId);
      const initial = await queue.getJob(
        (await queue.getDeduplicationJobId(`template-preview-${templateId}`))!,
      );
      await initial!.changeDelay(0);
      await entered.promise;
      await publisher.schedule(templateId);
      await publisher.schedule(templateId);
      await publisher.add(randomUUID());
      release.resolve();
      await until(async () => previewCount === 2);
      await delay(200);
      expect(seen).toEqual([
        'template-preview',
        'pdf-generation',
        'template-preview',
      ]);
      expect(previewCount).toBe(2);
    } finally {
      release.resolve();
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  }, 60000);
});

it.skipIf(!url)(
  'concurrent backfill never replaces a saved-edit job',
  async () => {
    const connection = new Redis(url!, { maxRetriesPerRequest: null });
    const queue = new Queue(`preview-race-${randomUUID()}`, { connection });
    const publisher = new BullMqPublisher(queue);
    const id = randomUUID();
    try {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          Promise.all([publisher.scheduleIfIdle(id), publisher.schedule(id)]),
        ),
      );
      const delivery = await queue.getDeduplicationJobId(
        `template-preview-${id}`,
      );
      const job = await queue.getJob(delivery!);
      expect(job?.opts.deduplication).toMatchObject({
        replace: true,
        keepLastIfActive: true,
      });
      expect((await queue.getJobs(['delayed'])).length).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  },
);

it.skipIf(!url)(
  'an interrupted active attempt is not retried but a saved-change follow-up survives',
  async () => {
    const connection = new Redis(url!, { maxRetriesPerRequest: null });
    const name = `preview-stall-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const publisher = new BullMqPublisher(queue);
    const id = randomUUID();
    const entered = deferred();
    const release = deferred();
    let count = 0;
    const first = new Worker(
      name,
      async () => {
        count++;
        entered.resolve();
        await release.promise;
      },
      {
        connection,
        concurrency: 1,
        maxStalledCount: 0,
        lockDuration: 500,
        stalledInterval: 500,
      },
    );
    first.on('error', () => {});
    let second: Worker | undefined;
    try {
      await publisher.schedule(id);
      const activeId = await queue.getDeduplicationJobId(
        `template-preview-${id}`,
      );
      await (await queue.getJob(activeId!))!.changeDelay(0);
      await entered.promise;
      await publisher.schedule(id);
      await first.close(true);
      second = new Worker(
        name,
        async () => {
          count++;
        },
        {
          connection,
          concurrency: 1,
          maxStalledCount: 0,
          lockDuration: 500,
          stalledInterval: 500,
        },
      );
      second.on('error', () => {});
      await until(async () => count === 2, 45000);
      await until(async () => (await queue.getActiveCount()) === 0);
      expect(count).toBe(2);
    } finally {
      release.resolve();
      await first.close(true);
      await second?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
    }
  },
  60000,
);
