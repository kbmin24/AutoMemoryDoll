import type { Readable } from 'node:stream';

export interface TreeEntry {
  name: string;
  kind: 'file' | 'directory';
  segments: string[];
}

export abstract class Storage {
  abstract withTemplateFileLock<T>(templateId: string, action: () => Promise<T>): Promise<T>;
  abstract createTemplateRoot(templateId: string): Promise<void>;
  abstract removeTemplateRoot(templateId: string): Promise<void>;
  abstract listTemplateTree(templateId: string): Promise<TreeEntry[]>;
  abstract createDirectory(
    templateId: string,
    segments: string[],
  ): Promise<void>;
  abstract readText(templateId: string, segments: string[]): Promise<string>;
  abstract writeText(
    templateId: string,
    segments: string[],
    text: string,
  ): Promise<void>;
  abstract uploadStagingDirectory(): Promise<string>;
  abstract moveUpload(
    templateId: string,
    segments: string[],
    temporaryPath: string,
  ): Promise<void>;
  abstract readPreviewInput(
    templateId: string,
    segments: string[],
  ): Promise<Buffer>;
  abstract openDownload(
    templateId: string,
    segments: string[],
  ): Promise<Readable>;
  abstract move(
    templateId: string,
    from: string[],
    to: string[],
  ): Promise<void>;
  abstract delete(templateId: string, segments: string[]): Promise<void>;
  abstract snapshot(templateId: string, jobId: string): Promise<string>;
  abstract jobInputExists(jobId: string): Promise<boolean>;
  abstract stageResource(
    jobId: string,
    storedName: string,
    temporaryPath: string,
  ): Promise<void>;
  abstract savePdf(
    jobId: string,
    source: string,
    filename: string,
  ): Promise<string>;
  abstract openPdf(jobId: string, filename: string): Promise<Readable>;
  abstract removeTemplatePreview(templateId: string): Promise<void>;
  abstract cleanupJob(jobId: string): Promise<void>;
}
