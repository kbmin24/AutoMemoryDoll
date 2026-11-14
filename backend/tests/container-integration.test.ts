import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileSystemStorage } from '../src/storage/filesystem-storage.js';
import { ContainerPdfGenerator } from '../src/worker/container-runner.js';
import { requireCompilerIdentity } from '../src/worker/config.js';

it.skipIf(process.env.RUN_COMPILER_INTEGRATION !== '1')(
  'compiles offline under runsc and removes output on failure',
  async () => {
    const identity = requireCompilerIdentity();
    const root = await mkdtemp(
      join(process.env.COMPILER_TEST_ROOT ?? tmpdir(), 'amd-runsc-'),
    );
    const storage = new FileSystemStorage(root);
    const generator = new ContainerPdfGenerator({
      ...identity,
      image: process.env.COMPILER_IMAGE ?? 'automemorydoll-compiler:local',
      cpus: 1,
      memoryMb: 1024,
      pids: 64,
      wallTimeMs: 120_000,
    });
    const templateId = randomUUID();
    try {
      await storage.createTemplateRoot(templateId);
      await storage.writeText(
        templateId,
        ['template.tex'],
        '\\documentclass{article}\n\\begin{document}Hello {{ name }}\\end{document}',
      );
      const goodId = randomUUID();
      const input = await storage.snapshot(templateId, goodId);
      await writeFile(
        join(input, 'data.json'),
        JSON.stringify({ name: 'Ada & friends' }),
      );
      const { output } = await storage.prepareJobOutput(goodId);
      const success = await generator.generate(input, output);
      expect(success.result).toBe('ok');
      if (success.result !== 'ok') throw new Error('Expected compiler success');
      expect(
        (await readFile(join(output, success.filename)))
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
      await storage.savePdf(
        goodId,
        join(output, success.filename),
        success.filename,
      );
      await storage.cleanupJob(goodId);
      expect(await readdir(join(root, 'pdfs', goodId))).toEqual([
        success.filename,
      ]);

      await storage.writeText(
        templateId,
        ['template.tex'],
        '\\documentclass{missing-amd-class}\n\\begin{document}bad\\end{document}',
      );
      const badId = randomUUID();
      const badInput = await storage.snapshot(templateId, badId);
      await writeFile(join(badInput, 'data.json'), '{}');
      const bad = await storage.prepareJobOutput(badId);
      expect((await generator.generate(badInput, bad.output)).result).toBe(
        'failed',
      );
      expect(
        (await readdir(bad.output)).filter((name) => name.endsWith('.pdf')),
      ).toEqual([]);
      await storage.cleanupJob(badId);
      expect(await storage.jobInputExists(badId)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  300_000,
);
