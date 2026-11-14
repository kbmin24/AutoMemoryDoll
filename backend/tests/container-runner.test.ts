import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureLogs } from './helpers/logging.js';
import {
  ContainerPdfGenerator,
  runDocker,
} from '../src/worker/container-runner.js';
import {
  loadWorkerConfig,
  requireCompilerIdentity,
} from '../src/worker/config.js';

let root: string;
beforeEach(async () => {
  vi.spyOn(process, 'getuid').mockReturnValue(2101);
  vi.spyOn(process, 'getgid').mockReturnValue(2102);
  root = await mkdtemp(join(tmpdir(), 'amd-docker-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('requires explicit resource limits in production and validates every limit', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
  };
  expect(() => loadWorkerConfig(base)).toThrow();
  const limits = {
    COMPILER_CPUS: '1',
    COMPILER_MEMORY_MB: '512',
    COMPILER_PIDS: '64',
    COMPILER_WALL_TIME_MS: '60000',
  };
  expect(loadWorkerConfig({ ...base, ...limits }).wallTimeMs).toBe(60000);
  for (const key of Object.keys(limits)) {
    for (const value of ['0', '-1', 'NaN', 'Infinity', 'abc', '']) {
      expect(() =>
        loadWorkerConfig({ ...base, ...limits, [key]: value }),
      ).toThrow();
    }
  }
});

it('launches with fixed isolation flags, resource limits and read-only input', async () => {
  const jobId = randomUUID();
  const input = join(root, 'jobs', jobId, 'input');
  const output = join(root, 'jobs', jobId, 'output');
  await mkdir(input, { recursive: true });
  await mkdir(output);
  const filename = `${randomUUID()}.pdf`;
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ result: 'ok', filename, message: 'done' }),
  );
  const commands: string[][] = [];
  const execute = async (args: string[]) => {
    commands.push(args);
    return { code: 0, stderr: '' };
  };
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    execute,
  );
  expect((await generator.generate(input, output)).result).toBe('ok');
  const args = commands[0];
  for (const flag of [
    '--runtime=runsc',
    '--read-only',
    '--cap-drop=ALL',
    '--network=none',
    '--security-opt=no-new-privileges',
    '--user=2101:2102',
    '--cpus=1',
    '--memory=512m',
    '--memory-swap=512m',
    '--pids-limit=64',
  ]) {
    expect(args).toContain(flag);
  }
  expect(args).toContain(`type=bind,source=${input},target=/input,readonly`);
  expect(args).toContain(`type=bind,source=${output},target=/output`);
  expect(args.at(-1)).toBe('compiler:test');
  expect(commands.at(-1)).toEqual(['rm', '--force', `amd-compiler-${jobId}`]);
});

it('rejects mismatched paths and comma injection in mount sources before invoking Docker', async () => {
  const execute = vi.fn();
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    execute,
  );
  await expect(
    generator.generate('/tmp/x,readonly=false/input', '/tmp/x/output'),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it('rejects success manifest when the container exited unsuccessfully', async () => {
  const id = randomUUID();
  const input = join(root, id, 'input');
  const output = join(root, id, 'output');
  await mkdir(input, { recursive: true });
  await mkdir(output);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ result: 'ok', filename: `${id}.pdf`, message: 'done' }),
  );
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    async (args) => ({ code: args[0] === 'run' ? 1 : 0, stderr: '' }),
  );
  await expect(generator.generate(input, output)).rejects.toThrow();
});

it('kills a timed-out Docker CLI and still forcibly removes the named container', async () => {
  const docker = join(root, 'docker');
  const log = join(root, 'commands');
  await writeFile(
    docker,
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$DOCKER_TEST_LOG"\nif [ "$1" = run ]; then exec sleep 10; fi\n',
  );
  await chmod(docker, 0o700);
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
  vi.stubEnv('DOCKER_TEST_LOG', log);
  const id = randomUUID();
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 100,
    },
    runDocker,
  );
  await expect(
    generator.generate(join(root, id, 'input'), join(root, id, 'output')),
  ).rejects.toThrow('timed out');
  expect(await readFile(log, 'utf8')).toBe('run\nrm\n');
});

it('stops the container before reading untrusted output', async () => {
  const id = randomUUID();
  const input = join(root, id, 'input');
  const output = join(root, id, 'output');
  await mkdir(output, { recursive: true });
  const filename = `${randomUUID()}.pdf`;
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    async (args) => {
      if (args[0] === 'rm') {
        await writeFile(
          join(output, 'result.json'),
          JSON.stringify({ result: 'ok', filename, message: 'final output' }),
        );
      }
      return { code: 0, stderr: '' };
    },
  );
  expect((await generator.generate(input, output)).result).toBe('ok');
});

