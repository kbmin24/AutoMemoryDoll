import { captureLogs } from './helpers/logging.js';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import {
  JobProcessor,
  reconcileFailedDeliveries,
} from '../src/worker/jobs.worker.js';
import { PdfGenerator } from '../src/worker/pdf-generator.js';

let root: string;
let storage: FileSystemStorage;
let job: any;
let db: any;
const jobId = randomUUID();
const templateId = randomUUID();
const filename = `${randomUUID()}.pdf`;
let generate: (input: string, output: string) => Promise<void>;
let calls: number;
class FakeGenerator extends PdfGenerator {
  async generate(input: string, output: string) {
    calls++;
    await generate(input, output);
    return this.readResult(output);
  }
  stop = vi.fn(async (_jobId: string) => undefined);
}
let generator: FakeGenerator;
let processor: JobProcessor;
let logs: ReturnType<typeof captureLogs>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-worker-'));
  storage = new FileSystemStorage(root);
  await storage.createTemplateRoot(templateId);
  const input = await storage.snapshot(templateId, jobId);
  await writeFile(join(input, 'data.json'), '{}');
  job = {
    id: jobId,
    status: 'queued',
    pdfFilename: null,
    startedAt: null,
    completedAt: null,
  };
  db = {
    generationJob: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (
          where.id !== job.id ||
          where.status !== job.status ||
          (where.startedAt instanceof Date &&
            +where.startedAt !== +job.startedAt)
        )
          return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const states = where.status.in ?? [where.status];
        return states.includes(job.status) &&
          (!where.startedAt || job.startedAt < where.startedAt.lt)
          ? [{ ...job }]
          : [];
      }),
    },
  };
  calls = 0;
  generate = async (_input, output) => {
    await writeFile(join(output, filename), '%PDF-1.7\nexample');
    await writeFile(join(output, `${randomUUID()}.pdf`), 'unlisted');
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ result: 'ok', filename, message: 'done' }),
    );
  };
  generator = new FakeGenerator();
  logs = captureLogs();
  processor = new JobProcessor(db, storage, generator, 1000, logs.logger);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('publishes only the named PDF, keeps it after cleanup, and ignores repeated delivery', async () => {
  await processor.processJob(jobId);
  await processor.processJob(jobId);
  expect(job.status).toBe('ok');
  expect(job.pdfFilename).toBe(filename);
  expect(calls).toBe(1);
  expect(await readdir(join(root, 'pdfs', jobId))).toEqual([filename]);
  expect(await readFile(join(root, 'pdfs', jobId, filename), 'utf8')).toContain(
    '%PDF-',
  );
  expect(await storage.jobInputExists(jobId)).toBe(false);
});

it('only one simultaneous delivery claims the job', async () => {
  await Promise.all([processor.processJob(jobId), processor.processJob(jobId)]);
  expect(calls).toBe(1);
  expect(job.status).toBe('ok');
});

it.each([
  { result: 'ok', filename: '../outside.pdf', message: 'bad' },
  { result: 'ok', filename: '/etc/passwd', message: 'bad' },
  { result: 'ok', filename: null, message: 'bad' },
  { result: 'failed', filename, message: 'bad' },
  { result: 'unknown', filename, message: 'bad' },
])('rejects malformed manifests: %j', async (manifest) => {
  generate = async (_input, output) => {
    await writeFile(join(output, 'result.json'), JSON.stringify(manifest));
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  expect(job.pdfFilename).toBeNull();
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
  expect(await storage.jobInputExists(jobId)).toBe(false);
});

it('rejects a symlink PDF', async () => {
  generate = async (_input, output) => {
    await symlink('/etc/passwd', join(output, filename));
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ result: 'ok', filename, message: 'done' }),
    );
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
});

it('does not expose private compiler diagnostics or leave PDFs on failure', async () => {
  generate = async (_input, output) => {
    await writeFile(join(output, filename), 'partial');
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({
        result: 'failed',
        filename: null,
        message: `/private/host/secret ${'x'.repeat(1000)}`,
      }),
    );
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  expect(job.message).not.toContain('/private');
  expect(job.message.length).toBeLessThanOrEqual(300);
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
});

it('reconciles interrupted jobs without rerunning and removes orphaned output/PDFs', async () => {
  job.status = 'generating';
  job.startedAt = new Date(0);
  await mkdir(join(root, 'pdfs', jobId), { recursive: true });
  await writeFile(join(root, 'pdfs', jobId, filename), 'orphan');
  await processor.reconcile();
  expect(job.status).toBe('failed');
  expect(calls).toBe(0);
  expect(generator.stop).toHaveBeenCalledWith(jobId);
  expect(await storage.jobInputExists(jobId)).toBe(false);
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
  await processor.processJob(jobId);
  expect(calls).toBe(0);
});

