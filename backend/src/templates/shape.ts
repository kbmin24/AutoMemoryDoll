import { TemplateError } from './templates.errors.js';
import {
  fieldTypes,
  type FieldType,
  type ManifestV1,
  type ShapeField,
  type ScalarField,
} from '../contracts.js';

const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const scalarTypes = new Set<string>(fieldTypes);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, names: string[]): boolean {
  return (
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

export function validateManifest(input: unknown): ManifestV1 {
  if (
    !record(input) ||
    !keysAre(input, ['version', 'shape']) ||
    input.version !== 1
  ) {
    throw new TemplateError(
      'Invalid template manifest',
      400,
      'Invalid workspace operation',
    );
  }
  if (input.shape === null) return { version: 1, shape: null };
  if (
    !record(input.shape) ||
    !keysAre(input.shape, ['fields']) ||
    !Array.isArray(input.shape.fields) ||
    input.shape.fields.length === 0
  ) {
    throw new TemplateError(
      'Invalid template shape',
      400,
      'Invalid workspace operation',
    );
  }

  return { version: 1, shape: { fields: validateFields(input.shape.fields) } };
}

function validateFields(input: unknown[], scalarOnly = false): ShapeField[] {
  const seen = new Set<string>();
  return input.map((value: unknown) => {
    const type = record(value) ? value.type : undefined;
    const keys = ['variable', 'label', 'type', 'optional'];
    if (type === 'list') keys.push('itemType');
    if (type === 'object-list') keys.push('properties');

    if (
      !record(value) ||
      !keysAre(value, keys) ||
      typeof value.variable !== 'string' ||
      !variablePattern.test(value.variable) ||
      typeof value.label !== 'string' ||
      value.label.trim().length === 0 ||
      value.label.length > 200 ||
      typeof type !== 'string' ||
      (!scalarTypes.has(type) &&
        (scalarOnly || (type !== 'list' && type !== 'object-list'))) ||
      (type === 'list' &&
        (typeof value.itemType !== 'string' ||
          !scalarTypes.has(value.itemType))) ||
      (type === 'object-list' &&
        (!Array.isArray(value.properties) || value.properties.length === 0)) ||
      typeof value.optional !== 'boolean' ||
      seen.has(value.variable)
    ) {
      throw new TemplateError(
        'Invalid template shape field',
        400,
        'Invalid workspace operation',
      );
    }
    seen.add(value.variable);
    const base = {
      variable: value.variable,
      label: value.label,
      optional: value.optional,
    };
    if (type === 'list')
      return { ...base, type, itemType: value.itemType as FieldType };
    if (type === 'object-list') {
      const properties = validateFields(
        value.properties as unknown[],
        true,
      ) as ScalarField[];
      return { ...base, type, properties };
    }
    return { ...base, type: type as FieldType };
  });
}
