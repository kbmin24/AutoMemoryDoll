import { randomUUID } from 'node:crypto';
import multer from 'multer';
import type { FileSystemStorage } from './filesystem-storage.js';

const fileLimit = 20 * 1024 * 1024;

export function createUploadMiddleware(
  storage: FileSystemStorage,
  limits: multer.Options['limits'] = {},
) {
  return multer({
    storage: multer.diskStorage({
      destination(_request, _file, callback) {
        void storage.uploadStagingDirectory().then(
          (directory) => callback(null, directory),
          (error) => callback(error as Error, ''),
        );
      },
      filename(_request, _file, callback) {
        callback(null, randomUUID());
      },
    }),
    limits: { fileSize: fileLimit, files: 1, ...limits },
  });
}
