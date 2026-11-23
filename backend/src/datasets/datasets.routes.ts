import { readFile, rm } from 'node:fs/promises';
import { Router } from 'express';
import { body, checkExact, param, query } from 'express-validator';
import {
  requireCsrf,
  requireUser,
  type AuthRequest,
} from '../auth/auth.middleware.js';
import type { AuthConfig } from '../auth/auth.service.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { createUploadMiddleware } from '../storage/multer-upload.js';
import type { Database } from '../users/users.repository.js';
import { ACCOUNT_ID_PATTERN, validateRequest } from '../validation.js';
import { csvByteLimit, importDatasetCsv } from './csv-import.js';
import {
  DatasetError,
  getOwnedDataset,
  getOwnedRow,
} from './datasets.repository.js';
import {
  appendRow,
  createDataset,
  datasetDto,
  deleteDataset,
  deleteRow,
  listRows,
  updateDataset,
  updateRow,
  validDatasetName,
} from './datasets.service.js';

function ownerId(request: AuthRequest) {
  return request.currentUser!.id;
}

function pageInteger(value: unknown) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export function datasetsRoutes(
  db: Database,
  config: AuthConfig,
  storage: FileSystemStorage,
) {
  const router = Router();
  router.use(requireUser(db, config));

  const csrf = requireCsrf(config);
  const id = param('id').matches(ACCOUNT_ID_PATTERN);
  const rowId = param('rowId').matches(ACCOUNT_ID_PATTERN);
  const values = body('values').isObject();
  const upload = createUploadMiddleware(storage, {
    fileSize: csvByteLimit + 1,
    fields: 0,
  });

  router.get('/', checkExact(), validateRequest, async (request, response) => {
    const datasets = await db.dataset.findMany({
      where: { ownedBy: ownerId(request) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    response.json({ datasets: datasets.map(datasetDto) });
  });

  router.post(
    '/',
    csrf,
    body('name').custom(validDatasetName),
    body('columns').isArray({ min: 1 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const { name, columns } = request.body;
      const dataset = await createDataset(db, ownerId(request), name, columns);
      response.status(201).json({ dataset: datasetDto(dataset) });
    },
  );

  router.post(
    '/:id/import',
    csrf,
    id,
    checkExact(),
    validateRequest,
    async (request, _response, next) => {
      await getOwnedDataset(db, ownerId(request), String(request.params.id));
      next();
    },
    upload.single('file'),
    async (request, response) => {
      const path = request.file?.path;
      if (!path) throw new DatasetError('CSV file is required');
      let payload: Buffer;
      try {
        payload = await readFile(path);
      } finally {
        await rm(path, { force: true });
      }
      const result = await importDatasetCsv(
        db,
        ownerId(request),
        String(request.params.id),
        payload,
      );
      response.status(201).json(result);
    },
  );

  router.get(
    '/:id',
    id,
    checkExact(),
    validateRequest,
    async (request, response) => {
      const dataset = await getOwnedDataset(
        db,
        ownerId(request),
        String(request.params.id),
      );
      response.json({ dataset: datasetDto(dataset) });
    },
  );

  router.patch(
    '/:id',
    csrf,
    id,
    body('name').optional().custom(validDatasetName),
    body('columns').optional().isArray({ min: 1 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const dataset = await updateDataset(
        db,
        ownerId(request),
        String(request.params.id),
        request.body ?? {},
      );
      response.json({ dataset: datasetDto(dataset) });
    },
  );

  router.delete(
    '/:id',
    csrf,
    id,
    checkExact(),
    validateRequest,
    async (request, response) => {
      await deleteDataset(db, ownerId(request), String(request.params.id));
      response.status(204).end();
    },
  );

  router.get(
    '/:id/rows',
    id,
    query('after')
      .optional()
      .custom(pageInteger)
      .isInt({ min: 0, max: 2147483647 }),
    query('limit').optional().custom(pageInteger).isInt({ min: 1, max: 100 }),
    checkExact(),
    validateRequest,
    async (request, response) => {
      const { after = '0', limit = '50' } = request.query;
      response.json(
        await listRows(
          db,
          ownerId(request),
          String(request.params.id),
          Number(after),
          Number(limit),
        ),
      );
    },
  );

  router.post(
    '/:id/rows',
    csrf,
    id,
    values,
    checkExact(),
    validateRequest,
    async (request, response) => {
      const row = await appendRow(
        db,
        ownerId(request),
        String(request.params.id),
        request.body.values,
      );
      response.status(201).json({ row });
    },
  );

  router.get(
    '/:id/rows/:rowId',
    id,
    rowId,
    checkExact(),
    validateRequest,
    async (request, response) => {
      const row = await getOwnedRow(
        db,
        ownerId(request),
        String(request.params.id),
        String(request.params.rowId),
      );
      response.json({ row });
    },
  );

  router.patch(
    '/:id/rows/:rowId',
    csrf,
    id,
    rowId,
    values,
    checkExact(),
    validateRequest,
    async (request, response) => {
      const row = await updateRow(
        db,
        ownerId(request),
        String(request.params.id),
        String(request.params.rowId),
        request.body.values,
      );
      response.json({ row });
    },
  );

  router.delete(
    '/:id/rows/:rowId',
    csrf,
    id,
    rowId,
    checkExact(),
    validateRequest,
    async (request, response) => {
      await deleteRow(
        db,
        ownerId(request),
        String(request.params.id),
        String(request.params.rowId),
      );
      response.status(204).end();
    },
  );

  return router;
}
