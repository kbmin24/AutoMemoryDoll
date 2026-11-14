import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const backend = fileURLToPath(new URL('../', import.meta.url));
const launcher = join(backend, 'scripts/run-service.sh');
let root: string;
let capture: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-service-scripts-'));
  capture = join(root, 'capture');
  const scripts: Record<string, string> = {
    id: 'case "$3" in root) echo 0;; automemorydoll) if [ "$1" = -u ]; then echo 2101; else echo 2102; fi;; *) exit 1;; esac',
    stat: 'echo 989',
    getent:
      'printf "automemorydoll:x:2101:2102::/home/automemorydoll:/usr/sbin/nologin\\n"',
    sudo: '[ "$1" != -- ] || shift\nexec "$@"',
    setpriv: 'printf "%s\\n" "$PWD" "$@" > "$SERVICE_TEST_CAPTURE"',
    node: 'printf "%s\\n" "$PWD" "$@" > "$SERVICE_TEST_CAPTURE"',
  };
  for (const [name, source] of Object.entries(scripts)) {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${source}\n`);
    await chmod(path, 0o700);
  }
  env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    npm_node_execpath: join(root, 'node'),
    SERVICE_TEST_CAPTURE: capture,
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(['api', 'worker'])(
  'runs %s as the named account with only the necessary groups',
  async (service) => {
    execFileSync('bash', [launcher, service, 'automemorydoll'], { env });
    const args = (await readFile(capture, 'utf8')).trim().split('\n');
    expect(args[0]).toBe(backend.replace(/\/$/, ''));
    expect(args).toContain('--reuid=2101');
    expect(args).toContain('--regid=2102');
    expect(args).toContain('HOME=/home/automemorydoll');
    expect(args).toContain(
      service === 'api' ? '--clear-groups' : '--groups=989',
    );
    expect(args.at(-1)).toBe(
      service === 'api' ? 'src/server.ts' : 'src/worker/main.ts',
    );
  },
);

it('preserves current-user startup when no username is provided', async () => {
  execFileSync('bash', [launcher, 'api'], { env });
  expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
    backend.replace(/\/$/, ''),
    '--import',
    'tsx',
    'src/server.ts',
  ]);
});

it.each([
  ['api', 'root'],
  ['worker', 'missing'],
  ['invalid', 'automemorydoll'],
  ['api', 'automemorydoll', 'extra'],
])('rejects invalid invocation %j', (...args) => {
  expect(() =>
    execFileSync('bash', [launcher, ...args], { env, stdio: 'pipe' }),
  ).toThrow();
});

it.each([
  ['dev:backend', 'src/server.ts'],
  ['worker', 'src/worker/main.ts'],
  ['previews:backfill', 'src/cli/backfill-previews.ts'],
])('forwards the username through npm run %s', async (command, entry) => {
  await rm(join(root, 'node'));
  execFileSync(
    process.execPath,
    [process.env.npm_execpath!, 'run', command, '--', 'automemorydoll'],
    { cwd: dirname(backend.replace(/\/$/, '')), env, stdio: 'pipe' },
  );
  const args = (await readFile(capture, 'utf8')).trim().split('\n');
  expect(args).toContain('--reuid=2101');
  expect(args.at(-1)).toBe(entry);
});

it('runs preview backfill as the service identity without Docker supplementary groups', async () => {
  execFileSync('bash', [launcher, 'preview-backfill', 'automemorydoll'], {
    env,
  });
  const args = (await readFile(capture, 'utf8')).trim().split('\n');
  expect(args).toContain('--clear-groups');
  expect(args).toContain('--reuid=2101');
  expect(args.at(-1)).toBe('src/cli/backfill-previews.ts');
});
