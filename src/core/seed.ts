/**
 * The one high-level operation: analyze a theme, generate content that fits it,
 * publish it.
 *
 * Both the MCP tools and the CLI call this, so the two surfaces cannot drift
 * apart in behaviour — only in presentation.
 */

import { createUsableImageSource, type ImageSourceOptions } from '../images/index.js';
import { generateSeedContent, type GenerateSummary } from '../content/generator.js';
import type { ContentEngine } from '../content/engine.js';
import { createProvider } from '../providers/registry.js';
import type { CmsProvider, SiteConfig } from '../providers/provider.js';
import { logger } from './logger.js';
import type {
  ImageSourceKind,
  PublishStatus,
  SeedResult,
  ThemeCapabilities,
} from './types.js';

export interface SeedRequest {
  site: SiteConfig;
  topic: string;
  count: number;
  imageSource?: ImageSourceKind;
  status?: PublishStatus;
  /** Titles from the caller (e.g. written by an MCP host's model). */
  titles?: string[];
  seed?: number;
  authorName?: string;
  engine?: ContentEngine;
  imageSourceOptions?: ImageSourceOptions;
  /** Reuse an existing analysis instead of running one. */
  capabilities?: ThemeCapabilities;
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

  request.onProgress?.('analyzing', 0, 1, 'reading the active theme');
  const capabilities = request.capabilities ?? (await provider.analyzeTheme());
  request.onProgress?.('analyzing', 1, 1, `${capabilities.themeName} (confidence ${capabilities.confidence})`);

  if (capabilities.confidence < 0.35) {
    logger.warn(
      `theme analysis for "${capabilities.themeName}" is low confidence (${capabilities.confidence}); ` +
        'content will use conservative defaults. Point --themes-dir at the Ghost install for an accurate reading.'
    );
  }

  const imageSourceKind = request.imageSource ?? 'stock';
  const imageSource = await createUsableImageSource(imageSourceKind, request.imageSourceOptions ?? {});

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
    onProgress: (done, total, title) => request.onProgress?.('generating', done, total, title),
  });

  const results = await provider.createContent(generation.posts, {
    imageSource,
    onProgress: (done, total, current) =>
      request.onProgress?.('publishing', done, total, current.error ? `${current.title} — FAILED` : current.title),
  });

  const failed = results.filter((result) => result.error).length;
  return {
    capabilities,
    results,
    generation: generation.stats,
    created: results.length - failed,
    failed,
  };
}
