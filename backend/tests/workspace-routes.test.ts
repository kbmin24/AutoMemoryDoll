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
const manifest = {
  version: 1,
  shape: {
    fields: [
      { variable: 'name', label: 'Name', type: 'text', optional: false },
    ],
  },
};
let root: string;
let storage: FileSystemStorage;
let template: any;
let app: ReturnType<typeof createApp>;

function dbForTests() {
  const db: any = {
    template: {
      create: vi.fn(async ({ data }: any) => {
        template = { ...data, deletedAt: null };
        return template;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        template &&
        template.ownedBy === where.ownedBy &&
        template.deletedAt === null
          ? [template]
          : [],
      ),
      findFirst: vi.fn(async ({ where }: any) =>
        template &&
        template.id === where.id &&
        template.ownedBy === where.ownedBy &&
        template.deletedAt === null
          ? template
          : null,
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (
          !template ||
          template.id !== where.id ||
          template.ownedBy !== where.ownedBy ||
          (where.deletedAt === null && template.deletedAt !== null) ||
          (where.deletedAt instanceof Date &&
            template.deletedAt !== where.deletedAt)
        )
          return { count: 0 };
        template = { ...template, ...data };
        return { count: 1 };
      }),
      delete: vi.fn(async () => {
        template = undefined;
      }),
    },
  };
  return db;
}

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
  root = await mkdtemp(join(tmpdir(), 'amd-template-routes-'));
  storage = new FileSystemStorage(root);
  template = undefined;
  app = createApp(
    dbForTests(),
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('template and workspace routes', () => {
  async function create() {
    return request(app)
      .post('/api/templates')
      .send({ name: 'Letters', manifest });
  }

  it('creates, updates, lists, and soft-deletes a private template', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.template.manifest).toEqual(manifest);
    const id = created.body.template.id;
    expect(
      await readFile(join(root, 'templates', id, 'template.tex'), 'utf8'),
    ).toBe('');
    expect(
      (await request(app).get('/api/templates')).body.templates,
    ).toHaveLength(1);
    const changed = await request(app)
      .patch(`/api/templates/${id}`)
      .send({ name: 'Renamed', manifest: { version: 1, shape: null } });
    expect(changed.body.template.name).toBe('Renamed');
    expect(changed.body.template.manifest.shape).toBeNull();
    expect((await request(app).delete(`/api/templates/${id}`)).status).toBe(
      204,
    );
    expect((await request(app).get(`/api/templates/${id}`)).status).toBe(404);
  });

  it('returns identical not-found responses for another owner and a deleted template', async () => {
    const id = (await create()).body.template.id;
    const foreign = await request(app)
      .get(`/api/templates/${id}`)
      .set('X-Test-User', otherId);
    const foreignFile = await request(app)
      .get(`/api/templates/${id}/files`)
      .set('X-Test-User', otherId);
    expect(foreign.status).toBe(404);
    expect(foreignFile.status).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/templates/${id}`)
          .set('X-Test-User', otherId)
          .send({ name: 'Stolen' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put(`/api/templates/${id}/files/text`)
          .set('X-Test-User', otherId)
          .send({ segments: ['template.tex'], text: 'Stolen' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/api/templates/${id}`)
          .set('X-Test-User', otherId)
      ).status,
    ).toBe(404);
    await request(app).delete(`/api/templates/${id}`);
    const deleted = await request(app).get(`/api/templates/${id}`);
    expect(deleted.body).toEqual(foreign.body);
  });

  it('edits and downloads files while protecting template.tex and rejecting unsafe paths', async () => {
    const id = (await create()).body.template.id;
    expect(
      (
        await request(app)
          .put(`/api/templates/${id}/files/text`)
          .send({ segments: ['template.tex'], text: 'Hello' })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get(`/api/templates/${id}/files/text`)
          .query({ segments: 'template.tex' })
      ).body.text,
    ).toBe('Hello');
    expect(
      (
        await request(app)
          .post(`/api/templates/${id}/files/directories`)
          .send({ segments: ['assets'] })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post(`/api/templates/${id}/files/uploads`)
          .field('segments', JSON.stringify(['assets', 'logo.bin']))
          .attach('file', Buffer.from([0, 1, 2]), 'logo.bin')
      ).status,
    ).toBe(201);
    const download = await request(app)
      .get(`/api/templates/${id}/files/download`)
      .query({ segments: ['assets', 'logo.bin'] });
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(
      (
        await request(app)
          .post(`/api/templates/${id}/files/move`)
          .send({ from: ['template.tex'], to: ['other.tex'] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .delete(`/api/templates/${id}/files`)
          .send({ segments: ['template.tex'] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`/api/templates/${id}/files/text`)
          .query({ segments: '..' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get(`/api/templates/${id}/files/text`)
          .query({ segments: 'missing.txt' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app).get(
          `/api/templates/${id}/files/text?segments=%2Fetc%2Fpasswd`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/templates/${id}/files/text`)
          .send({ segments: ['template.tex'], text: 'x', extra: true })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/templates/${id}/files/uploads`)
          .field('segments', '[".."]')
          .attach('file', Buffer.from('bad'), 'bad.txt')
      ).status,
    ).toBe(400);
    expect(await readdir(join(root, 'upload-staging'))).toEqual([]);
  });

  it('rejects invalid manifest updates without changing metadata', async () => {
    const id = (await create()).body.template.id;
    const invalid = await request(app)
      .patch(`/api/templates/${id}`)
      .send({ manifest: { version: 1, shape: { fields: [] } } });
    expect(invalid.status).toBe(400);
    expect(
      (await request(app).get(`/api/templates/${id}`)).body.template.manifest,
    ).toEqual(manifest);
  });

  it('restores visibility if workspace removal fails', async () => {
    const id = (await create()).body.template.id;
    vi.spyOn(storage, 'removeTemplateRoot').mockRejectedValueOnce(
      new Error('disk failure'),
    );
    expect((await request(app).delete(`/api/templates/${id}`)).status).toBe(
      500,
    );
    expect((await request(app).get(`/api/templates/${id}`)).status).toBe(200);
  });
});
