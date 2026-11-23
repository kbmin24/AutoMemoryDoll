import { Prisma } from '../generated/prisma/client.js';
import { databaseSchema } from '../db/prisma.js';
import type { ManifestV1 } from '../contracts.js';
import type { Database } from '../users/users.repository.js';
type TemplateDatabase = Pick<Database, 'template'>;

export async function listOwnedTemplates(db: TemplateDatabase, userId: string) {
  const templates = await db.template.findMany({
    where: { ownedBy: userId, deletedAt: null },
    include: { views: { where: { userId }, select: { viewedAt: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return templates.sort((left, right) => {
    const leftViewed = left.views[0]?.viewedAt.getTime() ?? -Infinity;
    const rightViewed = right.views[0]?.viewedAt.getTime() ?? -Infinity;
    return rightViewed === leftViewed ? 0 : rightViewed - leftViewed;
  });
}

export function recordTemplateView(
  db: Database,
  userId: string,
  templateId: string,
) {
  const schema = Prisma.raw(`"${databaseSchema(db).replaceAll('"', '""')}"`);
  return db.$executeRaw(Prisma.sql`
    INSERT INTO ${schema}."template_viewed_at" ("template_id", "user_id", "viewed_at")
    VALUES (${templateId}::uuid, ${userId}::uuid, clock_timestamp())
    ON CONFLICT ("template_id", "user_id")
    DO UPDATE SET "viewed_at" = clock_timestamp()
  `);
}

export function findOwnedTemplate(
  db: TemplateDatabase,
  userId: string,
  templateId: string,
) {
  return db.template.findFirst({
    where: { id: templateId, ownedBy: userId, deletedAt: null },
  });
}

export function insertTemplate(
  db: TemplateDatabase,
  id: string,
  userId: string,
  name: string,
  manifest: ManifestV1,
) {
  return db.template.create({
    data: {
      id,
      ownedBy: userId,
      name,
      manifest: manifest as unknown as Prisma.InputJsonValue,
    },
  });
}

export function updateOwnedTemplate(
  db: TemplateDatabase,
  userId: string,
  templateId: string,
  patch: { name?: string; manifest?: ManifestV1; deletedAt?: Date | null },
) {
  const data: Prisma.TemplateUpdateManyMutationInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.manifest !== undefined)
    data.manifest = patch.manifest as unknown as Prisma.InputJsonValue;
  if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt;
  return db.template.updateMany({
    where: { id: templateId, ownedBy: userId, deletedAt: null },
    data,
  });
}
