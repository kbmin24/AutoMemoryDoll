import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import { join } from 'node:path';
import type { Database } from '../users/users.repository.js';
import type { FileSystemStorage } from '../storage/filesystem-storage.js';
import { validateId } from '../storage/paths.js';
import {
  claimJob,
  failQueuedJob,
  finishJob,
  listQueuedJobs,
  listStaleJobs,
  listTerminalJobs,
} from '../jobs/jobs.repository.js';
import type { PdfGenerator } from './pdf-generator.js';

export class JobProcessor {
  constructor(
    private readonly db: Database,
    private readonly storage: FileSystemStorage,
    private readonly generator: PdfGenerator,
    private readonly wallTimeMs: number,
    private readonly log: Logger = silentLogger,
  ) {}

  async processJob(jobId: string): Promise<void> {
    validateId(jobId);
    const startedAt = new Date();
    const claimed = await claimJob(this.db, jobId, startedAt);
    if (claimed.count === 0) return;

    this.log.info('generation.started', { jobId });
    this.log.debug('generation.debug', { jobId, phase: 'claim' });
    const started = performance.now();
    let terminal = false;
    try {
      const { input, output } = await this.storage.prepareJobOutput(jobId);
      this.log.debug('generation.debug', { jobId, phase: 'container' });
      const result = await this.generator.generate(input, output);
      this.log.debug('generation.debug', { jobId, phase: 'result' });
      if (result.result === 'failed') {
        // Compiler diagnostics may contain document contents; log only the outcome.
        const failed = await finishJob(this.db, jobId, startedAt, {
          status: 'failed',
          message: 'Document compilation failed. Check the template and supplied values.',
          pdfFilename: null,
        });
        terminal = failed.count === 1;
        if (terminal)
          this.log.warn('generation.rejected', {
            jobId,
            outcome: 'rejected',
            errorCode: 'compiler',
            durationMs: performance.now() - started,
          });
      } else {
        this.log.debug('generation.debug', { jobId, phase: 'publication' });
        await this.storage.savePdf(jobId, join(output, result.filename), result.filename);
        const finished = await finishJob(this.db, jobId, startedAt, {
          status: 'ok',
          message: 'PDF generated',
          pdfFilename: result.filename,
        });
        terminal = finished.count === 1;
        if (terminal)
          this.log.info('generation.succeeded', {
            jobId,
            outcome: 'success',
            durationMs: performance.now() - started,
          });
        else await this.storage.removePdfs(jobId);
      }
    } catch (error) {
      this.log.error('generation.execution_failed', {
        jobId,
        ...safeError(error),
        durationMs: performance.now() - started,
      });
      // A lost database connection may leave the commit outcome unknown. Reconciliation owns cleanup then.
      const failed = await finishJob(this.db, jobId, startedAt, {
        status: 'failed',
        message:
          'Could not generate PDF. Check the template or contact the administrator.',
        pdfFilename: null,
      });
      if (failed.count === 1) {
        terminal = true;
        this.log.error('generation.failed', {
          jobId,
          outcome: 'failed',
          ...safeError(error),
          durationMs: performance.now() - started,
        });
        await this.storage.removePdfs(jobId);
      }
    } finally {
      if (terminal) {
        try {
          await this.storage.cleanupJob(jobId);
        } catch (error) {
          this.log.error('generation.cleanup_failed', {
            jobId,
            ...safeError(error),
          });
          throw error;
        }
      }
    }
  }

  async reconcile(): Promise<void> {
    const before = new Date(Date.now() - this.wallTimeMs - 60_000);
    for (const job of await listStaleJobs(this.db, before)) {
      if (!job.startedAt) continue;
      const finished = await finishJob(this.db, job.id, job.startedAt, {
        status: 'failed',
        message: 'Generation was interrupted. Submit a new job to try again.',
        pdfFilename: null,
      });
      if (finished.count === 1)
        this.log.error('generation.interrupted', {
          jobId: job.id,
          outcome: 'failed',
        });
    }
    for (const job of await listTerminalJobs(this.db)) {
      try {
        // Stop the producer before removing anything it could still write to after a crash.
        await this.generator.stop(job.id);
        if (job.status === 'failed') await this.storage.removePdfs(job.id);
        await this.storage.cleanupJob(job.id);
      } catch (error) {
        this.log.error('generation.cleanup_failed', {
          jobId: job.id,
          ...safeError(error),
        });
      }
    }
  }
}

export async function reconcileFailedDeliveries(
  db: Database,
  queue: {
    getJob(id: string): Promise<{ getState(): Promise<string> } | undefined>;
  },
  logger: Logger = silentLogger,
): Promise<void> {
  for (const job of await listQueuedJobs(db)) {
    const delivery = await queue.getJob(`job-${job.id}`);
    if (delivery && (await delivery.getState()) === 'failed') {
      const failed = await failQueuedJob(
        db,
        job.id,
        'Generation delivery was interrupted. Submit a new job to try again.',
      );
      if (failed.count === 1)
        logger.error('generation.interrupted', {
          jobId: job.id,
          outcome: 'failed',
          errorCode: 'queue',
        });
    }
  }
}