it('does not interrupt a recent active job', async () => {
  job.status = 'generating';
  job.startedAt = new Date();
  await processor.reconcile();
  expect(job.status).toBe('generating');
  expect(generator.stop).not.toHaveBeenCalled();
});

it('preserves a successful PDF while cleaning terminal leftovers', async () => {
  await processor.processJob(jobId);
  await processor.reconcile();
  expect(await readdir(join(root, 'pdfs', jobId))).toEqual([filename]);
});

it('rejects symlink manifests', async () => {
  generate = async (_input, output) => {
    await symlink('/etc/passwd', join(output, 'result.json'));
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  expect(job.pdfFilename).toBeNull();
});

it('preserves a committed PDF when the completion acknowledgement is lost', async () => {
  const update = db.generationJob.updateMany.getMockImplementation();
  db.generationJob.updateMany.mockImplementation(async (query: any) => {
    const result = await update(query);
    if (query.data.status === 'ok')
      throw new Error('Connection lost after commit');
    return result;
  });
  await processor.processJob(jobId);
  expect(job.status).toBe('ok');
  expect(await readdir(join(root, 'pdfs', jobId))).toEqual([filename]);
  await processor.reconcile();
  expect(await readdir(join(root, 'pdfs', jobId))).toEqual([filename]);
});

it('cannot publish a result after recovery has failed an interrupted job', async () => {
  const normalGenerate = generate;
  generate = async (input, output) => {
    await normalGenerate(input, output);
    job.status = 'failed';
    job.pdfFilename = null;
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
});

it('removes a PDF moved before a failed terminal database write', async () => {
  const update = db.generationJob.updateMany.getMockImplementation();
  db.generationJob.updateMany.mockImplementation(async (query: any) => {
    if (query.data.status === 'ok') throw new Error('Database write failed');
    return update(query);
  });
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
});

it('fails queued rows whose BullMQ delivery failed before the database claim', async () => {
  const queue = {
    getJob: async (id: string) => {
      expect(id).toBe(`job-${jobId}`);
      return { getState: async () => 'failed' };
    },
  };
  await reconcileFailedDeliveries(db, queue);
  expect(job.status).toBe('failed');
  expect(job.pdfFilename).toBeNull();
  await processor.reconcile();
  expect(await storage.jobInputExists(jobId)).toBe(false);
  expect(calls).toBe(0);
});

it('does not fail a queued row with a waiting or active delivery', async () => {
  for (const state of ['waiting', 'active']) {
    await reconcileFailedDeliveries(db, {
      getJob: async () => ({ getState: async () => state }),
    });
    expect(job.status).toBe('queued');
  }
});

it('rejects success when the manifest-named PDF is missing', async () => {
  generate = async (_input, output) => {
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({ result: 'ok', filename, message: 'done' }),
    );
  };
  await processor.processJob(jobId);
  expect(job.status).toBe('failed');
  expect(job.pdfFilename).toBeNull();
  await expect(readdir(join(root, 'pdfs', jobId))).rejects.toThrow();
});

it('logs one correlated outcome without raw compiler messages or duplicate deliveries', async () => {
  generate = async (_input, output) => {
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify({
        result: 'failed',
        filename: null,
        message: 'SECRET TEX',
      }),
    );
  };
  await processor.processJob(jobId);
  await processor.processJob(jobId);
  expect(
    logs.events.filter((event) => event.message === 'generation.started'),
  ).toHaveLength(1);
  expect(
    logs.events.filter((event) => event.message === 'generation.rejected'),
  ).toHaveLength(1);
  expect(
    logs.events.find((event) => event.message === 'generation.rejected'),
  ).toMatchObject({ jobId, level: 'warn', outcome: 'rejected' });
  expect(JSON.stringify(logs.events)).not.toContain('SECRET');
});

it('includes the original stack for unexpected generation failures', async () => {
  generate = async () => {
    throw new Error('SECRET connection string');
  };
  await processor.processJob(jobId);
  expect(
    logs.events.find((event) => event.message === 'generation.failed'),
  ).toMatchObject({
    jobId,
    level: 'error',
    errorCode: 'unexpected',
    errorMessage: 'SECRET connection string',
    stack: expect.stringContaining('Error: SECRET connection string'),
  });
});
