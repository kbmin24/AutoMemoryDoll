import { addTemplateTransactions } from './helpers/template-transactions.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { issueSession } from '../src/auth/auth.service.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { captureLogs } from './helpers/logging.js';

const config = { jwtSecret: 'x'.repeat(32), cookieHours: 12 };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(level = 'debug') {
  const root = await mkdtemp(join(tmpdir(), 'amd-actions-'));
  roots.push(root);
  const storage = new FileSystemStorage(root);
  const user = {
    id: randomUUID(),
    username: 'SECRET',
    role: 'owner',
    disabled: false,
    tokenVersion: 0,
    passwordHash: await argon2.hash('SECRET-password'),
  };
  const template = {
    id: randomUUID(),
    ownedBy: user.id,
    name: 'SECRET',
    deletedAt: null,
    manifest: { version: 1, shape: null },
  };
  const db: any = addTemplateTransactions({
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === user.id || where.username === user.username ? user : null,
      ),
      update: vi.fn(async () => user),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => user),
      create: vi.fn(async () => ({ ...user, id: randomUUID() })),
    },
    template: {
      findFirst: vi.fn(async () => template),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => template),
      create: vi.fn(async ({ data }: any) => ({ ...template, ...data })),
    },
    generationJob: {
      create: vi.fn(async ({ data }: any) => ({
        ...data,
        timestamp: new Date(),
        status: 'queued',
      })),
    },
  });
  await storage.createTemplateRoot(template.id);
  await storage.writeText(template.id, ['template.tex'], 'SECRET document');
  const { logger, events } = captureLogs(level);
  const app = createApp(
    db,
    config,
    storage,
    { add: async () => undefined },
    logger,
  );
  const session = await issueSession(config, user);
  function authorized(
    method: 'post' | 'put' | 'patch' | 'delete' | 'get',
    path: string,
  ) {
    return request(app)
      [method](path)
      .set('Cookie', `amd_session=${session.token}`)
      .set('X-CSRF-Token', session.csrfToken);
  }
  return { app, db, user, template, events, authorized, storage };
}
it('records success for workspace actions and links generation to the HTTP request', async () => {
  const { template, user, events, authorized } = await fixture();
  const base = `/api/templates/${template.id}`;
  const cases = [
    [
      'post',
      '/files/directories',
      { segments: ['dir'] },
      'workspace.directory_created',
    ],
    [
      'put',
      '/files/text',
      { segments: ['dir', 'note.tex'], text: 'SECRET' },
      'workspace.text_updated',
    ],
    [
      'post',
      '/files/move',
      { from: ['dir', 'note.tex'], to: ['dir', 'other.tex'] },
      'workspace.moved',
    ],
    ['delete', '/files', { segments: ['dir'] }, 'workspace.deleted'],
  ] as const;
  for (const [method, path, body, action] of cases) {
    const response = await authorized(method, base + path).send(body);
    expect(response.status).toBeLessThan(300);
    expect(events.find((event) => event.message === action)).toMatchObject({
      outcome: 'success',
      actorId: user.id,
      templateId: template.id,
      level: 'info',
    });
  }
  const result = await authorized('post', base + '/generations').send({
    data: {},
  });
  expect(result.status).toBe(201);
  expect(
    events.find((event) => event.message === 'generation.submitted'),
  ).toMatchObject({
    outcome: 'success',
    jobId: result.body.job.id,
    requestId: result.headers['x-request-id'],
  });
  expect(JSON.stringify(events)).not.toContain('SECRET');
});
it('records rejected actions before authentication, CSRF, or validation handlers', async () => {
  const { app, events, authorized } = await fixture();
  for (const [method, path, action] of [
    ['post', '/api/auth/login', 'auth.login'],
    ['post', '/api/auth/logout', 'auth.logout'],
    ['post', '/api/auth/password', 'auth.password_changed'],
    ['post', '/api/admin/users', 'account.created'],
    ['patch', `/api/admin/users/${randomUUID()}`, 'account.disabled_changed'],
    ['patch', `/api/owner/users/${randomUUID()}/role`, 'account.role_changed'],
    ['post', '/api/templates', 'template.created'],
    ['patch', `/api/templates/${randomUUID()}`, 'template.updated'],
    ['delete', `/api/templates/${randomUUID()}`, 'template.deleted'],
    [
      'post',
      `/api/templates/${randomUUID()}/files/uploads`,
      'workspace.uploaded',
    ],
    ['get', `/api/jobs/${randomUUID()}/pdf`, 'pdf.downloaded'],
  ] as const) {
    const result = await request(app)
      [method](path)
      .send({ password: 'SECRET' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(events.find((event) => event.message === action)).toMatchObject({
      level: 'warn',
      outcome: 'rejected',
    });
  }
  await authorized('put', `/api/templates/${randomUUID()}/files/text`).send({
    segments: [],
    text: 'SECRET',
  });
  expect(
    events.find((event) => event.message === 'workspace.text_updated'),
  ).toMatchObject({ outcome: 'rejected' });
  expect(JSON.stringify(events)).not.toContain('SECRET');
});
it('records login, logout, account changes, and unexpected failures with safe IDs', async () => {
  const { app, db, user, events, authorized } = await fixture();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: 'SECRET', password: 'SECRET-password' });
  expect(login.status).toBe(200);
  expect(events.find((event) => event.message === 'auth.login')).toMatchObject({
    outcome: 'success',
    actorId: user.id,
  });
  await authorized('post', '/api/auth/logout').send({});
  expect(events.find((event) => event.message === 'auth.logout')).toMatchObject(
    {
      outcome: 'success',
    },
  );
  const target = randomUUID();
  await authorized('patch', `/api/admin/users/${target}`).send({
    disabled: true,
  });
  expect(
    events.find((event) => event.message === 'account.disabled_changed'),
  ).toMatchObject({ outcome: 'success', targetId: target });
  await authorized('patch', `/api/owner/users/${target}/role`).send({
    role: 'admin',
  });
  expect(
    events.find((event) => event.message === 'account.role_changed'),
  ).toMatchObject({
    outcome: 'success',
    targetId: target,
  });
  db.template.create.mockRejectedValueOnce(
    new Error('database operation failed'),
  );
  await authorized('post', '/api/templates').send({
    name: 'SECRET',
    manifest: { version: 1, shape: null },
  });
  expect(
    events.find((event) => event.message === 'template.created'),
  ).toMatchObject({
    outcome: 'failed',
    level: 'error',
  });
  expect(JSON.stringify(events)).not.toContain('SECRET');
});
it('suppresses successful HTTP and action events at error level', async () => {
  const { authorized, events } = await fixture('error');
  await authorized('post', '/api/auth/logout').send({});
  expect(events).toEqual([]);
});

