import { Router } from 'express';
import { body, checkExact } from 'express-validator';
import { requireCsrf } from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import { beginAction, markActionSuccess } from '../logging/http.js';
import type { Database } from '../users/users.repository.js';
import { validateRequest } from '../validation.js';
import {
  createAiQuotaRepository,
  isTokenLimit,
  type QuotaLimits,
} from './ai-quota.repository.js';

const limitFields = ['appMonthlyTokens', 'userMonthlyTokens'] as const;

export function aiQuotaRoutes(db: Database, config: AuthConfig) {
  const router = Router();
  const quota = createAiQuotaRepository(db);

  router.get('/', async (_request, response) => {
    response.json(await quota.getLimits());
  });

  router.patch(
    '/',
    requireCsrf(config),
    checkExact(
      limitFields.map((field) => body(field).optional().custom(isTokenLimit)),
      { locations: ['body'] },
    ),
    body().custom(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        limitFields.some((field) => Object.hasOwn(value, field)),
    ),
    validateRequest,
    async (request, response) => {
      beginAction(response);
      const limits: Partial<QuotaLimits> = {};
      for (const field of limitFields) {
        if (Object.hasOwn(request.body, field))
          limits[field] = request.body[field];
      }
      const updated = await quota.setLimits(limits);
      markActionSuccess(response, {});
      response.json(updated);
    },
  );

  return router;
}
