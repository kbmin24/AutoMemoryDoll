import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../users/users.repository.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { validateId } from '../storage/paths.js';
import { withTemplateLock } from '../templates/template-lock.js';
import { TemplateError } from '../templates/templates.errors.js';
import { buildPreviewData } from '../templates/template-preview.js';
import { textFiles } from '../jobs/jobs.service.js';
import { findResourceAliases } from '../jobs/resource-tokens.js';
import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import type { PdfGenerator } from './pdf-generator.js';

export class PreviewProcessor {
  constructor(
    private readonly db: Database,
    private readonly storage: FileSystemStorage,
    private readonly generator: PdfGenerator,
    private readonly logger: Logger = silentLogger,
  ) {}

  async processTemplate(templateId: string): Promise<void> {
    validateId(templateId);
    const runId = randomUUID();
    const started = performance.now();
    try {
      const input = await withTemplateLock(
        this.db,
        this.storage,
        templateId,
        null,
        async (_tx, template) => {
          const input = await this.storage.snapshotPreview(templateId, runId);
          await writeFile(
            join(input, 'data.json'),
            JSON.stringify(buildPreviewData(template.manifest)),
            { mode: 0o600 },
          );
          return input;
        },
      );
      const files = await textFiles(join(input, 'template'));
      const main = files.find(
        (file) => file.path === join(input, 'template', 'template.tex'),
      );
      if (
        !main?.text.trim() ||
        findResourceAliases(files.map((file) => file.text)).length
      ) {
        this.logger.warn('preview.rejected', {
          templateId,
          jobId: runId,
          errorCode: 'invalid_input',
        });
        return;
      }
      const { output } = await this.storage.preparePreviewOutput(runId);
      this.logger.info('preview.started', { templateId, jobId: runId });
      const result = await this.generator.generatePreview(input, output);
      if (result.result === 'failed') {
        this.logger.warn('preview.rejected', {
          templateId,
          jobId: runId,
          errorCode: 'compiler',
        });
        return;
      }
      await withTemplateLock(
        this.db,
        this.storage,
        templateId,
        null,
        async () => {},
        async () => {
          await this.storage.publishPreview(templateId, runId);
        },
      );
      this.logger.info('preview.succeeded', {
        templateId,
        jobId: runId,
        durationMs: performance.now() - started,
      });
    } catch (error) {
      if (error instanceof TemplateError && error.status === 404) return;
      this.logger.error('preview.failed', {
        templateId,
        jobId: runId,
        ...safeError(error),
      });
      throw error;
    } finally {
      try {
        // Never remove a run while a daemon-owned container might still write to it.
        await this.generator.stop(runId);
        await this.storage.cleanupPreviewRun(runId);
      } catch (error) {
        this.logger.error('preview.cleanup_failed', {
          templateId,
          jobId: runId,
          ...safeError(error),
        });
        throw error;
      }
    }
  }

  async reconcile(): Promise<void> {
    for (const runId of await this.storage.listPreviewRuns()) {
      try {
        await this.generator.stop(runId);
        await this.storage.cleanupPreviewRun(runId);
        this.logger.warn('preview.interrupted', { jobId: runId });
      } catch (error) {
        this.logger.error('preview.cleanup_failed', {
          jobId: runId,
          ...safeError(error),
        });
        throw error;
      }
    }
  }
}
