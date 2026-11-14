import { setTimeout as delay } from 'node:timers/promises';
import { softDeleteTemplate } from '../src/templates/templates.service.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { createPrismaClient } from '../src/db/prisma.js';
import { withTemplateLock } from '../src/templates/template-lock.js';

const baseUrl = process.env.TEST_DATABASE_URL;
const schema = `preview_${randomUUID().replaceAll('-', '')}`;
let admin: Client;
let api: ReturnType<typeof createPrismaClient>;
let worker: ReturnType<typeof createPrismaClient>;
let templateId: string;
let otherTemplateId: string;
let userId: string;
let lockRoot: string;
let coordination: FileSystemStorage;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe.skipIf(!baseUrl)(
  'preview cross-process PostgreSQL coordination',
  () => {
    beforeAll(async () => {
      lockRoot = await mkdtemp(join(tmpdir(), 'amd-coordination-'));
      coordination = new FileSystemStorage(lockRoot);
      admin = new Client({ connectionString: baseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(baseUrl!);
      url.searchParams.set('schema', schema);
      execFileSync(
        process.execPath,
        [
          process.env.npm_execpath!,
          '--workspace',
          'backend',
          'run',
          'db:migrate:deploy',
        ],
        {
          cwd: new URL('../../', import.meta.url),
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: 'pipe',
        },
      );
      api = createPrismaClient(url.toString());
      worker = createPrismaClient(url.toString());
      userId = (
        await api.user.create({
          data: { username: 'preview-tester', passwordHash: 'unused' },
        })
      ).id;
      templateId = (
        await api.template.create({
          data: {
            ownedBy: userId,
            name: 'Preview',
            manifest: { version: 1, shape: null },
          },
        })
      ).id;
      otherTemplateId = (
        await api.template.create({
          data: {
            ownedBy: userId,
            name: 'Other',
            manifest: { version: 1, shape: null },
          },
        })
      ).id;
    }, 60000);
    afterAll(async () => {
      await Promise.all([api?.$disconnect(), worker?.$disconnect()]);
      if (lockRoot) await rm(lockRoot, { recursive: true, force: true });
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it('serializes snapshots and saves across independent clients without blocking another template', async () => {
      const entered = deferred();
      const release = deferred();
      let saved = false;
      const snapshot = withTemplateLock(
        worker,
        coordination,
        templateId,
        null,
        async () => {
          entered.resolve();
          await release.promise;
          return 'snapshot';
        },
      );
      await entered.promise;
      const saving = withTemplateLock(
        api,
        coordination,
        templateId,
        userId,
        async (tx) => {
          saved = true;
          await tx.template.update({
            where: { id: templateId },
            data: {
              manifest: {
                version: 1,
                shape: {
                  fields: [
                    {
                      variable: 'n',
                      type: 'number',
                      label: 'N',
                      optional: false,
                    },
                  ],
                },
              },
            },
          });
        },
      );
      try {
        await withTemplateLock(
          api,
          coordination,
          otherTemplateId,
          userId,
          async () => {},
        );
        expect(saved).toBe(false);
      } finally {
        release.resolve();
      }
      await Promise.all([snapshot, saving]);
      expect(saved).toBe(true);
      // A subsequent worker snapshot reads the committed saved manifest.
      const manifest = await withTemplateLock(
        worker,
        coordination,
        templateId,
        null,
        async (_tx, template) => template.manifest,
      );
      expect(manifest.shape?.fields[0].variable).toBe('n');
    });
    it('captures saved files and shape together and releases the lock before compilation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'amd-snapshot-lock-'));
      const apiStorage = new FileSystemStorage(root);
      const workerStorage = new FileSystemStorage(root);
      await apiStorage.createTemplateRoot(otherTemplateId);
      await apiStorage.writeText(
        otherTemplateId,
        ['template.tex'],
        'old {{ name }}',
      );
      const entered = deferred();
      const release = deferred();
      const runId = randomUUID();
      let saved = false;
      const snapshot = withTemplateLock(
        worker,
        coordination,
        otherTemplateId,
        null,
        async (_tx, template) => {
          entered.resolve();
          await release.promise;
          const input = await workerStorage.snapshotPreview(
            otherTemplateId,
            runId,
          );
          await writeFile(
            join(input, 'data.json'),
            JSON.stringify(template.manifest),
          );
          return input;
        },
      );
      await entered.promise;
      const saving = withTemplateLock(
        api,
        coordination,
        otherTemplateId,
        userId,
        async (tx) => {
          saved = true;
          await apiStorage.writeText(
            otherTemplateId,
            ['template.tex'],
            'new {{ number }}',
          );
          await tx.template.update({
            where: { id: otherTemplateId },
            data: {
              manifest: {
                version: 1,
                shape: {
                  fields: [
                    {
                      variable: 'number',
                      label: 'Number',
                      type: 'number',
                      optional: false,
                    },
                  ],
                },
              },
            },
          });
        },
      );
      try {
        // Query the other row to give both independent clients a completed round trip.
        await api.template.findUnique({ where: { id: templateId } });
        expect(saved).toBe(false);
      } finally {
        release.resolve();
      }
      try {
        const input = await snapshot;
        await saving;
        expect(
          await readFile(join(input, 'template/template.tex'), 'utf8'),
        ).toBe('old {{ name }}');
        expect(
          JSON.parse(await readFile(join(input, 'data.json'), 'utf8')),
        ).toEqual({ version: 1, shape: null });
        expect(
          await apiStorage.readText(otherTemplateId, ['template.tex']),
        ).toBe('new {{ number }}');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('retains filesystem coordination after a real transaction timeout until work settles', async () => {
      const template = await api.template.create({
        data: {
          ownedBy: userId,
          name: 'Timeout',
          manifest: { version: 1, shape: null },
        },
      });
      await coordination.createTemplateRoot(template.id);
      await coordination.writeText(template.id, ['template.tex'], 'source');
      const entered = deferred();
      const release = deferred();
      const original = worker.$transaction.bind(worker);
      const spy = vi
        .spyOn(worker, '$transaction')
        .mockImplementation(((callback: any, options: any) =>
          original(callback, { ...options, timeout: 100 })) as any);
      let deleted = false;
      let published = false;
      const publishing = withTemplateLock(
        worker,
        coordination,
        template.id,
        null,
        async () => {
          entered.resolve();
          await release.promise;
        },
        async () => {
          published = true;
        },
      );
      // Install a rejection handler before the transaction expires.
      const outcome = publishing.catch((error) => error);
      await entered.promise;
      const deleting = softDeleteTemplate(
        api,
        coordination,
        userId,
        template.id,
      ).then(() => {
        deleted = true;
      });
      try {
        await delay(250);
        expect(deleted).toBe(false);
        expect(
          (await api.template.findUnique({ where: { id: template.id } }))
            ?.deletedAt,
        ).toBeNull();
      } finally {
        release.resolve();
      }
      try {
        expect(await outcome).toBeInstanceOf(Error);
        await deleting;
        expect(published).toBe(false);
        expect(deleted).toBe(true);
        expect(await coordination.templatePreviewExists(template.id)).toBe(
          false,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('preserves source files when transaction completion fails after marking deletion', async () => {
      const template = await api.template.create({
        data: {
          ownedBy: userId,
          name: 'Rollback',
          manifest: { version: 1, shape: null },
        },
      });
      await coordination.createTemplateRoot(template.id);
      await coordination.writeText(
        template.id,
        ['template.tex'],
        'irreplaceable source',
      );
      const original = api.$transaction.bind(api);
      const spy = vi.spyOn(api, '$transaction').mockImplementation(((
        callback: any,
        options: any,
      ) =>
        original(async (tx) => {
          await callback(tx);
          throw new Error('commit failed');
        }, options)) as any);
      try {
        await expect(
          softDeleteTemplate(api, coordination, userId, template.id),
        ).rejects.toThrow('commit failed');
      } finally {
        spy.mockRestore();
      }
      expect(
        (await api.template.findUnique({ where: { id: template.id } }))
          ?.deletedAt,
      ).toBeNull();
      expect(await coordination.readText(template.id, ['template.tex'])).toBe(
        'irreplaceable source',
      );
    });

    it('prevents publication after a concurrent deletion wins the row lock', async () => {
      await withTemplateLock(
        api,
        coordination,
        templateId,
        userId,
        async (tx) => {
          await tx.template.update({
            where: { id: templateId },
            data: { deletedAt: new Date() },
          });
        },
      );
      let published = false;
      await expect(
        withTemplateLock(worker, coordination, templateId, null, async () => {
          published = true;
        }),
      ).rejects.toThrow('Template not found');
      expect(published).toBe(false);
    });
  },
);
