import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupLogs } from '../src/logging/retention.js';
import { createServiceLogger, closeLogger } from '../src/logging/logger.js';
import { loadLoggingConfig } from '../src/logging/config.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amd-retention-'));
  roots.push(root);
  return root;
}
it('expires old files and caps archives while preserving unrelated files and symlinks', async () => {
  const root = await directory();
  const today = new Date().toISOString().slice(0, 10);
  const active = `application-${today}.log`;
  await writeFile(join(root, 'application-2000-01-01.log'), 'expired');
  await writeFile(join(root, active), '12345');
  await writeFile(join(root, `application-${today}.log.1`), '12345');
  await writeFile(join(root, 'unrelated.log'), 'unrelated');
  await symlink(join(root, 'unrelated.log'), join(root, 'application-2001-01-01.log'));
  await cleanupLogs(root, 180, 5, active);
  expect((await readdir(root)).sort()).toEqual(
    [active, 'application-2001-01-01.log', 'unrelated.log'].sort(),
  );
  expect(await readFile(join(root, 'unrelated.log'), 'utf8')).toBe('unrelated');
});
it('rotates by size and preserves valid JSON with private file permissions', async () => {
  const root = await directory();
  vi.spyOn((console as any)._stdout, 'write').mockImplementation(() => true);
  const logger = createServiceLogger(
    'consumer',
    loadLoggingConfig({ LOG_DIR: root, LOG_MAX_FILE_BYTES: '128' }),
  );
  for (let i = 0; i < 20; i++) logger.info('generation.started');
  await closeLogger(logger);
  const files = (await readdir(join(root, 'consumer'))).filter((name) =>
    /^application-.*\.log(?:\.\d+)?$/.test(name),
  );
  expect(files.length).toBeGreaterThan(1);
  const rows = (
    await Promise.all(files.map((name) => readFile(join(root, 'consumer', name), 'utf8')))
  )
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows).toHaveLength(20);
  expect(rows.every((row) => row.service === 'consumer')).toBe(true);
});

it('rotates across UTC midnight and expires stale files after restart without new events', async () => {
  const root = await directory();
  vi.spyOn((console as any)._stdout, 'write').mockImplementation(() => true);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-08T23:59:59Z'));
    const config = loadLoggingConfig({ LOG_DIR: root });
    const first = createServiceLogger('api', config);
    first.info('service.ready');
    vi.setSystemTime(new Date('2026-11-09T00:00:01Z'));
    first.info('service.stopping');
    await closeLogger(first);
    expect(await readdir(join(root, 'api'))).toEqual(
      expect.arrayContaining([
        'application-2026-11-08.log',
        'application-2026-11-09.log',
      ]),
    );
    await writeFile(
      join(root, 'api', 'application-2000-01-01.log'),
      'stale from previous configuration',
    );
    const restarted = createServiceLogger('api', config);
    await new Promise((resolve) => setImmediate(resolve));
    await closeLogger(restarted);
    expect(await readdir(join(root, 'api'))).not.toContain('application-2000-01-01.log');
  } finally {
    vi.useRealTimers();
  }
});

it('enforces the optional disk cap after a burst and after restart', async () => {
  const root = await directory();
  vi.spyOn((console as any)._stdout, 'write').mockImplementation(() => true);
  const config = loadLoggingConfig({
    LOG_DIR: root,
    LOG_MAX_FILE_BYTES: '512',
    LOG_MAX_TOTAL_BYTES: '1024',
  });
  for (let run = 0; run < 2; run++) {
    const logger = createServiceLogger('consumer', config);
    for (let i = 0; i < 40; i++) logger.info('generation.started');
    await closeLogger(logger);
    const files = (await readdir(join(root, 'consumer'))).filter((name) =>
      name.startsWith('application-'),
    );
    const size = (
      await Promise.all(
        files.map(async (name) => (await readFile(join(root, 'consumer', name))).length),
      )
    ).reduce((a, b) => a + b, 0);
    expect(size).toBeLessThanOrEqual(1024);
    expect(files.length).toBeGreaterThan(0);
  }
});

it('expires an idle active file while the service stays running', async () => {
  const root = await directory();
  vi.spyOn((console as any)._stdout, 'write').mockImplementation(() => true);
  const interval = vi.spyOn(globalThis, 'setInterval');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  const logger = createServiceLogger('api', loadLoggingConfig({ LOG_DIR: root }));
  try {
    logger.info('service.ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
    (interval.mock.calls[0][0] as () => void)();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await readdir(join(root, 'api'))).includes('application-2026-01-01.log'))
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await readdir(join(root, 'api'))).not.toContain('application-2026-01-01.log');
  } finally {
    await closeLogger(logger);
    vi.useRealTimers();
  }
});

it('evicts a final oversized record during live cap maintenance without another event', async () => {
  const root = await directory();
  vi.spyOn((console as any)._stdout, 'write').mockImplementation(() => true);
  const interval = vi.spyOn(globalThis, 'setInterval');
  const logger = createServiceLogger(
    'api',
    loadLoggingConfig({
      LOG_DIR: root,
      LOG_MAX_FILE_BYTES: '64',
      LOG_MAX_TOTAL_BYTES: '64',
    }),
  );
  try {
    logger.info('service.ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    (interval.mock.calls[0][0] as () => void)();
    let size = Infinity;
    for (let attempt = 0; attempt < 20; attempt++) {
      const files = (await readdir(join(root, 'api'))).filter((name) =>
        name.startsWith('application-'),
      );
      size = (
        await Promise.all(
          files.map(async (name) => (await readFile(join(root, 'api', name))).length),
        )
      ).reduce((sum, bytes) => sum + bytes, 0);
      if (size <= 64) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(size).toBeLessThanOrEqual(64);
  } finally {
    await closeLogger(logger);
  }
});
