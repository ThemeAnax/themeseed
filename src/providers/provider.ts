/**
 * The contract every CMS integration implements.
 *
 * This file is the whole point of the project's architecture. Shared code —
 * the content generator, the image sources, the MCP tools, the CLI — talks
 * only to `CmsProvider`. Adding WordPress means adding one directory under
 * `src/providers/wordpress/` and one line in the registry; it must never mean
 * editing the generator or the tools.
 *
 * Rules for implementers:
 *   1. Nothing outside your own provider directory may import your types.
 *   2. Translate *from* the neutral model in `src/core/types.ts`. Do not push
 *      your CMS's block/field vocabulary back up into shared code.
 *   3. Tag everything you create with `SEED_TAG` so `wipeSeeded` is precise.
 *      Deleting content this tool did not create is the one unforgivable bug.
 *
 * See CONTRIBUTING.md for the full walkthrough.
 */

import type {
  Platform,
  SeedContent,
  SeedResult,
  ThemeCapabilities,
  UpdateContent,
  WipeSummary,
} from '../core/types.js';
import type { ImageSource } from '../images/source.js';

/** Identity of the CMS behind a configured site. */
export interface SiteInfo {
  title: string;
  url: string;
  /** CMS version string, when discoverable. */
  version?: string;
  description?: string;
}

export interface CreateContentOptions {
  /**
   * Used to upload/resolve any `ImageRef` the content carries. Providers should
   * not source images themselves — they only host what they are handed.
   */
  imageSource?: ImageSource;
  /** Called after each item so long runs can report progress. */
  onProgress?: (done: number, total: number, current: SeedResult) => void;
}

export interface UpdateContentOptions extends CreateContentOptions {
  /**
   * Permit editing posts this tool did not create.
   *
   * Off by default. `SEED_TAG` is what separates demo content from a real
   * publication's work, and an id is easy to mistype or copy from the wrong
   * list; overwriting somebody's actual article is a smaller disaster than
   * deleting it only by degree. Implementations must re-check the tag on the
   * fetched record — not on the caller's say-so — before writing.
   */
  allowUnseeded?: boolean;
}

export interface CmsProvider {
  readonly platform: Platform;

  /**
   * Confirm credentials work and report what we are talking to.
   * Should throw a `ProviderError` with a useful message on bad credentials —
   * this is what `themeseed add-site` uses to validate input.
   */
  verifyConnection(): Promise<SiteInfo>;

  /**
   * Inspect the site's *active* theme and report what it can display.
   *
   * Implementations are expected to degrade gracefully: return conservative
   * defaults with a low `confidence` rather than throwing, because a wrong
   * "false" merely produces plainer content, while a hard failure blocks the
   * user entirely.
   */
  analyzeTheme(): Promise<ThemeCapabilities>;

  /**
   * Create posts from neutral content. Must not throw for a single failed
   * item — record the failure in that item's `SeedResult.error` and carry on,
   * so one bad image does not lose fourteen good posts.
   */
  createContent(
    items: SeedContent[],
    options?: CreateContentOptions
  ): Promise<SeedResult[]>;

  /**
   * Change posts that already exist, leaving unmentioned fields as they are.
   *
   * Same failure contract as `createContent`: never throw for a single bad
   * item, record it in that item's `SeedResult.error` and carry on. Must
   * refuse to touch a post lacking `SEED_TAG` unless `allowUnseeded` is set.
   */
  updateContent(
    items: UpdateContent[],
    options?: UpdateContentOptions
  ): Promise<SeedResult[]>;

  /** Everything previously created by themeseed on this site. */
  listSeeded(): Promise<SeedResult[]>;

  /** Delete everything `listSeeded` would return. Never touches other content. */
  wipeSeeded(): Promise<WipeSummary>;
}

/** Credentials are provider-shaped; the shared config layer treats them opaquely. */
export type SiteCredentials = Record<string, string>;

export interface SiteConfig {
  platform: Platform;
  url: string;
  credentials: SiteCredentials;
  /** Provider-specific extras, e.g. Ghost's local themes directory. */
  options?: Record<string, unknown>;
}

/** A provider module registers one of these. */
export type ProviderFactory = (site: SiteConfig) => CmsProvider;
