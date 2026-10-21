/**
 * Image sourcing for the nic-demo exporter: which source may run for a target,
 * and turning the sources' neutral `ImageRef`s into contract-conformant files
 * plus the credit entry each file must carry.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ThemeseedError } from '../core/errors.js';
import type { ImageRef } from '../core/types.js';
import { createImageSource, hasAiKey, hasStockKey } from '../images/index.js';
import { extensionFor, probeImage } from '../images/inspect.js';
import type { ImageSource } from '../images/source.js';
import type { ImageSourceOptions } from '../images/index.js';
import {
  MEDIA_LIMITS,
  type MediaFile,
  type NicCreditEntry,
  type NicImageSource,
  type NicTarget,
} from './types.js';

/** Targets whose images ship inside a GPL product: stock licences are not compatible. */
export function isGplTarget(target: NicTarget): boolean {
  return target === 'themeforest' || target === 'wordpress.org';
}

export interface SourceChoice {
  /** Null means "no images". */
  source: ImageSource | null;
  warnings: string[];
}

/**
 * Resolves `images.source` against the target rule (spec §4 rule 6).
 *
 * Refusal happens here, before any content is generated, because a stock
 * image discovered at write time would mean discarding a finished run.
 */
export async function chooseImageSource(
  requested: NicImageSource,
  target: NicTarget,
  options: {
    sourceOptions?: ImageSourceOptions;
    override?: ImageSource;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<SourceChoice> {
  const warnings: string[] = [];
  const env = options.env ?? process.env;

  if (requested === 'none') return { source: null, warnings };

  let source: ImageSource;
  if (options.override) {
    source = options.override;
  } else if (requested === 'auto') {
    source = await resolveAuto(target, options.sourceOptions ?? {}, env, warnings);
  } else {
    source = createImageSource(requested, options.sourceOptions ?? {});
  }

  if (source.kind === 'none') return { source: null, warnings };

  if (isGplTarget(target) && source.kind === 'stock') {
    throw new ThemeseedError(
      `Stock images are refused for target "${target}": Unsplash, Pexels and Picsum licences are not GPL-compatible`,
      {
        code: 'STOCK_REFUSED',
        hint:
          'Set images.source to "ai" or "local" (a folder of your own images via THEMESEED_LOCAL_IMAGE_DIR) ' +
          'in the content request, or change target to "client" or "private" if the demo will not ship in a marketplace theme.',
      }
    );
  }

  if (!(await source.isAvailable())) {
    throw new ThemeseedError(`Image source "${source.kind}" is not usable`, {
      code: 'IMAGE_SOURCE_UNAVAILABLE',
      hint: await source.unavailableReason(),
    });
  }
  return { source, warnings };
}

/**
 * `auto`: AI first (exact subject match, GPL-credited), then a configured local
 * folder, then stock — but stock only for targets that may use it.
 */
async function resolveAuto(
  target: NicTarget,
  options: ImageSourceOptions,
  env: NodeJS.ProcessEnv,
  warnings: string[]
): Promise<ImageSource> {
  if (hasAiKey(env)) return createImageSource('ai', options);

  const localDir = options.local?.directory ?? env.THEMESEED_LOCAL_IMAGE_DIR;
  if (localDir) {
    const local = createImageSource('local', options);
    if (await local.isAvailable()) return local;
    warnings.push(
      `images.source "auto": local folder skipped — ${await local.unavailableReason()}`
    );
  }

  if (!isGplTarget(target)) {
    if (hasStockKey(env)) return createImageSource('stock', options);
  }

  warnings.push(
    `images.source "auto" found no usable source for target "${target}", so the demo has no images. ` +
      'Set an AI key (OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY, FAL_KEY), ' +
      'point THEMESEED_LOCAL_IMAGE_DIR at your own images, or set images.source to "ai" for placeholders.'
  );
  return createImageSource('none');
}

// ---------------------------------------------------------------------------

export type FetchBytes = (ref: ImageRef) => Promise<Uint8Array>;

export async function defaultFetchBytes(ref: ImageRef): Promise<Uint8Array> {
  if (ref.kind === 'file') return new Uint8Array(await fs.readFile(ref.location));
  const response = await fetch(ref.location, {
    headers: { 'User-Agent': 'themeseed' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${ref.location}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Accepts images one at a time and keeps only those the contract allows.
 * An image that breaks a rule is skipped with a warning rather than failing
 * the run: the item imports without a picture, which is better than no demo.
 */
export class MediaCollector {
  readonly files: MediaFile[] = [];
  readonly credits: NicCreditEntry[] = [];
  readonly warnings: string[] = [];
  /** Images that were requested and did not make it in. */
  skipped = 0;

  private total = 0;
  private readonly byHash = new Map<string, string>();
  private readonly names = new Set<string>();

  constructor(
    private readonly siteName: string,
    private readonly fetchBytes: FetchBytes = defaultFetchBytes
  ) {}

  /** Returns the `content-media/<name>` path, or undefined if the image was skipped. */
  async add(ref: ImageRef, baseName: string): Promise<string | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchBytes(ref);
    } catch (err) {
      return this.skip(
        ref,
        `could not be fetched (${err instanceof Error ? err.message : String(err)})`
      );
    }

    const info = probeImage(bytes);
    if (!info || !['png', 'jpeg', 'webp'].includes(info.format)) {
      return this.skip(
        ref,
        `is not a jpg, png or webp image (${info?.format ?? 'unreadable'})`
      );
    }
    if (Math.max(info.width, info.height) > MEDIA_LIMITS.maxLongEdge) {
      return this.skip(
        ref,
        `is ${info.width}x${info.height}, over the ${MEDIA_LIMITS.maxLongEdge}px long-edge limit — resize it first`
      );
    }
    if (bytes.byteLength > MEDIA_LIMITS.maxFileBytes) {
      return this.skip(
        ref,
        `is ${Math.ceil(bytes.byteLength / 1024)} KB, over the ${MEDIA_LIMITS.maxFileBytes / 1024} KB per-file limit — compress or resize it first`
      );
    }

    // The same picture used by several items is stored, credited and shipped once.
    const hash = createHash('sha256').update(bytes).digest('hex');
    const existing = this.byHash.get(hash);
    if (existing) return `content-media/${existing}`;

    if (this.total + bytes.byteLength > MEDIA_LIMITS.maxTotalBytes) {
      return this.skip(
        ref,
        `would take content-media/ over the ${MEDIA_LIMITS.maxTotalBytes / 1048576} MB limit`
      );
    }

    const name = this.uniqueName(baseName, extensionFor(info.format));
    this.total += bytes.byteLength;
    this.byHash.set(hash, name);
    this.files.push({ name, bytes });
    this.credits.push(creditFor(ref, name, this.siteName));
    return `content-media/${name}`;
  }

  private skip(ref: ImageRef, why: string): undefined {
    this.skipped += 1;
    this.warnings.push(`image ${describeRef(ref)} ${why}; the item imports without it`);
    return undefined;
  }

  private uniqueName(base: string, ext: string): string {
    const stem = slugForFile(base);
    let name = `${stem}.${ext}`;
    for (let n = 2; this.names.has(name); n++) name = `${stem}-${n}.${ext}`;
    this.names.add(name);
    return name;
  }
}

function describeRef(ref: ImageRef): string {
  return ref.kind === 'file' ? path.basename(ref.location) : ref.location;
}

function slugForFile(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'image';
}

/** One credit entry per file: SPDX licence, where it came from, who owns it. */
export function creditFor(
  ref: ImageRef,
  fileName: string,
  siteName: string
): NicCreditEntry {
  const entryPath = `demo/content-media/${fileName}`;
  switch (ref.source) {
    case 'stock': {
      const credit = ref.credit ?? '';
      const provider =
        /unsplash/i.test(credit) || /picsum/i.test(credit)
          ? 'Unsplash'
          : /pexels/i.test(credit)
            ? 'Pexels'
            : /unsplash/i.test(ref.location)
              ? 'Unsplash'
              : 'Pexels';
      return {
        path: entryPath,
        // Not SPDX-listed; LicenseRef- is the SPDX form for a custom licence.
        license: `LicenseRef-${provider}`,
        source: ref.kind === 'url' ? ref.location : credit || provider,
        author: credit || provider,
      };
    }
    case 'ai':
      return {
        path: entryPath,
        license: 'GPL-2.0-or-later',
        source: /^Procedurally generated/i.test(ref.credit ?? '')
          ? 'Procedurally generated placeholder (themeseed)'
          : ref.credit
            ? `AI-generated (${ref.credit.replace(/^Image generated with /i, '')})`
            : 'AI-generated',
        author: siteName,
      };
    default:
      // `local` — the contract treats a local folder as author-owned.
      return {
        path: entryPath,
        license: 'GPL-2.0-or-later',
        source: `Author-owned image (${path.basename(ref.location)})`,
        author: siteName,
      };
  }
}
