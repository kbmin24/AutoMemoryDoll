import { createPrismaClient } from './db/prisma.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig(process.env);
const db = createPrismaClient(config.databaseUrl);
const app = createApp(db, { jwtSecret: config.jwtSecret, cookieHours: config.cookieHours });
const server = app.listen(config.port, () => console.log(`API listening on ${config.port}`));
process.on('SIGTERM', () => server.close(() => { void db.$disconnect(); }));
