import sharp from 'sharp';
import { StorageError } from './storage.errors.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;
const PREVIEW_DIMENSION = 2048;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let activePreviews = 0;

function rejectImage(): never {
  throw new StorageError('Image cannot be previewed');
}

export function sanitizePng(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) rejectImage();
  const sanitized = Buffer.allocUnsafe(bytes.length);
  PNG_SIGNATURE.copy(sanitized);
  let written = PNG_SIGNATURE.length;
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) rejectImage();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') rejectImage();
    const required = ['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type);
    if (!required && (bytes[offset + 4]! & 0x20) === 0) rejectImage();
    // Compressed ancillary metadata can expand independently of pixel limits.
    if (required || type === 'tRNS') {
      written += bytes.copy(sanitized, written, offset, end);
    }
    if (type === 'IEND') {
      if (length !== 0) rejectImage();
      return sanitized.subarray(0, written);
    }
    offset = end;
  }
  rejectImage();
}

// Reserve before loading bytes so overload cannot accumulate buffered inputs.
export async function createImagePreview(
  load: () => Promise<Buffer>,
): Promise<Buffer> {
  if (activePreviews >= 2) throw new StorageError('Image preview is busy');
  activePreviews++;
  try {
    const bytes = await load();
    if (!bytes.length || bytes.length > MAX_BYTES) rejectImage();
    const png = bytes.subarray(0, 8).equals(PNG_SIGNATURE);
    const jpeg =
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    if (!png && !jpeg) rejectImage();
    const input = png ? sanitizePng(bytes) : bytes;

    // shortcut: processing timeout is cooperative; use process isolation for hard resource limits.
    const decoder = sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_PIXELS,
      limitInputChannels: 4,
      unlimited: false,
      ignoreIcc: true,
    }).timeout({ seconds: 3 });
    try {
      const metadata = await decoder.metadata();
      if (
        metadata.format !== (png ? 'png' : 'jpeg') ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > MAX_DIMENSION ||
        metadata.height > MAX_DIMENSION ||
        metadata.width * metadata.height > MAX_PIXELS ||
        (metadata.pages ?? 1) !== 1
      )
        rejectImage();

      // Re-encoding strips source metadata and trailing payloads; never serve input bytes.
      return await decoder
        .autoOrient()
        .resize(PREVIEW_DIMENSION, PREVIEW_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    } catch {
      rejectImage();
    } finally {
      decoder.destroy();
    }
  } finally {
    activePreviews--;
  }
}
