export type Role = 'user' | 'admin' | 'owner';

export interface User {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
}

export interface AuthSession {
  user: User;
  csrfToken: string;
}

export interface ShapeField {
  variable: string;
  label: string;
  type: 'text' | 'longtext' | 'number' | 'boolean';
  optional: boolean;
}

export interface Template {
  id: string;
  name: string;
  manifest: { version: 1; shape: null | { fields: ShapeField[] } };
}

export interface TreeEntry {
  name: string;
  kind: 'file' | 'directory';
  segments: string[];
}

export interface GenerationJob {
  id: string;
  templateId: string;
  templateName?: string;
  status: 'queued' | 'generating' | 'ok' | 'failed';
  message: string;
  timestamp: string;
  pdfFilename: string | null;
}
