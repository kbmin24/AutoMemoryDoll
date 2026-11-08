import { Writable } from 'node:stream';
import winston from 'winston';

export function captureLogs(level = 'debug') {
  const events: Record<string, any>[] = [];
  const stream = new Writable({
    objectMode: true,
    write(info, _encoding, callback) {
      events.push({ ...info });
      callback();
    },
  });
  const logger = winston.createLogger({
    level,
    transports: [new winston.transports.Stream({ stream })],
  });
  return { logger, events };
}
