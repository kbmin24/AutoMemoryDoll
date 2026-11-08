import express from 'express';
import request from 'supertest';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { requestLogging, markActionSuccess } from '../src/logging/http.js';
import { createApp } from '../src/app.js';
import { captureLogs } from './helpers/logging.js';

it('logs malformed JSON and unmatched requests without echoing input and generates request IDs', async () => {
  const { logger, events } = captureLogs();
  const app = createApp(
    {} as any,
    { jwtSecret: 'x'.repeat(32), cookieHours: 12 },
    undefined,
    undefined,
    logger,
  );
  const malformed = await request(app)
    .post('/api/auth/login?SECRET')
    .set('X-Request-ID', 'SECRET')
    .set('Content-Type', 'application/json')
    .send('{SECRET');
  expect(malformed.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  await request(app).get('/SECRET?SECRET=SECRET');
  expect(JSON.stringify(events)).not.toContain('SECRET');
  expect(events.filter((event) => event.message === 'http.completed')).toHaveLength(2);
  expect(events.find((event) => event.route === 'unmatched')).toMatchObject({
    level: 'warn',
    status: 404,
  });
});
it('assigns levels to completed HTTP requests', async () => {
  const { logger, events } = captureLogs();
  const app = express();
  app.use(requestLogging(logger));
  app.get('/api/templates', (_req, res) => res.end());
  app.get('/api/jobs', (_req, res) => res.status(400).end());
  app.get('/api/auth/me', (_req, res) => res.status(500).end());
  for (const path of ['/api/templates', '/api/jobs', '/api/auth/me'])
    await request(app).get(path);
  expect(events.map((event) => event.level)).toEqual(['info', 'warn', 'error']);
  expect(events.every((event) => event.durationMs >= 0)).toBe(true);
});
it('trusts forwarded addresses only for a configured peer', async () => {
  for (const [trusted, expected] of [
    [[], '127.0.0.1'],
    [['loopback'], '198.51.100.2'],
  ] as const) {
    const { logger, events } = captureLogs();
    const app = express();
    app.set('trust proxy', [...trusted]);
    app.use(requestLogging(logger));
    app.post('/api/templates', (_req, res) => res.end());
    await request(app).post('/api/templates').set('X-Forwarded-For', '198.51.100.2');
    expect(events[0].clientIp).toBe(expected);
  }
});
it('records a committed action separately from an aborted HTTP response', async () => {
  const { logger, events } = captureLogs();
  const app = express();
  app.use(requestLogging(logger));
  app.post('/api/templates', (_req, res) => {
    markActionSuccess(res);
    res.write('partial');
    setImmediate(() => res.destroy());
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port: address.port, path: '/api/templates', method: 'POST' },
      (res) => {
        res.resume();
        res.on('close', resolve);
        res.on('error', () => resolve());
      },
    );
    call.on('error', reject);
    call.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(events.filter((event) => event.message.startsWith('http.'))).toHaveLength(1);
  expect(events.find((event) => event.message === 'http.aborted')).toMatchObject({
    outcome: 'aborted',
    level: 'warn',
  });
  expect(events.find((event) => event.message === 'template.created')).toMatchObject({
    outcome: 'success',
    level: 'info',
  });
});

it('records a mutation that commits after the client disconnects', async () => {
  const { beginAction } = await import('../src/logging/http.js');
  const { logger, events } = captureLogs();
  const app = express();
  app.use(requestLogging(logger));
  let commit: () => void = () => {};
  app.post('/api/templates', async (_req, res) => {
    beginAction(res);
    res.write('partial');
    await new Promise<void>((resolve) => {
      commit = resolve;
      setImmediate(() => res.destroy());
    });
    markActionSuccess(res);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await new Promise<void>((resolve, reject) => {
      const call = httpRequest(
        {
          host: '127.0.0.1',
          port: (server.address() as { port: number }).port,
          path: '/api/templates',
          method: 'POST',
        },
        (res) => {
          res.resume();
          res.on('close', resolve);
          res.on('error', () => resolve());
        },
      );
      call.on('error', reject);
      call.end();
    });
    commit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.filter((event) => event.message === 'template.created')).toHaveLength(
      1,
    );
    expect(events.find((event) => event.message === 'template.created')).toMatchObject({
      outcome: 'success',
      level: 'info',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([false, true])(
  'waits for guard outcomes and late actor identity after disconnect (validation rejection: %s)',
  async (rejectValidation) => {
    const { randomUUID } = await import('node:crypto');
    const { body } = await import('express-validator');
    const { validateRequest } = await import('../src/validation.js');
    const { beginAction } = await import('../src/logging/http.js');
    const actorId = randomUUID();
    const { logger, events } = captureLogs();
    const app = express();
    app.use(requestLogging(logger));
    let release: () => void = () => {};
    let entered: () => void = () => {};
    let aborted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guardEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const serverAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    app.use(async (req, res, next) => {
      res.once('close', aborted);
      entered();
      await gate;
      (req as any).currentUser = { id: actorId };
      next();
    });
    if (rejectValidation) app.use(body('required').notEmpty(), validateRequest);
    app.post('/api/templates', (_req, res) => {
      beginAction(res);
      markActionSuccess(res);
      res.end();
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const call = httpRequest({
        host: '127.0.0.1',
        port: (server.address() as { port: number }).port,
        path: '/api/templates',
        method: 'POST',
      });
      call.on('error', () => {});
      call.end();
      await guardEntered;
      call.destroy();
      await serverAborted;
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const actions = events.filter((event) => event.message === 'template.created');
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        actorId,
        outcome: rejectValidation ? 'rejected' : 'success',
        level: rejectValidation ? 'warn' : 'info',
      });
      expect(events.filter((event) => event.message === 'http.aborted')).toHaveLength(1);
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
