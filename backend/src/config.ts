export type Config = {
  databaseUrl: string;
  jwtSecret: string;
  cookieHours: number;
  port: number;
  redisUrl?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
    throw new Error('JWT_SECRET must contain at least 32 characters');
  const cookieHours = Number(env.COOKIE_HOURS ?? 12);
  const port = Number(env.PORT ?? 3000);
  if (
    !Number.isFinite(cookieHours) ||
    cookieHours <= 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Invalid server configuration');
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    cookieHours,
    port,
  };
}
