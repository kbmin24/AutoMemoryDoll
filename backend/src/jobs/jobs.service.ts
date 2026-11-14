import { withTemplateLock } from '../templates/template-lock.js';
import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import { JobError } from './jobs.errors.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ManifestV1 } from '../contracts.js';
import type { Storage } from '../storage/storage.js';
import { validateId } from '../storage/paths.js';
import { getTemplate } from '../templates/templates.service.js';
import type { Database } from '../users/users.repository.js';
import {
  failQueuedJob,
  findOwnedJob,
  insertJob,
  listOwnedJobs,
  listQueuedJobs,
} from './jobs.repository.js';
import {
  findResourceAliases,
  rewriteResourceTokens,
} from './resource-tokens.js';

export { JobError } from './jobs.errors.js';

const aliasPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface QueuePublisher {
  add(jobId: string): Promise<unknown>;
}

export interface ResourceUpload {
  alias: string;
  temporaryPath: string;
  originalName?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateGenerationData(
  manifest: ManifestV1,
  input: unknown,
): Record<string, unknown> {
  if (!isObject(input)) throw new JobError('Invalid generation data');
  if (manifest.shape === null) return input;

  const known = new Set(manifest.shape.fields.map((field) => field.variable));
  if (Object.keys(input).some((key) => !known.has(key))) {
    throw new JobError('Invalid generation data');
  }

  const data: Record<string, unknown> = {};
  for (const field of manifest.shape.fields) {
    const value = input[field.variable];
    if (
      value === undefined ||
      (field.optional && (value === '' || value === null))
    ) {
      if (!field.optional) throw new JobError('Invalid generation data');
      continue;
    }

    if (field.type === 'text' || field.type === 'longtext') {
      if (typeof value !== 'string' || (!field.optional && !value.trim())) {
        throw new JobError('Invalid generation data');
      }
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new JobError('Invalid generation data');
      }
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean')
        throw new JobError('Invalid generation data');
    }
    data[field.variable] = value;
  }
  return data;
}

export async function templateResourceAliases(
  storage: Storage,
  templateId: string,
): Promise<string[]> {
  const texts: string[] = [];
  for (const entry of await storage.listTemplateTree(templateId)) {
    if (entry.kind !== 'file') continue;
    const stream = await storage.openDownload(templateId, entry.segments);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const text = decodeTemplateText(Buffer.concat(chunks));
    if (text !== null) texts.push(text);
  }
  return findResourceAliases(texts);
}

function decodeTemplateText(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export async function textFiles(
  root: string,
): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        const text = decodeTemplateText(bytes);
        if (text !== null) result.push({ path, text });
      }
    }
  };
  await visit(root);
  return result;
}

function storedName(upload: ResourceUpload): string {
  const extension = extname(upload.originalName ?? '');
  const safeExtension = /^\.[A-Za-z0-9]{1,16}$/.test(extension)
    ? extension
    : '';
  return `${randomUUID()}${safeExtension}`;
}

function jobDto(job: {
  id: string;
  templateId: string;
  status: string;
  message: string;
  timestamp: Date;
  pdfFilename?: string | null;
  template?: { name: string };
}) {
  return {
    id: job.id,
    templateId: job.templateId,
    templateName: job.template?.name,
    status: job.status,
    message: job.message,
    timestamp: job.timestamp,
    pdfFilename: job.pdfFilename ?? null,
  };
}

export async function submitGeneration(
  db: Database,
  storage: Storage,
  queue: QueuePublisher,
  input: {
    userId: string;
    templateId: string;
    data: unknown;
    uploads: ResourceUpload[];
  },
  logger: Logger = silentLogger,
) {
  const jobId = randomUUID();
  let preserveSnapshot = false;

  try {
    logger.debug('generation.debug', { jobId, phase: 'snapshot' });
    const { inputDirectory, data } = await withTemplateLock(
      db,
      storage,
      input.templateId,
      input.userId,
      async (_tx, template) => {
        const data = validateGenerationData(template.manifest, input.data);
        const inputDirectory = await storage.snapshot(input.templateId, jobId);
        return { inputDirectory, data };
      },
    );
    const templateDirectory = join(inputDirectory, 'template');
    const files = await textFiles(templateDirectory);
    const main = files.find(
      (file) => file.path === join(templateDirectory, 'template.tex'),
    );
    if (!main?.text.trim()) throw new JobError('Template is empty');

    const aliases = findResourceAliases(files.map((file) => file.text));
    const supplied = new Map<string, ResourceUpload>();
    for (const upload of input.uploads) {
      if (!aliasPattern.test(upload.alias) || supplied.has(upload.alias)) {
        throw new JobError('Invalid resource upload');
      }
      supplied.set(upload.alias, upload);
    }
    if (
      aliases.length !== supplied.size ||
      aliases.some((alias) => !supplied.has(alias))
    ) {
      throw new JobError('Required resource upload is missing');
    }

    const paths: Record<string, string> = {};
    for (const alias of aliases) {
      const upload = supplied.get(alias)!;
      const name = storedName(upload);
      await storage.stageResource(jobId, name, upload.temporaryPath);
      paths[alias] = `../resources/${name}`;
    }
    for (const file of files) {
      await writeFile(file.path, rewriteResourceTokens(file.text, paths));
    }
    await writeFile(join(inputDirectory, 'data.json'), JSON.stringify(data));

    const job = await insertJob(db, {
      id: jobId,
      userId: input.userId,
      templateId: input.templateId,
    });
    try {
      logger.debug('generation.debug', { jobId, phase: 'queue' });
      await queue.add(jobId);
    } catch {
      preserveSnapshot = true;
      const failed = await failQueuedJob(
        db,
        jobId,
        'Could not queue generation',
      );
      preserveSnapshot = failed.count === 0;
      throw new JobError('Could not queue generation', 503);
    }
    return jobDto(job);
  } catch (error) {
    if (!preserveSnapshot) {
      await storage.cleanupJob(jobId).catch(() => undefined);
    }
    throw error;
  }
}

export async function getJob(db: Database, userId: string, jobId: string) {
  try {
    validateId(jobId);
  } catch {
    throw new JobError('Job not found', 404);
  }
  const job = await findOwnedJob(db, userId, jobId);
  if (!job) throw new JobError('Job not found', 404);
  return jobDto(job);
}

export async function listJobs(db: Database, userId: string) {
  return (await listOwnedJobs(db, userId)).map(jobDto);
}

export async function reconcileQueuedJobs(
  db: Database,
  storage: Storage,
  queue: QueuePublisher,
  logger: Logger = silentLogger,
): Promise<void> {
  for (const job of await listQueuedJobs(db)) {
    if (!(await storage.jobInputExists(job.id))) {
      await failQueuedJob(db, job.id, 'Job input is unavailable');
      continue;
    }
    try {
      await queue.add(job.id);
    } catch (error) {
      logger.error('queue.reconciliation_failed', {
        jobId: job.id,
        ...safeError(error),
      });
    }
  }
}
