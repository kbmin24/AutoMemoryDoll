export type Role = 'user' | 'admin' | 'owner';
export const fieldTypes = ['text', 'longtext', 'number', 'boolean'] as const;
export type FieldType = (typeof fieldTypes)[number];
type ShapeFieldBase = {
  variable: string;
  label: string;
  optional: boolean;
};
export type ScalarField = ShapeFieldBase & { type: FieldType };
export type ShapeField =
  | ScalarField
  | (ShapeFieldBase & { type: 'list'; itemType: FieldType })
  | (ShapeFieldBase & { type: 'object-list'; properties: ScalarField[] });
export type ManifestV1 = { version: 1; shape: null | { fields: ShapeField[] } };
export type JobStatus = 'queued' | 'generating' | 'ok' | 'failed';
