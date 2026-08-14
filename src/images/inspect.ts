/**
 * Minimal image header parser: format detection plus intrinsic dimensions.
 *
 * Two jobs, one implementation. Gallery cards need real pixel dimensions to
 * lay out, and every image source needs to prove that what it fetched is
 * actually an image rather than an HTML error page with a .jpg URL — a very
 * common failure with stock APIs and CDNs. Parsing the header answers both.
 *
 * Deliberately dependency-free: `sharp`/`image-size` would pull a native build
 * step into a tool whose whole job is to be easy to install.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif';

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  mimeType: string;
}

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Returns null when the bytes are not a recognisable image. */
export function probeImage(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    probePng(bytes, view) ??
    probeGif(bytes, view) ??
    probeWebp(bytes, view) ??
    probeAvif(bytes) ??
    probeJpeg(bytes, view)
  );
}

export function isValidImage(bytes: Uint8Array): boolean {
  return probeImage(bytes) !== null;
}

export function mimeTypeFor(format: ImageFormat): string {
  return MIME[format];
}

/** Best-effort extension for a filename, from real bytes rather than the URL. */
export function extensionFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format;
}

// ---------------------------------------------------------------------------

function probePng(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return null;
  // IHDR is required to be the first chunk, so width/height sit at a fixed offset.
  return {
    format: 'png',
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    mimeType: MIME.png,
  };
}

function probeGif(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null;
  return {
    format: 'gif',
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
    mimeType: MIME.gif,
  };
}

function probeWebp(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;

  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    // 24-bit little-endian, stored as (dimension - 1).
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { format: 'webp', width, height, mimeType: MIME.webp };
  }
  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
      mimeType: MIME.webp,
    };
  }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true);
    return {
      format: 'webp',
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
      mimeType: MIME.webp,
    };
  }
  return null;
}

function probeAvif(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 32) return null;
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 4);
  if (brand !== 'avif' && brand !== 'avis') return null;
  // Dimensions live in an ispe box inside the meta hierarchy; scan for it
  // rather than walking the full ISOBMFF tree.
  for (let i = 16; i + 12 < bytes.length && i < 4096; i++) {
    if (ascii(bytes, i, 4) === 'ispe') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        format: 'avif',
        width: view.getUint32(i + 8, false),
        height: view.getUint32(i + 12, false),
        mimeType: MIME.avif,
      };
    }
  }
  return null;
}

function probeJpeg(bytes: Uint8Array, view: DataView): ImageInfo | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // SOF0-SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), carry dimensions.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        format: 'jpeg',
        height: view.getUint16(offset + 5, false),
        width: view.getUint16(offset + 7, false),
        mimeType: MIME.jpeg,
      };
    }
    const length = view.getUint16(offset + 2, false);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}
