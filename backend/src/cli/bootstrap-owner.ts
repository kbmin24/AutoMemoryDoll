import { pathToFileURL } from 'node:url';
import { loadEnvironment } from '../env.js';
import { createPrismaClient } from '../db/prisma.js';
import { closeLogger, runService } from '../logging/logger.js';
import type { Database } from '../users/users.repository.js';
import { createOwner } from '../users/users.service.js';

export async function bootstrapOwner(db: Database, env: NodeJS.ProcessEnv) {
  if (await db.user.findFirst({ where: { role: 'owner' } })) return null;
  if (!env.OWNER_USERNAME || !env.OWNER_PASSWORD) {
    throw new Error(
      'Set OWNER_USERNAME and OWNER_PASSWORD for initial deployment',
    );
  }
  return createOwner(db, env.OWNER_USERNAME, env.OWNER_PASSWORD);
}

async function main() {
  loadEnvironment();
  await runService('owner-cli', async (logger) => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const db = createPrismaClient(process.env.DATABASE_URL);
    try {
      const owner = await bootstrapOwner(db, process.env);
      if (owner) {
        logger.info('account.owner_created', {
          targetId: owner.id,
          outcome: 'success',
        });
      }
    } finally {
      await db.$disconnect();
      await closeLogger(logger);
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
