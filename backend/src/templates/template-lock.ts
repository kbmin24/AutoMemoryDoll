import type { Storage } from '../storage/storage.js';
import { databaseSchema } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ManifestV1 } from '../contracts.js';
import type { Database } from '../users/users.repository.js';
import { validateId } from '../storage/paths.js';
import { TemplateError } from './templates.errors.js';

export interface LockedTemplate {
  id: string;
  ownedBy: string;
  name: string;
  manifest: ManifestV1;
}

export async function withTemplateLock<T>(
  db: Database,
  storage: Pick<Storage, 'withTemplateFileLock'>,
  templateId: string,
  ownerId: string | null,
  action: (
    tx: Prisma.TransactionClient,
    template: LockedTemplate,
  ) => Promise<T>,
  afterCommit?: (result: T) => Promise<void>,
): Promise<T> {
  try {
    validateId(templateId);
  } catch {
    throw new TemplateError('Template not found', 404);
  }
  return storage.withTemplateFileLock(templateId, async () => {
    let work: Promise<T> | undefined;
    try {
      const result = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          const table = Prisma.raw(
            `"${databaseSchema(db).replaceAll('"', '""')}"."templates"`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM ${table} WHERE id = ${templateId}::uuid FOR UPDATE`,
          );
          const template = await tx.template.findFirst({
            where: {
              id: templateId,
              deletedAt: null,
              ...(ownerId === null ? {} : { ownedBy: ownerId }),
            },
          });
          if (!template) throw new TemplateError('Template not found', 404);
          work = action(tx, {
            ...template,
            manifest: template.manifest as ManifestV1,
          });
          return await work;
        },
        { maxWait: 5000, timeout: 60000 },
      );
      await afterCommit?.(result);
      return result;
    } finally {
      // A timed-out transaction cannot cancel filesystem work; settle it before callers clean up.
      await work?.catch(() => undefined);
    }
  });
}
