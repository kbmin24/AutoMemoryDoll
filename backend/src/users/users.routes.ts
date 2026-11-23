import { beginAction, markActionSuccess } from '../logging/http.js';
import { Router } from 'express';
import { createAiQuotaRepository } from '../ai/ai-quota.repository.js';
import { aiQuotaRoutes } from '../ai/ai-quota.routes.js';
import { body, checkExact, param } from 'express-validator';
import type { Database } from './users.repository.js';
import { listUsers } from './users.repository.js';
import { createRegularUser, setDisabled, setRole } from './users.service.js';
import {
  requireAdmin,
  requireCsrf,
  requireOwner,
  requireUser,
} from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import {
  ACCOUNT_ID_PATTERN,
  DISPLAY_NAME_PATTERN,
  USERNAME_PATTERN,
  validateAccountId,
  validateRequest,
} from '../validation.js';

import {
  apiSystemInformation,
  type DockerStatus,
} from '../system/system-information.js';

export function adminRoutes(
  db: Database,
  config: AuthConfig,
  readDockerStatus?: () => Promise<DockerStatus | null>,
) {
  const router = Router();
  router.use(requireUser(db, config), requireAdmin());
  router.get('/system-information', async (_request, response) => {
    const [system, docker] = await Promise.all([
      apiSystemInformation(),
      readDockerStatus?.().catch(() => null),
    ]);
    response.set('Cache-Control', 'private, no-store').json({
      system,
      docker: docker ?? null,
    });
  });
  router.use('/ai/quotas', aiQuotaRoutes(db, config));
  router.get(
    '/ai/usage',
    checkExact(),
    validateRequest,
    async (_request, response) => {
      const { usedTokens, ...quota } =
        await createAiQuotaRepository(db).getAppUsage();
      response.set('Cache-Control', 'private, no-store').json({
        usedTokens: usedTokens.toString(),
        ...quota,
      });
    },
  );
  router.patch(
    '/ai/enabled',
    requireCsrf(config),
    body('enabled').custom((value) => typeof value === 'boolean'),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const { enabled } = request.body;
      await createAiQuotaRepository(db).setEnabled(enabled);
      markActionSuccess(response);
      response.set('Cache-Control', 'private, no-store').json({ enabled });
    },
  );
  router.get(
    '/users',
    checkExact(),
    validateRequest,
    async (_request, response) => response.json({ users: await listUsers(db) }),
  );
  router.post(
    '/users',
    requireCsrf(config),
    body('username').notEmpty().isString().matches(USERNAME_PATTERN),
    body('displayId').optional().isString().matches(DISPLAY_NAME_PATTERN),
    body('password').notEmpty().isString().isLength({ min: 12, max: 1024 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const user = await createRegularUser(
        db,
        request.body?.username,
        request.body?.password,
        request.body?.displayId,
      );
      markActionSuccess(response, { targetId: user.id });
      response.status(201).json({ user });
    },
  );
  router.patch(
    '/users/:id',
    requireCsrf(config),
    param('id').matches(ACCOUNT_ID_PATTERN),
    validateAccountId,
    body('disabled').custom((value) => typeof value === 'boolean'),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const user = await setDisabled(
        db,
        String(request.params.id),
        request.body?.disabled,
      );
      markActionSuccess(response, { targetId: String(request.params.id) });
      response.json({ user });
    },
  );
  return router;
}

export function ownerRoutes(db: Database, config: AuthConfig) {
  const router = Router();
  router.use(requireUser(db, config), requireOwner());
  router.patch(
    '/users/:id/role',
    requireCsrf(config),
    param('id').matches(ACCOUNT_ID_PATTERN),
    validateAccountId,
    body('role').isString().isIn(['user', 'admin']),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const user = await setRole(
        db,
        String(request.params.id),
        request.body?.role,
      );
      markActionSuccess(response, { targetId: String(request.params.id) });
      response.json({ user });
    },
  );
  return router;
}
