import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import request from 'supertest';
import { beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/users/users.repository.js';

let passwordHash: string;
const password = 'local-test-password';
beforeAll(async () => {
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });
});

function fixture(nodeEnv?: string) {
  const user = {
    id: randomUUID(),
    username: 'tester',
    role: 'user',
    disabled: false,
    tokenVersion: 0,
    passwordHash,
  };
  const db = {
    user: {
      findUnique: async () => user,
      findUniqueOrThrow: async () => user,
      updateMany: async () => {
        user.tokenVersion++;
        return { count: 1 };
      },
      update: async () => {
        user.tokenVersion++;
        return user;
      },
    },
  } as unknown as Database;
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/test',
    JWT_SECRET: 'test-secret-at-least-32-characters-long',
    NODE_ENV: nodeEnv,
  });
  return createApp(db, config);
}

it('keeps a development session on HTTP and still requires CSRF', async () => {
  const agent = request.agent(fixture('development'));
  const login = await agent
    .post('/api/auth/login')
    .send({ username: 'tester', password });
  expect(login.status).toBe(200);
  const cookie = login.headers['set-cookie'][0];
  expect(cookie).not.toMatch(/; Secure(?:;|$)/);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  expect((await agent.get('/api/auth/me')).status).toBe(200);
  expect((await agent.post('/api/auth/logout')).status).toBe(403);
  const logout = await agent
    .post('/api/auth/logout')
    .set('X-CSRF-Token', login.body.csrfToken);
  expect(logout.status).toBe(204);
  expect(logout.headers['set-cookie'][0]).not.toContain('; Secure');
  expect((await agent.get('/api/auth/me')).status).toBe(401);
});

it.each([undefined, 'production'])(
  'keeps secure cookies for NODE_ENV=%s',
  async (nodeEnv) => {
    const app = fixture(nodeEnv);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'tester', password });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie'][0]).toMatch(
      /HttpOnly.*Secure.*SameSite=Strict/,
    );
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0])
      .set('X-CSRF-Token', login.body.csrfToken);
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie'][0]).toContain('; Secure');
  },
);

it('clears the development cookie after a password change', async () => {
  const agent = request.agent(fixture('development'));
  const login = await agent
    .post('/api/auth/login')
    .send({ username: 'tester', password });
  const changed = await agent
    .post('/api/auth/password')
    .set('X-CSRF-Token', login.body.csrfToken)
    .send({ currentPassword: password, newPassword: 'replacement-password' });
  expect(changed.status).toBe(200);
  expect(changed.headers['set-cookie'][0]).not.toContain('; Secure');
  expect(changed.headers['set-cookie'][0]).toContain(
    'Expires=Thu, 01 Jan 1970',
  );
  expect((await agent.get('/api/auth/me')).status).toBe(401);
});
