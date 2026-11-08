import { beginAction, markActionSuccess } from '../logging/http.js';
import { Router } from 'express';
import { body, checkExact } from 'express-validator';
import type { Database } from '../users/users.repository.js';
import { publicUser } from '../users/users.repository.js';
import {
  changePassword,
  authenticate,
  cookieName,
  csrfToken,
  issueSession,
  type AuthConfig,
} from './auth.service.js';
import { requireCsrf, requireUser, type AuthRequest } from './auth.middleware.js';
import { USERNAME_PATTERN, validateRequest } from '../validation.js';

export function authRoutes(db: Database, config: AuthConfig) {
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
      const user = await authenticate(db, request.body?.username, request.body?.password);
      const session = await issueSession(config, user);
      markActionSuccess(response, { actorId: user.id });
      response.cookie(cookieName, session.token, {
        ...cookieOptions,
        maxAge: config.cookieHours * 3600_000,
      });
      response.json({ user: publicUser(user), csrfToken: session.csrfToken });
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
