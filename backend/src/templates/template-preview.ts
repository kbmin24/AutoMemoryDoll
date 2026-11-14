import type { ManifestV1 } from '../contracts.js';
import { safeError, type Logger } from '../logging/logger.js';

export interface PreviewScheduler {
  schedule(templateId: string): Promise<void>;
  scheduleIfIdle(templateId: string): Promise<void>;
}

const sampleParagraph =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

export function buildPreviewData(
  manifest: ManifestV1,
): Record<string, unknown> {
  return Object.fromEntries(
    (manifest.shape?.fields ?? []).map((field) => {
      const values = {
        number: 1,
        text: 'Loream Ipsum',
        longtext: sampleParagraph,
        boolean: true,
      };
      return [field.variable, values[field.type]];
    }),
  );
}

export async function schedulePreviewAfterSave(
  scheduler: Pick<PreviewScheduler, 'schedule'> | undefined,
  templateId: string,
  logger: Logger,
): Promise<void> {
  if (!scheduler) return;
  try {
    await scheduler.schedule(templateId);
    logger.info('preview.scheduled', { templateId });
  } catch (error) {
    logger.error('preview.scheduling_failed', {
      templateId,
      ...safeError(error),
    });
  }
}
