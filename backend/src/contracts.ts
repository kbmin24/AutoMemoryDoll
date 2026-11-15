export type Role = 'user' | 'admin' | 'owner';
export type FieldType = 'text' | 'longtext' | 'number' | 'boolean';
type ShapeFieldBase = {
  variable: string;
  label: string;
  optional: boolean;
};
export type ShapeField = ShapeFieldBase &
  ({ type: FieldType } | { type: 'list'; itemType: FieldType });
export type ManifestV1 = { version: 1; shape: null | { fields: ShapeField[] } };
export type JobStatus = 'queued' | 'generating' | 'ok' | 'failed';
