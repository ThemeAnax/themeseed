/**
 * Turns a topic plus a `ThemeCapabilities` reading into platform-neutral posts.
 *
 * This is the file rule 2 of the architecture protects: it emits `SeedContent`
 * with structured blocks and never a line of any CMS's storage format. A
 * WordPress provider consumes exactly what Ghost's does.
 *
 * The other job here is restraint. A gallery in a theme with no gallery styles,
 * or an embed in a theme that never styled one, renders as a broken-looking
 * stack of images — worse than the plain post it replaced. So every enrichment
 * is gated on capabilities that were actually measured.
 */

import { logger } from '../core/logger.js';
import type {
  ContentBlock,
  ImageRef,
  ImageRequest,
  PublishStatus,
  SeedContent,
  ThemeCapabilities,
} from '../core/types.js';
import { hashString } from '../images/png.js';
import type { ImageSource } from '../images/source.js';
import { profileTopic, TemplateContentEngine, type ContentEngine } from './engine.js';
import { YouTubeVideoFinder } from './video.js';

export interface GenerateOptions {
  topic: string;
  count: number;
  capabilities: ThemeCapabilities;
  imageSource: ImageSource;
  status?: PublishStatus;
  /** Prose engine. Defaults to the offline template engine. */
  engine?: ContentEngine;
  /**
   * Titles supplied by the caller — typically written by the MCP host's own
   * model, which produces far better copy than any template can. When given,
   * these replace generated titles one-for-one.
   */
  titles?: string[];
  /** Set to make a run reproducible. Defaults to a hash of the topic. */
  seed?: number;
  /** Pass null to skip video lookup entirely (useful offline). */
  videoFinder?: YouTubeVideoFinder | null;
  authorName?: string;
  /** Spread publish dates back over this many days so archives look lived-in. */
  backdateDays?: number;
  onProgress?: (done: number, total: number, title: string) => void;
}

export interface GenerateSummary {
  posts: SeedContent[];
  /** What was actually included, for reporting and verification. */
  stats: {
    withFeatureImage: number;
    withInlineImage: number;
    withGallery: number;
    withVideo: number;
    skipped: {
      gallery?: string;
      video?: string;
      featureImage?: string;
    };
  };
}

const GALLERY_SIZE = 3;

export async function generateSeedContent(
  options: GenerateOptions
): Promise<GenerateSummary> {
  const {
    topic,
    count,
    capabilities,
    imageSource,
    status = 'published',
    engine = new TemplateContentEngine(),
    seed = hashString(topic),
    backdateDays = 90,
  } = options;

  const profile = profileTopic(topic);
  const videoFinder =
    options.videoFinder === null
      ? null
      : (options.videoFinder ??
        (capabilities.supportsVideoEmbed ? new YouTubeVideoFinder() : null));

  const titles = options.titles?.length
    ? options.titles.slice(0, count)
    : await engine.generateTitles(topic, count, seed);

  const stats: GenerateSummary['stats'] = {
    withFeatureImage: 0,
    withInlineImage: 0,
    withGallery: 0,
    withVideo: 0,
    skipped: {},
  };
  if (!capabilities.supportsFeatureImage) {
    stats.skipped.featureImage = 'theme does not display a feature image';
  }
  if (!capabilities.supportsGallery) {
    stats.skipped.gallery = 'theme has no gallery card styles';
  }
  if (!capabilities.supportsVideoEmbed) {
    stats.skipped.video = 'theme has no embed card styles';
  }

  const posts: SeedContent[] = [];

  for (const [index, title] of titles.entries()) {
    const postSeed = seed ^ hashString(`${title}#${index}`);
    const blocks = await engine.generateBody({
      title,
      topic,
      targetWords: capabilities.expectedWordCount.target,
      seed: postSeed,
    });

    // Which posts get which enrichment is decided by position, not chance, so
    // a run of 15 posts reliably exercises every card the theme supports —
    // that is what makes this useful for previewing a theme.
    const wantsGallery = capabilities.supportsGallery && index % 3 === 1;
    const wantsVideo = capabilities.supportsVideoEmbed && index % 3 === 2;
    const wantsInlineImage = index % 3 === 0 || (!wantsGallery && !wantsVideo);

    const enriched = await enrichBlocks({
      blocks,
      title,
      topic,
      profile: profile.subject,
      capabilities,
      imageSource,
      wantsGallery,
      wantsVideo,
      wantsInlineImage,
      videoFinder,
      stats,
    });

    let featureImage: ImageRef | undefined;
    if (capabilities.supportsFeatureImage) {
      featureImage = await firstImage(imageSource, {
        query: `${title} — ${profile.subject}`,
        ...(capabilities.featureImageAspectRatio !== undefined
          ? { aspectRatio: capabilities.featureImageAspectRatio }
          : {}),
        minWidth: 1600,
        role: 'feature',
      });
      if (featureImage) stats.withFeatureImage += 1;
    }

    const excerpt = await engine.generateExcerpt(title, topic, postSeed);

    posts.push({
      title,
      slug: slugify(title),
      excerpt,
      blocks: enriched,
      tags: tagsFor(profile.subject, topic, index),
      ...(featureImage ? { featureImage } : {}),
      status,
      publishedAt: backdatedIso(index, titles.length, backdateDays),
      ...(options.authorName ? { authorName: options.authorName } : {}),
    });

    options.onProgress?.(index + 1, titles.length, title);
  }

  return { posts, stats };
}

