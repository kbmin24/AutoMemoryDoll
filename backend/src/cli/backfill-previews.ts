import { pathToFileURL } from 'node:url';
import { loadEnvironment } from '../env.js';
import type { Database } from '../users/users.repository.js';
import type { PreviewScheduler } from '../templates/template-preview.js';
import { FileSystemStorage } from '../storage/filesystem-storage.js';
import { createPrismaClient } from '../db/prisma.js';
import { createJobQueue } from '../jobs/queue.js';
import { closeLogger, runService } from '../logging/logger.js';

export async function backfillPreviews(
  db: Database,
  storage: Pick<FileSystemStorage, 'templatePreviewExists'>,
  scheduler: Pick<PreviewScheduler, 'scheduleIfIdle'>,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const templates = await db.template.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const template of templates) {
      if (!(await storage.templatePreviewExists(template.id)))
        await scheduler.scheduleIfIdle(template.id);
    }
    if (templates.length < 100) return;
    cursor = templates.at(-1)!.id;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  loadEnvironment();
  await runService('preview-cli', async (logger) => {
    if (!process.env.DATABASE_URL || !process.env.REDIS_URL)
      throw new Error('DATABASE_URL and REDIS_URL are required');
    const db = createPrismaClient(process.env.DATABASE_URL);
    const queue = createJobQueue(process.env.REDIS_URL, logger);
    try {
      await backfillPreviews(
        db,
        new FileSystemStorage(process.env.STORAGE_ROOT ?? './data'),
        queue.publisher,
      );
      logger.info('preview.backfill_completed');
    } finally {
      await Promise.all([db.$disconnect(), queue.close()]);
      await closeLogger(logger);
    }
  });
}
