/**
 * A tiny PNG encoder.
 *
 * Used by the procedural image adapter so themeseed can produce valid,
 * correctly-sized images with no API key and no network — which is what makes
 * the tool demoable out of the box and the integration test loop hermetic.
 *
 * Only what is needed: 8-bit truecolour, no interlacing, no palette. Node's
 * zlib does the compression, so this is ~100 lines rather than a dependency.
 */

import zlib from 'node:zlib';

export interface RgbPixel {
  r: number;
  g: number;
  b: number;
}

/**
 * Encodes raw RGB pixels as PNG bytes.
 * `pixelAt` is called once per pixel and must return values in 0..255.
 */
export function encodePng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => RgbPixel
): Uint8Array {
  // Each scanline is prefixed with a filter-type byte; 0 = None.
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);

  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const { r, g, b } = pixelAt(x, y);
      raw[offset++] = clamp(r);
      raw[offset++] = clamp(g);
      raw[offset++] = clamp(b);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return new Uint8Array(png);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

let crcTable: Int32Array | null = null;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buffer.length; i++) {
    c = crcTable[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
  }
  return c ^ -1;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/**
 * Deterministic 32-bit hash, used to turn a prompt into a stable colour scheme
 * so the same query always yields the same picture. Reproducible output makes
 * failures reproducible too.
 */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32), seeded from `hashString`. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
