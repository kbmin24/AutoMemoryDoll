import { randomUUID } from 'node:crypto';
import { fieldTypes, type FieldType } from '../contracts.js';
import type { Dataset } from '../generated/prisma/client.js';
import type { Database } from '../users/users.repository.js';
import { ACCOUNT_ID_PATTERN } from '../validation.js';
import {
  DatasetError,
  getOwnedDataset,
  getOwnedRow,
  withDatasetLock,
  reserveRowPositions,
} from './datasets.repository.js';

export const datasetColumnLimit = 100;

type Column = {
  id: string;
  label: string;
  type: FieldType;
  optional: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && !/[\u0000\uD800-\uDFFF]/u.test(value);
}

export function validDatasetName(value: unknown): value is string {
  return validString(value) && value.trim().length > 0 && value.length <= 200;
}

export function datasetColumns(dataset: Dataset): Column[] {
  return dataset.columns as Column[];
}

function validateColumns(input: unknown, current: Column[] = []): Column[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new DatasetError('A dataset needs at least one column');
  }
  if (input.length > datasetColumnLimit) {
    throw new DatasetError(
      `A dataset can contain at most ${datasetColumnLimit} columns`,
    );
  }

  const labels = new Set<string>();
  const availableIds = new Set(current.map((column) => column.id));

  return input.map((value: unknown) => {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !['id', 'label', 'type', 'optional'].includes(key),
      ) ||
      !validDatasetName(value.label) ||
      typeof value.type !== 'string' ||
      !(fieldTypes as readonly string[]).includes(value.type) ||
      typeof value.optional !== 'boolean'
    ) {
      throw new DatasetError('Invalid dataset column');
    }
    const label = value.label.trim();
    if (labels.has(label))
      throw new DatasetError('Duplicate dataset column label');
    labels.add(label);

    if (Object.hasOwn(value, 'id')) {
      if (
        typeof value.id !== 'string' ||
        !ACCOUNT_ID_PATTERN.test(value.id) ||
        !availableIds.delete(value.id)
      ) {
        throw new DatasetError('Invalid dataset column ID');
      }
    }
    return {
      id: (value.id as string | undefined) ?? randomUUID(),
      label,
      type: value.type as FieldType,
      optional: value.optional,
    };
  });
}

export function validateDatasetValue(type: FieldType, value: unknown) {
  switch (type) {
    case 'text':
    case 'longtext':
      if (validString(value)) return value;
      throw new DatasetError('Invalid text value');
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      throw new DatasetError('Invalid number value');
    case 'boolean':
      if (typeof value === 'boolean') return value;
      throw new DatasetError('Invalid boolean value');
  }
}

export function validateDatasetValues(columns: Column[], input: unknown) {
  if (!isRecord(input)) throw new DatasetError('Invalid dataset row');
  const remaining = new Set(Object.keys(input));
  const values: Record<string, string | number | boolean> = {};

  for (const { id, type, optional } of columns) {
    if (!remaining.delete(id)) {
      if (optional) continue;
      throw new DatasetError('Required dataset value is missing');
    }

    values[id] = validateDatasetValue(type, input[id]);
  }

  if (remaining.size) throw new DatasetError('Unknown dataset column');
  return values;
}

export function datasetDto({
  id,
  name,
  columns,
  createdAt,
  updatedAt,
}: Dataset) {
  return { id, name, columns, createdAt, updatedAt };
}

export function createDataset(
  db: Database,
  ownedBy: string,
  name: string,
  input: unknown,
) {
  const columns = validateColumns(input);
  return db.dataset.create({ data: { ownedBy, name: name.trim(), columns } });
}

export function updateDataset(
  db: Database,
  ownedBy: string,
  id: string,
  input: { name?: string; columns?: unknown },
) {
  return withDatasetLock(db, ownedBy, id, async (tx, dataset) => {
    if (input.name === undefined && input.columns === undefined) {
      throw new DatasetError('No dataset changes were supplied');
    }
    const current = datasetColumns(dataset);
    const columns =
      input.columns === undefined
        ? undefined
        : validateColumns(input.columns, current);
    if (columns) {
      const schemaChanged =
        columns.length !== current.length ||
        columns.some((column, index) => {
          const existing = current[index];
          return (
            column.id !== existing.id ||
            column.type !== existing.type ||
            column.optional !== existing.optional
          );
        });
      if (
        schemaChanged &&
        (await tx.datasetRow.findFirst({
          where: { datasetId: id },
          select: { id: true },
        }))
      ) {
        throw new DatasetError(
          'Only column labels can change while the dataset has rows',
          409,
        );
      }
    }
    return tx.dataset.update({
      where: { id },
      data: { name: input.name?.trim(), columns },
    });
  });
}

export function deleteDataset(db: Database, ownedBy: string, id: string) {
  return withDatasetLock(db, ownedBy, id, (tx) =>
    tx.dataset.delete({ where: { id } }),
  );
}

export async function listRows(
  db: Database,
  ownedBy: string,
  datasetId: string,
  after: number,
  limit: number,
) {
  await getOwnedDataset(db, ownedBy, datasetId);
  const rows = await db.datasetRow.findMany({
    where: { datasetId, dataset: { ownedBy }, position: { gt: after } },
    orderBy: { position: 'asc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return { rows, nextAfter: hasMore ? rows.at(-1)!.position : null };
}

export function appendRow(
  db: Database,
  ownedBy: string,
  datasetId: string,
  input: unknown,
) {
  return withDatasetLock(db, ownedBy, datasetId, async (tx, dataset) => {
    const values = validateDatasetValues(datasetColumns(dataset), input);
    const position = await reserveRowPositions(tx, datasetId, 1);
    return tx.datasetRow.create({ data: { datasetId, position, values } });
  });
}

export function updateRow(
  db: Database,
  ownedBy: string,
  datasetId: string,
  id: string,
  input: unknown,
) {
  return withDatasetLock(db, ownedBy, datasetId, async (tx, dataset) => {
    await getOwnedRow(tx, ownedBy, datasetId, id);
    const values = validateDatasetValues(datasetColumns(dataset), input);
    const row = await tx.datasetRow.update({ where: { id }, data: { values } });
    await tx.dataset.update({
      where: { id: datasetId },
      data: { updatedAt: new Date() },
    });
    return row;
  });
}

export function deleteRow(
  db: Database,
  ownedBy: string,
  datasetId: string,
  id: string,
) {
  return withDatasetLock(db, ownedBy, datasetId, async (tx) => {
    await getOwnedRow(tx, ownedBy, datasetId, id);
    const row = await tx.datasetRow.delete({ where: { id } });
    await tx.dataset.update({
      where: { id: datasetId },
      data: { updatedAt: new Date() },
    });
    return row;
  });
}
