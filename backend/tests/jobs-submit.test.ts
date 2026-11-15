import { addTemplateTransactions } from './helpers/template-transactions.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import {
  reconcileQueuedJobs,
  submitGeneration,
  validateGenerationData,
} from '../src/jobs/jobs.service.js';
import {
  findResourceAliases,
  rewriteResourceTokens,
} from '../src/jobs/resource-tokens.js';
import { BullMqPublisher } from '../src/jobs/queue.js';
import type { ManifestV1 } from '../src/contracts.js';

const shaped: ManifestV1 = {
  version: 1,
  shape: {
    fields: [
      { variable: 'title', label: 'Title', type: 'text', optional: false },
      { variable: 'notes', label: 'Notes', type: 'longtext', optional: true },
      { variable: 'score', label: 'Score', type: 'number', optional: true },
      {
        variable: 'approved',
        label: 'Approved',
        type: 'boolean',
        optional: true,
      },
    ],
  },
};

describe('generation data validation', () => {
  it('preserves false and zero and omits blank optional fields', () => {
    expect(
      validateGenerationData(shaped, {
        title: 'Report',
        notes: '',
        score: 0,
        approved: false,
      }),
    ).toEqual({ title: 'Report', score: 0, approved: false });
  });

  it('omits an unset optional boolean represented by null', () => {
    expect(
      validateGenerationData(shaped, { title: 'Report', approved: null }),
    ).toEqual({
      title: 'Report',
    });
  });

  it('rejects missing required fields, unknown fields, and invalid numbers', () => {
    for (const input of [
      { title: '' },
      { title: 'Report', surprise: 1 },
      { title: 'Report', score: 'NaN' },
      { title: 'Report', score: Infinity },
      { title: 'Report', approved: 'false' },
    ]) {
      expect(() => validateGenerationData(shaped, input)).toThrow();
    }
  });

  it('accepts only a top-level object in JSON mode', () => {
    const jsonMode: ManifestV1 = { version: 1, shape: null };
    expect(
      validateGenerationData(jsonMode, { nested: [1, null, true] }),
    ).toEqual({
      nested: [1, null, true],
    });
    expect(() => validateGenerationData(jsonMode, [1, 2])).toThrow();
    expect(() => validateGenerationData(jsonMode, null)).toThrow();
  });
});

describe('list generation data', () => {
  const manifest = (
    itemType: 'text' | 'longtext' | 'number' | 'boolean',
    optional = false,
  ): ManifestV1 => ({
    version: 1,
    shape: {
      fields: [
        { variable: 'items', label: 'Items', type: 'list', itemType, optional },
      ],
    },
  });

  it('preserves typed lists, including zero and false', () => {
    for (const [itemType, items] of [
      ['text', ['first', 'second']],
      ['longtext', ['first\nsecond']],
      ['number', [0, 1.5]],
      ['boolean', [false, true]],
    ] as const) {
      expect(validateGenerationData(manifest(itemType), { items })).toEqual({
        items,
      });
    }
  });

  it('requires a nonempty required list and omits empty optional lists', () => {
    expect(
      validateGenerationData(manifest('text', true), { items: [] }),
    ).toEqual({});
    expect(validateGenerationData(manifest('text', true), {})).toEqual({});
    for (const items of [undefined, [], '', null, 'hello', {}]) {
      expect(() =>
        validateGenerationData(manifest('text'), { items }),
      ).toThrow();
    }
  });

  it('rejects invalid and nested items without coercion', () => {
    for (const optional of [false, true]) {
      for (const itemType of [
        'text',
        'longtext',
        'number',
        'boolean',
      ] as const) {
        for (const item of [null, [], {}, undefined]) {
          expect(() =>
            validateGenerationData(manifest(itemType, optional), {
              items: [item],
            }),
          ).toThrow();
        }
      }
      for (const itemType of ['text', 'longtext'] as const) {
        for (const items of [[''], ['   '], ['valid', false]]) {
          expect(() =>
            validateGenerationData(manifest(itemType, optional), { items }),
          ).toThrow();
        }
      }
      for (const items of [[Infinity], [NaN], [1, '2'], [true]]) {
        expect(() =>
          validateGenerationData(manifest('number', optional), { items }),
        ).toThrow();
      }
      expect(() =>
        validateGenerationData(manifest('boolean', optional), {
          items: [false, 'true'],
        }),
      ).toThrow();
    }
  });
});

describe('resource tokens', () => {
  it('finds unique aliases across text files and rewrites only supplied text', () => {
    const files = [
      'A @resource(logo) and @resource(chart_2)',
      'Again @resource(logo)',
    ];
    expect(findResourceAliases(files)).toEqual(['logo', 'chart_2']);
    expect(
      rewriteResourceTokens(files[0], {
        logo: '../resources/a.png',
        chart_2: '../resources/b.png',
      }),
    ).toBe('A ../resources/a.png and ../resources/b.png');
  });

  it('rejects pathlike aliases and missing mappings', () => {
    expect(() => findResourceAliases(['@resource(../secret)'])).toThrow();
    expect(() => findResourceAliases(['@resource(folder/logo)'])).toThrow();
    expect(() => rewriteResourceTokens('@resource(logo)', {})).toThrow();
  });
});

