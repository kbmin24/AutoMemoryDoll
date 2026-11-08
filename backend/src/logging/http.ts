import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { AuthRequest } from '../auth/auth.middleware.js';
import { safeError, silentLogger, type Logger } from './logger.js';

export type SafeActionFields = {
  actorId?: string;
  targetId?: string;
  templateId?: string;
  jobId?: string;
};
type Context = SafeActionFields & {
  logger: Logger;
  requestId: string;
  route: string;
  action?: string;
  committed: boolean;
  failed: boolean;
  actionPending?: boolean;
  downloadPending?: boolean;
  actionStatus?: number;
  emitAction?: () => void;
};
const contexts = new WeakMap<Response, Context>();

// Fixed patterns keep user paths and query strings out of request and action logs.
const operations: [string, string, string?][] = [
  ['POST', '/api/auth/login', 'auth.login'],
  ['POST', '/api/auth/logout', 'auth.logout'],
  ['POST', '/api/auth/password', 'auth.password_changed'],
  ['GET', '/api/auth/me'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users', 'account.created'],
  ['PATCH', '/api/admin/users/:id', 'account.disabled_changed'],
  ['PATCH', '/api/owner/users/:id/role', 'account.role_changed'],
  ['GET', '/api/templates'],
  ['POST', '/api/templates', 'template.created'],
  ['GET', '/api/templates/:id'],
  ['PATCH', '/api/templates/:id', 'template.updated'],
  ['DELETE', '/api/templates/:id', 'template.deleted'],
  ['GET', '/api/templates/:id/files'],
  ['DELETE', '/api/templates/:id/files', 'workspace.deleted'],
  ['POST', '/api/templates/:id/files/directories', 'workspace.directory_created'],
  ['GET', '/api/templates/:id/files/text'],
  ['PUT', '/api/templates/:id/files/text', 'workspace.text_updated'],
  ['POST', '/api/templates/:id/files/uploads', 'workspace.uploaded'],
  ['POST', '/api/templates/:id/files/move', 'workspace.moved'],
  ['GET', '/api/templates/:id/files/download', 'workspace.downloaded'],
  ['POST', '/api/templates/:id/generations', 'generation.submitted'],
  ['GET', '/api/jobs'],
  ['GET', '/api/jobs/:id'],
  ['GET', '/api/jobs/:id/pdf', 'pdf.downloaded'],
];
const matchers = operations.map(([method, route, action]) => ({
  method,
  route,
  action,
  pattern: new RegExp(`^${route.replace(':id', '([^/]+)')}/?$`, 'i'),
}));

function context(response: Response): Context | undefined {
  return contexts.get(response);
}

export function requestLogger(response: Response): Logger {
  const value = context(response);
  return value ? value.logger.child({ requestId: value.requestId }) : silentLogger;
}

export function markActionSuccess(
  response: Response,
  fields: SafeActionFields = {},
): void {
  const value = context(response);
  if (value) {
    Object.assign(value, fields, { committed: true, actionPending: false });
    const emit = value.emitAction;
    value.emitAction = undefined;
    emit?.();
  }
}

export function beginAction(response: Response): void {
  const value = context(response);
  if (value?.action) value.actionPending = true;
}

export function failAction(response: Response, status: number): void {
  const value = context(response);
  if (value) {
    value.actionStatus = status;
    value.actionPending = false;
    const emit = value.emitAction;
    value.emitAction = undefined;
    emit?.();
  }
}

export async function logDownload(
  response: Response,
  transfer: () => Promise<void>,
  fields: SafeActionFields,
): Promise<void> {
  const value = context(response);
  if (value) {
    value.actionPending = true;
    value.downloadPending = true;
    Object.assign(value, fields);
  }
  try {
    await transfer();
    markActionSuccess(response, fields);
  } catch (error) {
    failAction(response, 500);
    throw error;
  } finally {
    if (value) value.downloadPending = false;
  }
}

export function logRequestError(
  logger: Logger,
  response: Response,
  error: unknown,
): void {
  const value = context(response);
  if (value?.failed) return;
  if (value) value.failed = true;
  logger.error('http.failed', {
    requestId: value?.requestId,
    ...safeError(error),
  });
}

export function requestLogging(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const started = performance.now();
    const operation = matchers.find(
      (item) =>
        item.method === (request.method === 'HEAD' ? 'GET' : request.method) &&
        item.pattern.test(request.path),
    );
    const value: Context = {
      logger,
      requestId: randomUUID(),
      route: operation?.route ?? 'unmatched',
      action: operation?.action,
      actionPending: Boolean(operation?.action),
      committed: false,
      failed: false,
    };
    const target = operation?.pattern.exec(request.path)?.[1];
    if (
      target &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
    ) {
      if (operation!.route.startsWith('/api/templates/')) value.templateId = target;
      else if (operation!.route.startsWith('/api/jobs/')) value.jobId = target;
      else value.targetId = target;
    }
    contexts.set(response, value);
    response.setHeader('X-Request-ID', value.requestId);
    let recorded = false;
    const record = (aborted: boolean) => {
      if (recorded) return;
      recorded = true;
      const status = aborted && !response.headersSent ? undefined : response.statusCode;
      const unexpected = value.failed || (status !== undefined && status >= 500);
      const rejected = status !== undefined && status >= 400;
      let level = 'info';
      if (unexpected) level = 'error';
      else if (aborted || rejected) level = 'warn';
      let outcome = 'success';
      if (aborted) outcome = 'aborted';
      else if (unexpected) outcome = 'failed';
      else if (rejected) outcome = 'rejected';
      const fields = {
        requestId: value.requestId,
        route: value.route,
        method: request.method,
        status,
        durationMs: performance.now() - started,
        actorId: value.actorId ?? (request as AuthRequest).currentUser?.id,
        clientIp: request.ip,
      };
      logger.log(level, aborted ? 'http.aborted' : 'http.completed', {
        ...fields,
        outcome,
      });
      if (!aborted && !value.downloadPending) value.actionPending = false;
      const emitAction = () => {
        if (value.action) {
          const actionStatus = value.actionStatus ?? status;
          const actionFailed =
            value.failed || (actionStatus !== undefined && actionStatus >= 500);
          const actionRejected = actionStatus !== undefined && actionStatus >= 400;
          let outcome = 'failed';
          if (value.committed) outcome = 'success';
          else if (actionFailed) outcome = 'failed';
          else if (actionRejected) outcome = 'rejected';
          else if (aborted) outcome = 'aborted';
          let actionLevel = 'warn';
          if (outcome === 'success') actionLevel = 'info';
          else if (outcome === 'failed') actionLevel = 'error';
          logger.log(actionLevel, value.action, {
            ...fields,
            actorId: value.actorId ?? (request as AuthRequest).currentUser?.id,
            durationMs: performance.now() - started,
            targetId: value.targetId,
            templateId: value.templateId,
            jobId: value.jobId,
            outcome,
          });
        }
      };
      if (value.actionPending) value.emitAction = emitAction;
      else emitAction();
    };
    response.once('finish', () => record(false));
    response.once('close', () => record(!response.writableFinished));
    next();
  };
}
