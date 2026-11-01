import { stdout } from 'node:process';
import { input, password } from '@inquirer/prompts';
import { createPrismaClient } from '../db/prisma.js';
import { loadConfig } from '../config.js';
import { createOwner } from '../users/users.service.js';

const db = createPrismaClient(loadConfig(process.env).databaseUrl);
try {
  const username = await input({ message: 'Owner username:' });
  const secret = await password({ message: 'Owner password:', mask: '*' });
  const owner = await createOwner(db, username, secret);
  stdout.write(`Created owner ${owner.username}\n`);
} finally {
  await db.$disconnect();
}
