import { describe, expect, it } from 'vitest';
import { validateGenerationData } from '../src/jobs/jobs.service.js';
import { validateManifest } from '../src/templates/shape.js';
import { buildPreviewData } from '../src/templates/template-preview.js';

const students = {
  variable: 'students',
  label: 'Students',
  type: 'object-list',
  optional: false,
  properties: [
    { variable: 'name', label: 'Name', type: 'text', optional: false },
    { variable: 'score', label: 'Score', type: 'number', optional: true },
  ],
};

describe('object-list template fields', () => {
  it('validates and previews declared properties', () => {
    const manifest = validateManifest({
      version: 1,
      shape: { fields: [students] },
    });
    expect(buildPreviewData(manifest)).toEqual({
      students: [{ name: 'Loream Ipsum', score: 1 }],
    });
    expect(() =>
      validateManifest({
        version: 1,
        shape: {
          fields: [
            {
              ...students,
              properties: [students.properties[0], students.properties[0]],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('preserves typed values and rejects missing required or unknown properties', () => {
    const manifest = validateManifest({
      version: 1,
      shape: { fields: [students] },
    });
    const data = { students: [{ name: 'Ada', score: 0 }, { name: 'Grace' }] };
    expect(validateGenerationData(manifest, data)).toEqual(data);
    for (const rows of [
      [],
      [{}],
      [{ name: 'Ada', extra: true }],
      [{ name: 'Ada', score: '0' }],
    ]) {
      expect(() =>
        validateGenerationData(manifest, { students: rows }),
      ).toThrow();
    }
  });
});
