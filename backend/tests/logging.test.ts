import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadLoggingConfig } from '../src/logging/config.js';
import {
  closeLogger,
  createServiceLogger,
  safeError,
} from '../src/logging/logger.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amd-logs-'));
  roots.push(root);
  return root;
}
it('validates logging configuration before using it', () => {
  expect(loadLoggingConfig({})).toMatchObject({
    level: 'info',
    retentionDays: 180,
    maxFileBytes: 20971520,
    trustedProxies: [],
  });
  for (const name of [
    'LOG_LEVEL',
    'LOG_RETENTION_DAYS',
    'LOG_MAX_FILE_BYTES',
    'LOG_MAX_TOTAL_BYTES',
    'LOG_DIR',
    'TRUSTED_PROXY_CIDRS',
  ]) {
    expect(() => loadLoggingConfig({ [name]: '' })).toThrow();
  }
  for (const value of ['unknown', 'true', '127.0.0.1/99', '::1/129']) {
    expect(() => loadLoggingConfig({ TRUSTED_PROXY_CIDRS: value })).toThrow();
  }
  expect(
    loadLoggingConfig({ TRUSTED_PROXY_CIDRS: '127.0.0.1,::1/128' })
      .trustedProxies,
  ).toEqual(['127.0.0.1', '::1/128']);
});
it('filters both destinations and drops unapproved metadata and raw errors', async () => {
  const root = await directory();
  const out = vi
    .spyOn((console as any)._stdout, 'write')
    .mockImplementation(() => true);
  const logger = createServiceLogger(
    'api',
    loadLoggingConfig({ LOG_DIR: root }),
  );
  const requestId = randomUUID();
  logger.info('http.completed', {
    requestId,
    status: 200,
    body: 'SECRET',
    error: new Error('SECRET'),
    filename: 'SECRET',
    unknown: 'SECRET',
  });
  logger.debug('http.debug', { requestId });
  await closeLogger(logger);
  const files = (await readdir(join(root, 'api'))).filter((name) =>
    name.endsWith('.log'),
  );
  const text = await readFile(join(root, 'api', files[0]), 'utf8');
  const row = JSON.parse(text.trim());
  expect(row).toMatchObject({
    service: 'api',
    message: 'http.completed',
    event: 'http.completed',
    level: 'info',
    requestId,
    status: 200,
  });
  expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain('http.debug');
  expect(out.mock.calls.map((call) => String(call[0])).join('')).toContain(
    'http.completed',
  );
  expect((await stat(join(root, 'api', files[0]))).mode & 0o777).toBe(0o600);
  expect(
    safeError(Object.assign(new Error('SECRET'), { code: 'SECRET' })),
  ).toMatchObject({
    errorCode: 'unexpected',
  });
});
it('continues console output when the file directory cannot be opened', async () => {
  const root = await directory();
  await writeFile(join(root, 'blocked'), 'not a directory');
  const out = vi
    .spyOn((console as any)._stdout, 'write')
    .mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const logger = createServiceLogger(
    'api',
    loadLoggingConfig({ LOG_DIR: join(root, 'blocked') }),
  );
  logger.info('service.ready');
  await closeLogger(logger);
  expect(out.mock.calls.map((call) => String(call[0])).join('')).toContain(
    'service.ready',
  );
  expect(err.mock.calls.map((call) => String(call[0])).join('')).toContain(
    'logging.file_failed',
  );
});

it('handles runtime file transport errors without losing console output', async () => {
  const root = await directory();
  const out = vi
    .spyOn((console as any)._stdout, 'write')
    .mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const logger = createServiceLogger(
    'api',
    loadLoggingConfig({ LOG_DIR: root }),
  );
  const file = logger.transports.find(
    (transport) => transport.constructor.name === 'DailyRotateFile',
  )!;
  file.emit('error', new Error('SECRET'));
  logger.info('service.ready');
  await closeLogger(logger);
  expect(out.mock.calls.map((call) => String(call[0])).join('')).toContain(
    'service.ready',
  );
  const errors = err.mock.calls.map((call) => String(call[0])).join('');
  expect(errors).toContain('logging.file_failed');
  expect(errors).toContain('SECRET');
  expect(JSON.parse(errors.trim()).stack).toContain('Error: SECRET');
});

it('includes original error stacks and event-site stacks in both destinations', async () => {
  const root = await directory();
  const output = vi
    .spyOn((console as any)._stderr, 'write')
    .mockImplementation(() => true);
  const logger = createServiceLogger(
    'api',
    loadLoggingConfig({ LOG_DIR: root }),
  );
  const error = new Error('diagnostic failure');
  logger.error('http.failed', safeError(error));
  logger.error('generation.interrupted', { errorCode: 'timeout' });
  await closeLogger(logger);
  const files = (await readdir(join(root, 'api'))).filter((name) =>
    name.endsWith('.log'),
  );
  const text = await readFile(join(root, 'api', files[0]), 'utf8');
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows[0]).toMatchObject({
    errorMessage: error.message,
    stack: error.stack,
  });
  expect(rows[1].stack).toContain('Error: generation.interrupted');
  expect(rows[1].stack).toMatch(/\n\s+at /);
  const consoleRows = output.mock.calls
    .map((call) => String(call[0]))
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(consoleRows).toEqual(rows);
});
