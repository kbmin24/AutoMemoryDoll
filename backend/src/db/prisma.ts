import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
}
