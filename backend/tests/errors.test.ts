import { describe, expect, it } from 'vitest';
import { StorageError } from '../src/storage/storage.errors.js';
import { TemplateError } from '../src/templates/templates.service.js';
import { JobError } from '../src/jobs/jobs.service.js';
import { validateManifest } from '../src/templates/shape.js';
import { findResourceAliases, rewriteResourceTokens } from '../src/jobs/resource-tokens.js';
import { validateSegments } from '../src/storage/paths.js';

describe('domain error classification', () => {
  it('classifies invalid paths by type rather than their message', () => {
    for (const path of [[], ['..'], ['x'.repeat(129)], Array(10).fill('dir')]) {
      expect(() => validateSegments(path)).toThrow(StorageError);
    }
  });

  it('keeps invalid manifests in the template domain and preserves their public response', () => {
    for (const manifest of [
      {},
      { version: 1, shape: { fields: [] } },
      { version: 1, shape: { fields: [{}] } },
    ]) {
      try {
        validateManifest(manifest);
        expect.fail('Expected invalid manifest to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateError);
        expect(error).toMatchObject({ status: 400, publicMessage: 'Invalid workspace operation' });
      }
    }
  });

  it('throws JobError directly for malformed or missing resource aliases', () => {
    expect(() => findResourceAliases(['@resource(../secret)'])).toThrow(JobError);
    expect(() => rewriteResourceTokens('@resource(logo)', {})).toThrow(JobError);
  });
});
