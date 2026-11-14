import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';

it('requires authentication before looking up preview files', async () => {
  const storage = new FileSystemStorage('/unused');
  const read = vi.spyOn(storage, 'readPreviewInput');
  const app = createApp(
    {} as Parameters<typeof createApp>[0],
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
  );
  await request(app)
    .get(`/api/templates/${randomUUID()}/files/preview`)
    .query({ segments: 'secret.png' })
    .expect(401);
  expect(read).not.toHaveBeenCalled();
});

it('requires authentication before discovering template resource aliases', async () => {
  const storage = new FileSystemStorage('/unused');
  const list = vi.spyOn(storage, 'listTemplateTree');
  const app = createApp(
    {} as Parameters<typeof createApp>[0],
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
  );
  await request(app)
    .get(`/api/templates/${randomUUID()}/resources`)
    .expect(401);
  expect(list).not.toHaveBeenCalled();
});

it('requires authentication before reading generated template thumbnails', async () => {
  const storage = new FileSystemStorage('/unused');
  const read = vi.spyOn(storage, 'openTemplatePreview');
  const app = createApp(
    {} as Parameters<typeof createApp>[0],
    { jwtSecret: 'test-secret-at-least-32-characters-long', cookieHours: 12 },
    storage,
  );
  await request(app).get(`/api/templates/${randomUUID()}/preview`).expect(401);
  expect(read).not.toHaveBeenCalled();
});
