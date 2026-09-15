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
import { exportWordPressWxr } from '../providers/wordpress/export.js';
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
  /**
   * `ghost` writes an import archive (zip, images bundled); `wordpress`
   * writes a WXR file (images referenced by URL — the WordPress importer
   * downloads them at import time). Other platforms have no file export yet.
   */
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
  /**
   * The import artifact on disk — `content-export.zip` for Ghost,
   * `demo-content.xml` for WordPress.
   */
  artifactPath: string;
  capabilities: ThemeCapabilities;
  stats: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    /** Ghost: images bundled in the zip. WordPress: attachments referenced. */
    images: number;
    failedImages: number;
  };
  /** Images that could not travel. Reported, never fatal. */
  failed: Array<{ location: string; error: string }>;
}

const EXPORTABLE: readonly Platform[] = ['ghost', 'wordpress'] as const;

export async function exportSite(request: ExportRequest): Promise<ExportReport> {
  if (!EXPORTABLE.includes(request.platform)) {
    throw new ThemeseedError(`No file export implemented for platform "${request.platform}"`, {
      code: 'EXPORT_NOT_IMPLEMENTED',
      hint: `File export exists for ${EXPORTABLE.join(' and ')} today. See CONTRIBUTING.md for adding one.`,
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

  request.onProgress?.('writing', 0, 1, 'writing the import file');

  const bundle = {
    posts: generation.posts,
    ...(generation.pages ? { pages: generation.pages } : {}),
    ...(generation.tags ? { tags: generation.tags } : {}),
    ...(generation.authors ? { authors: generation.authors } : {}),
    ...(request.site ? { site: request.site } : {}),
  };

  const result =
    request.platform === 'wordpress'
      ? await exportWordPressWxr(bundle, { outDir: request.outDir })
      : await exportGhostArchive(bundle, { outDir: request.outDir }).then((r) => ({
          artifactPath: r.zipPath,
          stats: r.stats,
          failed: r.failed,
        }));

  request.onProgress?.('writing', 1, 1, result.artifactPath);

  // An export that lost every image still writes successfully, and reporting
  // that only to stderr is how a broken run calls itself a success.
  if (result.stats.failedImages > 0) {
    logger.warn(
      `${result.stats.failedImages} image(s) could not travel with the export; those posts import without them`,
    );
  }

  return {
    artifactPath: result.artifactPath,
    capabilities,
    stats: result.stats,
    failed: result.failed,
  };
}
