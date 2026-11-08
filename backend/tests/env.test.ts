import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amd-env-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function readEnvironment(exported?: string) {
  const env = { ...process.env };
  delete env.AMD_ENV_TEST_VALUE;
  delete env.AMD_ENV_TEST_BASE;
  if (exported !== undefined) env.AMD_ENV_TEST_VALUE = exported;
  const loader = new URL('../src/env.ts', import.meta.url).href;
  const script = `
    const { loadEnvironment } = await import(${JSON.stringify(loader)});
    loadEnvironment(${JSON.stringify(directory)});
    console.log(JSON.stringify({
      value: process.env.AMD_ENV_TEST_VALUE,
      base: process.env.AMD_ENV_TEST_BASE,
    }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        env,
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: new URL('../../', import.meta.url),
      },
    ),
  );
}

it('loads .env defaults and lets .env.local override them', async () => {
  await writeFile(
    join(directory, '.env'),
    'AMD_ENV_TEST_VALUE=base\nAMD_ENV_TEST_BASE="quoted value"\n',
  );
  await writeFile(join(directory, '.env.local'), 'AMD_ENV_TEST_VALUE=local\n');
  expect(readEnvironment()).toEqual({ value: 'local', base: 'quoted value' });
});

it('preserves exported variables even when empty', async () => {
  await writeFile(join(directory, '.env'), 'AMD_ENV_TEST_VALUE=base\n');
  await writeFile(join(directory, '.env.local'), 'AMD_ENV_TEST_VALUE=local\n');
  expect(readEnvironment('exported').value).toBe('exported');
  expect(readEnvironment('').value).toBe('');
});

it('allows either file or both files to be absent', async () => {
  expect(readEnvironment()).toEqual({});
  await writeFile(join(directory, '.env'), 'AMD_ENV_TEST_VALUE=base\n');
  expect(readEnvironment().value).toBe('base');
  await rm(join(directory, '.env'));
  await writeFile(join(directory, '.env.local'), 'AMD_ENV_TEST_VALUE=local\n');
  expect(readEnvironment().value).toBe('local');
});

it('does not silently ignore a file loading error other than absence', async () => {
  await mkdir(join(directory, '.env.local'));
  expect(() => readEnvironment()).toThrow();
});
