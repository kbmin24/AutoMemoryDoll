import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { BullMqPublisher, queueName } from '../src/jobs/queue.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { createOwner } from '../src/users/users.service.js';
import { requireCompilerIdentity } from '../src/worker/config.js';
import { ContainerPdfGenerator } from '../src/worker/container-runner.js';
import { JobProcessor } from '../src/worker/jobs.worker.js';

// Explicit opt-in fails on missing prerequisites rather than silently skipping.
it.skipIf(process.env.RUN_MVP_E2E !== '1')(
  'generates through HTTP, PostgreSQL, Redis and runsc, retaining private history after deletion',
  async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const redisUrl = process.env.TEST_REDIS_URL;
    if (!databaseUrl || !redisUrl) {
      throw new Error(
        'RUN_MVP_E2E requires TEST_DATABASE_URL and TEST_REDIS_URL',
      );
    }
    const identity = requireCompilerIdentity();
    const schema = `mvp_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: databaseUrl });
    const url = new URL(databaseUrl);
    url.searchParams.set('schema', schema);
    const db = createPrismaClient(url.toString());
    let root: string | undefined;
    let connection: Redis | undefined;
    let queue: Queue | undefined;
    let worker: Worker | undefined;
    let connected = false;
    try {
      await admin.connect();
      connected = true;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      execFileSync(
        'npm',
        ['--workspace', 'backend', 'run', 'db:migrate:deploy'],
        {
          cwd: new URL('../../', import.meta.url),
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: 'pipe',
        },
      );
      root = await mkdtemp(
        join(process.env.COMPILER_TEST_ROOT ?? tmpdir(), 'amd-mvp-'),
      );
      const storage = new FileSystemStorage(root);
      connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const prefix = `mvp-${randomUUID()}`;
      queue = new Queue(queueName, { connection, prefix });
      await queue.waitUntilReady();
      const app = createApp(
        db,
        {
          jwtSecret: 'mvp-test-secret-at-least-32-characters',
          cookieHours: 12,
        },
        storage,
        new BullMqPublisher(queue),
      );
      const password = 'mvp-test-password-123456';
      await createOwner(db, 'owner', password);
      await expect(createOwner(db, 'second-owner', password)).rejects.toThrow();
      async function login(username: string) {
        const response = await request(app)
          .post('/api/auth/login')
          .send({ username, password })
          .expect(200);
        return {
          Cookie: response.headers['set-cookie'][0],
          'X-CSRF-Token': response.body.csrfToken,
        };
      }
      const owner = await login('owner');
      for (const username of ['alice', 'bob']) {
        await request(app)
          .post('/api/admin/users')
          .set(owner)
          .send({ username, password })
          .expect(201);
      }
      const alice = await login('alice');
      const bob = await login('bob');
      const created = await request(app)
        .post('/api/templates')
        .set(alice)
        .send({
          name: 'E2E letter',
          manifest: {
            version: 1,
            shape: {
              fields: [
                {
                  variable: 'name',
                  label: 'Name',
                  type: 'text',
                  optional: false,
                },
                {
                  variable: 'score',
                  label: 'Score',
                  type: 'number',
                  optional: false,
                },
                {
                  variable: 'approved',
                  label: 'Approved',
                  type: 'boolean',
                  optional: false,
                },
              ],
            },
          },
        })
        .expect(201);
      const templateId = created.body.template.id;
      const templatePath = `/api/templates/${templateId}`;
      const image = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 3,
          background: '#123456',
        },
      })
        .png()
        .toBuffer();
      await request(app)
        .post(`${templatePath}/files/uploads`)
        .set(alice)
        .field('segments', JSON.stringify(['static.png']))
        .attach('file', image, 'static.png')
        .expect(201);
      const tex = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Hello {{ name }}. Score {{ score }}. Approved {{ approved }}.
\includegraphics[width=1cm]{static.png}
\includegraphics[width=1cm]{@resource(logo)}
\end{document}`;
      await request(app)
        .put(`${templatePath}/files/text`)
        .set(alice)
        .send({ segments: ['template.tex'], text: tex })
        .expect(204);
      const aliases = await request(app)
        .get(`${templatePath}/resources`)
        .set(alice)
        .expect(200);
      expect(aliases.body.aliases).toEqual(['logo']);
      const submitted = await request(app)
        .post(`${templatePath}/generations`)
        .set(alice)
        .field(
          'data',
          JSON.stringify({ name: 'Ada & friends', score: 0, approved: false }),
        )
        .attach('logo', image, 'logo.png')
        .expect(201);
      const jobId = submitted.body.job.id;
      const jobPath = `/api/jobs/${jobId}`;
      expect(submitted.body.job.status).toBe('queued');
      expect(
        (await request(app).get(jobPath).set(alice).expect(200)).body.job
          .status,
      ).toBe('queued');
      const input = join(root, 'jobs', jobId, 'input');
      expect(
        JSON.parse(await readFile(join(input, 'data.json'), 'utf8')),
      ).toEqual({ name: 'Ada & friends', score: 0, approved: false });
      // Edit before consumption to prove the queued snapshot is independent.
      await request(app)
        .put(`${templatePath}/files/text`)
        .set(alice)
        .send({ segments: ['template.tex'], text: 'Changed after submission' })
        .expect(204);
      expect(
        await readFile(join(input, 'template', 'template.tex'), 'utf8'),
      ).toContain('Hello {{ name }}');
      class ObservedCompiler extends ContainerPdfGenerator {
        override async generate(inputDir: string, outputDir: string) {
          expect(
            (await request(app).get(jobPath).set(alice).expect(200)).body.job
              .status,
          ).toBe('generating');
          return super.generate(inputDir, outputDir);
        }
      }
      const generator = new ObservedCompiler({
        ...identity,
        image: process.env.COMPILER_IMAGE ?? 'automemorydoll-compiler:local',
        cpus: 1,
        memoryMb: 1024,
        pids: 64,
        wallTimeMs: 120_000,
      });
      // Check the public generating state at the real compiler boundary.
      const processor = new JobProcessor(db, storage, generator, 120_000);
      const workerErrors: Error[] = [];
      worker = new Worker(
        queueName,
        async (job) => {
          expect(job.name).toBe(queueName);
          expect(job.data).toEqual({ jobId });
          await processor.processJob(job.data.jobId);
        },
        { connection, prefix, concurrency: 1, maxStalledCount: 0 },
      );
      worker.on('error', (error) => workerErrors.push(error));
      worker.on('failed', (_job, error) => workerErrors.push(error));
      let status = 'queued';
      const deadline = Date.now() + 150_000;
      while (status === 'queued' || status === 'generating') {
        expect(workerErrors).toEqual([]);
        if (Date.now() > deadline)
          throw new Error(`Job timed out in ${status}`);
        const response = await request(app).get(jobPath).set(alice).expect(200);
        status = response.body.job.status;
        if (status === 'failed') throw new Error(response.body.job.message);
        if (status !== 'ok') await delay(100);
      }
      expect(status).toBe('ok');
      await expect
        .poll(
          async () => {
            const delivery = await queue!.getJob(`job-${jobId}`);
            return delivery?.getState();
          },
          { timeout: 5_000 },
        )
        .toBe('completed');
      expect(workerErrors).toEqual([]);
      const pdf = await request(app)
        .get(`${jobPath}/pdf`)
        .set(alice)
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(Buffer.isBuffer(pdf.body)).toBe(true);
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(await readdir(join(root, 'jobs'))).toEqual([]);
      // Owner-role access must not bypass resource ownership either.
      for (const session of [bob, owner]) {
        for (const path of [
          templatePath,
          `${templatePath}/files`,
          jobPath,
          `${jobPath}/pdf`,
        ]) {
          await request(app).get(path).set(session).expect(404);
        }
        expect(
          (await request(app).get('/api/jobs').set(session).expect(200)).body
            .jobs,
        ).toEqual([]);
      }
      await request(app).delete(templatePath).set(alice).expect(204);
      await request(app).get(templatePath).set(alice).expect(404);
      const history = await request(app)
        .get('/api/jobs')
        .set(alice)
        .expect(200);
      expect(history.body.jobs).toEqual([
        expect.objectContaining({ id: jobId, status: 'ok' }),
      ]);
      await request(app).get(jobPath).set(alice).expect(200);
      const retained = await request(app)
        .get(`${jobPath}/pdf`)
        .set(alice)
        .expect(200);
      expect(retained.body).toEqual(pdf.body);
      for (const session of [bob, owner]) {
        await request(app).get(jobPath).set(session).expect(404);
        await request(app).get(`${jobPath}/pdf`).set(session).expect(404);
      }
    } finally {
      try {
        await worker?.close();
        await queue?.obliterate({ force: true });
        await queue?.close();
      } finally {
        connection?.disconnect();
        await db.$disconnect();
        if (connected) {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
  },
  240_000,
);
