import type { Database } from '../users/users.repository.js';

export function insertJob(db: Database, input: { id: string; userId: string; templateId: string }) {
  return db.generationJob.create({
    data: {
      id: input.id,
      userId: input.userId,
      templateId: input.templateId,
      message: 'Waiting to generate',
    },
    include: { template: { select: { name: true } } },
  });
}

export function listOwnedJobs(db: Database, userId: string) {
  return db.generationJob.findMany({
    where: { userId },
    orderBy: { timestamp: 'desc' },
    include: { template: { select: { name: true } } },
  });
}

export function findOwnedJob(db: Database, userId: string, jobId: string) {
  return db.generationJob.findFirst({
    where: { id: jobId, userId },
    include: { template: { select: { name: true } } },
  });
}

export function listQueuedJobs(db: Database) {
  return db.generationJob.findMany({
    where: { status: 'queued' },
    select: { id: true },
  });
}

export function failQueuedJob(db: Database, jobId: string, message: string) {
  return db.generationJob.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'failed', message, completedAt: new Date() },
  });
}

export function claimJob(db: Database, jobId: string, startedAt: Date) {
  return db.generationJob.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'generating', message: 'Generating PDF', startedAt },
  });
}

export function finishJob(
  db: Database,
  jobId: string,
  startedAt: Date,
  result: {
    status: 'ok' | 'failed';
    message: string;
    pdfFilename: string | null;
  },
) {
  return db.generationJob.updateMany({
    where: { id: jobId, status: 'generating', startedAt },
    data: { ...result, completedAt: new Date() },
  });
}

export function listStaleJobs(db: Database, before: Date) {
  return db.generationJob.findMany({
    where: { status: 'generating', startedAt: { lt: before } },
    select: { id: true, startedAt: true },
  });
}

export function listTerminalJobs(db: Database) {
  return db.generationJob.findMany({
    where: { status: { in: ['ok', 'failed'] } },
    select: { id: true, status: true },
  });
}
