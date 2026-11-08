import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { validateId } from '../storage/paths.js';

export type CompilerResult =
  | { result: 'ok'; filename: string; message: string }
  | { result: 'failed'; filename: null; message: string };

export abstract class PdfGenerator {
  abstract generate(inputDir: string, outputDir: string): Promise<CompilerResult>;
  abstract stop(jobId: string): Promise<void>;

  protected async readResult(outputDir: string): Promise<CompilerResult> {
    const file = await open(
      join(outputDir, 'result.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) {
        throw new Error('Invalid compiler manifest');
      }
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid compiler manifest');
      }
      const result = value as Record<string, unknown>;
      if (typeof result.message !== 'string') throw new Error('Invalid compiler message');
      if (result.result === 'failed' && result.filename === null) {
        return { result: 'failed', filename: null, message: result.message };
      }
      if (
        result.result !== 'ok' ||
        typeof result.filename !== 'string' ||
        !result.filename.endsWith('.pdf')
      ) {
        throw new Error('Invalid compiler filename');
      }
      validateId(result.filename.slice(0, -4));
      return {
        result: 'ok',
        filename: result.filename,
        message: result.message,
      };
    } finally {
      await file.close();
    }
  }
}
