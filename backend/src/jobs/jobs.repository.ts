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
