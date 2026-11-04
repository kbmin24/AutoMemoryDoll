import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/db/prisma.js';
import { reconcileQueuedJobs, submitGeneration } from '../src/jobs/jobs.service.js';
import { createJobQueue, queueName } from '../src/jobs/queue.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { createTemplate } from '../src/templates/templates.service.js';
import { createRegularUser } from '../src/users/users.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!databaseUrl || !redisUrl)('job submission with PostgreSQL and BullMQ', () => {
  it('persists a queued job and sends only its ID to Redis', async () => {
    const schema = `jobs_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('schema', schema);
    const root = await mkdtemp(join(tmpdir(), 'amd-jobs-db-'));
    let db: ReturnType<typeof createPrismaClient> | undefined;
    let publisher: ReturnType<typeof createJobQueue> | undefined;
    let reader: Queue | undefined;
    let readerConnection: Redis | undefined;
    try {
      execFileSync('npm', ['--workspace', 'backend', 'run', 'db:migrate:deploy'], {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
      });
      db = createPrismaClient(url.toString());
      publisher = createJobQueue(redisUrl!);
      readerConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      reader = new Queue(queueName, { connection: readerConnection });
      const storage = new FileSystemStorage(root);
      const user = await createRegularUser(db, `jobs_${randomUUID()}`, 'long-test-password-123');
      const template = await createTemplate(db, storage, user.id, 'Letter', {
        version: 1,
        shape: null,
      });
      await storage.writeText(template.id, ['template.tex'], 'Hello');
      const job = await submitGeneration(db, storage, publisher.publisher, {
        userId: user.id,
        templateId: template.id,
        data: { name: 'Ada' },
        uploads: [],
      });
      const record = await db.generationJob.findUnique({
        where: { id: job.id },
      });
      const queued = await reader.getJob(`job-${job.id}`);
      expect(record?.status).toBe('queued');
      expect(queued?.data).toEqual({ jobId: job.id });
      expect(queued?.opts.attempts).toBe(1);
      await reconcileQueuedJobs(db, storage, publisher.publisher);
      expect((await reader.getJob(`job-${job.id}`))?.data).toEqual({
        jobId: job.id,
      });
    } finally {
      await reader?.close();
      readerConnection?.disconnect();
      await publisher?.close();
      await db?.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