// ---------------------------------------------------------------------------
// enrichment
// ---------------------------------------------------------------------------

interface EnrichArgs {
  blocks: ContentBlock[];
  title: string;
  topic: string;
  profile: string;
  capabilities: ThemeCapabilities;
  imageSource: ImageSource;
  wantsGallery: boolean;
  wantsVideo: boolean;
  wantsInlineImage: boolean;
  videoFinder: YouTubeVideoFinder | null;
  stats: GenerateSummary['stats'];
}

async function enrichBlocks(args: EnrichArgs): Promise<ContentBlock[]> {
  const blocks = [...args.blocks];
  const insertions: Array<{ at: number; block: ContentBlock }> = [];

  // Insert after a heading's first paragraph rather than immediately after the
  // heading, so media never separates a heading from the text it introduces.
  const anchors = findInsertionPoints(blocks);

  if (args.wantsInlineImage && anchors.length > 0) {
    const image = await firstImage(args.imageSource, {
      query: `${args.profile}: ${args.title}`,
      minWidth: 1400,
      role: 'body',
      ...(args.capabilities.supportsWideImages ? {} : { aspectRatio: 1.5 }),
    });
    if (image) {
      insertions.push({
        at: anchors[0]!,
        block: {
          type: 'image',
          image,
          alt: image.alt ?? args.title,
          ...(image.credit ? { caption: image.credit } : {}),
        },
      });
      args.stats.withInlineImage += 1;
    }
  }

  if (args.wantsGallery && anchors.length > 0) {
    const images = await manyImages(
      args.imageSource,
      { query: `${args.profile} — details`, minWidth: 1200, role: 'gallery' },
      GALLERY_SIZE
    );
    // Ghost lays a gallery out as a grid; with fewer than two images that grid
    // is just a lopsided single image, so fall back rather than ship it.
    if (images.length >= 2) {
      insertions.push({
        at: anchors[Math.min(1, anchors.length - 1)]!,
        block: {
          type: 'gallery',
          images,
          caption: `${capitalise(args.profile)} in practice`,
        },
      });
      args.stats.withGallery += 1;
    } else {
      logger.debug(
        `gallery skipped for "${args.title}": image source returned ${images.length}`
      );
    }
  }

  if (args.wantsVideo && args.videoFinder && anchors.length > 0) {
    const video = await args.videoFinder.find(
      `${args.profile} ${args.title}`.slice(0, 90)
    );
    if (video) {
      insertions.push({ at: anchors[Math.min(1, anchors.length - 1)]!, block: video });
      args.stats.withVideo += 1;
    } else {
      logger.debug(
        `no verified video found for "${args.title}"; leaving the post without one`
      );
    }
  }

  // Apply from the back so earlier indices stay valid.
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    blocks.splice(insertion.at, 0, insertion.block);
  }
  return blocks;
}

/** Indices just after the first paragraph following each heading. */
function findInsertionPoints(blocks: ContentBlock[]): number[] {
  const points: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]?.type !== 'heading') continue;
    for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[j]?.type === 'paragraph') {
        points.push(j + 1);
        break;
      }
    }
  }
  // Fall back to just after the opening paragraph for posts with no headings.
  if (points.length === 0 && blocks.length > 1) points.push(1);
  return points;
}

/**
 * Images are an enhancement: a source that is down should cost pictures, not
 * the whole seed run. Every call into an `ImageSource` goes through one of
 * these two helpers so there is no path where a throw escapes.
 */
async function manyImages(
  source: ImageSource,
  request: ImageRequest,
  count: number
): Promise<ImageRef[]> {
  try {
    return await source.fetch(request, count);
  } catch (err) {
    logger.warn(`image lookup failed for "${request.query}":`, err);
    return [];
  }
}

async function firstImage(
  source: ImageSource,
  request: ImageRequest
): Promise<ImageRef | undefined> {
  return (await manyImages(source, request, 1))[0];
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

const EXTRA_TAGS = ['Notes', 'Practice', 'Field guide', 'Opinion', 'Teardown'];

function tagsFor(subject: string, topic: string, index: number): string[] {
  const primary = capitalise(subject.split(' ').slice(0, 2).join(' '));
  const secondary = EXTRA_TAGS[index % EXTRA_TAGS.length]!;
  const tags = [primary, secondary];
  const topicWord = topic.split(/\s+/).find((word) => word.length > 4);
  if (topicWord && !tags.some((tag) => tag.toLowerCase() === topicWord.toLowerCase())) {
    tags.push(capitalise(topicWord));
  }
  return [...new Set(tags)].slice(0, 3);
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'post'
  );
}

/**
 * Spreads posts backwards from today. Evenly-spaced dates look artificial, so
 * the spacing is derived from the index rather than uniform, and nothing is
 * dated in the future — Ghost would schedule it instead of publishing.
 */
function backdatedIso(index: number, total: number, days: number): string {
  const spacing = total > 1 ? days / total : 1;
  const jitter = ((index * 37) % 17) / 17;
  const daysAgo = (index + jitter) * spacing;
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return when.toISOString();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
