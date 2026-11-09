import {
  beginAction,
  markActionSuccess,
  logDownload,
} from '../logging/http.js';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type RequestHandler } from 'express';
import { body, checkExact, param } from 'express-validator';
import { requireCsrf, type AuthRequest } from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import type { Database } from '../users/users.repository.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { validateSegments } from '../storage/paths.js';
import { createUploadMiddleware } from '../storage/multer-upload.js';
import { ACCOUNT_ID_PATTERN, validateRequest } from '../validation.js';
import { getTemplate, TemplateError } from './templates.service.js';

function segments(value: unknown): string[] {
  try {
    return validateSegments(value as string[]);
  } catch {
    throw new TemplateError('Invalid path');
  }
}

function querySegments(request: Request): string[] {
  const values = request.query.segments;
  return segments(typeof values === 'string' ? [values] : values);
}

function exactQuery(request: Request): void {
  if (Object.keys(request.query).some((key) => key !== 'segments'))
    throw new TemplateError('Invalid request');
}

export function workspaceRoutes(
  db: Database,
  config: AuthConfig,
  storage: FileSystemStorage,
) {
  const router = Router({ mergeParams: true });
  const upload = createUploadMiddleware(storage);
  const owned: RequestHandler = async (request, _response, next) => {
    try {
      await getTemplate(
        db,
        (request as AuthRequest).currentUser!.id,
        String(request.params.id),
      );
      next();
    } catch (error) {
      next(error);
    }
  };
  router.use(param('id').matches(ACCOUNT_ID_PATTERN), validateRequest, owned);

  router.get(
    '/',
    checkExact([], { locations: ['body', 'query'] }),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      response.json({
        files: await storage.listTemplateTree(String(request.params.id)),
      });
    },
  );

  router.post(
    '/directories',
    requireCsrf(config),
    body('segments').isArray({ min: 1 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await storage.createDirectory(
        String(request.params.id),
        segments(request.body.segments),
      );
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(201).end();
    },
  );

  router.get('/text', async (request: Request, response) => {
    beginAction(response);
    exactQuery(request);
    response.json({
      text: await storage.readText(
        String(request.params.id),
        querySegments(request),
      ),
    });
  });

  router.put(
    '/text',
    requireCsrf(config),
    body('segments').isArray({ min: 1 }),
    body('text').isString(),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await storage.writeText(
        String(request.params.id),
        segments(request.body.segments),
        request.body.text,
      );
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(204).end();
    },
  );

  router.post(
    '/uploads',
    requireCsrf(config),
    upload.single('file'),
    async (request, response) => {
      beginAction(response);
      if (!request.file) throw new TemplateError('File is required');
      try {
        if (
          Object.keys(request.body).length !== 1 ||
          typeof request.body.segments !== 'string' ||
          Object.keys(request.query).length
        ) {
          throw new TemplateError('Invalid upload');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.body.segments);
        } catch {
          throw new TemplateError('Invalid path');
        }
        await storage.moveUpload(
          String(request.params.id),
          segments(parsed),
          request.file.path,
        );
        markActionSuccess(response, { templateId: String(request.params.id) });
        response.status(201).end();
      } finally {
        await rm(request.file.path, { force: true });
      }
    },
  );

  router.get('/download', async (request: Request, response) => {
    beginAction(response);
    exactQuery(request);
    const path = querySegments(request);
    const stream = await storage.openDownload(String(request.params.id), path);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.at(-1)}"`,
    );
    await logDownload(response, () => pipeline(stream, response), {
      templateId: String(request.params.id),
    });
  });

  router.post(
    '/move',
    requireCsrf(config),
    body('from').isArray({ min: 1 }),
    body('to').isArray({ min: 1 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await storage.move(
        String(request.params.id),
        segments(request.body.from),
        segments(request.body.to),
      );
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(204).end();
    },
  );

  router.delete(
    '/',
    requireCsrf(config),
    body('segments').isArray({ min: 1 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await storage.delete(
        String(request.params.id),
        segments(request.body.segments),
      );
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(204).end();
    },
  );

  return router;
}
