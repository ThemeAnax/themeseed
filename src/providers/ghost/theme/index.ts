/**
 * Ghost theme analysis: discover the active theme, then measure it with every
 * strategy that can run, and merge the readings.
 *
 * Discovering *which* theme is active is not obvious, because the endpoint you
 * would reach for — `GET /ghost/api/admin/themes/` — returns 403 for API-token
 * auth on every Ghost version (it requires a staff session). The active theme
 * name is however present in `GET /ghost/api/admin/settings/` as `active_theme`,
 * which tokens may read.
 */

import { logger } from '../../../core/logger.js';
import type { ThemeCapabilities } from '../../../core/types.js';
import type { GhostClient } from '../client.js';
import { LocalThemeSource } from './local-theme-source.js';
import { RenderedThemeSource } from './rendered-theme-source.js';
import {
  mergeSignals,
  type ThemeAnalysisStrategy,
  type ThemeSignalSet,
} from './signals.js';

export interface AnalyzeThemeOptions {
  /** Explicit path to Ghost's `content/themes` directory. */
  themesDir?: string;
  /** Skip the network strategy (used by unit tests). */
  skipRendered?: boolean;
  fetchImpl?: typeof fetch;
}

export async function analyzeGhostTheme(
  client: GhostClient,
  siteUrl: string,
  options: AnalyzeThemeOptions = {}
): Promise<ThemeCapabilities> {
  const themeName = await resolveActiveTheme(client);

  const strategies: ThemeAnalysisStrategy[] = [
    new LocalThemeSource({
      themeName,
      ...(options.themesDir ? { themesDir: options.themesDir } : {}),
    }),
  ];
  if (!options.skipRendered) {
    strategies.push(
      new RenderedThemeSource({
        siteUrl,
        themeName,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(await samplePost(client)),
      })
    );
  }

  const sets: ThemeSignalSet[] = [];
  for (const strategy of strategies) {
    try {
      const result = await strategy.analyze();
      if (result) sets.push(result);
      else logger.debug(`theme strategy "${strategy.name}" had nothing to measure`);
    } catch (err) {
      // One strategy failing must not sink the analysis — the other may well
      // have produced a usable reading, and a low-confidence answer beats none.
      logger.warn(`theme strategy "${strategy.name}" failed:`, err);
    }
  }

  const merged = mergeSignals(themeName, sets);
  return {
    platform: 'ghost',
    ...merged.capabilities,
    confidence: merged.confidence,
    evidence: merged.evidence,
    analyzedVia: merged.analyzedVia,
  };
}

/**
 * `active_theme` comes from the settings endpoint. If a Ghost version ever
 * stops exposing it we fall back to "casper", which is the default theme and
 * therefore the least-wrong guess.
 */
async function resolveActiveTheme(client: GhostClient): Promise<string> {
  try {
    const settings = await client.getSettings();
    const active = settings['active_theme'];
    if (typeof active === 'string' && active.trim()) return active.trim();
    logger.warn('Ghost settings did not include active_theme; assuming "casper"');
  } catch (err) {
    logger.warn('could not read Ghost settings to determine the active theme:', err);
  }
  return 'casper';
}

/**
 * A real published post gives the rendered strategy something to measure.
 *
 * Which post is not arbitrary. "Does this theme render a hero?" can only be
 * answered by a post that *has* a feature image, so one is preferred here and
 * the answer is flagged for the strategy. Taking simply the newest post made
 * the analysis self-poisoning: seed a site with image-less posts, and the next
 * analysis reads one of them, concludes the theme shows no feature image, and
 * every later run then skips feature images — which produces more image-less
 * posts. Observed on a real Ghost site; the theme supported heroes throughout.
 */
async function samplePost(
  client: GhostClient
): Promise<{ samplePostUrl?: string; sampleHasFeatureImage?: boolean }> {
  try {
    const withHero = await client.listPosts({
      limit: 1,
      filter: 'status:published+feature_image:-null',
    });
    const heroUrl = withHero[0]?.url;
    if (heroUrl) return { samplePostUrl: heroUrl, sampleHasFeatureImage: true };

    const anyPost = await client.listPosts({ limit: 1, filter: 'status:published' });
    const url = anyPost[0]?.url;
    if (!url) return {};
    // Every published post lacks a feature image, so the hero question cannot
    // be answered from rendered output at all. Say so rather than guess.
    return { samplePostUrl: url, sampleHasFeatureImage: false };
  } catch {
    return {};
  }
}

export { LocalThemeSource } from './local-theme-source.js';
export { RenderedThemeSource } from './rendered-theme-source.js';
export * from './signals.js';
