import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { cookieName, issueSession } from '../src/auth/auth.service.js';
import { createPrismaClient } from '../src/db/prisma.js';

const config = {
  jwtSecret: 'dataset-integration-tests-secret',
  cookieHours: 1,
};
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('dataset CSV import with PostgreSQL', () => {
  let db: ReturnType<typeof createPrismaClient>;
  let app: ReturnType<typeof createApp>;
  let owner: Record<string, string>;
  let other: Record<string, string>;
  let admin: Client;
  let root: string;
  let storage: FileSystemStorage;
  const schema = `datasets_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const url = new URL(databaseUrl!);
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
    root = await mkdtemp(join(tmpdir(), 'amd-dataset-import-'));
    storage = new FileSystemStorage(root);
    app = createApp(db, config, storage);
    async function headers(username: string) {
      const user = await db.user.create({
        data: { username, displayId: username, passwordHash: 'unused' },
      });
      const session = await issueSession(config, user);
      return {
        Cookie: `${cookieName}=${session.token}`,
        'X-CSRF-Token': session.csrfToken,
      };
    }
    owner = await headers('dataset-owner');
    other = await headers('dataset-other');
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  async function createDataset() {
    const { body } = await request(app)
      .post('/api/datasets')
      .set(owner)
      .send({
        name: 'Roster',
        columns: [
          { label: 'Name', type: 'text', optional: false },
          { label: 'Notes', type: 'longtext', optional: true },
          { label: 'Score', type: 'number', optional: false },
          { label: 'Present', type: 'boolean', optional: false },
        ],
      })
      .expect(201);
    return body.dataset;
  }

  function upload(id: string, csv: string | Buffer, headers = owner) {
    return request(app)
      .post(`/api/datasets/${id}/import`)
      .set(headers)
      .attach('file', Buffer.from(csv), 'rows.csv');
  }

  const header = 'Name,Notes,Score,Present\n';

  async function expectEmptyStaging() {
    expect(await readdir(await storage.uploadStagingDirectory())).toEqual([]);
  }

  it('appends typed rows in CSV order and preserves quoted text', async () => {
    const dataset = await createDataset();
    const [name, notes, score, present] = dataset.columns;
    const initial = {
      [name.id]: 'Existing',
      [score.id]: 1,
      [present.id]: true,
    };
    await request(app)
      .post(`/api/datasets/${dataset.id}/rows`)
      .set(owner)
      .send({ values: initial })
      .expect(201);

    const result = await upload(
      dataset.id,
      '\uFEFFPresent,Notes,Name,Score\r\n' +
        ' TRUE ," line 1\r\nline 2 ""quote"" ","Ada, Jr.",1\r\n' +
        'false,,, -2.5e1 \r\n',
    ).expect(201);
    expect(result.body).toEqual({ imported: 2 });
    const rows = await db.datasetRow.findMany({
      where: { datasetId: dataset.id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map(({ position, values }) => ({ position, values }))).toEqual([
      { position: 1, values: initial },
      {
        position: 2,
        values: {
          [name.id]: 'Ada, Jr.',
          [notes.id]: ' line 1\r\nline 2 "quote" ',
          [score.id]: 1,
          [present.id]: true,
        },
      },
      {
        position: 3,
        values: { [name.id]: '', [score.id]: -25, [present.id]: false },
      },
    ]);
    await expectEmptyStaging();
  });

  it('rejects malformed or invalid imports atomically and omits cell contents from errors', async () => {
    const { id } = await createDataset();
    const cases = [
      {
        csv: header + 'Ada,,1,true\nBob,,private-value,false\n',
        error: /row 2.*column 3/i,
      },
      { csv: header + 'Ada,,1,true\nBob,,2,\n', error: /row 2.*column 4/i },
      {
        csv: 'Name,Name,Score,Present\nAda,,1,true\n',
        error: /header.*column 2/i,
      },
      { csv: 'Name,Notes,Score\nAda,,1\n', error: /header/i },
      { csv: header + '"missing quote,,1,true', error: /row 1.*column 1/i },
    ];
    for (const { csv, error } of cases) {
      const result = await upload(id, csv).expect(400);
      expect(result.body.error).toMatch(error);
      expect(result.body.error).not.toContain('private-value');
      expect(await db.datasetRow.count({ where: { datasetId: id } })).toBe(0);
      await expectEmptyStaging();
    }
  });

  it('enforces ownership and the file, row, and column limits', async () => {
    const { id } = await createDataset();
    await upload(id, header + 'Ada,,1,true\n', other).expect(404);
    await upload(id, Buffer.alloc(5 * 1024 * 1024 + 1, 'a')).expect(400);
    await upload(id, header + 'Ada,,1,true\n'.repeat(1001)).expect(400);
    await upload(
      id,
      Array.from({ length: 101 }, (_, i) => `C${i}`).join(','),
    ).expect(400);
    expect(await db.datasetRow.count({ where: { datasetId: id } })).toBe(0);
    const accepted = await upload(
      id,
      header + 'Ada,,1,true\n'.repeat(999),
    ).expect(201);
    expect(accepted.body).toEqual({ imported: 999 });
    await upload(id, header + 'Ada,,1,true\n'.repeat(2)).expect(409);
    expect(await db.datasetRow.count({ where: { datasetId: id } })).toBe(999);

    const dataset = await db.dataset.findUniqueOrThrow({ where: { id } });
    const [name, , score, present] = dataset.columns as { id: string }[];
    const values = { [name.id]: 'Ada', [score.id]: 1, [present.id]: true };
    const manual = () =>
      request(app).post(`/api/datasets/${id}/rows`).set(owner).send({ values });
    const outcomes = await Promise.all([
      manual(),
      upload(id, header + 'Ada,,1,true\n'),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([201, 409]);
    await manual().expect(409);
    expect(await db.datasetRow.count({ where: { datasetId: id } })).toBe(1000);
    const last = await db.datasetRow.findFirstOrThrow({
      where: { datasetId: id },
      orderBy: { position: 'desc' },
    });
    await request(app)
      .delete(`/api/datasets/${id}/rows/${last.id}`)
      .set(owner)
      .expect(204);
    await manual().expect(201);
    await expectEmptyStaging();
  });
});
