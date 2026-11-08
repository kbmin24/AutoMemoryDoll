import { TemplateError } from './templates.errors.js';
import { randomUUID } from 'node:crypto';
import type { ManifestV1 } from '../contracts.js';
import type { Database } from '../users/users.repository.js';
import type { Storage } from '../storage/storage.js';
import { validateId } from '../storage/paths.js';
import { validateManifest } from './shape.js';
import {
  findOwnedTemplate,
  insertTemplate,
  listOwnedTemplates,
  updateOwnedTemplate,
} from './templates.repository.js';

export { TemplateError } from './templates.errors.js';

function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new TemplateError('Invalid template name');
  }
  return value.trim();
}

export function templateDto(template: { id: string; name: string; manifest: unknown }) {
  return {
    id: template.id,
    name: template.name,
    manifest: template.manifest as ManifestV1,
  };
}

export async function listTemplates(db: Database, userId: string) {
  return (await listOwnedTemplates(db, userId)).map(templateDto);
}

export async function getTemplate(db: Database, userId: string, templateId: string) {
  try {
    validateId(templateId);
  } catch {
    throw new TemplateError('Template not found', 404);
  }
  const template = await findOwnedTemplate(db, userId, templateId);
  if (!template) throw new TemplateError('Template not found', 404);
  return template;
}

export async function createTemplate(
  db: Database,
  storage: Storage,
  userId: string,
  name: unknown,
  manifest: unknown,
) {
  const id = randomUUID();
  const validManifest = validateManifest(manifest);
  const template = await insertTemplate(db, id, userId, validName(name), validManifest);
  try {
    await storage.createTemplateRoot(id);
    await storage.writeText(id, ['template.tex'], '');
  } catch (error) {
    await db.template.delete({ where: { id } });
    await storage.removeTemplateRoot(id).catch(() => undefined);
    throw error;
  }
  return templateDto(template);
}

export async function updateTemplate(
  db: Database,
  userId: string,
  templateId: string,
  patch: { name?: unknown; manifest?: unknown },
) {
  await getTemplate(db, userId, templateId);
  const changes: { name?: string; manifest?: ManifestV1 } = {};
  if (patch.name !== undefined) changes.name = validName(patch.name);
  if (patch.manifest !== undefined) changes.manifest = validateManifest(patch.manifest);
  if (!Object.keys(changes).length) throw new TemplateError('Empty template update');
  const updated = await updateOwnedTemplate(db, userId, templateId, changes);
  if (!updated.count) throw new TemplateError('Template not found', 404);
  return templateDto(await getTemplate(db, userId, templateId));
}

export async function softDeleteTemplate(
  db: Database,
  storage: Storage,
  userId: string,
  templateId: string,
) {
  await getTemplate(db, userId, templateId);
  const deletedAt = new Date();
  const updated = await updateOwnedTemplate(db, userId, templateId, {
    deletedAt,
  });
  if (!updated.count) throw new TemplateError('Template not found', 404);
  try {
    await storage.removeTemplateRoot(templateId);
  } catch (error) {
    await db.template.updateMany({
      where: { id: templateId, ownedBy: userId, deletedAt },
      data: { deletedAt: null },
    });
    throw error;
  }
}
