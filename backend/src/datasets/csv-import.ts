import { isDeepStrictEqual } from 'node:util';
import { parse } from 'csv-parse/sync';
import type { Database } from '../users/users.repository.js';
import {
  DatasetError,
  datasetRowLimit,
  getOwnedDataset,
  reserveAppendedRows,
  withDatasetLock,
} from './datasets.repository.js';
import {
  datasetColumnLimit,
  datasetColumns,
  validateDatasetValue,
} from './datasets.service.js';

export const csvByteLimit = 5 * 1024 * 1024;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function location(records: number, column: number) {
  return records === 0
    ? `CSV header, column ${column}`
    : `CSV data row ${records}, column ${column}`;
}

function parseRecords(payload: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new DatasetError('CSV must be valid UTF-8');
  }

  try {
    return parse(text, {
      cast(value, context) {
        if (context.records > datasetRowLimit) {
          throw new DatasetError(
            `CSV exceeds the ${datasetRowLimit} data row limit`,
          );
        }
        if (context.index >= datasetColumnLimit) {
          throw new DatasetError(
            `${location(context.records, context.index + 1)} exceeds the ${datasetColumnLimit} column limit`,
          );
        }
        return value;
      },
      relax_column_count: true,
    });
  } catch (error) {
    if (error instanceof DatasetError) throw error;
    if (
      error instanceof Error &&
      'records' in error &&
      typeof error.records === 'number'
    ) {
      const column =
        'column' in error && typeof error.column === 'number'
          ? error.column + 1
          : 1;
      throw new DatasetError(
        `${location(error.records, column)} has invalid CSV syntax`,
      );
    }
    throw error;
  }
}

type Column = ReturnType<typeof datasetColumns>[number];

function csvValue(column: Column, cell: string) {
  if (column.optional && cell === '') return undefined;
  if (column.type === 'text' || column.type === 'longtext') {
    return validateDatasetValue(column.type, cell);
  }

  const trimmed = cell.trim();
  if (column.optional && trimmed === '') return undefined;
  if (column.type === 'number') {
    return validateDatasetValue(
      column.type,
      decimal.test(trimmed) ? Number(trimmed) : undefined,
    );
  }

  const lower = trimmed.toLowerCase();
  const boolean =
    lower === 'true' ? true : lower === 'false' ? false : undefined;
  return validateDatasetValue(column.type, boolean);
}

function readRows(payload: Buffer, columns: Column[]) {
  const [header, ...records] = parseRecords(payload);
  if (!header) throw new DatasetError('CSV header is required');
  const unmatched = new Map(columns.map((column) => [column.label, column]));
  const ordered = header.map((label, index) => {
    const column = unmatched.get(label);
    if (!column) {
      throw new DatasetError(
        `${location(0, index + 1)} is unknown or duplicated`,
      );
    }
    unmatched.delete(label);
    return column;
  });
  if (unmatched.size)
    throw new DatasetError('CSV header is missing dataset columns');

  return records.map((record, index) => {
    const row = index + 1;
    if (record.length !== ordered.length) {
      const column = Math.min(record.length, ordered.length) + 1;
      throw new DatasetError(
        `${location(row, column)} does not match the header width`,
      );
    }

    const values: Record<string, string | number | boolean> = {};
    for (const [index, column] of ordered.entries()) {
      try {
        const value = csvValue(column, record[index]);
        if (value !== undefined) values[column.id] = value;
      } catch (error) {
        if (!(error instanceof DatasetError)) throw error;
        throw new DatasetError(`${location(row, index + 1)}: ${error.message}`);
      }
    }
    return values;
  });
}

export async function importDatasetCsv(
  db: Database,
  ownedBy: string,
  datasetId: string,
  payload: Buffer,
) {
  const snapshot = await getOwnedDataset(db, ownedBy, datasetId);
  const rows = readRows(payload, datasetColumns(snapshot));

  return withDatasetLock(db, ownedBy, datasetId, async (tx, dataset) => {
    if (!isDeepStrictEqual(snapshot.columns, dataset.columns)) {
      throw new DatasetError('Dataset columns changed during import', 409);
    }
    if (rows.length === 0) return { imported: 0 };

    const { firstPosition, ranks } = await reserveAppendedRows(
      tx,
      dataset,
      rows.length,
    );
    const { count } = await tx.datasetRow.createMany({
      data: rows.map((values, index) => ({
        datasetId,
        position: firstPosition + index,
        rank: ranks[index],
        values,
      })),
    });
    return { imported: count };
  });
}
