import { expect, it, vi } from 'vitest';
import { backfillPreviews } from '../src/cli/backfill-previews.js';
it('pages active templates, skips images and uses non-replacing scheduling', async () => {
  const rows = Array.from({ length: 103 }, (_, i) => ({
    id: String(i).padStart(3, '0'),
  }));
  const findMany = vi.fn(async ({ cursor, take }: any) =>
    rows.slice(
      cursor ? Number(cursor.id) + 1 : 0,
      (cursor ? Number(cursor.id) + 1 : 0) + take,
    ),
  );
  const scheduleIfIdle = vi.fn(async () => {});
  await backfillPreviews(
    { template: { findMany } } as any,
    { templatePreviewExists: async (id: string) => id === '001' } as any,
    { scheduleIfIdle },
  );
  expect(findMany).toHaveBeenCalledTimes(2);
  expect(findMany.mock.calls[0][0]).toMatchObject({
    where: { deletedAt: null },
    take: 100,
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  expect(scheduleIfIdle).toHaveBeenCalledTimes(102);
  expect(scheduleIfIdle).not.toHaveBeenCalledWith('001');
});
it('stops on queue failure so an operator can rerun instead of reporting success', async () => {
  const db = { template: { findMany: async () => [{ id: 'one' }] } } as any;
  await expect(
    backfillPreviews(db, { templatePreviewExists: async () => false } as any, {
      scheduleIfIdle: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
});
