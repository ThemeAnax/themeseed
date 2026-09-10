/**
 * A minimal ZIP writer, built on Node's own `zlib`.
 *
 * Why not a dependency: this package deliberately ships six runtime
 * dependencies, and the archive it needs to produce is the easy end of the
 * format — a handful of known-good filenames, no encryption, no zip64, no
 * streaming. The whole encoder is under a hundred lines, and its test
 * extracts every archive with the system `unzip`, so it is validated against
 * a real implementation rather than against itself.
 *
 * Format reference: PKWARE APPNOTE 6.3.4, sections 4.3.7 (local file header),
 * 4.3.12 (central directory) and 4.3.16 (end of central directory).
 */

import { deflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;

/** 8 = deflate, 0 = stored. Empty entries cannot be deflated meaningfully. */
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

/** Minimum reader version: 2.0, the first that understands deflate. */
const VERSION_NEEDED = 20;

/** Bit 11 marks the filename as UTF-8 rather than the legacy code page. */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * ZIP timestamps are MS-DOS format: a 16-bit date and a 16-bit time, with
 * two-second resolution and a 1980 epoch.
 */
function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new Uint8Array(Buffer.from(value, 'utf8')) : value;
}

interface Entry {
  nameBytes: Buffer;
  crc: number;
  method: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  offset: number;
}

/**
 * Builds a ZIP archive from `entries`, keyed by archive-relative path.
 * Forward slashes in a key become directories on extraction — the format
 * stores the path verbatim and extractors create the tree.
 */
export function createZip(
  entries: Record<string, string | Uint8Array>,
  now: Date = new Date(),
): Buffer {
  const { date, time } = dosDateTime(now);
  const chunks: Buffer[] = [];
  const written: Entry[] = [];
  let offset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const bytes = toBytes(value);
    const nameBytes = Buffer.from(name, 'utf8');
    // Deflating nothing produces a two-byte stream that some readers reject;
    // storing an empty entry is both smaller and safer.
    const method = bytes.length === 0 ? METHOD_STORE : METHOD_DEFLATE;
    const compressed = method === METHOD_STORE ? bytes : new Uint8Array(deflateRawSync(bytes));
    const crc = crc32(bytes);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // no extra field

    chunks.push(header, nameBytes, Buffer.from(compressed));
    written.push({
      nameBytes,
      crc,
      method,
      compressed,
      uncompressedSize: bytes.length,
      offset,
    });
    offset += header.length + nameBytes.length + compressed.length;
  }

  const centralStart = offset;
  for (const entry of written) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    record.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(FLAG_UTF8, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.compressed.length, 20);
    record.writeUInt32LE(entry.uncompressedSize, 24);
    record.writeUInt16LE(entry.nameBytes.length, 28);
    record.writeUInt16LE(0, 30); // extra field length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0o644 << 16, 38); // external attributes: regular file
    record.writeUInt32LE(entry.offset, 42);
    chunks.push(record, entry.nameBytes);
    offset += record.length + entry.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(written.length, 8);
  end.writeUInt16LE(written.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  return Buffer.concat(chunks);
}
