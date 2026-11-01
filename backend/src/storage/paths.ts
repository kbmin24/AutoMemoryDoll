import { isAbsolute } from 'node:path';

const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function validateSegments(segments: string[]): string[] {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 9) {
    throw new Error('Invalid path depth');
  }

  let length = 0;
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length > 128 ||
        segment === '.' || segment === '..' || !namePattern.test(segment) ||
        segment.endsWith('.') || segment.endsWith(' ') ||
        segment.includes('/') || segment.includes('\\') || isAbsolute(segment)) {
      throw new Error('Invalid path segment');
    }
    length += Buffer.byteLength(segment) + 1;
  }
  if (length - 1 > 512) throw new Error('Path too long');
  return [...segments];
}

// Validates if id is a valid UUID
export function validateId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Invalid identifier');
  }
  return id;
}
