import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createPrismaClient } from '../src/db/prisma.js';

const baseUrl = process.env.TEST_DATABASE_URL;
const schema = `task1_${randomUUID().replaceAll('-', '')}`;
let admin: Client;
let databaseUrl: string;

describe.skipIf(!baseUrl)('Prisma foundation', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(baseUrl!);
    url.searchParams.set('schema', schema);
    databaseUrl = url.toString();
    for (let i = 0; i < 2; i++) {
      execFileSync('npm', ['--workspace', 'backend', 'run', 'db:migrate:deploy'], {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
    }
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('enforces owner uniqueness, roles and job statuses', async () => {
    const db = createPrismaClient(databaseUrl);
    try {
      const owner = await db.user.create({ data: { username: 'owner', passwordHash: 'hash', role: 'owner' } });
      await expect(db.user.create({ data: { username: 'second', passwordHash: 'hash', role: 'owner' } })).rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "${schema}".users (id, username, password_hash, role) VALUES (gen_random_uuid(), 'invalid', 'hash', 'superuser')`)).rejects.toThrow();
      const template = await db.template.create({ data: { ownedBy: owner.id, name: 'Test', manifest: { version: 1, shape: null } } });
      const job = await db.generationJob.create({ data: { userId: owner.id, templateId: template.id, status: 'queued', message: 'Queued' } });
      expect(job.batchCount).toBe(1);
      await expect(db.$executeRawUnsafe(`UPDATE "${schema}".generation_jobs SET status = 'unknown' WHERE id = $1`, job.id)).rejects.toThrow();
    } finally {
      await db.$disconnect();
    }
  });

  it('has the approved owner and user/time indexes', async () => {
    const indexes = await admin.query<{ tablename: string; indexname: string; indexdef: string }>(
      'SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1', [schema],
    );
    expect(indexes.rows.some(row => row.tablename === 'templates' && row.indexdef.includes('(owned_by)'))).toBe(true);
    expect(indexes.rows.some(row => row.tablename === 'generation_jobs' && row.indexdef.includes('(user_id, "timestamp")'))).toBe(true);
    expect(indexes.rows.some(row => row.tablename === 'users' && row.indexdef.includes('WHERE (role ='))).toBe(true);
  });
});
