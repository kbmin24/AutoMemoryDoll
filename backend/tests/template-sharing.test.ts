import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import { cookieName, issueSession } from '../src/auth/auth.service.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { createTemplate } from '../src/templates/templates.service.js';
import { JobProcessor } from '../src/worker/jobs.worker.js';
import {
  PdfGenerator,
  type CompilerResult,
} from '../src/worker/pdf-generator.js';

const baseUrl = process.env.TEST_DATABASE_URL;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!baseUrl)('template sharing with PostgreSQL', () => {
  const schema = `sharing_${randomUUID().replaceAll('-', '')}`;
  const config = {
    jwtSecret: 'test-secret-at-least-32-characters-long',
    cookieHours: 12,
  };
  let admin: Client | undefined;
  let db: ReturnType<typeof createPrismaClient> | undefined;
  let root: string | undefined;
  let app: ReturnType<typeof createApp>;
  let storage: FileSystemStorage;
  let shares: string;
  let ownerId: string;
  let recipient: { id: string; username: string };
  let ownerHeaders: Record<string, string>;
  let recipientHeaders: Record<string, string>;
  let strangerHeaders: Record<string, string>;
  const queue = { add: vi.fn(async (_jobId: string) => undefined) };

  beforeAll(async () => {
    admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(baseUrl!);
    url.searchParams.set('schema', schema);
    execFileSync('npm', ['run', 'db:migrate:deploy', '-w', 'backend'], {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
    });

    const database = createPrismaClient(url.toString());
    db = database;
    root = await mkdtemp(join(tmpdir(), 'amd-sharing-'));
    storage = new FileSystemStorage(root);
    app = createApp(database, config, storage, queue);

    const createAccount = (username: string, disabled = false) =>
      database.user.create({
        data: {
          username,
          displayId: username,
          passwordHash: 'unused',
          disabled,
        },
      });
    const owner = await createAccount('TemplateOwner');
    ownerId = owner.id;
    const invited = await createAccount('RecipientName');
    recipient = { id: invited.id, username: invited.username };
    await createAccount('DisabledAccount', true);

    const template = await database.template.create({
      data: {
        ownedBy: owner.id,
        name: 'Letter',
        manifest: { version: 1, shape: null },
      },
    });
    shares = `/api/templates/${template.id}/shares`;

    const headersFor = async (user: Parameters<typeof issueSession>[1]) => {
      const session = await issueSession(config, user);
      return {
        Cookie: `${cookieName}=${session.token}`,
        'X-CSRF-Token': session.csrfToken,
      };
    };
    ownerHeaders = await headersFor(owner);
    recipientHeaders = await headersFor(invited);
    strangerHeaders = await headersFor(
      await createAccount('UnrelatedAccount'),
    );
  }, 30_000);

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('grants and revokes access idempotently for the template owner', async () => {
    const list = () => request(app).get(shares).set(ownerHeaders);
    const invite = () =>
      request(app).post(shares).set(ownerHeaders).send({
        username: recipient.username,
      });
    const revoke = () =>
      request(app).delete(`${shares}/${recipient.id}`).set(ownerHeaders);

    await list().expect(200, { recipients: [] });
    await Promise.all([
      invite().expect(200, recipient),
      invite().expect(200, recipient),
    ]);
    await list().expect(200, { recipients: [recipient] });
    await revoke().expect(204);
    await revoke().expect(204);
    await list().expect(200, { recipients: [] });
  });

  it('requires ownership and CSRF and validates exact usernames', async () => {
    const invite = (username: string) =>
      request(app).post(shares).set(ownerHeaders).send({ username });

    await request(app).get(shares).expect(401);
    await request(app).get(shares).set(recipientHeaders).expect(404);
    await request(app)
      .post(shares)
      .set(recipientHeaders)
      .send({ username: recipient.username })
      .expect(404);
    await request(app)
      .delete(`${shares}/${recipient.id}`)
      .set(recipientHeaders)
      .expect(404);
    await request(app)
      .post(shares)
      .set('Cookie', ownerHeaders.Cookie)
      .send({ username: recipient.username })
      .expect(403);
    await request(app)
      .delete(`${shares}/${recipient.id}`)
      .set('Cookie', ownerHeaders.Cookie)
      .expect(403);
    await invite('TemplateOwner').expect(400);
    await invite('recipientname').expect(404);
    await invite('DisabledAccount').expect(404);
    await invite('MissingAccount').expect(404);
    await invite('bad name').expect(400);
    expect((await request(app).get(shares).set(ownerHeaders)).body).toEqual({
      recipients: [],
    });
  });

  it('exposes generation metadata only for live templates the caller can use', async () => {
    const shape = {
      fields: [
        { variable: 'name', label: 'Name', type: 'text', optional: false },
      ],
    };
    const template = await createTemplate(
      db!,
      storage,
      ownerId,
      'Shared letter',
      {
        version: 1,
        shape,
      },
    );
    await storage.writeText(template.id, ['template.tex'], '@resource(logo)');
    const base = `/api/templates/${template.id}`;
    const shared = '/api/templates';
    const metadata = `${base}/view`;
    const resources = () =>
      request(app).get(`${base}/resources`).set(recipientHeaders);
    const discover = () => request(app).get(shared).set(recipientHeaders);
    const view = () => request(app).post(metadata).set(recipientHeaders);
    const invite = () =>
      request(app).post(`${base}/shares`).set(ownerHeaders).send({
        username: recipient.username,
      });

    await request(app).get(shared).expect(401);
    await request(app).post(metadata).expect(401);
    await discover().expect(200, { templates: [], sharedTemplates: [] });
    await view().expect(404);
    await resources().expect(404);
    await invite().expect(200);
    await discover().expect(200, {
      templates: [],
      sharedTemplates: [{ id: template.id, name: template.name }],
    });
    await request(app)
      .get(shared)
      .set(ownerHeaders)
      .expect(200)
      .expect(({ body }) => {
        expect(body.sharedTemplates).toEqual([]);
      });
    await request(app)
      .post(metadata)
      .set('Cookie', recipientHeaders.Cookie)
      .expect(403);

    const projection = { template };
    await resources()
      .expect('Cache-Control', 'private, no-store')
      .expect(200, { aliases: ['logo'] });
    await view()
      .expect('Cache-Control', 'private, no-store')
      .expect(200, projection);
    await request(app)
      .post(metadata)
      .set(ownerHeaders)
      .expect(200, projection);
    const views = await db!.templateViewedAt.findMany({
      where: { templateId: template.id },
    });
    expect(views.map(({ userId }) => userId).sort()).toEqual(
      [ownerId, recipient.id].sort(),
    );

    for (const path of ['', '/files']) {
      await request(app)
        .get(base + path)
        .set(recipientHeaders)
        .expect(404);
    }
    await request(app)
      .patch(base)
      .set(recipientHeaders)
      .send({ name: 'Changed' })
      .expect(404);
    await request(app).delete(base).set(recipientHeaders).expect(404);
    await request(app)
      .post(`${base}/ai/draft`)
      .set(recipientHeaders)
      .send({
        description: 'Draft a letter',
        pageSize: 'A4',
        orientation: 'portrait',
      })
      .expect(404);

    await request(app)
      .delete(`${base}/shares/${recipient.id}`)
      .set(ownerHeaders)
      .expect(204);
    await view().expect(404);
    await resources().expect(404);
    await discover().expect(200, { templates: [], sharedTemplates: [] });
    await invite().expect(200);
    await request(app).delete(base).set(ownerHeaders).expect(204);
    await view().expect(404);
    await resources().expect(404);
    await discover().expect(200, { templates: [], sharedTemplates: [] });
  });

  it('serves the published sample preview to invited accounts until revocation', async () => {
    const template = await createTemplate(
      db!,
      storage,
      ownerId,
      'Preview letter',
      {
        version: 1,
        shape: null,
      },
    );
    const base = `/api/templates/${template.id}`;
    const preview = () =>
      request(app).get(`${base}/preview`).set(recipientHeaders);
    const runId = randomUUID();
    const image = Buffer.from('RIFF1234WEBPimage');
    await storage.snapshotPreview(template.id, runId);
    const { output } = await storage.preparePreviewOutput(runId);
    await writeFile(join(output, 'preview.webp'), image);
    await storage.publishPreview(template.id, runId);

    await preview().expect(404);
    await request(app)
      .post(`${base}/shares`)
      .set(ownerHeaders)
      .send({ username: recipient.username })
      .expect(200);
    const result = await preview()
      .expect('Content-Type', 'image/webp')
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(result.body).toEqual(image);
    await request(app)
      .get(`${base}/preview`)
      .set(strangerHeaders)
      .expect(404);
    await request(app)
      .delete(`${base}/shares/${recipient.id}`)
      .set(ownerHeaders)
      .expect(204);
    await preview().expect(404);
  });

  async function shareForGeneration(shape: unknown = null) {
    const template = await createTemplate(
      db!,
      storage,
      ownerId,
      'Job letter',
      {
        version: 1,
        shape,
      },
    );
    await storage.writeText(template.id, ['template.tex'], '@resource(logo)');
    const base = `/api/templates/${template.id}`;
    await request(app)
      .post(`${base}/shares`)
      .set(ownerHeaders)
      .send({ username: recipient.username })
      .expect(200);
    return {
      submit: (headers = recipientHeaders) =>
        request(app)
          .post(`${base}/generations`)
          .set(headers)
          .field('data', '{}'),
      revoke: () =>
        request(app)
          .delete(`${base}/shares/${recipient.id}`)
          .set(ownerHeaders)
          .expect(204),
    };
  }

  it('submits with recipient-owned bindings and keeps PDFs and diagnostics private to the submitter', async () => {
    const property = {
      variable: 'name',
      label: 'Name',
      type: 'text',
      optional: false,
    };
    const { submit } = await shareForGeneration({
      fields: [
        {
          variable: 'people',
          label: 'People',
          type: 'object-list',
          optional: false,
          properties: [property],
        },
      ],
    });
    const staging = vi.spyOn(storage, 'uploadStagingDirectory');
    await submit(strangerHeaders)
      .attach('logo', Buffer.from('logo'), 'logo.png')
      .expect(404);
    expect(staging).not.toHaveBeenCalled();

    const column = {
      id: randomUUID(),
      label: 'Name',
      type: 'text',
      optional: false,
    };
    const datasetFor = (ownedBy: string) =>
      db!.dataset.create({
        data: {
          ownedBy,
          name: 'People',
          columns: [column],
          rowCount: 1,
          lastPosition: 1,
          rows: {
            create: {
              position: 1,
              rank: 'a0',
              values: { [column.id]: 'Ada' },
            },
          },
        },
      });
    const submitWithDataset = (datasetId: string) =>
      submit()
        .field(
          'bindings',
          JSON.stringify([
            {
              field: 'people',
              datasetId,
              mode: 'all',
              columns: { name: column.id },
            },
          ]),
        )
        .attach('logo', Buffer.from('logo'), 'logo.png');
    await submitWithDataset((await datasetFor(ownerId)).id).expect(404);
    const dataset = await datasetFor(recipient.id);
    const {
      body: { job },
    } = await submitWithDataset(dataset.id).expect(201);
    expect(queue.add).toHaveBeenCalledWith(job.id);
    expect(
      await db!.generationJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ userId: recipient.id });
    expect(
      await readFile(
        join(root!, 'jobs', job.id, 'input', 'data.json'),
        'utf8',
      ),
    ).toBe(JSON.stringify({ people: [{ name: 'Ada' }] }));

    const filename = `${randomUUID()}.pdf`;
    class TestGenerator extends PdfGenerator {
      generate = vi.fn(
        async (_input: string, output: string): Promise<CompilerResult> => {
          await writeFile(join(output, filename), '%PDF-1.7\nexample');
          return { result: 'ok', filename, message: 'ok' };
        },
      );
      async generatePreview(): Promise<never> {
        throw new Error('Unexpected preview');
      }
      async stop() {}
    }
    const generator = new TestGenerator();
    const processor = new JobProcessor(db!, storage, generator, 1000);
    await processor.processJob(job.id);
    const path = `/api/jobs/${job.id}`;
    await request(app).get(`${path}/pdf`).set(recipientHeaders).expect(200);
    await request(app).get(`${path}/pdf`).set(ownerHeaders).expect(404);

    const {
      body: { job: failed },
    } = await submitWithDataset(dataset.id).expect(201);
    const diagnostic = 'Compiler reported details for the template';
    generator.generate.mockResolvedValueOnce({
      result: 'failed',
      filename: null,
      stage: 'latex',
      message: diagnostic,
    });
    await processor.processJob(failed.id);
    const failedPath = `/api/jobs/${failed.id}`;
    const result = await request(app)
      .get(failedPath)
      .set(recipientHeaders)
      .expect(200);
    expect(result.body.job.message).toContain(diagnostic);
    await request(app).get(failedPath).set(ownerHeaders).expect(404);
    await request(app).get(failedPath).set(strangerHeaders).expect(404);
  });

  it('cleans up staged uploads when revocation wins before the snapshot', async () => {
    const { submit, revoke } = await shareForGeneration();
    const staging = await storage.uploadStagingDirectory();
    const reachedUpload = deferred();
    const resumeUpload = deferred();
    vi.spyOn(storage, 'uploadStagingDirectory').mockImplementationOnce(
      async () => {
        reachedUpload.resolve();
        await resumeUpload.promise;
        return staging;
      },
    );
    const snapshot = vi.spyOn(storage, 'snapshot');
    const pending = submit()
      .attach('logo', Buffer.from('logo'), 'logo.png')
      .then((response) => response);
    try {
      await Promise.race([
        reachedUpload.promise,
        pending.then(({ status }) => {
          throw new Error(
            `Submission finished before staging with status ${status}`,
          );
        }),
      ]);
      await revoke();
    } finally {
      resumeUpload.resolve();
    }
    expect((await pending).status).toBe(404);
    expect(snapshot).not.toHaveBeenCalled();
    expect(await readdir(staging)).toEqual([]);
  });

  it('accepts the captured snapshot when revocation waits for the same lock', async () => {
    const { submit, revoke } = await shareForGeneration();
    const reachedSnapshot = deferred();
    const resumeSnapshot = deferred();
    const revokeWaiting = deferred();
    const snapshot = storage.snapshot.bind(storage);
    vi.spyOn(storage, 'snapshot').mockImplementationOnce(
      async (templateId, jobId) => {
        const directory = await snapshot(templateId, jobId);
        reachedSnapshot.resolve();
        await resumeSnapshot.promise;
        return directory;
      },
    );
    const pending = submit()
      .attach('logo', Buffer.from('logo'), 'logo.png')
      .then((response) => response);
    let revocation: Promise<unknown> | undefined;
    try {
      await Promise.race([
        reachedSnapshot.promise,
        pending.then(({ status }) => {
          throw new Error(
            `Submission finished before snapshot with status ${status}`,
          );
        }),
      ]);
      const lock = storage.withTemplateFileLock.bind(storage);
      vi.spyOn(storage, 'withTemplateFileLock').mockImplementationOnce(
        (id, action) => {
          revokeWaiting.resolve();
          return lock(id, action);
        },
      );
      revocation = revoke().then((response) => response);
      await Promise.race([revokeWaiting.promise, revocation]);
    } finally {
      resumeSnapshot.resolve();
    }
    const accepted = await pending;
    expect(accepted.status).toBe(201);
    await revocation;
    expect(queue.add).toHaveBeenCalledWith(accepted.body.job.id);
    await submit()
      .attach('logo', Buffer.from('logo'), 'logo.png')
      .expect(404);
  });
});