it('records remaining successful actions and streamed downloads without content or filenames', async () => {
  const { db, user, template, events, authorized, storage } = await fixture();
  const base = `/api/templates/${template.id}`;
  expect(
    (
      await authorized('post', base + '/files/uploads')
        .field('segments', JSON.stringify(['SECRET.txt']))
        .attach('file', Buffer.from('SECRET'), 'SECRET.txt')
    ).status,
  ).toBe(201);
  expect(
    (
      await authorized('get', base + '/files/download').query({
        segments: 'SECRET.txt',
      })
    ).status,
  ).toBe(200);
  expect(
    (await authorized('patch', base).send({ name: 'SECRET' })).status,
  ).toBe(200);
  expect(
    (
      await authorized('post', '/api/templates').send({
        name: 'SECRET',
        manifest: { version: 1, shape: null },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await authorized('post', '/api/admin/users').send({
        username: 'new_account',
        password: 'SECRET-password',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await authorized('post', '/api/auth/password').send({
        currentPassword: 'SECRET-password',
        newPassword: 'SECRET-new-password',
      })
    ).status,
  ).toBe(200);
  const jobId = randomUUID();
  await storage.snapshot(template.id, jobId);
  const { output } = await storage.prepareJobOutput(jobId);
  const filename = `${randomUUID()}.pdf`;
  await writeFile(join(output, filename), '%PDF-1.7 SECRET');
  await storage.savePdf(jobId, join(output, filename), filename);
  db.generationJob.findFirst = vi.fn(async () => ({
    id: jobId,
    templateId: template.id,
    userId: user.id,
    status: 'ok',
    timestamp: new Date(),
    pdfFilename: filename,
  }));
  expect((await authorized('get', `/api/jobs/${jobId}/pdf`)).status).toBe(200);
  expect((await authorized('delete', base)).status).toBe(204);
  for (const action of [
    'workspace.uploaded',
    'workspace.downloaded',
    'template.updated',
    'template.created',
    'account.created',
    'auth.password_changed',
    'pdf.downloaded',
    'template.deleted',
  ]) {
    expect(events.find((event) => event.message === action)).toMatchObject({
      level: 'info',
      outcome: 'success',
      actorId: user.id,
    });
  }
  expect(JSON.stringify(events)).not.toContain('SECRET');
  expect(JSON.stringify(events)).not.toContain(filename);
});