it('never forwards raw diagnostics while bounding the captured error tail', async () => {
  const docker = join(root, 'docker');
  await writeFile(docker, '#!/bin/sh\nprintf "%070000d" 0 >&2\n');
  await chmod(docker, 0o700);
  vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
  const chunks: Buffer[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    chunks.push(Buffer.from(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const result = await runDocker(['run'], 1000);
    expect(result.stderr.length).toBe(64 * 1024);
    expect(Buffer.concat(chunks).length).toBe(0);
  } finally {
    write.mockRestore();
  }
});

it('uses the actual non-root service identity without requiring a fixed UID', () => {
  expect(requireCompilerIdentity()).toEqual({ uid: 2101, gid: 2102 });
  const config = loadWorkerConfig({
    DATABASE_URL: 'postgresql://localhost/test',
    REDIS_URL: 'redis://localhost',
  });
  expect(config).toMatchObject({ uid: 2101, gid: 2102 });
});

it.each([
  [0, 2102],
  [2101, 0],
  [0, 0],
])('rejects privileged worker identity %i:%i', (uid, gid) => {
  vi.mocked(process.getuid!).mockReturnValue(uid);
  vi.mocked(process.getgid!).mockReturnValue(gid);
  expect(() => requireCompilerIdentity()).toThrow('non-root');
});

it.each([125, 0])(
  'reports Docker exit code %i when no manifest was produced, without logging raw stderr',
  async (code) => {
    const id = randomUUID();
    const output = join(root, id, 'output');
    await mkdir(output, { recursive: true });
    const { logger, events } = captureLogs();
    const execute = vi.fn(async (args: string[]) => ({
      code: args[0] === 'run' ? code : 0,
      stderr: 'SECRET compiler or daemon diagnostics',
    }));
    const generator = new ContainerPdfGenerator(
      {
        uid: 2101,
        gid: 2102,
        image: 'compiler:test',
        cpus: 1,
        memoryMb: 512,
        pids: 64,
        wallTimeMs: 1000,
      },
      execute,
      logger,
    );
    await expect(
      generator.generate(join(root, id, 'input'), output),
    ).rejects.toThrow(
      `Compiler container did not produce result.json (Docker exit code: ${code})`,
    );
    expect(execute.mock.calls.at(-1)?.[0]).toEqual([
      'rm',
      '--force',
      `amd-compiler-${id}`,
    ]);
    expect(
      events.find((event) => event.message === 'compiler.failed'),
    ).toMatchObject({ jobId: id, exitCode: code, errorCode: 'compiler' });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  },
);

it('preserves a reported compilation failure when the compiler exits nonzero', async () => {
  const id = randomUUID();
  const output = join(root, id, 'output');
  await mkdir(output, { recursive: true });
  const result = {
    result: 'failed',
    filename: null,
    message: 'Compilation failed',
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(result));
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    async (args) => ({ code: args[0] === 'run' ? 1 : 0, stderr: '' }),
  );
  expect(await generator.generate(join(root, id, 'input'), output)).toEqual(
    result,
  );
});

it('uses explicit preview mode and rejects a PDF manifest for a preview', async () => {
  const id = randomUUID();
  const input = join(root, 'preview-runs', id, 'input');
  const output = join(root, 'preview-runs', id, 'output');
  await mkdir(input, { recursive: true });
  await mkdir(output);
  const execute = vi.fn(async (_args: string[]) => ({ code: 0, stderr: '' }));
  const generator = new ContainerPdfGenerator(
    {
      uid: 2101,
      gid: 2102,
      image: 'compiler:test',
      cpus: 1,
      memoryMb: 512,
      pids: 64,
      wallTimeMs: 1000,
    },
    execute,
  );
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ result: 'ok', filename: 'preview.webp', message: 'ok' }),
  );
  expect((await generator.generatePreview(input, output)).result).toBe('ok');
  expect(execute.mock.calls[0][0].slice(-4)).toEqual([
    'compiler:test',
    '/input',
    '/output',
    '--preview',
  ]);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({
      result: 'ok',
      filename: `${randomUUID()}.pdf`,
      message: 'ok',
    }),
  );
  await expect(generator.generatePreview(input, output)).rejects.toThrow();
});
