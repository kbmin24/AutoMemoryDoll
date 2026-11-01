export type Role = 'user' | 'admin' | 'owner';
export type FieldType = 'text' | 'longtext' | 'number' | 'boolean';
export type ShapeField = {
  variable: string;
  label: string;
  type: FieldType;
  optional: boolean;
};
export type ManifestV1 = { version: 1; shape: null | { fields: ShapeField[] } };
export type JobStatus = 'queued' | 'generating' | 'ok' | 'failed';
