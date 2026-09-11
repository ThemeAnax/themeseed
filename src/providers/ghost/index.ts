/**
 * Ghost implementation of `CmsProvider`.
 *
 * The only file outside this directory that knows Ghost exists is the provider
 * registry, and all it knows is the name.
 */

import { ProviderError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  SEED_TAG,
  type SeedContent,
  type SeedPage,
  type SeedTag,
  type SeedResult,
  type ThemeCapabilities,
  type UpdateContent,
  type WipeSummary,
} from '../../core/types.js';
import type {
  CmsProvider,
  CreateContentOptions,
  SiteConfig,
  SiteInfo,
  UpdateContentOptions,
} from '../provider.js';
import { GhostClient } from './client.js';
import { publishPages, publishPosts, publishTags, updatePosts, toSeedResult } from './posts.js';
import { analyzeGhostTheme } from './theme/index.js';

/**
 * Ghost slugifies an internal tag `#themeseed` to `hash-themeseed`, and its
 * filter syntax matches on slug rather than name. Getting this wrong is how a
 * wipe silently matches nothing — or, far worse, matches everything.
 */
const SEED_TAG_SLUG = 'hash-themeseed';
const SEED_FILTER = `tag:${SEED_TAG_SLUG}`;

export interface GhostProviderOptions {
  /** Path to Ghost's `content/themes`, enabling source-accurate analysis. */
  themesDir?: string;
  fetchImpl?: typeof fetch;
}

export class GhostProvider implements CmsProvider {
  readonly platform = 'ghost' as const;

  private readonly client: GhostClient;
  private readonly siteUrl: string;
  private readonly options: GhostProviderOptions;

  constructor(site: SiteConfig, options: GhostProviderOptions = {}) {
    const adminApiKey =
      site.credentials['adminApiKey'] ?? site.credentials['admin_api_key'];
    if (!adminApiKey) {
      throw new ProviderError('Ghost site is missing an adminApiKey credential', {
        code: 'GHOST_MISSING_KEY',
        hint: 'Run `themeseed add-site` and paste the Admin API key from Ghost Admin → Settings → Integrations.',
      });
    }

    this.siteUrl = site.url.replace(/\/+$/, '');
    this.options = {
      ...options,
      ...(typeof site.options?.['themesDir'] === 'string'
        ? { themesDir: site.options['themesDir'] as string }
        : {}),
    };
    this.client = new GhostClient({
      url: this.siteUrl,
      adminApiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  /**
   * Confirms both that the site is reachable *and* that the key works.
   *
   * `GET /site/` alone is not enough: Ghost serves it without authentication —
   * the admin client calls it before login — so a completely invalid key
   * returns a cheerful 200. Verifying with it would let `themeseed add-site`
   * save a broken credential and surface the failure much later, half way
   * through a seed run. `/settings/` does require auth, so it is the one that
   * actually proves anything.
   */
  async verifyConnection(): Promise<SiteInfo> {
    const [site] = await Promise.all([this.client.getSite(), this.client.getSettings()]);
    return {
      title: site.title,
      url: site.url,
      version: site.version,
      ...(site.description ? { description: site.description } : {}),
    };
  }

  async analyzeTheme(): Promise<ThemeCapabilities> {
    return analyzeGhostTheme(this.client, this.siteUrl, {
      ...(this.options.themesDir ? { themesDir: this.options.themesDir } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }

  async createContent(
    items: SeedContent[],
    options: CreateContentOptions = {}
  ): Promise<SeedResult[]> {
    return publishPosts(this.client, items, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  async updateContent(
    items: UpdateContent[],
    options: UpdateContentOptions = {}
  ): Promise<SeedResult[]> {
    return updatePosts(this.client, items, {
      seedTagSlug: SEED_TAG_SLUG,
      ...(options.allowUnseeded !== undefined
        ? { allowUnseeded: options.allowUnseeded }
        : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  /**
   * Ghost models a page as a post on its own endpoint. A supplied body goes
   * over as html — it is already final markup, and round-tripping it through
   * our block model could only change it.
   */
  async createPages(
    items: SeedPage[],
    options: CreateContentOptions = {}
  ): Promise<SeedResult[]> {
    return publishPages(this.client, items, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  /** Tags as entities, so a tag archive has a description to render. */
  async createTags(
    items: SeedTag[],
    options: CreateContentOptions = {}
  ): Promise<SeedResult[]> {
    return publishTags(this.client, items, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  // `createAuthors` is deliberately absent. Ghost's Admin API exposes
  // `/users/` as Browse and Read only: a user is invited by email and has to
  // accept, which an unattended tool cannot complete. Declaring the method and
  // having it quietly do nothing would be worse than not having it — the
  // caller could not tell the difference. The file export is not bound by
  // this, because Ghost's importer creates users from the archive.

  async listSeeded(): Promise<SeedResult[]> {
    const posts = await this.client.listPosts({ filter: SEED_FILTER, include: 'tags' });
    return posts.map((post) => toSeedResult(post));
  }

  async wipeSeeded(): Promise<WipeSummary> {
    const posts = await this.client.listPosts({ filter: SEED_FILTER, include: 'tags' });

    // Defence in depth. `listPosts` already filtered server-side, but a wipe is
    // irreversible, so the tag is re-checked client-side on the actual records
    // before anything is deleted. A filter typo must delete nothing, not
    // everything.
    const confirmed = posts.filter((post) =>
      post.tags?.some((tag) => tag.slug === SEED_TAG_SLUG || tag.name === SEED_TAG)
    );

    const skipped = posts.length - confirmed.length;
    if (skipped > 0) {
      logger.warn(
        `${skipped} post(s) matched the seed filter but do not carry ${SEED_TAG}; leaving them alone`
      );
    }

    const failed: Array<{ id: string; error: string }> = [];
    let removed = 0;

    for (const post of confirmed) {
      try {
        await this.client.deletePost(post.id);
        removed += 1;
      } catch (err) {
        failed.push({
          id: post.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return failed.length ? { removed, failed } : { removed };
  }
}

export function createGhostProvider(site: SiteConfig): CmsProvider {
  return new GhostProvider(site);
}

export { GhostClient } from './client.js';
