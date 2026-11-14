import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/templates/shape.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { createRegularUser } from '../src/users/users.service.js';
import {
  createTemplate,
  getTemplate,
  softDeleteTemplate,
  updateTemplate,
} from '../src/templates/templates.service.js';

describe('template manifest', () => {
  const field = {
    variable: 'student_name',
    label: 'Student name',
    type: 'text',
    optional: false,
  };

  it('accepts ordered version-one fields and JSON mode', () => {
    expect(validateManifest({ version: 1, shape: null })).toEqual({
      version: 1,
      shape: null,
    });
    expect(
      validateManifest({
        version: 1,
        shape: {
          fields: [
            field,
            {
              variable: 'score',
              label: 'Score',
              type: 'number',
              optional: true,
            },
            {
              variable: 'notes',
              label: 'Notes',
              type: 'longtext',
              optional: true,
            },
            {
              variable: 'passed',
              label: 'Passed',
              type: 'boolean',
              optional: false,
            },
          ],
        },
      }).shape?.fields.map((item) => item.variable),
    ).toEqual(['student_name', 'score', 'notes', 'passed']);
  });

  it('requires an explicit shape choice and at least one field when enabled', () => {
    for (const input of [
      undefined,
      {},
      { version: 2, shape: null },
      { version: 1, shape: { fields: [] } },
    ]) {
      expect(() => validateManifest(input)).toThrow();
    }
  });

  it('rejects malformed, duplicate, and unexpected fields', () => {
    for (const fields of [
      [field, field],
      [{ ...field, variable: 'bad.name' }],
      [{ ...field, variable: '1bad' }],
      [{ ...field, label: '   ' }],
      [{ ...field, type: 'date' }],
      [{ ...field, optional: 'false' }],
      [{ ...field, extra: true }],
    ]) {
      expect(() =>
        validateManifest({ version: 1, shape: { fields } }),
      ).toThrow();
    }
    expect(() =>
      validateManifest({ version: 1, shape: null, extra: true }),
    ).toThrow();
  });
});

const baseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!baseUrl)('template persistence with PostgreSQL', () => {
  const schema = `templates_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let db: ReturnType<typeof createPrismaClient>;
  let root: string;

  it('persists private metadata and retains soft-deleted rows', async () => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(baseUrl!);
    url.searchParams.set('schema', schema);
    execFileSync(
      'npm',
      ['--workspace', 'backend', 'run', 'db:migrate:deploy'],
      {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
      },
    );
    db = createPrismaClient(url.toString());
    root = await mkdtemp(join(tmpdir(), 'amd-template-db-'));
    try {
      const storage = new FileSystemStorage(root);
      const owner = await createRegularUser(
        db,
        `owner_${randomUUID()}`,
        'owner-password-123456',
      );
      const stranger = await createRegularUser(
        db,
        `stranger_${randomUUID()}`,
        'stranger-password-123456',
      );
      const created = await createTemplate(db, storage, owner.id, 'Letter', {
        version: 1,
        shape: null,
      });
      const app = createApp(
        db,
        {
          jwtSecret: 'test-secret-at-least-32-characters-long',
          cookieHours: 12,
        },
        storage,
      );
      const ownerLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: owner.username, password: 'owner-password-123456' });
      const strangerLogin = await request(app).post('/api/auth/login').send({
        username: stranger.username,
        password: 'stranger-password-123456',
      });
      const ownerCookie = ownerLogin.headers['set-cookie'][0];
      const strangerCookie = strangerLogin.headers['set-cookie'][0];
      expect(
        (
          await request(app)
            .get(`/api/templates/${created.id}`)
            .set('Cookie', strangerCookie)
        ).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .patch(`/api/templates/${created.id}`)
            .set('Cookie', ownerCookie)
            .send({ name: 'Without CSRF' })
        ).status,
      ).toBe(403);
      await expect(
        getTemplate(db, stranger.id, created.id),
      ).rejects.toMatchObject({ status: 404 });
      const changed = await updateTemplate(db, storage, owner.id, created.id, {
        name: 'Contract',
      });
      expect(changed.name).toBe('Contract');
      await softDeleteTemplate(db, storage, owner.id, created.id);
      await expect(getTemplate(db, owner.id, created.id)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(
        (await db.template.findUnique({ where: { id: created.id } }))
          ?.deletedAt,
      ).not.toBeNull();
    } finally {
      await db.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
