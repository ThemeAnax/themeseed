/**
 * Platform-neutral domain model.
 *
 * Everything in this file is deliberately free of any CMS's own vocabulary.
 * Ghost's Lexical, WordPress's Gutenberg blocks and Drupal's field API are all
 * downstream of these types — a provider translates *from* this model, never
 * back into it. If a type here starts needing a Ghost-shaped field, that is a
 * signal the field belongs in the provider instead.
 */

/** Platforms the provider registry knows about. Only `ghost` ships today. */
export type Platform = 'ghost' | 'wordpress' | 'joomla' | 'drupal' | 'magento';

export const PLATFORMS: readonly Platform[] = [
  'ghost',
  'wordpress',
  'joomla',
  'drupal',
  'magento',
] as const;

/** Platforms with a working implementation right now. */
export const IMPLEMENTED_PLATFORMS: readonly Platform[] = ['ghost'] as const;

// ---------------------------------------------------------------------------
// Content blocks — the intermediate representation
// ---------------------------------------------------------------------------

export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface HeadingBlock {
  type: 'heading';
  level: 2 | 3 | 4;
  text: string;
}

export interface ImageBlock {
  type: 'image';
  /** Resolved at publish time by an ImageSource; see `ImageRequest`. */
  image: ImageRef;
  caption?: string;
  alt?: string;
}

export interface GalleryBlock {
  type: 'gallery';
  images: ImageRef[];
  caption?: string;
}

export interface VideoBlock {
  type: 'video';
  /** Canonical watch URL. Always a real, resolvable video — never fabricated. */
  url: string;
  provider: 'youtube' | 'vimeo';
  title?: string;
  thumbnailUrl?: string;
  authorName?: string;
}

export interface QuoteBlock {
  type: 'quote';
  text: string;
  attribution?: string;
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: string[];
}

export interface CodeBlock {
  type: 'code';
  language?: string;
  code: string;
}

export interface DividerBlock {
  type: 'divider';
}

export type ContentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ImageBlock
  | GalleryBlock
  | VideoBlock
  | QuoteBlock
  | ListBlock
  | CodeBlock
  | DividerBlock;

export type ContentBlockType = ContentBlock['type'];

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * A pointer to an image that has been *sourced* but not yet uploaded to a CMS.
 * Either a local file on disk or a remote URL; providers upload it and swap in
 * their own hosted URL before rendering.
 */
export interface ImageRef {
  /** `file` = absolute path on disk, `url` = remote http(s) URL. */
  kind: 'file' | 'url';
  location: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  /** Free-form credit line, e.g. "Photo by X on Unsplash". */
  credit?: string;
  /** Which ImageSource produced this. */
  source?: ImageSourceKind;
}

export type ImageSourceKind = 'local' | 'stock' | 'ai' | 'none';

/**
 * What a caller may ask for. `auto` picks a kind from whichever provider keys
 * are configured, so it is a request and never an answer — `ImageRef.source`
 * records the kind that actually produced the bytes.
 */
export type RequestedImageSource = ImageSourceKind | 'auto';

export interface ImageRequest {
  /** What the image should depict. */
  query: string;
  /** Target aspect ratio (width / height), if the theme is opinionated. */
  aspectRatio?: number;
  /** Minimum width in pixels. */
  minWidth?: number;
  /** Distinguishes a hero image from a body/gallery image. */
  role?: 'feature' | 'body' | 'gallery';
  orientation?: 'landscape' | 'portrait' | 'square';
}

// ---------------------------------------------------------------------------
// Theme capabilities
// ---------------------------------------------------------------------------

/**
 * What a theme can actually display. The content generator reads this and
 * only emits blocks the theme will render well — a gallery block in a theme
 * with no gallery styles is worse than no gallery at all.
 *
 * Every field carries an implicit "as far as we could tell". `confidence` and
 * `evidence` record how the answer was reached so a human can sanity-check it.
 */
export interface ThemeCapabilities {
  platform: Platform;
  /** Machine name of the active theme, e.g. "casper". */
  themeName: string;
  themeVersion?: string;
  /** Human-facing description pulled from theme metadata, when present. */
  description?: string;

  /** Theme renders a hero/feature image on posts. */
  supportsFeatureImage: boolean;
  /**
   * Aspect ratio (width / height) the feature image is displayed at, when the
   * theme pins one. Undefined means "no fixed ratio detected".
   */
  featureImageAspectRatio?: number;

  supportsGallery: boolean;
  supportsVideoEmbed: boolean;
  supportsBookmarkCard: boolean;
  supportsCodeBlocks: boolean;
  supportsWideImages: boolean;

  displaysTags: boolean;
  displaysAuthor: boolean;
  displaysAuthorImage: boolean;
  displaysExcerpt: boolean;
  displaysReadingTime: boolean;

  /** Roughly how long a post should be for this theme's layout to look right. */
  expectedWordCount: {
    min: number;
    target: number;
    max: number;
  };

  /** Posts per index page, when the theme declares it. */
  postsPerPage?: number;

  /** 0..1. How much of this was measured vs. assumed from defaults. */
  confidence: number;
  /** Human-readable notes: which files/selectors drove each conclusion. */
  evidence: string[];
  /** Which analysis strategies contributed. */
  analyzedVia: string[];
}

