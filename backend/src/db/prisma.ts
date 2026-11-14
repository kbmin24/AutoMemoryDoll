import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const schemas = new WeakMap<PrismaClient, string>();

export function databaseSchema(db: PrismaClient): string {
  return schemas.get(db) ?? 'public';
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const schema = new URL(databaseUrl).searchParams.get('schema') ?? undefined;
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
  });
  schemas.set(client, schema ?? 'public');
  return client;
}
