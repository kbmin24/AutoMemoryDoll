import { databaseSchema } from '../db/prisma.js';
import type { ManifestV1, ShapeField } from '../contracts.js';
import { Prisma, type DatasetRow } from '../generated/prisma/client.js';
import {
  datasetRowLimit,
  lockOwnedDataset,
} from '../datasets/datasets.repository.js';
import { datasetColumns } from '../datasets/datasets.service.js';
import type { Database } from '../users/users.repository.js';
import { ACCOUNT_ID_PATTERN } from '../validation.js';
import { JobError } from './jobs.errors.js';

type Mode = 'first' | 'last' | 'random' | 'all';
type ObjectList = Extract<ShapeField, { type: 'object-list' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBindings(
  manifest: ManifestV1,
  data: Record<string, unknown>,
  input: unknown,
) {
  if (!Array.isArray(input)) throw new JobError('Invalid dataset bindings');
  const fields = new Map(
    (manifest.shape?.fields ?? [])
      .filter((field): field is ObjectList => field.type === 'object-list')
      .map((field) => [field.variable, field]),
  );
  if (input.length > fields.size)
    throw new JobError('Invalid dataset bindings');

  return input.map((binding: unknown) => {
    if (!isRecord(binding)) throw new JobError('Invalid dataset binding');
    const { mode, count } = binding;
    if (
      Object.keys(binding).length !== (mode === 'all' ? 4 : 5) ||
      typeof binding.field !== 'string' ||
      Object.hasOwn(data, binding.field) ||
      typeof binding.datasetId !== 'string' ||
      !ACCOUNT_ID_PATTERN.test(binding.datasetId) ||
      (mode !== 'all' &&
        ((mode !== 'first' && mode !== 'last' && mode !== 'random') ||
          typeof count !== 'number' ||
          !Number.isInteger(count) ||
          count < 1 ||
          count > datasetRowLimit)) ||
      !isRecord(binding.columns)
    ) {
      throw new JobError('Invalid dataset binding');
    }

    const field = fields.get(binding.field);
    if (!field) throw new JobError('Invalid dataset binding field');
    fields.delete(binding.field);

    const properties = new Map(
      field.properties.map((property) => [property.variable, property]),
    );
    const mappings = Object.entries(binding.columns).map(([name, columnId]) => {
      const property = properties.get(name);
      if (
        !property ||
        typeof columnId !== 'string' ||
        !ACCOUNT_ID_PATTERN.test(columnId)
      ) {
        throw new JobError('Invalid dataset column mapping');
      }
      properties.delete(name);
      return { property, columnId };
    });
    if (
      mappings.length === 0 ||
      [...properties.values()].some((property) => !property.optional)
    ) {
      throw new JobError('Required dataset column mapping is missing');
    }
    return {
      field,
      datasetId: binding.datasetId.toLowerCase(),
      mode: mode as Mode,
      count: typeof count === 'number' ? count : undefined,
      mappings,
    };
  });
}

async function selectRows(
  db: Database,
  tx: Prisma.TransactionClient,
  datasetId: string,
  mode: Mode,
  count: number | undefined,
  columnIds: string[],
) {
  const table = Prisma.raw(
    `"${databaseSchema(db).replaceAll('"', '""')}"."dataset_rows"`,
  );
  const order = {
    all: Prisma.sql`rank ASC`,
    first: Prisma.sql`rank ASC`,
    last: Prisma.sql`rank DESC`,
    random: Prisma.sql`random()`,
  }[mode];
  const rows = await tx.$queryRaw<Pick<DatasetRow, 'rank' | 'values'>[]>(
    Prisma.sql`SELECT rank, (
      SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
      FROM jsonb_each("values")
      WHERE key IN (${Prisma.join(columnIds)})
    ) AS "values"
    FROM ${table}
    WHERE dataset_id = ${datasetId}::uuid
    ORDER BY ${order}
    ${mode === 'all' ? Prisma.empty : Prisma.sql`LIMIT ${count}`}`,
  );
  return rows.sort((left, right) =>
    left.rank < right.rank ? -1 : Number(left.rank > right.rank),
  );
}

export async function resolveDatasetBindings(
  db: Database,
  tx: Prisma.TransactionClient,
  userId: string,
  manifest: ManifestV1,
  data: unknown,
  input: unknown,
) {
  if (!isRecord(data)) throw new JobError('Invalid generation data');
  const bindings = parseBindings(manifest, data, input);
  const datasets = new Map<string, ReturnType<typeof datasetColumns>>();
  for (const id of [
    ...new Set(bindings.map(({ datasetId }) => datasetId)),
  ].sort()) {
    datasets.set(
      id,
      datasetColumns(await lockOwnedDataset(db, tx, userId, id)),
    );
  }

  const resolved = new Map(Object.entries(data));
  for (const { field, datasetId, mode, count, mappings } of bindings) {
    const columns = new Map(
      datasets.get(datasetId)!.map((column) => [column.id, column]),
    );
    for (const { property, columnId } of mappings) {
      if (columns.get(columnId)?.type !== property.type) {
        throw new JobError(
          'Dataset column type does not match the template property',
        );
      }
    }
    const rows = await selectRows(
      db,
      tx,
      datasetId,
      mode,
      count,
      mappings.map(({ columnId }) => columnId),
    );
    const items = rows.map(({ values }) => {
      if (!isRecord(values)) throw new JobError('Invalid dataset row');
      return Object.fromEntries(
        mappings.flatMap(({ property, columnId }) =>
          Object.hasOwn(values, columnId)
            ? [[property.variable, values[columnId]]]
            : [],
        ),
      );
    });
    resolved.set(field.variable, items);
  }
  return Object.fromEntries(resolved);
}
