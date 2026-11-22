import { createAiQuotaRepository } from '../ai/ai-quota.repository.js';
import type { AiDraftService } from '../ai/ai.service.js';
import { beginAction, markActionSuccess } from '../logging/http.js';
import { Router } from 'express';
import { body, checkExact } from 'express-validator';
import type { Database } from '../users/users.repository.js';
import {
  changePassword,
  authenticate,
  cookieName,
  csrfToken,
  issueSession,
  sessionUser,
  type AuthConfig,
} from './auth.service.js';
import {
  requireCsrf,
  requireUser,
  type AuthRequest,
} from './auth.middleware.js';
import {
  DISPLAY_NAME_PATTERN,
  USERNAME_PATTERN,
  validateRequest,
} from '../validation.js';

export function authRoutes(
  db: Database,
  config: AuthConfig,
  ai?: AiDraftService,
) {
  const router = Router();
  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure ?? true,
    sameSite: 'strict' as const,
    path: '/',
  };

  router.post(
    '/login',
    body('username').notEmpty().isString().matches(USERNAME_PATTERN),
    body('password').notEmpty().isString().isLength({ min: 12, max: 1024 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const user = await authenticate(
        db,
        request.body?.username,
        request.body?.password,
      );
      const session = await issueSession(config, user);
      markActionSuccess(response, { actorId: user.id });
      response.cookie(cookieName, session.token, {
        ...cookieOptions,
        maxAge: config.cookieHours * 3600_000,
      });
      response.json({ user: sessionUser(user), csrfToken: session.csrfToken });
    },
  );

  router.get(
    '/me',
    requireUser(db, config),
    checkExact(),
    validateRequest,
    (request, response) => {
      const auth = request as AuthRequest;
      response.json({
        user: auth.currentUser,
        csrfToken: csrfToken(config, auth.sessionJti!),
      });
    },
  );

  router.patch(
    '/display-id',
    requireUser(db, config),
    requireCsrf(config),
    body('displayId').isString().matches(DISPLAY_NAME_PATTERN),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const { id } = (request as AuthRequest).currentUser!;
      const { displayId } = await db.user.update({
        where: { id },
        data: { displayId: request.body.displayId },
        select: { displayId: true },
      });
      markActionSuccess(response);
      response.set('Cache-Control', 'private, no-store').json({ displayId });
    },
  );

  router.get(
    '/ai-status',
    requireUser(db, config),
    checkExact(),
    validateRequest,
    async (_request, response) => {
      const enabled = ai ? await ai.isEnabled() : false;
      response.set('Cache-Control', 'private, no-store').json({ enabled });
    },
  );

  router.get(
    '/ai-usage',
    requireUser(db, config),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const userId = (request as AuthRequest).currentUser!.id;
      const percentUsed =
        await createAiQuotaRepository(db).getUserUsagePercent(userId);
      response.set('Cache-Control', 'private, no-store').json({ percentUsed });
    },
  );

  router.post(
    '/logout',
    requireUser(db, config),
    requireCsrf(config),
    checkExact(),
    validateRequest,
    (_request, response) => {
      markActionSuccess(response);
      response.clearCookie(cookieName, cookieOptions);
      response.status(204).end();
    },
  );

  router.post(
    '/password',
    requireUser(db, config),
    requireCsrf(config),
    body('currentPassword').isString().notEmpty().isLength({ max: 1024 }),
    body('newPassword').notEmpty().isString().isLength({ min: 12, max: 1024 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      await changePassword(
        db,
        (request as AuthRequest).currentUser!.id,
        request.body?.currentPassword,
        request.body?.newPassword,
      );
      markActionSuccess(response);
      response.clearCookie(cookieName, cookieOptions);
      response.status(200).json({ message: 'Password changed' });
    },
  );
  return router;
}
