export type Config = {
  databaseUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return { databaseUrl: env.DATABASE_URL };
}