// ---------------------------------------------------------------------------
// Seed content + results
// ---------------------------------------------------------------------------

export type PublishStatus = 'draft' | 'published' | 'scheduled';

/** One post, fully generated and platform-neutral, ready for a provider. */
export interface SeedContent {
  title: string;
  /** URL slug suggestion. Providers may normalise or ignore it. */
  slug?: string;
  excerpt?: string;
  blocks: ContentBlock[];
  tags: string[];
  /** Hero image, if the theme supports one. */
  featureImage?: ImageRef;
  status: PublishStatus;
  /** ISO timestamp. Providers backdate posts so archives look lived-in. */
  publishedAt?: string;
  authorName?: string;
}

/**
 * One static page — an "about", "contact" or "privacy policy".
 *
 * Separate from `SeedContent` because a page is not a post: it carries no tags,
 * no author byline and no place in a chronological feed. Every CMS this project
 * targets draws the same line.
 */
export interface SeedPage {
  title: string;
  slug: string;
  blocks: ContentBlock[];
  excerpt?: string;
  featureImage?: ImageRef;
  status: PublishStatus;
  /**
   * False when the CMS renders this page through a dedicated template that
   * supplies its own content, so a generated body would never be shown — an
   * "authors" page whose template lists the authors, for instance.
   *
   * Only the caller can answer this, because only the caller knows the theme.
   * Defaults to true when unstated: a body a template ignores costs nothing,
   * whereas a page rendered by the generic template with no body is blank.
   */
  needsBody?: boolean;
  /**
   * Body supplied by the caller, used verbatim instead of generating one.
   *
   * For content the caller already has in final form and does not want
   * invented — a style guide, a legal notice. When present, `blocks` and
   * `needsBody` are both ignored.
   */
  suppliedBody?: string;
}

/**
 * A tag as an entity rather than a bare name.
 *
 * `SeedContent.tags` carries names only, which is all a post needs. A theme's
 * tag archive usually wants more: a description under the heading, a hero
 * image behind it. Those live here.
 */
export interface SeedTag {
  name: string;
  slug: string;
  description?: string;
  featureImage?: ImageRef;
}

/**
 * An author as an entity rather than a bare name.
 *
 * `SeedContent.authorName` is enough to attribute a post. An author archive
 * page needs the profile behind it.
 */
export interface SeedAuthor {
  name: string;
  slug: string;
  bio?: string;
  avatar?: ImageRef;
}

/** One entry in a site menu. */
export interface NavItem {
  label: string;
  url: string;
}

/**
 * Site-level configuration that belongs with the content rather than in it.
 *
 * Navigation is here because a theme's header and footer are shaped by the
 * menu, and demo content without one leaves them empty — the site reads as
 * broken rather than unconfigured. Every CMS this project targets stores menus
 * as site settings rather than as content.
 */
export interface SeedSiteConfig {
  navigation?: NavItem[];
  secondaryNavigation?: NavItem[];
}

/**
 * Everything one generation run produced.
 *
 * Providers that only handle posts can read `posts` and ignore the rest; the
 * optional entity collections exist so a provider that can create pages,
 * tags or author profiles has them available.
 */
export interface SeedBundle {
  posts: SeedContent[];
  pages?: SeedPage[];
  tags?: SeedTag[];
  authors?: SeedAuthor[];
  site?: SeedSiteConfig;
}

/**
 * A change to one post that already exists.
 *
 * Every field is optional and *absent means leave alone*, because an update
 * addresses a live post rather than describing one from scratch: a caller
 * fixing a missing hero must not blank the excerpt by not mentioning it. The
 * one field that needs three states is `featureImage`, which distinguishes
 * "leave it" (absent) from "remove it" (null) from "use this" (a ref).
 */
export interface UpdateContent {
  /** CMS-assigned id, as returned by `listSeeded` or `createContent`. */
  id: string;
  title?: string;
  excerpt?: string;
  /** Replaces the post body wholesale when given. */
  blocks?: ContentBlock[];
  /** Absent leaves the hero alone; `null` removes it; a ref replaces it. */
  featureImage?: ImageRef | null;
  /** One image to splice into the existing body, leaving the prose untouched. */
  insertImage?: ImageRef;
  status?: PublishStatus;
}

/** What a provider did with one SeedContent item. */
export interface SeedResult {
  /** CMS-assigned identifier. */
  id: string;
  title: string;
  slug?: string;
  url?: string;
  status: PublishStatus;
  /** Set when creation failed; `id` is then a synthetic placeholder. */
  error?: string;
  /** Blocks that survived into the published post, for verification. */
  blockTypes?: ContentBlockType[];
  hasFeatureImage?: boolean;
  createdAt?: string;
}

/**
 * Marker applied to everything themeseed creates, so `wipeSeeded` can find its
 * own work and nothing else. Providers map this onto their native tagging.
 * The `#` prefix is Ghost's convention for an internal (non-public) tag; other
 * providers should use whatever hidden-taxonomy mechanism they have.
 */
export const SEED_TAG = '#themeseed';

export interface WipeSummary {
  removed: number;
  /** Ids that could not be removed, with the reason. */
  failed?: Array<{ id: string; error: string }>;
}
