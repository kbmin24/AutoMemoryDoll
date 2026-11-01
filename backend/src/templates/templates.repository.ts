import type { Prisma } from '../generated/prisma/client.js';
import type { Database } from '../users/users.repository.js';
import type { ManifestV1 } from '../contracts.js';

export function listOwnedTemplates(db: Database, userId: string) {
  return db.template.findMany({
    where: { ownedBy: userId, deletedAt: null },
    orderBy: { name: 'asc' },
  });
}

export function findOwnedTemplate(
  db: Database,
  userId: string,
  templateId: string,
) {
  return db.template.findFirst({
    where: { id: templateId, ownedBy: userId, deletedAt: null },
  });
}

export function insertTemplate(
  db: Database,
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
  db: Database,
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
