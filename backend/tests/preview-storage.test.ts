import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
let root: string;
let storage: FileSystemStorage;
let templateId: string;
const image = Buffer.from('RIFF\x10\0\0\0WEBPVP8 fixture');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-preview-'));
  storage = new FileSystemStorage(root);
  templateId = randomUUID();
  await storage.createTemplateRoot(templateId);
  await storage.writeText(templateId, ['template.tex'], 'hello');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function run() {
  const runId = randomUUID();
  await storage.snapshotPreview(templateId, runId);
  return { runId, ...(await storage.preparePreviewOutput(runId)) };
}
it('atomically replaces one image and removes preview without touching template', async () => {
  expect(await storage.templatePreviewExists(templateId)).toBe(false);
  const first = await run();
  await writeFile(join(first.output, 'preview.webp'), image);
  await storage.publishPreview(templateId, first.runId);
  expect(await storage.templatePreviewExists(templateId)).toBe(true);
  const second = await run();
  await writeFile(join(second.output, 'preview.webp'), Buffer.from('invalid'));
  await expect(
    storage.publishPreview(templateId, second.runId),
  ).rejects.toThrow();
  expect(
    await readFile(join(root, 'previews', templateId, 'preview.webp')),
  ).toEqual(image);
  await storage.removeTemplatePreview(templateId);
  expect(await storage.templatePreviewExists(templateId)).toBe(false);
  expect(await storage.readText(templateId, ['template.tex'])).toBe('hello');
});
it('rejects linked and oversized compiler images while keeping run cleanup separate', async () => {
  for (const kind of ['symlink', 'hardlink', 'oversize']) {
    const attempt = await run();
    const source = join(attempt.output, 'preview.webp');
    if (kind === 'symlink')
      await symlink(
        join(root, 'templates', templateId, 'template.tex'),
        source,
      );
    if (kind === 'hardlink')
      await link(join(root, 'templates', templateId, 'template.tex'), source);
    if (kind === 'oversize')
      await writeFile(source, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(
      storage.publishPreview(templateId, attempt.runId),
    ).rejects.toThrow();
    expect(await storage.listPreviewRuns()).toContain(attempt.runId);
    await storage.cleanupPreviewRun(attempt.runId);
  }
  expect(await storage.listPreviewRuns()).toEqual([]);
});

it('compares WebP signature bytes exactly instead of masking their high bits', async () => {
  const attempt = await run();
  const corrupted = Buffer.from(image);
  for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) corrupted[index] |= 0x80;
  await writeFile(join(attempt.output, 'preview.webp'), corrupted);
  await expect(
    storage.publishPreview(templateId, attempt.runId),
  ).rejects.toThrow('Invalid preview output');
});
