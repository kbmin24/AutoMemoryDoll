import express from 'express';
import { requestLogging, logRequestError, failAction } from './logging/http.js';
import { silentLogger, type Logger } from './logging/logger.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { authRoutes } from './auth/auth.routes.js';
import { adminRoutes, ownerRoutes } from './users/users.routes.js';
import { AccountError } from './users/users.service.js';
import type { AuthConfig } from './auth/auth.service.js';
import { FileSystemStorage } from './storage/filesystem-storage.js';
import { templatesRoutes } from './templates/templates.routes.js';
import { TemplateError } from './templates/templates.errors.js';
import { StorageError } from './storage/storage.errors.js';
import multer from 'multer';
import { jobsRoutes } from './jobs/jobs.routes.js';
import { JobError } from './jobs/jobs.errors.js';
import type { QueuePublisher } from './jobs/jobs.service.js';

export function createApp(
  db: PrismaClient,
  config: AuthConfig,
  storage = new FileSystemStorage(process.env.STORAGE_ROOT ?? './data'),
  queue?: QueuePublisher,
  logger: Logger = silentLogger,
  trustedProxies: string[] = [],
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustedProxies);
  app.use(requestLogging(logger));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes(db, config));
  app.use('/api/admin', adminRoutes(db, config));
  app.use('/api/owner', ownerRoutes(db, config));
  app.use('/api/templates', templatesRoutes(db, config, storage, queue));
  if (queue) app.use('/api/jobs', jobsRoutes(db, config, storage));
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      const reply = (status: number, message: string) => {
        failAction(response, status);
        return response.status(status).json({ error: message });
      };
      if (response.headersSent) {
        logRequestError(logger, response, error);
        failAction(response, 500);
        response.destroy();
        return;
      }
      if (error instanceof AccountError) return reply(error.status, error.message);
      if (error instanceof TemplateError) return reply(error.status, error.publicMessage);
      if (error instanceof JobError) return reply(error.status, error.message);
      if (error instanceof multer.MulterError) return reply(400, 'Invalid upload');
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return reply(404, 'File not found');
      if (error instanceof StorageError) return reply(400, 'Invalid workspace operation');
      logRequestError(logger, response, error);
      return reply(500, 'Internal server error');
    },
  );
  return app;
}
