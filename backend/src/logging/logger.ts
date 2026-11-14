import { lstatSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { loadLoggingConfig, type LoggingConfig } from './config.js';
import { cleanupLogs } from './retention.js';

export type { Logger } from 'winston';
export const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

const events = new Set([
  'http.completed',
  'http.aborted',
  'http.failed',
  'http.debug',
  'auth.login',
  'auth.logout',
  'auth.password_changed',
  'account.created',
  'account.disabled_changed',
  'account.role_changed',
  'account.owner_created',
  'template.created',
  'template.updated',
  'template.deleted',
  'workspace.directory_created',
  'workspace.text_updated',
  'workspace.uploaded',
  'workspace.moved',
  'workspace.deleted',
  'workspace.downloaded',
  'pdf.downloaded',
  'preview.backfill_completed',
  'preview.scheduled',
  'preview.scheduling_failed',
  'preview.started',
  'preview.succeeded',
  'preview.rejected',
  'preview.failed',
  'preview.cleanup_failed',
  'preview.interrupted',
  'generation.submitted',
  'generation.started',
  'generation.succeeded',
  'generation.rejected',
  'generation.failed',
  'generation.interrupted',
  'generation.execution_failed',
  'generation.cleanup_failed',
  'generation.debug',
  'queue.reconciliation_failed',
  'queue.delivery_failed',
  'queue.error',
  'compiler.completed',
  'compiler.failed',
  'compiler.debug',
  'service.starting',
  'service.ready',
  'service.stopping',
  'service.stopped',
  'service.startup_failed',
  'service.shutdown_failed',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
const errorCodes = new Set([
  'unexpected',
  'invalid_input',
  'not_found',
  'forbidden',
  'unauthenticated',
  'storage',
  'database',
  'queue',
  'compiler',
  'timeout',
  'filesystem',
  'configuration',
]);
const phases = new Set([
  'snapshot',
  'queue',
  'claim',
  'container',
  'result',
  'publication',
]);

export function safeError(error: unknown): {
  errorCode: string;
  errorMessage: string;
  stack?: string;
} {
  const diagnostic = error instanceof Error ? error : new Error(String(error));
  let errorCode = 'unexpected';
  if (error instanceof Error && 'code' in error) {
    if (
      ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(
        String(error.code),
      )
    )
      errorCode = 'filesystem';
    if (error.code === 'COMPILER_TIMEOUT') errorCode = 'timeout';
  }
  return {
    errorCode,
    errorMessage: diagnostic.message,
    stack: diagnostic.stack,
  };
}

function safeFields(info: winston.Logform.TransformableInfo) {
  const result: winston.Logform.TransformableInfo = {
    level: info.level,
    message: events.has(info.message as string)
      ? info.message
      : 'logging.invalid_event',
    [Symbol.for('level')]: info[Symbol.for('level')],
  };
  result.event = result.message;
  for (const key of [
    'requestId',
    'jobId',
    'actorId',
    'targetId',
    'templateId',
  ]) {
    if (typeof info[key] === 'string' && uuid.test(info[key] as string))
      result[key] = info[key];
  }
  if (
    typeof info.deliveryId === 'string' &&
    /^(?:job|preview)-[0-9a-f-]{36}$/i.test(info.deliveryId)
  )
    result.deliveryId = info.deliveryId;
  for (const key of ['status', 'durationMs', 'exitCode', 'port']) {
    if (
      typeof info[key] === 'number' &&
      Number.isFinite(info[key]) &&
      (key === 'exitCode' || (info[key] as number) >= 0)
    )
      result[key] = info[key];
  }
  if (methods.has(info.method as string)) result.method = info.method;
  if (
    typeof info.route === 'string' &&
    info.route.length <= 160 &&
    /^\/(?:api|health)(?:\/[a-z:_-]+)*$/.test(info.route)
  )
    result.route = info.route;
  else if (info.route === 'unmatched') result.route = 'unmatched';
  if (typeof info.clientIp === 'string' && isIP(info.clientIp))
    result.clientIp = info.clientIp;
  if (
    ['success', 'rejected', 'failed', 'aborted'].includes(
      info.outcome as string,
    )
  )
    result.outcome = info.outcome;
  if (errorCodes.has(info.errorCode as string))
    result.errorCode = info.errorCode;
  if (phases.has(info.phase as string)) result.phase = info.phase;
  if (typeof info.timedOut === 'boolean') result.timedOut = info.timedOut;
  for (const key of ['errorMessage', 'stack']) {
    if (typeof info[key] === 'string') result[key] = info[key];
  }
  // Events without an exception show where the failure was logged.
  if (info.level === 'error' && !result.stack)
    result.stack = new Error(String(result.event)).stack;
  return result;
}

const lifecycles = new WeakMap<winston.Logger, () => Promise<void>>();

export function createServiceLogger(
  service: 'api' | 'consumer' | 'owner-cli' | 'preview-cli',
  config: LoggingConfig,
): winston.Logger {
  const logger = winston.createLogger({
    level: config.level,
    format: winston.format.combine(
      winston.format(safeFields)(),
      winston.format((info) => {
        info.service = service;
        return info;
      })(),
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console({ stderrLevels: ['error'] })],
  });
  let reported = false;
  let file: DailyRotateFile | undefined;
  let timer: NodeJS.Timeout | undefined;
  let maintenance = Promise.resolve();
  let activeFile = '';
  let closing = false;
  let drained = false;
  function fallback(error?: unknown) {
    if (reported) return;
    reported = true;
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service,
        level: 'error',
        event: 'logging.file_failed',
        ...safeError(error ?? new Error('Log file output failed')),
        errorCode: 'filesystem',
      }) + '\n',
    );
  }
  function fileFailed(error?: unknown) {
    fallback(error);
    if (timer) clearInterval(timer);
    if (file) {
      const failed = file;
      file = undefined;
      failed.silent = true;
      logger.remove(failed);
      failed.close?.();
    }
  }
  logger.on('error', (error: unknown, transport?: DailyRotateFile) => {
    if (transport) {
      transport.silent = true;
      logger.remove(transport);
    }
    fileFailed(error);
  });
  const directory = join(config.directory, service);
  function cleanup() {
    maintenance = maintenance
      .then(async () => {
        if (file && activeFile) {
          // Empty writes advance date/size rotation without emitting an event.
          if (!closing) file.logStream.write('');
          await cleanupLogs(
            directory,
            config.retentionDays,
            config.maxTotalBytes,
            drained ? '' : activeFile,
          );
        }
      })
      .catch((error) => {
        fallback(error);
      });
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of [config.directory, directory]) {
      const info = lstatSync(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error('Unsafe log directory');
    }
    // The transport rounds numeric byte limits to whole KB; strings preserve sub-KB limits.
    const rotationKilobytes =
      config.maxFileBytes < 1024
        ? config.maxFileBytes / 1024
        : Math.floor(config.maxFileBytes / 1024);
    file = new DailyRotateFile({
      dirname: directory,
      filename: 'application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      utc: true,
      maxSize: `${rotationKilobytes}k`,
      maxFiles: `${config.retentionDays}d`,
      auditFile: join(directory, '.rotation-audit.json'),
      options: { flags: 'a', mode: 0o600 },
    });
    file.on('error', fallback);
    file.logStream.on('error', fileFailed);
    file.on('new', (name: string) => {
      activeFile = name;
      cleanup();
    });
    logger.add(file);
    timer = setInterval(
      cleanup,
      config.maxTotalBytes === undefined ? 3_600_000 : 60_000,
    );
    timer.unref();
  } catch (error) {
    fileFailed(error);
  }
  lifecycles.set(logger, async () => {
    closing = true;
    if (timer) clearInterval(timer);
    await maintenance;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      logger.once('finish', () => {
        clearTimeout(timeout);
        resolve();
      });
      logger.end();
    });
    if (file) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        file!.logStream.end(() => {
          drained = true;
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    logger.close();
    cleanup();
    await maintenance;
  });
  return logger;
}

export async function closeLogger(logger: winston.Logger): Promise<void> {
  const close = lifecycles.get(logger);
  lifecycles.delete(logger);
  if (close) await close();
}

export async function runService(
  service: 'api' | 'consumer' | 'owner-cli' | 'preview-cli',
  start: (logger: winston.Logger, config: LoggingConfig) => Promise<void>,
): Promise<void> {
  let logger: winston.Logger | undefined;
  try {
    const config = loadLoggingConfig(process.env);
    logger = createServiceLogger(service, config);
    logger.info('service.starting');
    await start(logger, config);
  } catch (error) {
    if (logger) {
      logger.error('service.startup_failed', safeError(error));
      await closeLogger(logger);
    } else {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service,
          level: 'error',
          event: 'service.startup_failed',
          ...safeError(error),
          errorCode: 'configuration',
        }) + '\n',
      );
    }
    process.exit(1);
  }
}
