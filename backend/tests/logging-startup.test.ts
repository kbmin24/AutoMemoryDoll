import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('prints the startup error stack and exits nonzero after draining logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amd-startup-'));
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            "import { runService } from './src/logging/logger.ts'; await runService('api', async () => { throw new Error('startup test failure'); });",
          ],
          {
            cwd: new URL('../', import.meta.url),
            env: { ...process.env, LOG_DIR: root },
          },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Error: startup test failure');
    expect(JSON.parse(result.stderr.trim()).stack).toMatch(/\n\s+at /);
    expect(JSON.parse(result.stderr.trim().split('\n')[0])).toMatchObject({
      event: 'service.startup_failed',
      level: 'error',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps running and reports safe JSON after a real asynchronous log-file open failure', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'amd-file-failure-'));
  try {
    await mkdir(join(root, 'api'), { mode: 0o700 });
    await mkdir(
      join(
        root,
        'api',
        `application-${new Date().toISOString().slice(0, 10)}.log`,
      ),
    );
    const result = await new Promise<{
      code: number | null;
      stderr: string;
      stdout: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import { createServiceLogger, closeLogger } from './src/logging/logger.ts';
        import { loadLoggingConfig } from './src/logging/config.ts';
        const logger = createServiceLogger('api', loadLoggingConfig(process.env));
        logger.info('service.starting');
        await new Promise(resolve => setTimeout(resolve, 50));
        logger.info('service.ready');
        await closeLogger(logger);
      `,
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: { ...process.env, LOG_DIR: root, LOG_LEVEL: 'info' },
        },
      );
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr, stdout }));
    });
    expect(result.code).toBe(0);
    expect(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'service.ready' }),
      ]),
    );
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      event: 'logging.file_failed',
      errorCode: 'filesystem',
    });
    expect(JSON.parse(result.stderr.trim()).stack).toContain('Error:');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
