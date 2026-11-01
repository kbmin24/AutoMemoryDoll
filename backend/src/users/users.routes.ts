import { Router } from 'express';
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
  USERNAME_PATTERN,
  validateAccountId,
  validateRequest,
} from '../validation.js';

export function adminRoutes(db: Database, config: AuthConfig) {
  const router = Router();
  router.use(requireUser(db, config), requireAdmin());
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
    body('password').notEmpty().isString().isLength({ min: 12, max: 1024 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const user = await createRegularUser(
        db,
        request.body?.username,
        request.body?.password,
      );
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
      response.json({
        user: await setDisabled(
          db,
          String(request.params.id),
          request.body?.disabled,
        ),
      });
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
      response.json({
        user: await setRole(db, String(request.params.id), request.body?.role),
      });
    },
  );
  return router;
}
