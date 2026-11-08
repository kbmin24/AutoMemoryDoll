import { TemplateError } from './templates.errors.js';
import type { ManifestV1, ShapeField } from '../contracts.js';

const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fieldTypes = new Set(['text', 'longtext', 'number', 'boolean']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, names: string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}

export function validateManifest(input: unknown): ManifestV1 {
  if (!record(input) || !keysAre(input, ['version', 'shape']) || input.version !== 1) {
    throw new TemplateError('Invalid template manifest', 400, 'Invalid workspace operation');
  }
  if (input.shape === null) return { version: 1, shape: null };
  if (
    !record(input.shape) ||
    !keysAre(input.shape, ['fields']) ||
    !Array.isArray(input.shape.fields) ||
    input.shape.fields.length === 0
  ) {
    throw new TemplateError('Invalid template shape', 400, 'Invalid workspace operation');
  }

  const seen = new Set<string>();
  const fields: ShapeField[] = input.shape.fields.map((value: unknown) => {
    if (
      !record(value) ||
      !keysAre(value, ['variable', 'label', 'type', 'optional']) ||
      typeof value.variable !== 'string' ||
      !variablePattern.test(value.variable) ||
      typeof value.label !== 'string' ||
      value.label.trim().length === 0 ||
      value.label.length > 200 ||
      !fieldTypes.has(String(value.type)) ||
      typeof value.optional !== 'boolean' ||
      seen.has(value.variable)
    ) {
      throw new TemplateError('Invalid template shape field', 400, 'Invalid workspace operation');
    }
    seen.add(value.variable);
    return {
      variable: value.variable,
      label: value.label,
      type: value.type as ShapeField['type'],
      optional: value.optional,
    };
  });
  return { version: 1, shape: { fields } };
}
