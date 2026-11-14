import { resolve } from 'node:path';

export type CompilerConfig = {
  uid: number;
  gid: number;
  image: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  wallTimeMs: number;
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');
  const production = env.NODE_ENV === 'production';
  function limit(
    name: string,
    developmentDefault: number,
    integer = true,
  ): number {
    const raw = env[name];
    if (production && raw === undefined)
      throw new Error(`${name} is required in production`);
    const value = raw === undefined ? developmentDefault : Number(raw);
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      (integer && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  }
  const image = env.COMPILER_IMAGE ?? 'automemorydoll-compiler:local';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image))
    throw new Error('Invalid COMPILER_IMAGE');
  const config = {
    ...requireCompilerIdentity(),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    storageRoot: resolve(env.STORAGE_ROOT ?? './data'),
    image,
    cpus: limit('COMPILER_CPUS', 1, false),
    memoryMb: limit('COMPILER_MEMORY_MB', 512),
    pids: limit('COMPILER_PIDS', 64),
    wallTimeMs: limit('COMPILER_WALL_TIME_MS', 60_000),
  };
  if (config.wallTimeMs > 2_147_423_647)
    throw new Error('Invalid COMPILER_WALL_TIME_MS');
  return config;
}

export function requireCompilerIdentity(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
    throw new Error(
      'The queue consumer must run with a non-root Unix UID and GID',
    );
  }
  return { uid, gid };
}
