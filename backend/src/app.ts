import express from 'express';
import type { PrismaClient } from './generated/prisma/client.js';
import { authRoutes } from './auth/auth.routes.js';
import { adminRoutes, ownerRoutes } from './users/users.routes.js';
import { AccountError } from './users/users.service.js';
import type { AuthConfig } from './auth/auth.service.js';
import { FileSystemStorage } from './storage/filesystem-storage.js';
import { templatesRoutes } from './templates/templates.routes.js';
import { TemplateError } from './templates/templates.service.js';
import multer from 'multer';
import { jobsRoutes } from './jobs/jobs.routes.js';
import { JobError, type QueuePublisher } from './jobs/jobs.service.js';

export function createApp(
  db: PrismaClient,
  config: AuthConfig,
  storage = new FileSystemStorage(process.env.STORAGE_ROOT ?? './data'),
  queue?: QueuePublisher,
) {
  const app = express();
  app.disable('x-powered-by');
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
      if (response.headersSent) return next(error);
      if (error instanceof AccountError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof TemplateError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof JobError)
        return response.status(error.status).json({ error: error.message });
      if (error instanceof multer.MulterError)
        return response.status(400).json({ error: 'Invalid upload' });
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return response.status(404).json({ error: 'File not found' });
      if (
        error instanceof Error &&
        (error.message.startsWith('Invalid ') ||
          error.message.startsWith('Cannot ') ||
          error.message.includes('limit') ||
          error.message.includes('Path already exists') ||
          error.message.includes('editable text'))
      )
        return response.status(400).json({ error: 'Invalid workspace operation' });
      console.error(error);
      return response.status(500).json({ error: 'Internal server error' });
    },
  );
  return app;
}
