import { StorageError } from '../src/storage/storage.errors.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { validateSegments } from '../src/storage/paths.js';

let root: string;
let storage: FileSystemStorage;
const id = '123e4567-e89b-42d3-a456-426614174000';
const job = '123e4567-e89b-42d3-a456-426614174001';

async function staged(contents: string | Buffer): Promise<string> {
  const path = join(await storage.uploadStagingDirectory(), `upload-${randomUUID()}`);
  await writeFile(path, contents);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amd-storage-'));
  storage = new FileSystemStorage(root);
  await storage.createTemplateRoot(id);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('rooted storage', () => {
  it('rejects unsafe names', () => {
    for (const name of [
      '.',
      '..',
      '.hidden',
      'bad/',
      'bad\\name',
      'bad.',
      'bad ',
      'é',
      'x'.repeat(129),
    ]) {
      expect(() => validateSegments([name])).toThrow();
    }
    expect(() => validateSegments(Array(10).fill('dir'))).toThrow();
  });

  it('creates, edits, moves, downloads and deletes files', async () => {
    await storage.createDirectory(id, ['assets']);
    await storage.writeText(id, ['template.tex'], 'Hello');
    await storage.moveUpload(id, ['assets', 'a.txt'], await staged('world'));
    expect(await storage.readText(id, ['assets', 'a.txt'])).toBe('world');
    await storage.move(id, ['assets', 'a.txt'], ['assets', 'b.txt']);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.openDownload(id, ['assets', 'b.txt']))
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('world');
    expect(await storage.listTemplateTree(id)).toContainEqual({
      name: 'b.txt',
      kind: 'file',
      segments: ['assets', 'b.txt'],
    });
    await storage.delete(id, ['assets', 'b.txt']);
    await expect(storage.readText(id, ['assets', 'b.txt'])).rejects.toThrow();
    await expect(storage.delete(id, ['template.tex'])).rejects.toThrow();
  });

  it('rejects links and oversize text', async () => {
    await symlink('/etc/passwd', join(root, 'templates', id, 'link'));
    await expect(storage.openDownload(id, ['link'])).rejects.toThrow();
    await expect(storage.listTemplateTree(id)).rejects.toThrow();
    await rm(join(root, 'templates', id, 'link'));
    await expect(
      storage.writeText(id, ['template.tex'], 'x'.repeat(1024 * 1024 + 1)),
    ).rejects.toThrow();
  });

  it('enforces upload size and preserves the destination on failure', async () => {
    await expect(
      storage.moveUpload(id, ['large.bin'], await staged(Buffer.alloc(20 * 1024 * 1024 + 1))),
    ).rejects.toThrow();
    expect(await storage.listTemplateTree(id)).not.toContainEqual(
      expect.objectContaining({ name: 'large.bin' }),
    );
  });

  it('serializes concurrent edits and snapshots', async () => {
    await storage.writeText(id, ['template.tex'], 'first');
    const [input] = await Promise.all([
      storage.snapshot(id, job),
      storage.writeText(id, ['template.tex'], 'second'),
    ]);
    expect(await readFile(join(input, 'template', 'template.tex'), 'utf8')).toBe('first');
  });

  it('serializes competing moves', async () => {
    await storage.moveUpload(id, ['original.txt'], await staged('data'));
    const results = await Promise.allSettled([
      storage.move(id, ['original.txt'], ['one.txt']),
      storage.move(id, ['original.txt'], ['two.txt']),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await storage.listTemplateTree(id)).filter((entry) => entry.kind === 'file'),
    ).toHaveLength(1);
  });

  it('keeps retained PDFs after job cleanup', async () => {
    const input = await storage.snapshot(id, job);
    const output = join(root, 'jobs', job, 'output');
    await mkdir(output);
    const filename = `${id}.pdf`;
    await writeFile(join(output, filename), 'pdf');
    await storage.savePdf(job, join(output, filename), filename);
    await storage.cleanupJob(job);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.openPdf(job, filename)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('pdf');
    expect(input).toContain(job);
  });

  it('snapshots a consistent template and stages resources', async () => {
    await storage.writeText(id, ['template.tex'], 'before');
    const input = await storage.snapshot(id, job);
    await storage.writeText(id, ['template.tex'], 'after');
    expect(await readFile(join(input, 'template', 'template.tex'), 'utf8')).toBe('before');
    await storage.stageResource(job, 'image.png', await staged('abc'));
    expect(await readFile(join(input, 'resources', 'image.png'), 'utf8')).toBe('abc');
  });
});

it('uses private job/PDF directories and atomically moves the published PDF', async () => {
  const { stat } = await import('node:fs/promises');
  await storage.snapshot(id, job);
  const { output } = await storage.prepareJobOutput(job);
  const filename = `${randomUUID()}.pdf`;
  const source = join(output, filename);
  await writeFile(source, '%PDF-1.7');
  const destination = await storage.savePdf(job, source, filename);
  await expect(stat(source)).rejects.toThrow();
  expect((await stat(join(root, 'jobs', job))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, 'pdfs', job))).mode & 0o777).toBe(0o700);
  expect(await readFile(destination, 'utf8')).toBe('%PDF-1.7');
});

it('uses the collision code even when the diagnostic wording changes', async () => {
  await storage.writeText(id, ['template.tex'], 'before');
  const target = vi.spyOn(storage as any, 'target');
  try {
    target.mockRejectedValueOnce(new StorageError('Different diagnostic', 'ALREADY_EXISTS'));
    await storage.writeText(id, ['template.tex'], 'after');
    expect(await storage.readText(id, ['template.tex'])).toBe('after');

    const internal = new Error('Path already exists');
    target.mockRejectedValueOnce(internal);
    await expect(storage.writeText(id, ['template.tex'], 'unexpected')).rejects.toBe(internal);
    expect(await storage.readText(id, ['template.tex'])).toBe('after');
  } finally {
    target.mockRestore();
  }
});
