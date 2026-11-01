import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import request from 'supertest';
import { createPrismaClient } from '../src/db/prisma.js';
import { createApp } from '../src/app.js';
import { createOwner } from '../src/users/users.service.js';

const baseUrl = process.env.TEST_DATABASE_URL;
const schema = `auth_${randomUUID().replaceAll('-', '')}`;
let admin: Client;
let db: ReturnType<typeof createPrismaClient>;
let app: ReturnType<typeof createApp>;

describe.skipIf(!baseUrl)('authentication and account roles', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(baseUrl!);
    url.searchParams.set('schema', schema);
    execFileSync(
      'npm',
      ['--workspace', 'backend', 'run', 'db:migrate:deploy'],
      {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
      },
    );
    db = createPrismaClient(url.toString());
    app = createApp(db, {
      jwtSecret: 'test-secret-at-least-32-characters-long',
      cookieHours: 12,
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  async function login(username: string, password: string) {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ username, password });
    return {
      response,
      cookie: response.headers['set-cookie']?.[0] as string,
      csrf: response.body.csrfToken as string,
    };
  }

  it('bootstraps only one owner, with no public signup or exposed hash', async () => {
    const owner = await createOwner(
      db,
      'owner',
      'correct horse battery staple',
    );
    expect(owner.role).toBe('owner');
    await expect(
      createOwner(db, 'other-owner', 'correct horse battery staple'),
    ).rejects.toThrow();
    expect(
      (
        await request(app)
          .post('/api/auth/signup')
          .send({ username: 'stranger', password: 'password' })
      ).status,
    ).toBe(404);
    const { response } = await login('owner', 'correct horse battery staple');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(response.headers['set-cookie'][0]).toMatch(
      /HttpOnly.*Secure.*SameSite=Strict/,
    );
  });

  it('rejects bad credentials and requires CSRF for mutations', async () => {
    expect((await login('owner', 'wrong password')).response.status).toBe(401);
    const { cookie, csrf } = await login(
      'owner',
      'correct horse battery staple',
    );
    expect(
      (
        await request(app)
          .post('/api/admin/users')
          .set('Cookie', cookie)
          .send({ username: 'alice', password: 'password-123456' })
      ).status,
    ).toBe(403);
    const created = await request(app)
      .post('/api/admin/users')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ username: 'alice', password: 'password-123456' });
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe('user');
    expect(JSON.stringify(created.body)).not.toContain('passwordHash');
    const alice = await login('alice', 'password-123456');
    expect(alice.response.status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/owner/users/' + created.body.user.id + '/role')
          .set('Cookie', alice.cookie)
          .set('X-CSRF-Token', alice.csrf)
          .send({ role: 'admin' })
      ).status,
    ).toBe(403);
  });

  it('invalidates old tokens after login, password change, and disabling an account', async () => {
    const owner = await login('owner', 'correct horse battery staple');
    const second = await login('owner', 'correct horse battery staple');
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', owner.cookie))
        .status,
    ).toBe(401);
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', second.cookie))
        .status,
    ).toBe(200);
    const changed = await request(app)
      .post('/api/auth/password')
      .set('Cookie', second.cookie)
      .set('X-CSRF-Token', second.csrf)
      .send({
        currentPassword: 'correct horse battery staple',
        newPassword: 'new-password-123456',
      });
    expect(changed.status).toBe(200);
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', second.cookie))
        .status,
    ).toBe(401);
    const fresh = await login('owner', 'new-password-123456');
    const users = await request(app)
      .get('/api/admin/users')
      .set('Cookie', fresh.cookie);
    const alice = users.body.users.find(
      (user: { username: string }) => user.username === 'alice',
    );
    const promoted = await request(app)
      .patch('/api/owner/users/' + alice.id + '/role')
      .set('Cookie', fresh.cookie)
      .set('X-CSRF-Token', fresh.csrf)
      .send({ role: 'admin' });
    expect(promoted.body.user.role).toBe('admin');
    const disabled = await request(app)
      .patch('/api/admin/users/' + alice.id)
      .set('Cookie', fresh.cookie)
      .set('X-CSRF-Token', fresh.csrf)
      .send({ disabled: true });
    expect(disabled.status).toBe(200);
    expect((await login('alice', 'password-123456')).response.status).toBe(401);
  });

  it('returns CSRF after reload and protects owner and account boundaries', async () => {
    const owner = await login('owner', 'new-password-123456');
    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', owner.cookie);
    expect(me.status).toBe(200);
    expect(me.body.csrfToken).toBe(owner.csrf);
    const ownerId = me.body.user.id;
    expect(
      (
        await request(app)
          .patch('/api/admin/users/not-a-uuid')
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', owner.csrf)
          .send({ disabled: true })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch('/api/admin/users/' + ownerId)
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', owner.csrf)
          .send({ disabled: true })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch('/api/owner/users/' + ownerId + '/role')
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Token', owner.csrf)
          .send({ role: 'user' })
      ).status,
    ).toBe(404);
    const created = await request(app)
      .post('/api/admin/users')
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrf)
      .send({ username: 'bob', password: 'password-123456' });
    const bob = await login('bob', 'password-123456');
    expect(
      (await request(app).get('/api/admin/users').set('Cookie', bob.cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch('/api/admin/users/' + created.body.user.id)
          .set('Cookie', bob.cookie)
          .set('X-CSRF-Token', bob.csrf)
          .send({ disabled: true })
      ).status,
    ).toBe(403);
    const promoted = await request(app)
      .patch('/api/owner/users/' + created.body.user.id + '/role')
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrf)
      .send({ role: 'admin' });
    expect(promoted.status).toBe(200);
    expect(
      (await request(app).get('/api/admin/users').set('Cookie', bob.cookie))
        .status,
    ).toBe(401);
    const adminSession = await login('bob', 'password-123456');
    expect(
      (
        await request(app)
          .get('/api/admin/users')
          .set('Cookie', adminSession.cookie)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch('/api/owner/users/' + created.body.user.id + '/role')
          .set('Cookie', adminSession.cookie)
          .set('X-CSRF-Token', adminSession.csrf)
          .send({ role: 'user' })
      ).status,
    ).toBe(403);
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', adminSession.cookie)
      .set('X-CSRF-Token', adminSession.csrf);
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie'][0]).toContain(
      'Expires=Thu, 01 Jan 1970',
    );
  });

  it('rejects unexpected and malformed request input before account mutations', async () => {
    const owner = await login('owner', 'new-password-123456');

    const loginWithExtraField = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'owner',
        password: 'new-password-123456',
        redirectTo: '/admin',
      });
    expect(loginWithExtraField.status).toBe(400);
    expect(JSON.stringify(loginWithExtraField.body)).not.toContain(
      'new-password-123456',
    );

    const createWithRole = await request(app)
      .post('/api/admin/users')
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        username: 'unexpected-role',
        password: 'password-123456',
        role: 'owner',
      });
    expect(createWithRole.status).toBe(400);
    expect(
      await db.user.findUnique({ where: { username: 'unexpected-role' } }),
    ).toBeNull();

    const ownerId = (
      await db.user.findUniqueOrThrow({ where: { username: 'owner' } })
    ).id;
    const disabledAsText = await request(app)
      .patch(`/api/admin/users/${ownerId}`)
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrf)
      .send({ disabled: 'true' });
    expect(disabledAsText.status).toBe(400);

    const passwordWithExtraField = await request(app)
      .post('/api/auth/password')
      .set('Cookie', owner.cookie)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        currentPassword: 'new-password-123456',
        newPassword: 'replacement-123456',
        extra: true,
      });
    expect(passwordWithExtraField.status).toBe(400);

    const queryWithExtraField = await request(app)
      .get('/api/admin/users?includeHashes=true')
      .set('Cookie', owner.cookie);
    expect(queryWithExtraField.status).toBe(400);
  });
});
