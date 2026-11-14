import { spawn } from 'node:child_process';
import { StorageError } from './storage.errors.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Storage, type TreeEntry } from './storage.js';
import { validateId, validateSegments } from './paths.js';

const FILE_LIMIT = 20 * 1024 * 1024;
const WORKSPACE_LIMIT = 100 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

export class FileSystemStorage extends Storage {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  private template(id: string): string {
    return join(this.root, 'templates', validateId(id));
  }
  private job(id: string): string {
    return join(this.root, 'jobs', validateId(id));
  }
  private pdf(id: string): string {
    return join(this.root, 'pdfs', validateId(id));
  }

  private async locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((done) => {
      release = done;
    });
    this.locks.set(id, current);
    await prior;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  async withTemplateFileLock<T>(
    templateId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const parent = join(this.root, 'template-locks');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.ordinary(parent, 'directory');
    const file = await open(
      join(parent, `${validateId(templateId)}.lock`),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new Error('Invalid template lock file');
      // flock inherits the same open file description; our handle retains its lock after the child exits.
      await new Promise<void>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '--timeout', '5', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', file.fd],
        });
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Template lock unavailable')),
        );
      });
      return await action();
    } finally {
      await file.close();
    }
    // Lock files are never unlinked: replacing their inode could split coordination between processes.
  }

  private async ordinary(
    path: string,
    kind?: 'file' | 'directory',
  ): Promise<void> {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      (kind === 'file' && (!info.isFile() || info.nlink !== 1)) ||
      (kind === 'directory' && !info.isDirectory())
    ) {
      throw new Error('Unsupported filesystem entry');
    }
  }

  // Validates that the path exists and is of the expected kind, or that it does not exist if leafExists is false.
  private async target(
    id: string,
    segments: string[],
    leafExists: boolean,
  ): Promise<string> {
    const names = validateSegments(segments);
    let path = this.template(id);
    await this.ordinary(path, 'directory');
    for (const name of names.slice(0, -1)) {
      path = join(path, name);
      await this.ordinary(path, 'directory');
    }
    path = join(path, names.at(-1)!);
    if (leafExists) await this.ordinary(path);
    else {
      try {
        await lstat(path);
        throw new StorageError('Path already exists', 'ALREADY_EXISTS');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return path;
  }

  private async entries(id: string): Promise<TreeEntry[]> {
    const result: TreeEntry[] = [];
    const visit = async (dir: string, parts: string[]): Promise<void> => {
      for (const name of await readdir(dir)) {
        const segments = [...parts, name];
        validateSegments(segments);
        const path = join(dir, name);
        await this.ordinary(path);
        const info = await lstat(path);
        const kind = info.isDirectory() ? 'directory' : 'file';
        result.push({ name, kind, segments });
        if (kind === 'directory') await visit(path, segments);
      }
    };
    const root = this.template(id);
    await this.ordinary(root, 'directory');
    await visit(root, []);
    return result;
  }

  private async workspaceBytes(id: string): Promise<number> {
    let total = 0;
    for (const entry of await this.entries(id)) {
      if (entry.kind === 'file')
        total += (await lstat(join(this.template(id), ...entry.segments))).size;
    }
    return total;
  }

  async uploadStagingDirectory(): Promise<string> {
    const dir = join(this.root, 'upload-staging');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.ordinary(dir, 'directory');
    return dir;
  }

  private async stagedFile(path: string): Promise<number> {
    const dir = await this.uploadStagingDirectory();
    if (dirname(resolve(path)) !== dir)
      throw new Error('Upload is outside staging directory');
    await this.ordinary(path, 'file');
    return (await lstat(path)).size;
  }

  async createTemplateRoot(id: string): Promise<void> {
    await this.locked(id, async () => {
      await mkdir(join(this.root, 'templates'), { recursive: true });
      await this.ordinary(join(this.root, 'templates'), 'directory');
      await mkdir(this.template(id));
    });
  }

  async removeTemplateRoot(id: string): Promise<void> {
    await this.locked(id, async () => {
      await this.entries(id);
      await rm(this.template(id), { recursive: true });
    });
  }

  async listTemplateTree(id: string): Promise<TreeEntry[]> {
    return this.locked(id, () => this.entries(id));
  }

  async createDirectory(id: string, segments: string[]): Promise<void> {
    await this.locked(id, async () => {
      await mkdir(await this.target(id, segments, false));
    });
  }

  async readText(id: string, segments: string[]): Promise<string> {
    return this.locked(id, async () => {
      const path = await this.target(id, segments, true);
      await this.ordinary(path, 'file');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > TEXT_LIMIT)
          throw new StorageError('Not an editable text file');
        const bytes = await file.readFile();
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new StorageError('Not an editable text file');
        }
        if (text.includes('\0'))
          throw new StorageError('Not an editable text file');
        return text;
      } finally {
        await file.close();
      }
    });
  }

  async writeText(id: string, segments: string[], text: string): Promise<void> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > TEXT_LIMIT)
      throw new StorageError('Text size limit exceeded');
    await this.locked(id, async () => {
      const names = validateSegments(segments);
      const path = await this.target(id, names, false).catch(async (error) => {
        if (!(error instanceof StorageError) || error.code !== 'ALREADY_EXISTS')
          throw error;
        const existing = await this.target(id, names, true);
        await this.ordinary(existing, 'file');
        return existing;
      });
      let oldSize = 0;
      try {
        oldSize = (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        (await this.workspaceBytes(id)) - oldSize + Buffer.byteLength(text) >
        WORKSPACE_LIMIT
      )
        throw new StorageError('Workspace size limit exceeded');
      const temp = join(this.template(id), `.write-${randomUUID()}`);
      try {
        const file = await open(
          temp,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(text);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    });
  }

  async moveUpload(
    id: string,
    segments: string[],
    temporaryPath: string,
  ): Promise<void> {
    await this.locked(id, async () => {
      await this.stagedFile(temporaryPath);
      try {
        const path = await this.target(id, segments, false);
        const remaining = WORKSPACE_LIMIT - (await this.workspaceBytes(id));
        const size = await this.stagedFile(temporaryPath);
        if (size > FILE_LIMIT || size > remaining)
          throw new StorageError('File size limit exceeded');
        await this.target(id, segments, false);
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  }

  async readPreviewInput(id: string, segments: string[]): Promise<Buffer> {
    const stream = await this.openDownload(id, segments);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > FILE_LIMIT)
        throw new StorageError('Image size limit exceeded');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  }

  async openDownload(id: string, segments: string[]): Promise<Readable> {
    return this.locked(id, async () => {
      const path = await this.target(id, segments, true);
      await this.ordinary(path, 'file');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) {
        await file.close();
        throw new Error('Unsupported filesystem entry');
      }
      return file.createReadStream();
    });
  }

  async move(id: string, from: string[], to: string[]): Promise<void> {
    await this.locked(id, async () => {
      if (from.length === 1 && from[0] === 'template.tex')
        throw new StorageError('Cannot move template.tex');
      const source = await this.target(id, from, true);
      const destination = await this.target(id, to, false);
      if (destination.startsWith(source + sep))
        throw new StorageError('Cannot move directory into itself');
      await rename(source, destination);
    });
  }

  async delete(id: string, segments: string[]): Promise<void> {
    await this.locked(id, async () => {
      if (segments.length === 1 && segments[0] === 'template.tex')
        throw new StorageError('Cannot delete template.tex');
      const path = await this.target(id, segments, true);
      const info = await lstat(path);
      if (info.isDirectory()) {
        await this.entries(id);
        await rm(path, { recursive: true });
      } else {
        await this.ordinary(path, 'file');
        await rm(path);
      }
    });
  }

  async snapshot(id: string, jobId: string): Promise<string> {
    return this.copySnapshot(id, this.job(jobId));
  }

  async snapshotPreview(id: string, runId: string): Promise<string> {
    return this.copySnapshot(id, this.previewRun(runId));
  }

  private previewRun(runId: string): string {
    return join(this.root, 'preview-runs', validateId(runId));
  }

  private async copySnapshot(id: string, jobRoot: string): Promise<string> {
    return this.locked(id, async () => {
      await mkdir(dirname(jobRoot), { recursive: true, mode: 0o700 });
      await this.ordinary(dirname(jobRoot), 'directory');
      await mkdir(jobRoot, { mode: 0o700 });
      const input = join(jobRoot, 'input');
      const template = join(input, 'template');
      try {
        const entries = await this.entries(id);
        await mkdir(template, { recursive: true });
        await mkdir(join(input, 'resources'));
        for (const entry of entries) {
          const dest = join(template, ...entry.segments);
          if (entry.kind === 'directory') await mkdir(dest);
          else {
            const source = await this.target(id, entry.segments, true);
            await this.ordinary(source, 'file');
            await copyFile(source, dest);
          }
        }
        return input;
      } catch (error) {
        await rm(jobRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async preparePreviewOutput(
    runId: string,
  ): Promise<{ input: string; output: string }> {
    const root = this.previewRun(runId);
    await this.ordinary(dirname(root), 'directory');
    await this.ordinary(root, 'directory');
    const input = join(root, 'input');
    await this.ordinary(input, 'directory');
    const output = join(root, 'output');
    await mkdir(output, { mode: 0o700 });
    return { input, output };
  }

  private async previewDirectory(
    templateId: string,
    create = false,
  ): Promise<string> {
    const parent = join(this.root, 'previews');
    const dir = join(parent, validateId(templateId));
    if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
    await this.ordinary(parent, 'directory');
    if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.ordinary(dir, 'directory');
    return dir;
  }

  async publishPreview(templateId: string, runId: string): Promise<void> {
    const root = this.previewRun(runId);
    await this.ordinary(dirname(root), 'directory');
    await this.ordinary(root, 'directory');
    const output = join(root, 'output');
    await this.ordinary(output, 'directory');
    const file = await open(
      join(output, 'preview.webp'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 2 * 1024 * 1024 ||
        info.size < 12
      )
        throw new Error('Invalid preview output');
      bytes = await file.readFile();
      if (
        bytes.length > 2 * 1024 * 1024 ||
        !bytes.subarray(0, 4).equals(Buffer.from('RIFF')) ||
        !bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
      )
        throw new Error('Invalid preview output');
    } finally {
      await file.close();
    }
    const dir = await this.previewDirectory(templateId, true);
    const temp = join(dir, `.preview-${randomUUID()}`);
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temp, join(dir, 'preview.webp'));
    } finally {
      await rm(temp, { force: true });
    }
  }

  async openTemplatePreview(templateId: string): Promise<Readable> {
    const dir = await this.previewDirectory(templateId);
    const file = await open(
      join(dir, 'preview.webp'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) {
      await file.close();
      throw new Error('Invalid preview file');
    }
    return file.createReadStream();
  }

  async templatePreviewExists(templateId: string): Promise<boolean> {
    try {
      const stream = await this.openTemplatePreview(templateId);
      stream.destroy();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async removeTemplatePreview(templateId: string): Promise<void> {
    try {
      const dir = await this.previewDirectory(templateId);
      await rm(dir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async listPreviewRuns(): Promise<string[]> {
    const parent = join(this.root, 'preview-runs');
    try {
      await this.ordinary(parent, 'directory');
      const names = await readdir(parent);
      for (const name of names) {
        validateId(name);
        await this.ordinary(join(parent, name), 'directory');
      }
      return names;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async cleanupPreviewRun(runId: string): Promise<void> {
    const root = this.previewRun(runId);
    try {
      await this.ordinary(dirname(root), 'directory');
      await this.ordinary(root, 'directory');
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async jobInputExists(jobId: string): Promise<boolean> {
    try {
      const input = join(this.job(jobId), 'input');
      await this.ordinary(input, 'directory');
      await this.ordinary(join(input, 'data.json'), 'file');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async stageResource(
    jobId: string,
    storedName: string,
    temporaryPath: string,
  ): Promise<void> {
    await this.locked(`resource:${jobId}`, async () => {
      await this.stagedFile(temporaryPath);
      try {
        validateSegments([storedName]);
        const dir = join(this.job(jobId), 'input', 'resources');
        await this.ordinary(dir, 'directory');
        let total = 0;
        for (const name of await readdir(dir)) {
          validateSegments([name]);
          const path = join(dir, name);
          await this.ordinary(path, 'file');
          total += (await lstat(path)).size;
        }
        const size = await this.stagedFile(temporaryPath);
        if (size > FILE_LIMIT || size > WORKSPACE_LIMIT - total)
          throw new StorageError('File size limit exceeded');
        const destination = join(dir, storedName);
        try {
          await lstat(destination);
          throw new StorageError('Path already exists', 'ALREADY_EXISTS');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(temporaryPath, destination);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  }

  async prepareJobOutput(
    jobId: string,
  ): Promise<{ input: string; output: string }> {
    const root = this.job(jobId);
    await this.ordinary(root, 'directory');
    const input = join(root, 'input');
    await this.ordinary(input, 'directory');
    const output = join(root, 'output');
    await mkdir(output, { mode: 0o700 });
    return { input, output };
  }

  async removePdfs(jobId: string): Promise<void> {
    await rm(this.pdf(jobId), { recursive: true, force: true });
  }

  async savePdf(
    jobId: string,
    source: string,
    filename: string,
  ): Promise<string> {
    validateId(jobId);
    if (
      !filename.endsWith('.pdf') ||
      filename !== `${validateId(filename.slice(0, -4))}.pdf`
    )
      throw new Error('Invalid PDF filename');
    const output = join(this.job(jobId), 'output');
    const resolved = resolve(source);
    if (dirname(resolved) !== output) throw new Error('PDF outside job output');
    await this.ordinary(output, 'directory');
    await this.ordinary(resolved, 'file');
    const dir = this.pdf(jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.ordinary(dir, 'directory');
    const target = join(dir, filename);
    await rename(resolved, target);
    return target;
  }

  async openPdf(jobId: string, filename: string): Promise<Readable> {
    validateId(jobId);
    if (
      !filename.endsWith('.pdf') ||
      filename !== `${validateId(filename.slice(0, -4))}.pdf`
    )
      throw new Error('Invalid PDF filename');
    const path = join(this.pdf(jobId), filename);
    await this.ordinary(this.pdf(jobId), 'directory');
    await this.ordinary(path, 'file');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) {
      await file.close();
      throw new Error('Unsupported filesystem entry');
    }
    return file.createReadStream();
  }

  async cleanupJob(jobId: string): Promise<void> {
    await rm(this.job(jobId), { recursive: true, force: true });
  }
}
