import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
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

describe.skipIf(!databaseUrl)('dataset management with PostgreSQL', () => {
  let db: ReturnType<typeof createPrismaClient>;
  let app: ReturnType<typeof createApp>;
  let owner: Record<string, string>;
  let other: Record<string, string>;
  let admin: Client;
  let root: string;
  let storage: FileSystemStorage;
  const queued: string[] = [];
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
    root = await mkdtemp(join(tmpdir(), 'amd-dataset-routes-'));
    storage = new FileSystemStorage(root);
    app = createApp(db, config, storage, {
      add: async (id) => queued.push(id),
    });
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

  it('lists datasets by last modification, including row edits and deletions', async () => {
    const older = await createDataset();
    const [name, , score, present] = older.columns;
    const path = '/api/datasets';
    const values = { [name.id]: 'Ada', [score.id]: 1, [present.id]: false };
    const rowsPath = `${path}/${older.id}/rows`;
    const {
      body: { row },
    } = await request(app)
      .post(rowsPath)
      .set(owner)
      .send({ values })
      .expect(201);
    const newer = await createDataset();
    const stamp = new Date('2020-01-01T00:00:00Z');
    const setOlderTimestamp = () =>
      db.dataset.update({
        where: { id: older.id },
        data: { updatedAt: stamp },
      });
    const list = async () =>
      (
        await request(app).get(path).set(owner).expect(200)
      ).body.datasets.filter(
        ({ id }: { id: string }) => id === older.id || id === newer.id,
      );

    await setOlderTimestamp();
    expect((await list()).map(({ id }: { id: string }) => id)).toEqual([
      newer.id,
      older.id,
    ]);
    await request(app)
      .patch(`${rowsPath}/${row.id}`)
      .set(owner)
      .send({ values: { ...values, [score.id]: 2 } })
      .expect(200);
    expect((await list())[0].id).toBe(older.id);

    await setOlderTimestamp();
    await request(app).delete(`${rowsPath}/${row.id}`).set(owner).expect(204);
    const [latest] = await list();
    expect(latest.id).toBe(older.id);
    expect(Date.parse(latest.updatedAt)).toBeGreaterThan(stamp.getTime());
  });

  it('limits columns on dataset creation and schema replacement', async () => {
    const columns = Array.from({ length: 101 }, (_, index) => ({
      label: `Column ${index + 1}`,
      type: 'text',
      optional: false,
    }));
    const path = '/api/datasets';
    await request(app)
      .post(path)
      .set(owner)
      .send({ name: 'Too wide', columns })
      .expect(400);
    const created = await request(app)
      .post(path)
      .set(owner)
      .send({ name: 'Wide', columns: columns.slice(0, 100) })
      .expect(201);
    await request(app)
      .patch(`${path}/${created.body.dataset.id}`)
      .set(owner)
      .send({ columns })
      .expect(400);
  });

  it('requires authentication and CSRF and scopes every operation to the owner', async () => {
    await request(app).get('/api/datasets').expect(401);
    await request(app)
      .post('/api/datasets')
      .set('Cookie', owner.Cookie)
      .expect(403);
    const dataset = await createDataset();
    const path = `/api/datasets/${dataset.id}`;
    const values = Object.fromEntries(
      ['Ada', 'A note', 4, true].map((value, index) => [
        dataset.columns[index].id,
        value,
      ]),
    );
    const {
      body: { row },
    } = await request(app)
      .post(`${path}/rows`)
      .set(owner)
      .send({ values })
      .expect(201);
    const rowPath = `${path}/rows/${row.id}`;
    const { body } = await request(app)
      .get('/api/datasets')
      .set(other)
      .expect(200);
    expect(body.datasets).toEqual([]);
    await request(app).get(path).set(other).expect(404);
    await request(app)
      .patch(path)
      .set(other)
      .send({ name: 'Other' })
      .expect(404);
    await request(app).delete(path).set(other).expect(404);
    await request(app).get(`${path}/rows`).set(other).expect(404);
    await request(app)
      .post(`${path}/rows`)
      .set(other)
      .send({ values })
      .expect(404);
    await request(app).get(rowPath).set(other).expect(404);
    await request(app).patch(rowPath).set(other).send({ values }).expect(404);
    await request(app).delete(rowPath).set(other).expect(404);
    await request(app).delete(path).set(owner).expect(204);
    await request(app).get(rowPath).set(owner).expect(404);
    expect(await db.datasetRow.count({ where: { id: row.id } })).toBe(0);
  });

  it('validates schemas and row types and preserves row data on column rename', async () => {
    const dataset = await createDataset();
    const path = `/api/datasets/${dataset.id}`;
    const [name, , score, present] = dataset.columns;
    const values = { [name.id]: 'Ada', [score.id]: 4, [present.id]: true };
    const replace = (columns: unknown) =>
      request(app).patch(path).set(owner).send({ columns });
    await replace([{ ...name }, { ...score, label: name.label }]).expect(400);
    await replace([{ ...name, type: 'list' }]).expect(400);
    await request(app)
      .post(`${path}/rows`)
      .set(owner)
      .send({ values: { ...values, [score.id]: '4' } })
      .expect(400);
    await request(app)
      .post(`${path}/rows`)
      .set(owner)
      .send({ values: { ...values, unknown: true } })
      .expect(400);
    const {
      body: { row },
    } = await request(app)
      .post(`${path}/rows`)
      .set(owner)
      .send({ values })
      .expect(201);
    await replace([
      { ...name, type: 'number' },
      ...dataset.columns.slice(1),
    ]).expect(409);
    const renamed = await replace([
      { ...name, label: 'Full name' },
      ...dataset.columns.slice(1),
    ]).expect(200);
    expect(renamed.body.dataset.columns[0]).toEqual({
      ...name,
      label: 'Full name',
    });
    const rowPath = `${path}/rows/${row.id}`;
    expect(
      (await request(app).get(rowPath).set(owner).expect(200)).body.row.values,
    ).toEqual(values);
    const replacement = { ...values, [score.id]: 5 };
    expect(
      (
        await request(app)
          .patch(rowPath)
          .set(owner)
          .send({ values: replacement })
          .expect(200)
      ).body.row.values,
    ).toEqual(replacement);
    await request(app).delete(rowPath).set(owner).expect(204);
    await request(app).get(rowPath).set(owner).expect(404);
  });

  it('serializes overlapping appends and pages rows in position order', async () => {
    const dataset = await createDataset();
    const [name, , score, present] = dataset.columns;
    const path = `/api/datasets/${dataset.id}/rows`;
    const created = await Promise.all(
      [1, 2, 3].map((value) =>
        request(app)
          .post(path)
          .set(owner)
          .send({
            values: { [name.id]: 'Ada', [score.id]: value, [present.id]: true },
          })
          .expect(201),
      ),
    );
    const positions = created
      .map(({ body }) => body.row.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3]);
    const first = await request(app)
      .get(path)
      .set(owner)
      .query({ limit: 2 })
      .expect(200);
    expect(
      first.body.rows.map((row: { position: number }) => row.position),
    ).toEqual([1, 2]);
    const last = await request(app)
      .get(path)
      .set(owner)
      .query({ limit: 2, after: first.body.nextAfter })
      .expect(200);
    expect(
      last.body.rows.map((row: { position: number }) => row.position),
    ).toEqual([3]);
    expect(last.body.nextAfter).toBeNull();
    await request(app)
      .delete(`${path}/${last.body.rows[0].id}`)
      .set(owner)
      .expect(204);
    const appended = await request(app)
      .post(path)
      .set(owner)
      .send({
        values: { [name.id]: 'Ada', [score.id]: 4, [present.id]: false },
      })
      .expect(201);
    expect(appended.body.row.position).toBe(4);
  });
  it('resolves owned rows in JSON and multipart submissions and snapshots the selection', async () => {
    const dataset = await createDataset();
    const [name, , score, present] = dataset.columns;
    const rowsPath = `/api/datasets/${dataset.id}/rows`;
    const dataFor = (number: number) => ({
      [name.id]: `Row ${number}`,
      [score.id]: number,
      [present.id]: true,
    });
    const rows = [];
    for (let number = 1; number <= 4; number++) {
      rows.push(
        (
          await request(app)
            .post(rowsPath)
            .set(owner)
            .send({ values: dataFor(number) })
            .expect(201)
        ).body.row,
      );
    }
    await request(app)
      .delete(`${rowsPath}/${rows[1].id}`)
      .set(owner)
      .expect(204);

    const manifest = {
      version: 1,
      shape: {
        fields: [
          {
            type: 'object-list',
            variable: 'students',
            label: 'Students',
            optional: false,
            properties: [
              {
                type: 'text',
                variable: 'name',
                label: 'Name',
                optional: false,
              },
              {
                type: 'number',
                variable: 'score',
                label: 'Score',
                optional: true,
              },
            ],
          },
        ],
      },
    };
    const makeTemplate = async (headers: Record<string, string>) => {
      const created = await request(app)
        .post('/api/templates')
        .set(headers)
        .send({ name: 'Roster', manifest })
        .expect(201);
      const { id } = created.body.template;
      await storage.writeText(id, ['template.tex'], 'Hello');
      return `/api/templates/${id}/generations`;
    };
    const path = await makeTemplate(owner);
    const binding = {
      field: 'students',
      datasetId: dataset.id,
      mode: 'first',
      count: 2,
      columns: { name: name.id, score: score.id },
    };

    const queuedBefore = queued.length;
    await request(app)
      .post(path)
      .set(owner)
      .send({
        data: {},
        bindings: [{ ...binding, columns: { name: score.id } }],
      })
      .expect(400);
    await request(app)
      .post(path)
      .set(owner)
      .send({ data: { students: [] }, bindings: [binding] })
      .expect(400);
    await request(app)
      .post(await makeTemplate(other))
      .set(other)
      .send({ data: {}, bindings: [binding] })
      .expect(404);
    expect(queued).toHaveLength(queuedBefore);
    expect(await db.generationJob.count()).toBe(queuedBefore);

    const first = await request(app)
      .post(path)
      .set(owner)
      .send({ data: {}, bindings: [binding] })
      .expect(201);
    const last = await request(app)
      .post(path)
      .set(owner)
      .field('data', '{}')
      .field('bindings', JSON.stringify([{ ...binding, mode: 'last' }]))
      .expect(201);
    const random = await request(app)
      .post(path)
      .set(owner)
      .send({ data: {}, bindings: [{ ...binding, mode: 'random' }] })
      .expect(201);
    const { count: _count, ...selection } = binding;
    const all = await request(app)
      .post(path)
      .set(owner)
      .send({ data: {}, bindings: [{ ...selection, mode: 'all' }] })
      .expect(201);
    const snapshot = async (id: string) =>
      JSON.parse(
        await readFile(join(root, 'jobs', id, 'input', 'data.json'), 'utf8'),
      ).students;
    await request(app)
      .patch(`${rowsPath}/${rows[0].id}`)
      .set(owner)
      .send({ values: dataFor(9) })
      .expect(200);
    expect(await snapshot(first.body.job.id)).toEqual([
      { name: 'Row 1', score: 1 },
      { name: 'Row 3', score: 3 },
    ]);
    expect(await snapshot(last.body.job.id)).toEqual([
      { name: 'Row 3', score: 3 },
      { name: 'Row 4', score: 4 },
    ]);
    expect(await snapshot(all.body.job.id)).toEqual([
      { name: 'Row 1', score: 1 },
      { name: 'Row 3', score: 3 },
      { name: 'Row 4', score: 4 },
    ]);
    const selected = (await snapshot(random.body.job.id)).map(
      (row: { score: number }) => row.score,
    );
    expect([
      [1, 3],
      [1, 4],
      [3, 4],
    ]).toContainEqual(selected);
    expect(queued.slice(queuedBefore)).toEqual([
      first.body.job.id,
      last.body.job.id,
      random.body.job.id,
      all.body.job.id,
    ]);
  });
});
