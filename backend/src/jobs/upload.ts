import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { JobError } from './jobs.service.js';

const fileLimit = 20 * 1024 * 1024;
const jobLimit = 100 * 1024 * 1024;

export function createGenerationUploadMiddleware(
  storage: FileSystemStorage,
  totalLimit = jobLimit,
) {
  const totals = new WeakMap<Express.Request, { bytes: number }>();
  const disk: multer.StorageEngine = {
    _handleFile(request, file, callback) {
      void (async () => {
        const directory = await storage.uploadStagingDirectory();
        const path = join(directory, randomUUID());
        const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
        const total = totals.get(request) ?? { bytes: 0 };
        totals.set(request, total);
        file.stream.on('data', (chunk: Buffer) => {
          total.bytes += chunk.length;
          if (total.bytes > totalLimit) {
            file.stream.destroy(new JobError('Job resource size limit exceeded'));
          }
        });
        try {
          await pipeline(file.stream, output);
          callback(null, { path, size: output.bytesWritten });
        } catch (error) {
          await rm(path, { force: true });
          callback(error as Error);
        }
      })().catch((error: unknown) => callback(error as Error));
    },
    _removeFile(_request, file, callback) {
      void rm(file.path, { force: true }).then(
        () => callback(null),
        (error) => callback(error as Error),
      );
    },
  };
  return multer({
    storage: disk,
    limits: { fileSize: fileLimit, files: 256, fields: 1 },
  });
}
