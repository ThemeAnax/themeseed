/**
 * Images from a folder on disk.
 *
 * The right choice when a client has supplied real brand photography, or when
 * you want a demo build to be fully offline and reproducible. Files are used
 * as-is: no resizing, no cropping. Selection is deterministic per query, so the
 * same post always gets the same picture across runs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { logger } from '../core/logger.js';
import type { ImageRef, ImageRequest } from '../core/types.js';
import { probeImage } from './inspect.js';
import { hashString } from './png.js';
import { orientationFor, type ImageSource } from './source.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

export interface LocalImageSourceOptions {
  /** Directory to scan. Defaults to `THEMESEED_LOCAL_IMAGE_DIR`. */
  directory?: string;
  /** Recurse into subdirectories. */
  recursive?: boolean;
}

interface ScannedImage {
  file: string;
  width: number;
  height: number;
  ratio: number;
}

export class LocalImageSource implements ImageSource {
  readonly kind = 'local' as const;

  private readonly directory: string | undefined;
  private readonly recursive: boolean;
  private scanned: ScannedImage[] | null = null;

  constructor(options: LocalImageSourceOptions = {}) {
    this.directory = options.directory ?? process.env.THEMESEED_LOCAL_IMAGE_DIR;
    this.recursive = options.recursive ?? true;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.unavailableReason()) === '';
  }

  async unavailableReason(): Promise<string> {
    if (!this.directory) {
      return 'No image directory configured. Set THEMESEED_LOCAL_IMAGE_DIR or pass a directory.';
    }
    try {
      const stat = await fs.stat(this.directory);
      if (!stat.isDirectory()) return `${this.directory} is not a directory.`;
    } catch {
      return `${this.directory} does not exist.`;
    }
    const images = await this.scan();
    if (images.length === 0) {
      return `${this.directory} contains no usable images (looked for ${[...IMAGE_EXTENSIONS].join(', ')}).`;
    }
    return '';
  }

  async fetch(request: ImageRequest, count: number): Promise<ImageRef[]> {
    const images = await this.scan();
    if (images.length === 0) return [];

    const ranked = this.rank(images, request);

    // Deterministic offset from the query, so distinct posts get distinct
    // pictures while any single post is stable across runs.
    const start = hashString(request.query) % ranked.length;
    const picked: ScannedImage[] = [];
    for (let i = 0; i < Math.min(count, ranked.length); i++) {
      picked.push(ranked[(start + i) % ranked.length]!);
    }

    return picked.map((image) => ({
      kind: 'file' as const,
      location: image.file,
      width: image.width,
      height: image.height,
      alt: altTextFor(image.file, request.query),
      source: this.kind,
    }));
  }

  /** Closest aspect ratio first, then widest — a crop is better than an upscale. */
  private rank(images: ScannedImage[], request: ImageRequest): ScannedImage[] {
    const target = request.aspectRatio ?? defaultRatioFor(request);
    const minWidth = request.minWidth ?? 0;
    return [...images]
      .filter((image) => image.width >= minWidth || images.every((i) => i.width < minWidth))
      .sort((a, b) => {
        const delta = Math.abs(a.ratio - target) - Math.abs(b.ratio - target);
        if (Math.abs(delta) > 0.05) return delta;
        return b.width - a.width;
      });
  }

  private async scan(): Promise<ScannedImage[]> {
    if (this.scanned) return this.scanned;
    if (!this.directory) return (this.scanned = []);

    const files: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.recursive) await walk(full, depth + 1);
        } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(full);
        }
      }
    };
    await walk(this.directory, 0);

    const results: ScannedImage[] = [];
    for (const file of files.sort()) {
      try {
        // Read only the head: enough for every header this parser understands,
        // and it keeps a folder of 4K photos from being pulled into memory.
        const handle = await fs.open(file, 'r');
        try {
          const buffer = Buffer.alloc(65536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const info = probeImage(new Uint8Array(buffer.subarray(0, bytesRead)));
          if (info) {
            results.push({
              file,
              width: info.width,
              height: info.height,
              ratio: info.height === 0 ? 1 : info.width / info.height,
            });
          } else {
            logger.debug(`skipping ${file}: not a readable image`);
          }
        } finally {
          await handle.close();
        }
      } catch (err) {
        logger.debug(`skipping ${file}:`, err);
      }
    }

    this.scanned = results;
    return results;
  }
}

function defaultRatioFor(request: ImageRequest): number {
  const orientation = orientationFor(request);
  if (orientation === 'portrait') return 0.75;
  if (orientation === 'square') return 1;
  return 1.5;
}

/**
 * Filenames are the only description a local file carries, so a descriptive
 * one ("standing-desk-morning.jpg") makes better alt text than the query.
 *
 * Camera and export filenames (`IMG_4821`, `a3f9c2`) are not descriptive, and
 * using them would produce alt text that actively misinforms a screen reader.
 * So a stem only wins if it reads like words: two real tokens, or one long
 * alphabetic one.
 */
function altTextFor(file: string, query: string): string {
  const stem = path.basename(file).replace(/\.\w+$/, '');
  const tokens = stem
    .replace(/[_\-.]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => /^[a-zA-Z]+$/.test(token));

  const meaningful = tokens.filter((token) => token.length >= 3);
  if (meaningful.length >= 2) return meaningful.join(' ');
  if (meaningful.length === 1 && meaningful[0]!.length >= 6) return meaningful[0]!;
  return query;
}
