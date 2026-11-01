import express from 'express';
import type { PrismaClient } from './generated/prisma/client.js';
import { authRoutes } from './auth/auth.routes.js';
import { adminRoutes, ownerRoutes } from './users/users.routes.js';
import { AccountError } from './users/users.service.js';
import type { AuthConfig } from './auth/auth.service.js';

export function createApp(db: PrismaClient, config: AuthConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes(db, config));
  app.use('/api/admin', adminRoutes(db, config));
  app.use('/api/owner', ownerRoutes(db, config));
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof AccountError)
        return response.status(error.status).json({ error: error.message });
      console.error(error);
      return response.status(500).json({ error: 'Internal server error' });
    },
  );
  return app;
}
