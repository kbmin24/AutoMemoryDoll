import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';

const ownerId = randomUUID();
const otherId = randomUUID();
const templateId = randomUUID();
let root: string;
let storage: FileSystemStorage;
let app: ReturnType<typeof createApp>;
let jobs: any[];
let queue: { add: ReturnType<typeof vi.fn<(jobId: string) => Promise<void>>> };

vi.mock('../src/auth/auth.middleware.js', () => ({
  requireUser: () => (req: any, _res: any, next: any) => {
    req.currentUser = {
      id: req.header('X-Test-User') ?? ownerId,
      role: 'user',
    };
    next();
  },
  requireCsrf: () => (_req: any, _res: any, next: any) => next(),
  requireAdmin: () => (_req: any, _res: any, next: any) => next(),
  requireOwner: () => (_req: any, _res: any, next: any) => next(),
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-jobs-routes-'));
  storage = new FileSystemStorage(root);
  await storage.createTemplateRoot(templateId);
  await storage.writeText(templateId, ['template.tex'], 'Hello @resource(logo)');
  jobs = [];
  queue = { add: vi.fn(async (_jobId: string) => undefined) };
  const template = {
    id: templateId,
    ownedBy: ownerId,
    name: 'Letter',
    deletedAt: null,
    manifest: { version: 1, shape: null },
  };
  const db: any = {
    template: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === templateId && where.ownedBy === ownerId ? template : null,
      ),
    },
    generationJob: {
      create: vi.fn(async ({ data }: any) => {
        const job = {
          ...data,
          status: 'queued',
          timestamp: new Date(),
          template,
        };
        jobs.push(job);
        return job;
      }),
      findMany: vi.fn(async ({ where }: any) => jobs.filter((job) => job.userId === where.userId)),
      findFirst: vi.fn(
        async ({ where }: any) =>
          jobs.find((job) => job.id === where.id && job.userId === where.userId) ?? null,
      ),
    },
  };
  app = createApp(
    db,
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
    queue,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('generation routes', () => {
  it('accepts multipart data and an upload keyed by alias', async () => {
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .field('data', '{}')
      .attach('logo', Buffer.from('image bytes'), 'logo.png');
    expect(response.status).toBe(201);
    const jobId = response.body.job.id;
    expect(queue.add).toHaveBeenCalledWith(jobId);
    expect(await readFile(join(root, 'jobs', jobId, 'input', 'data.json'), 'utf8')).toBe('{}');
    expect((await request(app).get(`/api/jobs/${jobId}`)).status).toBe(200);
    expect((await request(app).get('/api/jobs')).body.jobs).toHaveLength(1);
    expect((await request(app).get(`/api/jobs/${jobId}`).set('X-Test-User', otherId)).status).toBe(
      404,
    );
  });

  it('rejects another user with the same not-found response', async () => {
    const foreign = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .set('X-Test-User', otherId)
      .send({ data: {} });
    expect(foreign.status).toBe(404);
    expect(jobs).toHaveLength(0);
  });

  it('rejects malformed requests without enqueuing', async () => {
    for (const response of [
      await request(app)
        .post(`/api/templates/${templateId}/generations`)
        .send({ data: {}, extra: true }),
      await request(app)
        .post(`/api/templates/${templateId}/generations`)
        .field('data', '[]')
        .attach('logo', Buffer.from('x'), 'logo.png'),
    ]) {
      expect(response.status).toBe(400);
    }
    expect(jobs).toHaveLength(0);
  });

  it('reports a malformed resource alias as a generation request error', async () => {
    await storage.writeText(templateId, ['template.tex'], '@resource(../secret)');
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .send({ data: {} });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid resource alias');
    expect(jobs).toHaveLength(0);
  });

  it('accepts a JSON request when no job upload is required', async () => {
    await storage.writeText(templateId, ['template.tex'], 'Hello {{ name }}');
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .send({ data: { name: 'Ada' } });
    expect(response.status).toBe(201);
    expect(jobs).toHaveLength(1);
  });

  it('reports invalid JSON-mode data as a generation error', async () => {
    await storage.writeText(templateId, ['template.tex'], 'Hello');
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .send({ data: [1, 2] });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid generation data');
  });

  it('removes staged uploads when request validation rejects multipart data', async () => {
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .attach('logo', Buffer.from('image bytes'), 'logo.png');
    expect(response.status).toBe(400);
    expect(await readdir(join(root, 'upload-staging'))).toEqual([]);
    expect(jobs).toHaveLength(0);
  });
});
