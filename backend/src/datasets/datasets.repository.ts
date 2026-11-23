import {
  generateNJitteredKeysBetween,
  generateNKeysBetween,
} from 'fractional-indexing-jittered';
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

export const maxDatasetRankLength = 128;

export async function reserveAppendedRows(
  tx: Prisma.TransactionClient,
  dataset: Dataset,
  count: number,
) {
  // The dataset lock serializes capacity checks, rank allocation, and writes.
  if (dataset.rowCount + count > datasetRowLimit) {
    throw new DatasetError(
      `A dataset can contain at most ${datasetRowLimit} rows`,
      409,
    );
  }

  const last = await tx.datasetRow.findFirst({
    where: { datasetId: dataset.id },
    orderBy: { rank: 'desc' },
    select: { rank: true },
  });
  const ranks = generateNJitteredKeysBetween(last?.rank ?? null, null, count);
  await tx.dataset.update({
    where: { id: dataset.id },
    data: {
      lastPosition: { increment: count },
      rowCount: { increment: count },
    },
  });
  return { firstPosition: dataset.lastPosition + 1, ranks };
}

export async function rebalanceDatasetRanks(
  db: Database,
  tx: Prisma.TransactionClient,
  datasetId: string,
  movedId: string,
  beforeId: string | undefined,
) {
  const rows = await tx.datasetRow.findMany({
    where: { datasetId, id: { not: movedId } },
    orderBy: { rank: 'asc' },
    select: { id: true },
  });
  const index = beforeId
    ? rows.findIndex(({ id }) => id === beforeId)
    : rows.length;
  rows.splice(index, 0, { id: movedId });
  const ranks = generateNKeysBetween(null, null, rows.length);
  const replacements = rows.map(({ id }, offset) => ({
    id,
    rank: ranks[offset],
  }));
  const table = Prisma.raw(
    `"${databaseSchema(db).replaceAll('"', '""')}"."dataset_rows"`,
  );

  // Move existing keys out of the fractional key space before assigning new ones.
  await tx.$executeRaw`UPDATE ${table}
    SET rank = '~' || id::text
    WHERE dataset_id = ${datasetId}::uuid`;
  await tx.$executeRaw`UPDATE ${table} AS row
    SET rank = replacement.rank
    FROM jsonb_to_recordset(${JSON.stringify(replacements)}::jsonb)
      AS replacement(id uuid, rank text)
    WHERE row.dataset_id = ${datasetId}::uuid AND row.id = replacement.id`;

  return ranks[index];
}
