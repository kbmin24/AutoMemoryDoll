import { silentLogger, safeError, type Logger } from '../logging/logger.js';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { validateId } from '../storage/paths.js';
import {
  PdfGenerator,
  type PreviewResult,
  type CompilerResult,
} from './pdf-generator.js';
import type { CompilerConfig } from './config.js';

export type DockerResult = { code: number | null; stderr: string };
type ExecuteDocker = (
  args: string[],
  timeoutMs: number,
) => Promise<DockerResult>;

export function runDocker(
  args: string[],
  timeoutMs: number,
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          Object.assign(new Error('Compiler container timed out'), {
            code: 'COMPILER_TIMEOUT',
          }),
        );
      else resolve({ code, stderr });
    });
  });
}

function containerName(jobId: string): string {
  return `amd-compiler-${validateId(jobId)}`;
}

export class ContainerPdfGenerator extends PdfGenerator {
  constructor(
    private readonly config: CompilerConfig,
    private readonly execute: ExecuteDocker = runDocker,
    private readonly logger: Logger = silentLogger,
  ) {
    super();
  }

  generate(inputDir: string, outputDir: string): Promise<CompilerResult> {
    return this.generateForMode(inputDir, outputDir, false);
  }

  generatePreview(inputDir: string, outputDir: string): Promise<PreviewResult> {
    return this.generateForMode(inputDir, outputDir, true);
  }

  private generateForMode(
    inputDir: string,
    outputDir: string,
    preview: false,
  ): Promise<CompilerResult>;
  private generateForMode(
    inputDir: string,
    outputDir: string,
    preview: true,
  ): Promise<PreviewResult>;
  private async generateForMode(
    inputDir: string,
    outputDir: string,
    preview: boolean,
  ): Promise<CompilerResult | PreviewResult> {
    if (
      !isAbsolute(inputDir) ||
      !isAbsolute(outputDir) ||
      inputDir.includes(',') ||
      outputDir.includes(',') ||
      basename(inputDir) !== 'input' ||
      basename(outputDir) !== 'output' ||
      dirname(inputDir) !== dirname(outputDir)
    ) {
      throw new Error('Invalid compiler mount paths');
    }
    const jobId = validateId(basename(dirname(inputDir)));
    const started = performance.now();
    this.logger.debug('compiler.debug', { jobId, phase: 'container' });
    let result: DockerResult;
    try {
      result = await this.execute(
        [
          'run',
          '--rm',
          `--name=${containerName(jobId)}`,
          '--runtime=runsc',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          `--user=${this.config.uid}:${this.config.gid}`,
          `--cpus=${this.config.cpus}`,
          `--memory=${this.config.memoryMb}m`,
          `--memory-swap=${this.config.memoryMb}m`,
          `--pids-limit=${this.config.pids}`,
          '--mount',
          `type=bind,source=${inputDir},target=/input,readonly`,
          '--mount',
          `type=bind,source=${outputDir},target=/output`,
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,mode=1777',
          this.config.image,
          ...(preview ? ['/input', '/output', '--preview'] : []),
        ],
        this.config.wallTimeMs,
      );
    } catch (error) {
      this.logger.error('compiler.failed', {
        jobId,
        ...safeError(error),
        durationMs: performance.now() - started,
      });
      throw error;
    } finally {
      // Killing the CLI alone does not guarantee the daemon stopped the container.
      await this.stop(jobId);
    }
    let manifest: CompilerResult | PreviewResult;
    try {
      manifest = preview
        ? await this.readResult(outputDir, true)
        : await this.readResult(outputDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.logger.error('compiler.failed', {
        jobId,
        exitCode: result.code,
        errorCode: 'compiler',
        durationMs: performance.now() - started,
      });
      throw new Error(
        `Compiler container did not produce result.json (Docker exit code: ${result.code})`,
        { cause: error },
      );
    }
    if (result.code !== 0 && manifest.result === 'ok') {
      this.logger.error('compiler.failed', {
        jobId,
        exitCode: result.code,
        errorCode: 'compiler',
      });
      throw new Error('Compiler exited unsuccessfully');
    }
    this.logger.log(
      manifest.result === 'failed' ? 'warn' : 'debug',
      'compiler.completed',
      {
        jobId,
        exitCode: result.code,
        durationMs: performance.now() - started,
        outcome: manifest.result === 'failed' ? 'rejected' : 'success',
      },
    );
    return manifest;
  }

  async stop(jobId: string): Promise<void> {
    const result = await this.execute(
      ['rm', '--force', containerName(jobId)],
      10_000,
    );
    if (result.code !== 0 && !result.stderr.includes('No such container')) {
      this.logger.error('compiler.failed', {
        jobId,
        exitCode: result.code,
        errorCode: 'compiler',
      });
      throw new Error('Could not remove compiler container');
    }
  }
}