it('publishes only a stable job ID with one processing attempt', async () => {
  const add = vi.fn(async () => undefined);
  const publisher = new BullMqPublisher({ add } as any);
  const id = randomUUID();
  await publisher.add(id);
  expect(add).toHaveBeenCalledWith(
    'pdf-generation',
    { jobId: id },
    { jobId: `job-${id}`, attempts: 1 },
  );
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(manifest: ManifestV1 = { version: 1, shape: null }) {
  const root = await mkdtemp(join(tmpdir(), 'amd-jobs-submit-'));
  roots.push(root);
  const storage = new FileSystemStorage(root);
  const templateId = randomUUID();
  const userId = randomUUID();
  const template = {
    id: templateId,
    ownedBy: userId,
    name: 'Letter',
    manifest,
    deletedAt: null,
  };
  const jobs: any[] = [];
  const db: any = addTemplateTransactions({
    template: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === templateId && where.ownedBy === userId ? template : null,
      ),
    },
    generationJob: {
      create: vi.fn(async ({ data }: any) => {
        const job = {
          ...data,
          status: 'queued',
          timestamp: new Date(),
          template,
        };
        jobs.push(job);
        return job;
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          jobs.find((job) => job.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () =>
        jobs.filter((job) => job.status === 'queued'),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const job = jobs.find(
          (item) => item.id === where.id && item.status === where.status,
        );
        if (!job) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
    },
  });
  const queue = { add: vi.fn(async (_jobId: string) => undefined) };
  await storage.createTemplateRoot(templateId);
  await storage.writeText(
    templateId,
    ['template.tex'],
    'Hello @resource(logo) {{ name }}',
  );
  return { root, storage, templateId, userId, jobs, db, queue };
}

describe('job submission', () => {
  it('freezes template, data, and aliased upload before queueing', async () => {
    const context = await setup();
    const staging = await context.storage.uploadStagingDirectory();
    const upload = join(staging, randomUUID());
    await writeFile(upload, 'image bytes');
    const job = await submitGeneration(
      context.db,
      context.storage,
      context.queue,
      {
        userId: context.userId,
        templateId: context.templateId,
        data: { name: '@resource(logo)' },
        uploads: [{ alias: 'logo', temporaryPath: upload }],
      },
    );

    expect(context.jobs).toHaveLength(1);
    expect(context.queue.add).toHaveBeenCalledWith(job.id);
    await context.storage.writeText(
      context.templateId,
      ['template.tex'],
      'Changed',
    );
    const input = join(context.root, 'jobs', job.id, 'input');
    expect(await readFile(join(input, 'data.json'), 'utf8')).toBe(
      '{"name":"@resource(logo)"}',
    );
    const tex = await readFile(join(input, 'template', 'template.tex'), 'utf8');
    expect(tex).toContain('Hello ../resources/');
    expect(tex).not.toContain('Changed');
    expect(await readdir(join(input, 'resources'))).toHaveLength(1);
  });

  it('rejects missing and duplicate uploads before creating a job', async () => {
    const context = await setup();
    const staging = await context.storage.uploadStagingDirectory();
    const first = join(staging, randomUUID());
    const second = join(staging, randomUUID());
    await writeFile(first, 'one');
    await writeFile(second, 'two');
    for (const uploads of [
      [],
      [
        { alias: 'logo', temporaryPath: first },
        { alias: 'logo', temporaryPath: second },
      ],
      [{ alias: '../logo', temporaryPath: first }],
    ]) {
      await expect(
        submitGeneration(context.db, context.storage, context.queue, {
          userId: context.userId,
          templateId: context.templateId,
          data: {},
          uploads,
        }),
      ).rejects.toThrow();
    }
    expect(context.jobs).toHaveLength(0);
    expect(context.queue.add).not.toHaveBeenCalled();
  });

  it('finds aliases in a nested text file and rejects an empty main template', async () => {
    const context = await setup();
    await context.storage.createDirectory(context.templateId, ['parts']);
    await context.storage.writeText(
      context.templateId,
      ['template.tex'],
      'Main',
    );
    await context.storage.writeText(
      context.templateId,
      ['parts', 'figure.tex'],
      '@resource(figure)',
    );
    await expect(
      submitGeneration(context.db, context.storage, context.queue, {
        userId: context.userId,
        templateId: context.templateId,
        data: {},
        uploads: [],
      }),
    ).rejects.toThrow();
    expect(context.jobs).toHaveLength(0);
    await context.storage.writeText(
      context.templateId,
      ['template.tex'],
      '   ',
    );
    await expect(
      submitGeneration(context.db, context.storage, context.queue, {
        userId: context.userId,
        templateId: context.templateId,
        data: {},
        uploads: [],
      }),
    ).rejects.toThrow('Template is empty');
  });

  it('marks a created job failed and cleans its snapshot when enqueue fails', async () => {
    const context = await setup();
    await context.storage.writeText(
      context.templateId,
      ['template.tex'],
      'Hello',
    );
    context.queue.add.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      submitGeneration(context.db, context.storage, context.queue, {
        userId: context.userId,
        templateId: context.templateId,
        data: {},
        uploads: [],
      }),
    ).rejects.toThrow();
    expect(context.jobs[0].status).toBe('failed');
    expect(await readdir(join(context.root, 'jobs'))).toEqual([]);
  });

  it('re-enqueues a queued row left by an API crash using the same job ID', async () => {
    const context = await setup();
    await context.storage.writeText(
      context.templateId,
      ['template.tex'],
      'Hello',
    );
    const jobId = randomUUID();
    const input = await context.storage.snapshot(context.templateId, jobId);
    await writeFile(join(input, 'data.json'), '{}');
    context.jobs.push({ id: jobId, status: 'queued' });
    await reconcileQueuedJobs(context.db, context.storage, context.queue);
    expect(context.queue.add).toHaveBeenCalledWith(jobId);
  });
});
