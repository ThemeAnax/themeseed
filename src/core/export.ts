/**
 * Generate content and write it to a file, rather than to a live site.
 *
 * The sibling of `seedSite()`. Both generate the same neutral content from the
 * same options; they differ in where it goes — `seedSite` publishes over a
 * CMS's API, this produces an archive somebody can carry, commit, or ship
 * inside a theme package.
 *
 * It deliberately bypasses `CmsProvider`. That contract is built around a
 * live site: `createProvider` needs registered credentials, and Ghost's
 * provider throws without an Admin API key. A file export has no site to
 * point at, so routing it through the registry would mean weakening the check
 * that stops `add-site` saving a broken credential.
 */

import { generateSeedContent, type PageRequest } from '../content/generator.js';
import type { ContentEngine } from '../content/engine.js';
import { createRequestedImageSource, type ImageSourceOptions } from '../images/index.js';
import { exportGhostArchive } from '../providers/ghost/export.js';
import { logger } from './logger.js';
import { genericCapabilities } from './theme-defaults.js';
import { ThemeseedError } from './errors.js';
import type {
  Platform,
  PublishStatus,
  RequestedImageSource,
  SeedSiteConfig,
  ThemeCapabilities,
} from './types.js';

export interface ExportRequest {
  /** Only `ghost` writes an archive today. */
  platform: Platform;
  topic: string;
  count: number;
  /** Directory the archive is written to. Created if missing. */
  outDir: string;
  pages?: PageRequest[];
  site?: SeedSiteConfig;
  imageSource?: RequestedImageSource;
  imageSourceOptions?: ImageSourceOptions;
  status?: PublishStatus;
  titles?: string[];
  authorName?: string;
  seed?: number;
  engine?: ContentEngine;
  includeVideo?: boolean;
  /**
   * A theme reading, when the caller has one. Without a live site there is
   * nothing to analyse, so the conservative defaults apply instead.
   */
  capabilities?: ThemeCapabilities;
  onProgress?: (phase: ExportPhase, done: number, total: number, detail: string) => void;
}

export type ExportPhase = 'generating' | 'writing';

export interface ExportReport {
  zipPath: string;
  capabilities: ThemeCapabilities;
  stats: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    failedImages: number;
  };
  /** Images that could not be bundled. Reported, never fatal. */
  failed: Array<{ location: string; error: string }>;
}

export async function exportSite(request: ExportRequest): Promise<ExportReport> {
  if (request.platform !== 'ghost') {
    throw new ThemeseedError(`No file export implemented for platform "${request.platform}"`, {
      code: 'EXPORT_NOT_IMPLEMENTED',
      hint: 'Only ghost writes an import archive today. See CONTRIBUTING.md for adding one.',
    });
  }

  const capabilities = request.capabilities ?? genericCapabilities(request.platform);

  const imageSource = await createRequestedImageSource(
    request.imageSource ?? 'auto',
    request.imageSourceOptions ?? {},
  );

  const generation = await generateSeedContent({
    topic: request.topic,
    count: request.count,
    capabilities,
    imageSource,
    status: request.status ?? 'published',
    ...(request.pages?.length ? { pages: request.pages } : {}),
    ...(request.titles?.length ? { titles: request.titles } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.authorName ? { authorName: request.authorName } : {}),
    ...(request.engine ? { engine: request.engine } : {}),
    ...(request.includeVideo === false ? { videoFinder: null } : {}),
    onProgress: (done, total, title) => request.onProgress?.('generating', done, total, title),
  });

  request.onProgress?.('writing', 0, 1, 'bundling images and writing the archive');

  const result = await exportGhostArchive(
    {
      posts: generation.posts,
      ...(generation.pages ? { pages: generation.pages } : {}),
      ...(generation.tags ? { tags: generation.tags } : {}),
      ...(generation.authors ? { authors: generation.authors } : {}),
      ...(request.site ? { site: request.site } : {}),
    },
    { outDir: request.outDir },
  );

  request.onProgress?.('writing', 1, 1, result.zipPath);

  // An archive that lost every image still writes successfully, and reporting
  // that only to stderr is how a broken run calls itself a success.
  if (result.stats.failedImages > 0) {
    logger.warn(
      `${result.stats.failedImages} image(s) could not be bundled; those posts import without them`,
    );
  }

  return {
    zipPath: result.zipPath,
    capabilities,
    stats: result.stats,
    failed: result.failed,
  };
}
