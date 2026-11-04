import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { createGenerationUploadMiddleware } from '../src/jobs/upload.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it('stops multipart staging as soon as total resource bytes exceed the job limit', async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-job-upload-'));
  const storage = new FileSystemStorage(root);
  const app = express();
  app.post('/upload', createGenerationUploadMiddleware(storage, 5).any(), (_req, res) => {
    res.status(204).end();
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).end();
    },
  );

  const response = await request(app)
    .post('/upload')
    .attach('first', Buffer.from('abc'), 'a.txt')
    .attach('second', Buffer.from('def'), 'b.txt');
  expect(response.status).toBe(400);
  expect(await readdir(join(root, 'upload-staging'))).toEqual([]);
});
