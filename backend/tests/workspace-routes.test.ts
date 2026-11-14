import { addTemplateTransactions } from './helpers/template-transactions.js';
import sharp from 'sharp';
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
  return addTemplateTransactions(db);
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

  it('lists workspace files and rejects unexpected query fields', async () => {
    const id = (await create()).body.template.id;
    const response = await request(app).get(`/api/templates/${id}/files`);
    expect(response.status).toBe(200);
    expect(response.body.files).toEqual(expect.any(Array));
    expect(
      (await request(app).get(`/api/templates/${id}/files?unexpected=true`))
        .status,
    ).toBe(400);
  });

  it('creates, updates, lists, and soft-deletes a private template', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body.template.manifest).toEqual(manifest);
    const id = created.body.template.id;
    expect(await readFile(join(root, 'templates', id, 'template.tex'), 'utf8'))
      .toBe(String.raw`\documentclass[12pt, a4paper]{article}

\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{graphicx}

\title{Enter title here}
\author{Your Name}
\date{\today}

\begin{document}

\maketitle


\end{document}
`);
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
    expect(invalid.body).toEqual({ error: 'Invalid workspace operation' });
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

it.each([
  'Invalid internal state',
  'Cannot connect to database',
  'disk limit reached',
])(
  'does not classify an internal error from its wording: %s',
  async (message) => {
    const created = await request(app)
      .post('/api/templates')
      .send({ name: 'Letters', manifest });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      vi.spyOn(storage, 'readText').mockRejectedValueOnce(new Error(message));
      const response = await request(app)
        .get(`/api/templates/${created.body.template.id}/files/text`)
        .query({ segments: 'template.tex' });
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    } finally {
      log.mockRestore();
    }
  },
);

it('returns the existing generic response for a typed storage error regardless of wording', async () => {
  const { StorageError } = await import('../src/storage/storage.errors.js');
  const created = await request(app)
    .post('/api/templates')
    .send({ name: 'Letters', manifest });
  vi.spyOn(storage, 'readText').mockRejectedValueOnce(
    new StorageError('Wording changed'),
  );
  const response = await request(app)
    .get(`/api/templates/${created.body.template.id}/files/text`)
    .query({ segments: 'template.tex' });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: 'Invalid workspace operation' });
});

it('serves only validated image previews with private security headers', async () => {
  const created = await request(app)
    .post('/api/templates')
    .send({ name: 'Letters', manifest });
  const id = created.body.template.id;
  const pixels = await sharp({
    create: { width: 4, height: 3, channels: 3, background: 'red' },
  })
    .jpeg()
    .toBuffer();
  await request(app)
    .post(`/api/templates/${id}/files/uploads`)
    .field('segments', JSON.stringify(['mislabeled.png']))
    .attach('file', pixels, {
      filename: 'mislabeled.png',
      contentType: 'text/html',
    })
    .expect(201);
  const preview = await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'mislabeled.png' });
  expect(preview.status).toBe(200);
  expect(preview.headers['content-type']).toBe('image/png');
  expect(preview.headers['x-content-type-options']).toBe('nosniff');
  expect(preview.headers['cache-control']).toBe('private, no-store');
  expect(preview.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(preview.headers['content-security-policy']).toContain(
    "default-src 'none'",
  );
  expect(preview.headers['content-disposition']).toBe(
    'inline; filename="preview.png"',
  );
  expect((await sharp(preview.body).metadata()).format).toBe('png');
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'mislabeled.png' })
    .set('X-Test-User', otherId)
    .expect(404);
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: '../secret' })
    .expect(400);
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'mislabeled.png', extra: 'x' })
    .expect(400);
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'mislabeled.png' })
    .send({ extra: 'x' })
    .expect(400);
  await request(app).get(`/api/templates/${id}/files/preview`).expect(400);
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'absent.png' })
    .expect(404);
});

it('rejects fake image content and reports binary text reads as a controlled 400', async () => {
  const created = await request(app)
    .post('/api/templates')
    .send({ name: 'Letters', manifest });
  const id = created.body.template.id;
  await request(app)
    .post(`/api/templates/${id}/files/uploads`)
    .field('segments', JSON.stringify(['fake.png']))
    .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
      filename: 'fake.png',
      contentType: 'image/png',
    })
    .expect(201);
  await request(app)
    .get(`/api/templates/${id}/files/preview`)
    .query({ segments: 'fake.png' })
    .expect(400);
  await request(app)
    .post(`/api/templates/${id}/files/uploads`)
    .field('segments', JSON.stringify(['binary.png']))
    .attach('file', Buffer.from([137, 80, 78, 71]), 'binary.png')
    .expect(201);
  const response = await request(app)
    .get(`/api/templates/${id}/files/text`)
    .query({ segments: 'binary.png' });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: 'Invalid workspace operation' });
});

it('serves a generated template thumbnail only to its owner with private headers', async () => {
  const id = (
    await request(app)
      .post('/api/templates')
      .send({ name: 'Private', manifest })
  ).body.template.id;
  const runId = randomUUID();
  await storage.snapshotPreview(id, runId);
  const { output } = await storage.preparePreviewOutput(runId);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(output, 'preview.webp'),
    Buffer.from('RIFF1234WEBPimage'),
  );
  await storage.publishPreview(id, runId);
  const response = await request(app).get(`/api/templates/${id}/preview`);
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('image/webp');
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(
    (
      await request(app)
        .get(`/api/templates/${id}/preview`)
        .set('X-Test-User', otherId)
    ).status,
  ).toBe(404);
  expect(
    (await request(app).get(`/api/templates/${id}/preview?path=secret`)).status,
  ).toBe(400);
  await request(app).delete(`/api/templates/${id}`);
  expect((await request(app).get(`/api/templates/${id}/preview`)).status).toBe(
    404,
  );
  expect(await storage.templatePreviewExists(id)).toBe(false);
});

it('schedules previews after saved content/shape changes but not names, failed edits or reads', async () => {
  const previews = {
    schedule: vi.fn(async () => {}),
    scheduleIfIdle: vi.fn(async () => {}),
  };
  app = createApp(
    dbForTests(),
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
    undefined,
    undefined,
    [],
    previews,
  );
  const id = (
    await request(app)
      .post('/api/templates')
      .send({ name: 'Private', manifest })
  ).body.template.id;
  expect(previews.schedule).toHaveBeenCalledTimes(1);
  await request(app).patch(`/api/templates/${id}`).send({ name: 'Renamed' });
  await request(app).patch(`/api/templates/${id}`).send({ manifest });
  await request(app).get(`/api/templates/${id}/files`);
  await request(app)
    .put(`/api/templates/${id}/files/text`)
    .send({ segments: ['../bad'], text: 'no' });
  expect(previews.schedule).toHaveBeenCalledTimes(1);
  await request(app)
    .patch(`/api/templates/${id}`)
    .send({ manifest: { version: 1, shape: null } });
  expect(previews.schedule).toHaveBeenCalledTimes(2);
  previews.schedule.mockRejectedValueOnce(new Error('queue offline'));
  const response = await request(app)
    .put(`/api/templates/${id}/files/text`)
    .send({ segments: ['template.tex'], text: 'saved' });
  expect(response.status).toBe(204);
  expect(await storage.readText(id, ['template.tex'])).toBe('saved');
});
