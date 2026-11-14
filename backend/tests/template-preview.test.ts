import { expect, it, vi } from 'vitest';
import {
  buildPreviewData,
  schedulePreviewAfterSave,
} from '../src/templates/template-preview.js';
import { BullMqPublisher } from '../src/jobs/queue.js';
import { silentLogger } from '../src/logging/logger.js';
it('uses typed sample values for required and optional fields without user data', () => {
  const data = buildPreviewData({
    version: 1,
    shape: {
      fields: [
        { variable: 'n', label: 'Number', type: 'number', optional: false },
        { variable: 't', label: 'Text', type: 'text', optional: true },
        { variable: 'l', label: 'Long', type: 'longtext', optional: false },
        { variable: 'b', label: 'Boolean', type: 'boolean', optional: true },
      ],
    },
  });
  expect(data).toMatchObject({ n: 1, t: 'Loream Ipsum', b: true });
  expect(data.l).toBe(
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  );
  expect(buildPreviewData({ version: 1, shape: null })).toEqual({});
  expect(buildPreviewData({ version: 1, shape: { fields: [] } })).toEqual({});
});
it('debounces live edits with active follow-up but backfill never replaces them', async () => {
  const add = vi.fn().mockResolvedValue({});
  const publisher = new BullMqPublisher({ add });
  await publisher.schedule('bba1a839-9b12-45a3-9bd6-72b79d914b63');
  expect(add).toHaveBeenLastCalledWith(
    'template-preview',
    { templateId: 'bba1a839-9b12-45a3-9bd6-72b79d914b63' },
    expect.objectContaining({
      delay: 30000,
      priority: 10,
      attempts: 1,
      deduplication: {
        id: 'template-preview-bba1a839-9b12-45a3-9bd6-72b79d914b63',
        replace: true,
        keepLastIfActive: true,
      },
    }),
  );
  await publisher.scheduleIfIdle('bba1a839-9b12-45a3-9bd6-72b79d914b63');
  expect(add.mock.lastCall![2].deduplication).toEqual({
    id: 'template-preview-bba1a839-9b12-45a3-9bd6-72b79d914b63',
  });
  await expect(
    schedulePreviewAfterSave(
      { schedule: vi.fn().mockRejectedValue(new Error('offline')) },
      'bba1a839-9b12-45a3-9bd6-72b79d914b63',
      silentLogger,
    ),
  ).resolves.toBeUndefined();
});
