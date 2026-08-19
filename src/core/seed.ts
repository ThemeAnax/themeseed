/**
 * The one high-level operation: generate content and publish it, optionally
 * shaping it to the site's real theme first.
 *
 * Both the MCP tools and the CLI call this, so the two surfaces cannot drift
 * apart in behaviour — only in presentation.
 */

import {
  createRequestedImageSource,
  type ImageSourceOptions,
} from '../images/index.js';
import { generateSeedContent, type GenerateSummary } from '../content/generator.js';
import type { ContentEngine } from '../content/engine.js';
import { createProvider } from '../providers/registry.js';
import type { CmsProvider, SiteConfig } from '../providers/provider.js';
import { logger } from './logger.js';
import { genericCapabilities } from './theme-defaults.js';
import type {
  PublishStatus,
  RequestedImageSource,
  SeedResult,
  ThemeCapabilities,
} from './types.js';

export interface SeedRequest {
  site: SiteConfig;
  topic: string;
  count: number;
  /** Defaults to `auto`: AI if a key is set, else stock, else no images. */
  imageSource?: RequestedImageSource;
  status?: PublishStatus;
  /** Titles from the caller (e.g. written by an MCP host's model). */
  titles?: string[];
  seed?: number;
  authorName?: string;
  engine?: ContentEngine;
  imageSourceOptions?: ImageSourceOptions;
  /** Reuse an existing analysis instead of running one. */
  capabilities?: ThemeCapabilities;
  /**
   * Read the site's real theme and shape content to it. Off by default: the
   * analysis costs a round trip and only pays for itself when the caller
   * actually wants content matched to the theme's design.
   */
  studyTheme?: boolean;
  /** Skip YouTube lookups (offline runs, or when speed matters more). */
  includeVideo?: boolean;
  onProgress?: (phase: SeedPhase, done: number, total: number, detail: string) => void;
}

export type SeedPhase = 'analyzing' | 'generating' | 'publishing';

export interface SeedReport {
  capabilities: ThemeCapabilities;
  results: SeedResult[];
  generation: GenerateSummary['stats'];
  created: number;
  failed: number;
}

export async function seedSite(request: SeedRequest): Promise<SeedReport> {
  const provider: CmsProvider = createProvider(request.site);

  const studyTheme = request.studyTheme ?? false;

  if (studyTheme) request.onProgress?.('analyzing', 0, 1, 'reading the active theme');
  const capabilities =
    request.capabilities ??
    (studyTheme
      ? await provider.analyzeTheme()
      : genericCapabilities(request.site.platform));
  request.onProgress?.(
    'analyzing',
    1,
    1,
    studyTheme
      ? `${capabilities.themeName} (confidence ${capabilities.confidence})`
      : 'using generic defaults (pass studyTheme to read the theme)'
  );

  // Only an analysis that ran can be low confidence. Warning about defaults
  // would nag every run about a reading nobody asked for.
  if (studyTheme && !request.capabilities && capabilities.confidence < 0.35) {
    logger.warn(
      `theme analysis for "${capabilities.themeName}" is low confidence (${capabilities.confidence}); ` +
        'content will use conservative defaults. Point --themes-dir at the Ghost install for an accurate reading.'
    );
  }

  const imageSource = await createRequestedImageSource(
    request.imageSource ?? 'auto',
    request.imageSourceOptions ?? {}
  );

  const generation = await generateSeedContent({
    topic: request.topic,
    count: request.count,
    capabilities,
    imageSource,
    status: request.status ?? 'published',
    ...(request.titles?.length ? { titles: request.titles } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.authorName ? { authorName: request.authorName } : {}),
    ...(request.engine ? { engine: request.engine } : {}),
    ...(request.includeVideo === false ? { videoFinder: null } : {}),
    onProgress: (done, total, title) =>
      request.onProgress?.('generating', done, total, title),
  });

  const results = await provider.createContent(generation.posts, {
    imageSource,
    onProgress: (done, total, current) =>
      request.onProgress?.(
        'publishing',
        done,
        total,
        current.error ? `${current.title} — FAILED` : current.title
      ),
  });

  const failed = results.filter((result) => result.error).length;

  // Report what actually landed, not what was planned. An image that failed to
  // download is dropped at publish time, so the generator's own count would
  // claim a feature image the post does not have.
  const publishedFeatureImages = results.filter(
    (result) => result.hasFeatureImage
  ).length;

  return {
    capabilities,
    results,
    generation: { ...generation.stats, withFeatureImage: publishedFeatureImages },
    created: results.length - failed,
    failed,
  };
}
