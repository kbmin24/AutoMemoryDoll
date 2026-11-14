import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviewProcessor } from '../src/worker/previews.worker.js';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { addTemplateTransactions } from './helpers/template-transactions.js';
let root: string;
let storage: FileSystemStorage;
let template: any;
let db: any;
let generator: any;
let processor: PreviewProcessor;
const image = Buffer.from('RIFF1234WEBPimage');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-preview-worker-'));
  storage = new FileSystemStorage(root);
  template = {
    id: randomUUID(),
    ownedBy: randomUUID(),
    manifest: { version: 1, shape: null },
    deletedAt: null,
  };
  db = addTemplateTransactions({
    template: {
      findFirst: vi.fn(async () => (template.deletedAt ? null : template)),
    },
    generationJob: { create: vi.fn() },
  });
  generator = {
    stop: vi.fn(async () => {}),
    generatePreview: vi.fn(async (input: string, output: string) => {
      expect(
        JSON.parse(await readFile(join(input, 'data.json'), 'utf8')),
      ).toEqual({});
      await writeFile(join(output, 'preview.webp'), image);
      return { result: 'ok', filename: 'preview.webp', message: 'ok' };
    }),
  };
  processor = new PreviewProcessor(db, storage, generator);
  await storage.createTemplateRoot(template.id);
  await storage.writeText(template.id, ['template.tex'], 'hello');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('publishes a sample preview without a database job and cleans the run', async () => {
  await processor.processTemplate(template.id);
  expect(
    await readFile(join(root, 'previews', template.id, 'preview.webp')),
  ).toEqual(image);
  expect(db.generationJob.create).not.toHaveBeenCalled();
  expect(await storage.listPreviewRuns()).toEqual([]);
});
it('retains old image on compile failure or missing resource and waits for another save', async () => {
  await processor.processTemplate(template.id);
  generator.generatePreview.mockResolvedValueOnce({
    result: 'failed',
    filename: null,
    message: 'bad',
  });
  await processor.processTemplate(template.id);
  await storage.writeText(template.id, ['template.tex'], '@resource(logo)');
  await processor.processTemplate(template.id);
  expect(generator.generatePreview).toHaveBeenCalledTimes(2);
  expect(
    await readFile(join(root, 'previews', template.id, 'preview.webp')),
  ).toEqual(image);
  expect(await storage.listPreviewRuns()).toEqual([]);
});
it('discards a result if the template was deleted during compilation', async () => {
  generator.generatePreview.mockImplementation(
    async (_input: string, output: string) => {
      template.deletedAt = new Date();
      await writeFile(join(output, 'preview.webp'), image);
      return { result: 'ok', filename: 'preview.webp', message: 'ok' };
    },
  );
  await processor.processTemplate(template.id);
  expect(await storage.templatePreviewExists(template.id)).toBe(false);
  expect(await storage.listPreviewRuns()).toEqual([]);
});
it('stops leftover containers before deleting run files and leaves failed stops for later cleanup', async () => {
  const id = randomUUID();
  await storage.snapshotPreview(template.id, id);
  generator.stop.mockImplementationOnce(async () => {
    expect(await storage.listPreviewRuns()).toContain(id);
    throw new Error('daemon offline');
  });
  await expect(processor.reconcile()).rejects.toThrow('daemon offline');
  expect(await storage.listPreviewRuns()).toContain(id);
  await processor.reconcile();
  expect(await storage.listPreviewRuns()).toEqual([]);
});
