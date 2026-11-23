import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { Redis } from 'ioredis';
import {
  dockerSnapshotKey,
  dockerSnapshotTtlSeconds,
  type DockerStatus,
} from '../system/system-information.js';
import type { CompilerConfig } from './config.js';

const executeDocker = promisify(execFile);

export async function publishDockerStatus(
  connection: Pick<Redis, 'set' | 'status'>,
  { cpus, memoryMb, pids, wallTimeMs }: CompilerConfig,
  execute: (
    file: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<{ stdout: string }> = executeDocker,
) {
  if (connection.status !== 'ready') return;
  const { stdout } = await execute(
    'docker',
    [
      'ps',
      '--filter=status=running',
      '--filter=name=^/amd-compiler-',
      '--format={{.ID}}',
    ],
    { timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
  );
  const running = stdout.trim() ? stdout.trim().split('\n').length : 0;
  const status: DockerStatus = { running, cpus, memoryMb, pids, wallTimeMs };
  if (connection.status === 'ready') {
    await connection.set(
      dockerSnapshotKey,
      JSON.stringify({ status, sampledAt: Date.now() }),
      'EX',
      dockerSnapshotTtlSeconds,
    );
  }
}
