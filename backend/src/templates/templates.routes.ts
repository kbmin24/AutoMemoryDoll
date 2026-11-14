import { beginAction, markActionSuccess } from '../logging/http.js';
import { Router } from 'express';
import { body, checkExact, param } from 'express-validator';
import { requireCsrf, requireUser, type AuthRequest } from '../auth/auth.middleware.js';
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
import { workspaceRoutes } from './workspace.routes.js';
import { generationRoutes } from '../jobs/jobs.routes.js';
import { templateResourceAliases, type QueuePublisher } from '../jobs/jobs.service.js';

function userId(request: AuthRequest): string {
  return request.currentUser!.id;
}

export function templatesRoutes(
  db: Database,
  config: AuthConfig,
  storage: FileSystemStorage,
  queue?: QueuePublisher,
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
      markActionSuccess(response, { templateId: template.id });
      response.status(201).json({ template });
    },
  );

  const id = param('id').matches(ACCOUNT_ID_PATTERN);
  router.get('/:id', id, checkExact(), validateRequest, async (request, response) => {
    beginAction(response);
    const template = await getTemplate(db, userId(request), String(request.params.id));
    response.json({ template: templateDto(template) });
  });

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
      response.json({ aliases: await templateResourceAliases(storage, templateId) });
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
      const template = await updateTemplate(
        db,
        userId(request),
        String(request.params.id),
        request.body,
      );
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
      await softDeleteTemplate(db, storage, userId(request), String(request.params.id));
      markActionSuccess(response, { templateId: String(request.params.id) });
      response.status(204).end();
    },
  );

  router.use('/:id/files', workspaceRoutes(db, config, storage));
  if (queue) router.use('/:id/generations', generationRoutes(db, config, storage, queue));
  return router;
}
