import { pipeline } from 'node:stream/promises';
import { rm } from 'node:fs/promises';
import { Router, type RequestHandler } from 'express';
import { body, checkExact, param, validationResult } from 'express-validator';
import { requireCsrf, requireUser, type AuthRequest } from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { getTemplate } from '../templates/templates.service.js';
import type { Database } from '../users/users.repository.js';
import { ACCOUNT_ID_PATTERN, validateRequest } from '../validation.js';
import {
  getJob,
  JobError,
  listJobs,
  submitGeneration,
  type QueuePublisher,
  type ResourceUpload,
} from './jobs.service.js';
import { createGenerationUploadMiddleware } from './upload.js';

function userId(request: AuthRequest): string {
  return request.currentUser!.id;
}

function stagedFiles(request: AuthRequest): Express.Multer.File[] {
  return (request.files ?? []) as Express.Multer.File[];
}

async function cleanupUploads(request: AuthRequest): Promise<void> {
  await Promise.all(stagedFiles(request).map((file) => rm(file.path, { force: true })));
}

function generationData(request: AuthRequest): unknown {
  if (
    Object.keys(request.query).length ||
    Object.keys(request.body ?? {}).length !== 1 ||
    !Object.hasOwn(request.body, 'data')
  ) {
    throw new JobError('Invalid generation request');
  }
  if (request.is('multipart/form-data')) {
    if (typeof request.body.data !== 'string') {
      throw new JobError('Invalid generation data');
    }
    try {
      return JSON.parse(request.body.data);
    } catch {
      throw new JobError('Invalid generation data');
    }
  }
  if (!request.is('application/json')) {
    throw new JobError('Invalid generation request');
  }
  return request.body.data;
}

export function generationRoutes(
  db: Database,
  config: AuthConfig,
  storage: FileSystemStorage,
  queue: QueuePublisher,
) {
  const router = Router({ mergeParams: true });
  const upload = createGenerationUploadMiddleware(storage);

  const owned: RequestHandler = async (request, _response, next) => {
    try {
      await getTemplate(db, userId(request as AuthRequest), String(request.params.id));
      next();
    } catch (error) {
      next(error);
    }
  };

  router.post(
    '/',
    requireCsrf(config),
    owned,
    upload.any(),
    body('data').exists(),
    checkExact(),
    async (request, _response, next) => {
      if (!validationResult(request).isEmpty()) {
        await cleanupUploads(request as AuthRequest);
      }
      next();
    },
    validateRequest,
    async (request, response) => {
      const files = stagedFiles(request as AuthRequest);
      try {
        const data = generationData(request as AuthRequest);
        const uploads: ResourceUpload[] = files.map((file) => ({
          alias: file.fieldname,
          temporaryPath: file.path,
          originalName: file.originalname,
        }));
        if (!ACCOUNT_ID_PATTERN.test(String(request.params.id))) {
          throw new JobError('Template not found', 404);
        }
        const job = await submitGeneration(db, storage, queue, {
          userId: userId(request as AuthRequest),
          templateId: String(request.params.id),
          data,
          uploads,
        });
        response.status(201).json({ job });
      } finally {
        await cleanupUploads(request as AuthRequest);
      }
    },
  );
  return router;
}

export function jobsRoutes(db: Database, config: AuthConfig, storage: FileSystemStorage) {
  const router = Router();
  router.use(requireUser(db, config));
  router.get('/', checkExact(), validateRequest, async (request, response) => {
    response.json({ jobs: await listJobs(db, userId(request as AuthRequest)) });
  });
  router.get(
    '/:id',
    param('id').matches(ACCOUNT_ID_PATTERN),
    checkExact(),
    validateRequest,
    async (request, response) => {
      response.json({
        job: await getJob(db, userId(request as AuthRequest), String(request.params.id)),
      });
    },
  );
  router.get(
    '/:id/pdf',
    param('id').matches(ACCOUNT_ID_PATTERN),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const job = await getJob(db, userId(request as AuthRequest), String(request.params.id));
      if (job.status !== 'ok' || !job.pdfFilename) throw new JobError('Job not found', 404);
      const stream = await storage.openPdf(job.id, job.pdfFilename);
      response.type('application/pdf');
      response.attachment(job.pdfFilename);
      response.set('Cache-Control', 'private, no-store');
      response.set('X-Content-Type-Options', 'nosniff');
      await pipeline(stream, response);
    },
  );
  return router;
}
