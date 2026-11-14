import { addTemplateTransactions } from './helpers/template-transactions.js';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  await storage.writeText(
    templateId,
    ['template.tex'],
    'Hello @resource(logo)',
  );
  jobs = [];
  queue = { add: vi.fn(async (_jobId: string) => undefined) };
  const template = {
    id: templateId,
    ownedBy: ownerId,
    name: 'Letter',
    deletedAt: null,
    manifest: { version: 1, shape: null },
  };
  const db: any = addTemplateTransactions({
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
      findMany: vi.fn(async ({ where }: any) =>
        jobs.filter((job) => job.userId === where.userId),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          jobs.find(
            (job) => job.id === where.id && job.userId === where.userId,
          ) ?? null,
      ),
    },
  });
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
  it('discovers unique aliases across nested UTF-8 files and ignores binary content', async () => {
    await storage.createDirectory(templateId, ['support']);
    await storage.writeText(
      templateId,
      ['support', 'part.tex'],
      '@resource(logo) @resource(signature)',
    );
    await writeFile(
      join(root, 'templates', templateId, 'binary.dat'),
      Buffer.from([255, 64, 114]),
    );
    const response = await request(app).get(
      `/api/templates/${templateId}/resources`,
    );
    expect(response.status).toBe(200);
    expect(response.body.aliases.sort()).toEqual(['logo', 'signature']);
  });

  it('keeps resource discovery private and validates requests', async () => {
    await request(app)
      .get(`/api/templates/${templateId}/resources`)
      .set('X-Test-User', otherId)
      .expect(404);
    await request(app).get('/api/templates/invalid/resources').expect(400);
    await request(app)
      .get(`/api/templates/${templateId}/resources?extra=1`)
      .expect(400);
    await storage.writeText(
      templateId,
      ['template.tex'],
      '@resource(../secret)',
    );
    await request(app)
      .get(`/api/templates/${templateId}/resources`)
      .expect(400);
  });

  it('accepts multipart data and an upload keyed by alias', async () => {
    const response = await request(app)
      .post(`/api/templates/${templateId}/generations`)
      .field('data', '{}')
      .attach('logo', Buffer.from('image bytes'), 'logo.png');
    expect(response.status).toBe(201);
    const jobId = response.body.job.id;
    expect(queue.add).toHaveBeenCalledWith(jobId);
    expect(
      await readFile(join(root, 'jobs', jobId, 'input', 'data.json'), 'utf8'),
    ).toBe('{}');
    expect((await request(app).get(`/api/jobs/${jobId}`)).status).toBe(200);
    expect((await request(app).get('/api/jobs')).body.jobs).toHaveLength(1);
    expect(
      (await request(app).get(`/api/jobs/${jobId}`).set('X-Test-User', otherId))
        .status,
    ).toBe(404);
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
    await storage.writeText(
      templateId,
      ['template.tex'],
      '@resource(../secret)',
    );
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

it('streams only a successful owned PDF, including after template deletion', async () => {
  const jobId = randomUUID();
  const filename = `${randomUUID()}.pdf`;
  jobs.push({
    id: jobId,
    userId: ownerId,
    status: 'ok',
    pdfFilename: filename,
  });
  await mkdir(join(root, 'pdfs', jobId), { recursive: true });
  await writeFile(join(root, 'pdfs', jobId, filename), '%PDF-1.7\nexample');
  const own = await request(app).get(`/api/jobs/${jobId}/pdf`);
  expect(own.status).toBe(200);
  expect(own.headers['content-type']).toContain('application/pdf');
  expect(own.headers['content-disposition']).toContain('attachment');
  expect(own.body.toString()).toContain('%PDF-');
  const foreign = await request(app)
    .get(`/api/jobs/${jobId}/pdf`)
    .set('X-Test-User', otherId);
  const missing = await request(app).get(`/api/jobs/${randomUUID()}/pdf`);
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual(missing.body);
  jobs[0].status = 'failed';
  expect((await request(app).get(`/api/jobs/${jobId}/pdf`)).status).toBe(404);
});
