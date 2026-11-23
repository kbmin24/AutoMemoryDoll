import { databaseSchema } from '../db/prisma.js';
import { Prisma, type Dataset } from '../generated/prisma/client.js';
import type { Database } from '../users/users.repository.js';

export const datasetRowLimit = 1000;

export class DatasetError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function getOwnedDataset(
  db: Database | Prisma.TransactionClient,
  ownedBy: string,
  id: string,
) {
  const dataset = await db.dataset.findUnique({ where: { id, ownedBy } });
  if (!dataset) throw new DatasetError('Dataset not found', 404);
  return dataset;
}

export function withDatasetLock<T>(
  db: Database,
  ownedBy: string,
  id: string,
  action: (tx: Prisma.TransactionClient, dataset: Dataset) => Promise<T>,
) {
  return db.$transaction(async (tx) =>
    action(tx, await lockOwnedDataset(db, tx, ownedBy, id)),
  );
}

export async function lockOwnedDataset(
  db: Database,
  tx: Prisma.TransactionClient,
  ownedBy: string,
  id: string,
) {
  const table = Prisma.raw(
    `"${databaseSchema(db).replaceAll('"', '""')}"."datasets"`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ${table}
      WHERE id = ${id}::uuid AND owned_by = ${ownedBy}::uuid FOR UPDATE`,
  );
  return getOwnedDataset(tx, ownedBy, id);
}

export async function getOwnedRow(
  db: Database | Prisma.TransactionClient,
  ownedBy: string,
  datasetId: string,
  id: string,
) {
  const row = await db.datasetRow.findUnique({
    where: { id, datasetId, dataset: { ownedBy } },
  });
  if (!row) throw new DatasetError('Dataset row not found', 404);
  return row;
}

export async function reserveRowPositions(
  tx: Prisma.TransactionClient,
  datasetId: string,
  count: number,
) {
  // Callers hold the dataset lock through the count, reservation, and insert.
  const currentCount = await tx.datasetRow.count({ where: { datasetId } });
  if (currentCount + count > datasetRowLimit) {
    throw new DatasetError(
      `A dataset can contain at most ${datasetRowLimit} rows`,
      409,
    );
  }

  const { lastPosition } = await tx.dataset.update({
    where: { id: datasetId },
    data: { lastPosition: { increment: count } },
    select: { lastPosition: true },
  });
  return lastPosition - count + 1;
}
