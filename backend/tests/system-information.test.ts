import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { cookieName, issueSession } from '../src/auth/auth.service.js';
import { dockerSnapshotKey } from '../src/system/system-information.js';
import { publishDockerStatus } from '../src/worker/docker-status.js';

it('serves private system information only to admins and owners', async () => {
  const config = {
    jwtSecret: 'test-secret-at-least-32-characters-long',
    cookieHours: 1,
  };
  const user = { id: 'account', tokenVersion: 0, role: 'user' };
  const db = {
    user: { findUnique: vi.fn(async () => user) },
  } as unknown as Parameters<typeof createApp>[0];
  const docker = {
    running: 0,
    cpus: 1,
    memoryMb: 512,
    pids: 64,
    wallTimeMs: 60_000,
  };
  const readDocker = vi.fn(async (): Promise<typeof docker | null> => docker);
  const app = createApp(
    db,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    readDocker,
  );
  const path = '/api/admin/system-information';
  const { token } = await issueSession(config, user);
  const cookie = `${cookieName}=${token}`;

  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).get(path).set('Cookie', cookie)).status).toBe(403);
  expect(readDocker).not.toHaveBeenCalled();

  user.role = 'admin';
  const response = await request(app).get(path).set('Cookie', cookie);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body.system).toMatchObject({
    hostname: expect.any(String),
    uptimeSeconds: expect.any(Number),
  });
  expect(response.body.docker).toEqual(docker);

  user.role = 'owner';
  readDocker.mockResolvedValueOnce(null);
  const unavailable = await request(app).get(path).set('Cookie', cookie);
  expect(unavailable.status).toBe(200);
  expect(unavailable.body.docker).toBeNull();
});

it('publishes only a running compiler count and configured limits with an expiry', async () => {
  const set = vi.fn();
  const execute = vi.fn(async () => ({
    stdout: 'first\nsecond\n',
    stderr: '',
  }));
  const limits = { cpus: 1, memoryMb: 512, pids: 64, wallTimeMs: 60_000 };
  const config = { ...limits, uid: 1000, gid: 1000, image: 'compiler' };

  await publishDockerStatus({ status: 'ready', set }, config, execute);
  expect(execute).toHaveBeenCalledWith(
    'docker',
    [
      'ps',
      '--filter=status=running',
      '--filter=name=^/amd-compiler-',
      '--format={{.ID}}',
    ],
    expect.objectContaining({ timeout: 3_000 }),
  );
  const [[key, value, expiry, ttl]] = set.mock.calls;
  expect([key, expiry, ttl]).toEqual([dockerSnapshotKey, 'EX', 15]);
  expect(JSON.parse(value)).toEqual({
    status: { ...limits, running: 2 },
    sampledAt: expect.any(Number),
  });

  execute.mockRejectedValueOnce(new Error('Docker unavailable'));
  await expect(
    publishDockerStatus({ status: 'ready', set }, config, execute),
  ).rejects.toThrow('Docker unavailable');
  expect(set).toHaveBeenCalledTimes(1);
});
