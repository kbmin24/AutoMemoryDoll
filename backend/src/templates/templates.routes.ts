import {
  schedulePreviewAfterSave,
  type PreviewScheduler,
} from './template-preview.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import { pipeline } from 'node:stream/promises';
import { beginAction, markActionSuccess } from '../logging/http.js';
import { Router } from 'express';
import { body, checkExact, param } from 'express-validator';
import {
  requireCsrf,
  requireUser,
  type AuthRequest,
} from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import type { Database } from '../users/users.repository.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { ACCOUNT_ID_PATTERN, validateRequest } from '../validation.js';
import {
  createTemplate,
  getTemplate,
  listTemplates,
  softDeleteTemplate,
  templateDto,
  updateTemplate,
} from './templates.service.js';
import { AiDraftError, type AiDraftService } from '../ai/ai.service.js';
import { validateManifest } from './shape.js';
import { workspaceRoutes } from './workspace.routes.js';
import { generationRoutes } from '../jobs/jobs.routes.js';
import { recordTemplateView } from './templates.repository.js';
import {
  templateResourceAliases,
  type QueuePublisher,
} from '../jobs/jobs.service.js';

function userId(request: AuthRequest): string {
  return request.currentUser!.id;
}

export function templatesRoutes(
  db: Database,
  config: AuthConfig,
  storage: FileSystemStorage,
  queue?: QueuePublisher,
  previews?: PreviewScheduler,
  logger: Logger = silentLogger,
  ai?: AiDraftService,
) {
  const router = Router();
  router.use(requireUser(db, config));

  router.get('/', checkExact(), validateRequest, async (request, response) => {
    beginAction(response);
    response.json({ templates: await listTemplates(db, userId(request)) });
  });

  router.post(
    '/',
    requireCsrf(config),
    body('name').isString().notEmpty().isLength({ max: 200 }),
    body('manifest')
      .exists()
      .custom((value) => typeof value === 'object' && value !== null),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const template = await createTemplate(
        db,
        storage,
        userId(request),
        request.body.name,
        request.body.manifest,
      );
      await schedulePreviewAfterSave(previews, template.id, logger);
      markActionSuccess(response, { templateId: template.id });
      response.status(201).json({ template });
    },
  );

  const id = param('id').matches(ACCOUNT_ID_PATTERN);
  router.get(
    '/:id/preview',
    id,
    checkExact([], { locations: ['body', 'query'] }),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const templateId = String(request.params.id);
      await getTemplate(db, userId(request), templateId);
      const stream = await storage.openTemplatePreview(templateId);
      response.set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      await pipeline(stream, response);
    },
  );
  router.get(
    '/:id',
    id,
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const template = await getTemplate(
        db,
        userId(request),
        String(request.params.id),
      );
      response.json({ template: templateDto(template) });
    },
  );

  router.get(
    '/:id/resources',
    id,
    checkExact([], { locations: ['body', 'query'] }),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const templateId = String(request.params.id);
      await getTemplate(db, userId(request), templateId);
      response.set('Cache-Control', 'private, no-store');
      response.json({
        aliases: await templateResourceAliases(storage, templateId),
      });
    },
  );

  router.post(
    '/:id/view',
    requireCsrf(config),
    id,
    checkExact([], { locations: ['body', 'query'] }),
    validateRequest,
    async (request, response) => {
      const viewerId = userId(request);
      const template = await getTemplate(
        db,
        viewerId,
        String(request.params.id),
      );
      await recordTemplateView(db, viewerId, template.id);
      response.json({ template: templateDto(template) });
    },
  );

  router.patch(
    '/:id',
    requireCsrf(config),
    id,
    body('name').optional().isString().notEmpty().isLength({ max: 200 }),
    body('manifest')
      .optional()
      .custom((value) => typeof value === 'object' && value !== null),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      let shapeChanged = false;
      const template = await updateTemplate(
        db,
        storage,
        userId(request),
        String(request.params.id),
        request.body,
        () => {
          shapeChanged = true;
        },
      );
      if (shapeChanged)
        await schedulePreviewAfterSave(previews, template.id, logger);
      markActionSuccess(response, { templateId: template.id });
      response.json({ template });
    },
  );

  router.delete(
    '/:id',
    requireCsrf(config),
    id,
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await softDeleteTemplate(
        db,
        storage,
        userId(request),
        String(request.params.id),
      );
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(204).end();
    },
  );

  router.post(
    '/:id/ai/draft',
    requireCsrf(config),
    id,
    body('pageSize')
      .if((_value, { req }) => req.body?.source === undefined)
      .isString()
      .isIn(['A4', 'Letter']),
    body('orientation')
      .if((_value, { req }) => req.body?.source === undefined)
      .isString()
      .isIn(['portrait', 'landscape']),
    body('source')
      .optional()
      .isString()
      .bail()
      .custom(
        (source, { req }) =>
          Boolean(source.trim()) &&
          req.body.pageSize === undefined &&
          req.body.orientation === undefined,
      ),
    body('description')
      .isString()
      .bail()
      .trim()
      .isLength({ min: 1, max: 4000 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const ownerId = userId(request);
      const template = await getTemplate(
        db,
        ownerId,
        String(request.params.id),
      );
      if (!ai) throw new AiDraftError();
      const { shape } = validateManifest(template.manifest);
      const result = await ai.draft(ownerId, request.body, {
        name: template.name,
        shape,
      });
      response.set('Cache-Control', 'private, no-store').json(result);
    },
  );

  router.use(
    '/:id/files',
    workspaceRoutes(db, config, storage, previews, logger),
  );
  if (queue)
    router.use(
      '/:id/generations',
      generationRoutes(db, config, storage, queue),
    );
  return router;
}
