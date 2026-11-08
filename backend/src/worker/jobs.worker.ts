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
    private readonly log: (message: string, error?: unknown) => void = console.error,
  ) {}

  async processJob(jobId: string): Promise<void> {
    validateId(jobId);
    const startedAt = new Date();
    const claimed = await claimJob(this.db, jobId, startedAt);
    if (claimed.count === 0) return;

    let terminal = false;
    try {
      const { input, output } = await this.storage.prepareJobOutput(jobId);
      const result = await this.generator.generate(input, output);
      if (result.result === 'failed') {
        this.log(`Compiler failed for job ${jobId}`, result.message);
        // Compiler diagnostics can contain host paths and user-controlled TeX; keep them private.
        const failed = await finishJob(this.db, jobId, startedAt, {
          status: 'failed',
          message: 'Document compilation failed. Check the template and supplied values.',
          pdfFilename: null,
        });
        terminal = failed.count === 1;
      } else {
        await this.storage.savePdf(jobId, join(output, result.filename), result.filename);
        const finished = await finishJob(this.db, jobId, startedAt, {
          status: 'ok',
          message: 'PDF generated',
          pdfFilename: result.filename,
        });
        terminal = finished.count === 1;
        if (!terminal) await this.storage.removePdfs(jobId);
      }
    } catch (error) {
      this.log(`Generation failed for job ${jobId}`, error);
      // A lost database connection may leave the commit outcome unknown. Reconciliation owns cleanup then.
      const failed = await finishJob(this.db, jobId, startedAt, {
        status: 'failed',
        message: 'Could not generate PDF. Check the template or contact the administrator.',
        pdfFilename: null,
      });
      if (failed.count === 1) {
        terminal = true;
        await this.storage.removePdfs(jobId);
      }
    } finally {
      if (terminal) await this.storage.cleanupJob(jobId);
    }
  }

  async reconcile(): Promise<void> {
    const before = new Date(Date.now() - this.wallTimeMs - 60_000);
    for (const job of await listStaleJobs(this.db, before)) {
      if (!job.startedAt) continue;
      await finishJob(this.db, job.id, job.startedAt, {
        status: 'failed',
        message: 'Generation was interrupted. Submit a new job to try again.',
        pdfFilename: null,
      });
    }
    for (const job of await listTerminalJobs(this.db)) {
      try {
        // Stop the producer before removing anything it could still write to after a crash.
        await this.generator.stop(job.id);
        if (job.status === 'failed') await this.storage.removePdfs(job.id);
        await this.storage.cleanupJob(job.id);
      } catch (error) {
        this.log(`Could not clean job ${job.id}`, error);
      }
    }
  }
}

export async function reconcileFailedDeliveries(
  db: Database,
  queue: {
    getJob(id: string): Promise<{ getState(): Promise<string> } | undefined>;
  },
): Promise<void> {
  for (const job of await listQueuedJobs(db)) {
    const delivery = await queue.getJob(`job-${job.id}`);
    if (delivery && (await delivery.getState()) === 'failed') {
      await failQueuedJob(
        db,
        job.id,
        'Generation delivery was interrupted. Submit a new job to try again.',
      );
    }
  }
}
