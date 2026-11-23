import { readFile } from 'node:fs/promises';
import {
  availableParallelism,
  hostname,
  machine,
  release,
  type,
} from 'node:os';
import { parseEnv } from 'node:util';

export const dockerSnapshotKey = 'amd:compiler-container-status';
export const dockerSnapshotTtlSeconds = 15;

export type DockerStatus = {
  running: number;
  cpus: number;
  memoryMb: number;
  pids: number;
  wallTimeMs: number;
};

export async function apiSystemInformation() {
  const osRelease = await readFile('/etc/os-release', 'utf8').catch(() => '');
  return {
    hostname: hostname(),
    os: parseEnv(osRelease).PRETTY_NAME || `${type()} ${release()}`,
    cpuArchitecture: machine(),
    availableCpuThreads: availableParallelism(),
    memoryUsedBytes: process.memoryUsage.rss(),
    memoryLimitBytes: process.constrainedMemory() || null,
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  };
}
