import { loadEnvironment } from '../env.js';
import { closeLogger, runService, safeError } from '../logging/logger.js';
import { stdout } from 'node:process';
import { input, password } from '@inquirer/prompts';
import { createPrismaClient } from '../db/prisma.js';
import { loadConfig } from '../config.js';
import { AccountError, createOwner } from '../users/users.service.js';

loadEnvironment();

await runService('owner-cli', async (logger) => {
  const db = createPrismaClient(loadConfig(process.env).databaseUrl);
  try {
    const username = await input({ message: 'Owner username:' });
    const secret = await password({ message: 'Owner password:', mask: '*' });
    const owner = await createOwner(db, username, secret);
    logger.info('account.owner_created', {
      targetId: owner.id,
      outcome: 'success',
    });
    stdout.write(`Created owner ${owner.username}\n`);
  } catch (error) {
    logger.log(
      error instanceof AccountError ? 'warn' : 'error',
      'account.owner_created',
      {
        outcome: error instanceof AccountError ? 'rejected' : 'failed',
        ...safeError(error),
      },
    );
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
    await closeLogger(logger);
  }
});
