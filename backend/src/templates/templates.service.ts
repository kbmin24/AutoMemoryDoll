import { withTemplateLock } from './template-lock.js';
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

const defaultTemplate = String.raw`\documentclass[12pt, a4paper]{article}

\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage{graphicx}

\title{Enter title here}
\author{Your Name}
\date{\today}

\begin{document}

\maketitle


\end{document}
`;

function validName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new TemplateError('Invalid template name');
  }
  return value.trim();
}

export function templateDto(template: {
  id: string;
  name: string;
  manifest: unknown;
}) {
  return {
    id: template.id,
    name: template.name,
    manifest: template.manifest as ManifestV1,
  };
}

export async function listTemplates(db: Database, userId: string) {
  return (await listOwnedTemplates(db, userId)).map(templateDto);
}

export async function getTemplate(
  db: Pick<Database, 'template'>,
  userId: string,
  templateId: string,
) {
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
  const template = await insertTemplate(
    db,
    id,
    userId,
    validName(name),
    validManifest,
  );
  try {
    await storage.createTemplateRoot(id);
    await storage.writeText(id, ['template.tex'], defaultTemplate);
  } catch (error) {
    await db.template.delete({ where: { id } });
    await storage.removeTemplateRoot(id).catch(() => undefined);
    throw error;
  }
  return templateDto(template);
}

export async function updateTemplate(
  db: Database,
  storage: Storage,
  userId: string,
  templateId: string,
  patch: { name?: unknown; manifest?: unknown },
  onShapeChanged?: () => void,
) {
  const changes: { name?: string; manifest?: ManifestV1 } = {};
  if (patch.name !== undefined) changes.name = validName(patch.name);
  if (patch.manifest !== undefined)
    changes.manifest = validateManifest(patch.manifest);
  if (!Object.keys(changes).length)
    throw new TemplateError('Empty template update');
  return withTemplateLock(
    db,
    storage,
    templateId,
    userId,
    async (tx, existing) => {
      const shapeChanged =
        changes.manifest !== undefined &&
        JSON.stringify(existing.manifest.shape) !==
          JSON.stringify(changes.manifest.shape);
      const updated = await updateOwnedTemplate(
        tx,
        userId,
        templateId,
        changes,
      );
      if (!updated.count) throw new TemplateError('Template not found', 404);
      const result = templateDto(await getTemplate(tx, userId, templateId));
      if (shapeChanged) onShapeChanged?.();
      return result;
    },
  );
}

export async function softDeleteTemplate(
  db: Database,
  storage: Storage,
  userId: string,
  templateId: string,
) {
  const deletedAt = new Date();
  await withTemplateLock(
    db,
    storage,
    templateId,
    userId,
    async (tx) => {
      await updateOwnedTemplate(tx, userId, templateId, { deletedAt });
    },
    async () => {
      try {
        await storage.removeTemplatePreview(templateId);
        await storage.removeTemplateRoot(templateId);
      } catch (error) {
        await db.template.updateMany({
          where: { id: templateId, ownedBy: userId, deletedAt },
          data: { deletedAt: null },
        });
        throw error;
      }
    },
  );
}
