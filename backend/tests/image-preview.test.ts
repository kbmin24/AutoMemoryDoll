import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createImagePreview,
  sanitizePng,
} from '../src/storage/image-preview.js';
import { StorageError } from '../src/storage/storage.errors.js';

const image = (format: 'png' | 'jpeg', width = 8, height = 6) =>
  sharp({ create: { width, height, channels: 3, background: '#aabbcc' } })
    .toFormat(format)
    .toBuffer();

describe('image previews', () => {
  it.each(['png', 'jpeg'] as const)(
    'decodes actual %s and returns PNG pixels',
    async (format) => {
      const output = await createImagePreview(async () => image(format));
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(8);
      expect(metadata.height).toBe(6);
    },
  );

  it('bounds output size and strips metadata and appended payloads', async () => {
    const source = await sharp(await image('jpeg', 3000, 1500))
      .withExif({ IFD0: { Artist: 'private metadata' } })
      .jpeg()
      .toBuffer();
    const output = await createImagePreview(async () =>
      Buffer.concat([source, Buffer.from('<script>secret-payload</script>')]),
    );
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(2048);
    expect(metadata.height).toBe(1024);
    expect(metadata.exif).toBeUndefined();
    expect(output.includes(Buffer.from('secret-payload'))).toBe(false);
  });

  it.each([
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    ),
    Buffer.from('<html><script>alert(1)</script></html>'),
    Buffer.from('GIF89a'),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  ])('rejects unsupported or header-only content', async (source) => {
    await expect(createImagePreview(async () => source)).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it.each([
    ['png', 4001, 4000],
    ['jpeg', 4001, 4000],
    ['png', 8193, 1],
    ['jpeg', 8193, 1],
  ] as const)(
    'rejects compressed %s dimension bombs %s × %s',
    async (format, width, height) => {
      const source = await image(format, width, height);
      expect(source.length).toBeLessThan(1024 * 1024);
      await expect(
        createImagePreview(async () => source),
      ).rejects.toBeInstanceOf(StorageError);
    },
  );

  it('rejects truncated compressed pixels', async () => {
    const source = await image('png');
    await expect(
      createImagePreview(async () => source.subarray(0, source.length - 20)),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects oversized encoded input', async () => {
    await expect(
      createImagePreview(async () => Buffer.alloc(20 * 1024 * 1024 + 1)),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects overload without loading another input and releases failed slots', async () => {
    const source = await image('png');
    let release!: (value: Buffer) => void;
    const waiting = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const first = createImagePreview(() => waiting);
    const second = createImagePreview(() => waiting);
    let loaded = false;
    await expect(
      createImagePreview(async () => {
        loaded = true;
        return source;
      }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(loaded).toBe(false);
    release(source);
    await Promise.all([first, second]);
    await expect(
      createImagePreview(async () => {
        throw new Error('disk failure');
      }),
    ).rejects.toThrow('disk failure');
    expect(
      (await createImagePreview(async () => source)).length,
    ).toBeGreaterThan(0);
  });
});

it('rejects APNG animation before decoding frames', async () => {
  const source = await image('png');
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write('acTL', 4);
  animation.writeUInt32BE(2, 8);
  animation.writeUInt32BE(crc32(animation.subarray(4, 16)), 16);
  const apng = Buffer.concat([
    source.subarray(0, 33),
    animation,
    source.subarray(33),
  ]);
  await expect(createImagePreview(async () => apng)).rejects.toBeInstanceOf(
    StorageError,
  );
});

it('rejects enormous declared dimensions without allocating their pixels', async () => {
  const source = await image('png');
  source.writeUInt32BE(100_000, 16);
  source.writeUInt32BE(100_000, 20);
  source.writeUInt32BE(crc32(source.subarray(12, 29)), 29);
  await expect(createImagePreview(async () => source)).rejects.toBeInstanceOf(
    StorageError,
  );
});

it('accepts the pixel limit and axis boundary', async () => {
  const preview = await createImagePreview(async () =>
    image('png', 4000, 4000),
  );
  expect((await sharp(preview).metadata()).width).toBe(2048);
  const narrow = await createImagePreview(async () => image('png', 8192, 1));
  expect((await sharp(narrow).metadata()).width).toBe(2048);
});

it('removes compressed metadata before the native decoder sees it', async () => {
  const source = await image('png');
  const compressed = deflateSync(Buffer.alloc(32 * 1024 * 1024, 65));
  const payload = Buffer.concat([Buffer.from('Comment\0\0'), compressed]);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write('zTXt', 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bomb = Buffer.concat([
    source.subarray(0, 33),
    chunk,
    source.subarray(33),
  ]);
  expect(bomb.length).toBeLessThan(40_000);
  const sanitized = sanitizePng(bomb);
  expect(sanitized.length).toBeLessThan(1024);
  expect((await sharp(sanitized).metadata()).comments).toBeUndefined();
  const preview = await createImagePreview(async () => bomb);
  expect((await sharp(preview).metadata()).width).toBe(8);
});

it('rejects truncated JPEG pixels', async () => {
  const source = await image('jpeg');
  await expect(
    createImagePreview(async () => source.subarray(0, source.length - 30)),
  ).rejects.toBeInstanceOf(StorageError);
});

it('preserves palette transparency after removing ancillary metadata', async () => {
  const source = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0 },
    },
  })
    .png({ palette: true })
    .toBuffer();
  const preview = await createImagePreview(async () => source);
  const { data, info } = await sharp(preview)
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  expect(data[3]).toBe(0);
});
