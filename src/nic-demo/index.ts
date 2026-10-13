/**
 * `themeseed nic-demo` — the demo-content exporter for NIC Core themes.
 *
 * Contract: docs/superpowers/specs/2026-10-13-demo-content-contract.md in the
 * mcphub repo (§4 input, §5 output, §7 credits, §10 CLI). Like the other file
 * exports this bypasses `CmsProvider`: there is no live site, only a request
 * file in and a package out.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ContentEngine } from '../content/engine.js';
import { ThemeseedError } from '../core/errors.js';
import { readVersion } from '../core/version.js';
import type { ImageSourceOptions } from '../images/index.js';
import type { ImageSource } from '../images/source.js';
import { generateNicContent } from './generate.js';
import { chooseImageSource, MediaCollector, type FetchBytes } from './media.js';
import { validateRequestSchema } from './schema.js';
import { validateNicContent } from './validate.js';
import { writeNicPackage } from './write.js';
import { NIC_TYPES, type NicContentRequest, type NicCredits } from './types.js';

/** The caller got the invocation wrong (exit code 2), as opposed to a refusal (exit code 1). */
export class NicDemoUsageError extends ThemeseedError {
  constructor(message: string, hint?: string) {
    super(message, { code: 'NIC_DEMO_USAGE', ...(hint ? { hint } : {}) });
    this.name = 'NicDemoUsageError';
  }
}

export interface NicDemoOptions {
  /** Path to a content-request JSON file, or the already-parsed object. */
  request: string | Record<string, unknown>;
  /** The theme's `demo/` directory. Only `posts.json` and `content-media/` are written. */
  outDir: string;
  /** Where credits go. Must be outside `outDir` — it would ship in the theme zip. */
  creditsPath: string;
  /** Test seams. */
  imageSource?: ImageSource;
  imageSourceOptions?: ImageSourceOptions;
  fetchBytes?: FetchBytes;
  engine?: ContentEngine;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  onProgress?: (done: number, total: number, title: string) => void;
}

export interface NicDemoReport {
  ok: true;
  /** Paths relative to `outDir`. */
  written: string[];
  counts: Record<string, number>;
  credits: string;
  warnings: string[];
}

export async function exportNicDemo(options: NicDemoOptions): Promise<NicDemoReport> {
  const request = await loadRequest(options.request);

  const outDir = path.resolve(options.outDir);
  const creditsPath = path.resolve(options.creditsPath);
  if (creditsPath === outDir || creditsPath.startsWith(outDir + path.sep)) {
    throw new NicDemoUsageError(
      `--credits (${options.creditsPath}) is inside --out (${options.outDir}); it would ship in the theme zip`,
      'Write credits next to the content request, outside the theme folder.'
    );
  }

  const warnings: string[] = [];
  const choice = await chooseImageSource(
    request.images?.source ?? 'auto',
    request.target,
    {
      ...(options.imageSource ? { override: options.imageSource } : {}),
      ...(options.imageSourceOptions
        ? { sourceOptions: options.imageSourceOptions }
        : {}),
      ...(options.env ? { env: options.env } : {}),
    }
  );
  warnings.push(...choice.warnings);

  const media = new MediaCollector(request.site.name, options.fetchBytes);
  const version = await readVersion();
  const generated = await generateNicContent({
    request,
    media,
    imageSource: choice.source,
    generator: `themeseed@${version}`,
    ...(options.engine ? { engine: options.engine } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  warnings.push(...generated.warnings);

  // Asked for images, got none: a demo that silently lost every picture is a failed run.
  if (choice.source && media.files.length === 0 && media.skipped > 0) {
    throw new ThemeseedError(
      `Every image was rejected (${media.skipped}); refusing to write a demo with no pictures`,
      {
        code: 'NO_USABLE_IMAGES',
        hint:
          'Images must be jpg/png/webp, at most 2000px on the long edge and 500 KB each. ' +
          `First problem: ${media.warnings[0] ?? 'see warnings'}. Resize the source images or use another image source.`,
      }
    );
  }

  const credits: NicCredits = {
    assets: [...media.credits].sort((a, b) => a.path.localeCompare(b.path)),
  };

  const problems = validateNicContent(generated.content, {
    media: media.files,
    credits,
    ...(options.now ? { now: options.now } : {}),
  });
  if (problems.length > 0) {
    throw new ThemeseedError(
      `Refusing to write: the generated package is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
      {
        code: 'INVALID_OUTPUT',
        hint:
          problems.slice(0, 8).join('; ') +
          (problems.length > 8 ? `; …and ${problems.length - 8} more` : '') +
          '. If a seed caused it, fix that seed in the content request.',
      }
    );
  }

  const written = await writeNicPackage({
    outDir,
    creditsPath,
    content: generated.content,
    media: media.files,
    credits,
  });

  const counts: Record<string, number> = {};
  for (const type of NIC_TYPES) {
    const n = generated.counts[type];
    if (n !== undefined) counts[type] = n;
  }

  return { ok: true, written, counts, credits: options.creditsPath, warnings };
}

async function loadRequest(
  source: string | Record<string, unknown>
): Promise<NicContentRequest> {
  let doc: unknown = source;
  if (typeof source === 'string') {
    let raw: string;
    try {
      raw = await fs.readFile(source, 'utf8');
    } catch (err) {
      throw new NicDemoUsageError(
        `Cannot read the content request ${source}: ${err instanceof Error ? err.message : String(err)}`,
        'Pass --request <path to a nic-content-request/1 JSON file>.'
      );
    }
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new NicDemoUsageError(
        `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const problems = validateRequestSchema(doc);
  if (problems.length > 0) {
    throw new NicDemoUsageError(
      `The content request is not a valid nic-content-request/1 document:\n  - ${problems.join('\n  - ')}`,
      'Fix the request (schema: nic-content-request-1.schema.json).'
    );
  }
  const request = doc as NicContentRequest;

  for (const type of NIC_TYPES) {
    const keys = new Set<string>();
    for (const seed of request.types[type]?.seeds ?? []) {
      if (keys.has(seed.key)) {
        throw new NicDemoUsageError(
          `types.${type}: seed key "${seed.key}" appears twice`,
          'Seed keys are the import idempotency key and must be unique per type.'
        );
      }
      keys.add(seed.key);
    }
  }
  return request;
}

export { validateNicContent } from './validate.js';
export { validateContentSchema, validateRequestSchema } from './schema.js';
export type { NicContent, NicContentRequest, NicCredits } from './types.js';
