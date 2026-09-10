/**
 * The Ghost publish path: neutral `SeedContent` in, real Ghost posts out.
 *
 * Order matters. Every image referenced by a post — the feature image, inline
 * images, gallery members — is uploaded to Ghost *first*, then the post body is
 * built against the resulting hosted URLs. Creating the post first and patching
 * images in afterwards would leave a window where the post renders with dead
 * `src`s, and Ghost has no transactional way to close it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { logger } from '../../core/logger.js';
import {
  SEED_TAG,
  type ContentBlockType,
  type ImageRef,
  type SeedContent,
  type SeedPage,
  type SeedResult,
  type SeedTag,
  type UpdateContent,
} from '../../core/types.js';
import { extensionFor, probeImage, type ImageFormat } from '../../images/inspect.js';
import type { GhostClient } from './client.js';
import { blocksToLexical, insertImageCard, type HostedImage } from './lexical.js';
import type { GhostPost } from './types.js';

export interface PublishOptions {
  onProgress?: (done: number, total: number, current: SeedResult) => void;
  /** Retry count for transient upload/create failures. */
  maxRetries?: number;
}

export async function publishPosts(
  client: GhostClient,
  items: SeedContent[],
  options: PublishOptions = {}
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  const uploadCache = new Map<string, HostedImage>();

  for (const [index, item] of items.entries()) {
    let result: SeedResult;
    try {
      result = await publishOne(client, item, uploadCache, options);
    } catch (err) {
      // One bad post must not lose the other fourteen. Record and continue —
      // the caller reports failures rather than the run aborting mid-way.
      logger.warn(`failed to create post "${item.title}":`, err);
      result = {
        id: `failed-${index}`,
        title: item.title,
        status: item.status,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    options.onProgress?.(index + 1, items.length, result);
  }

  return results;
}

export interface UpdateOptions extends PublishOptions {
  /** Permit editing posts that do not carry the seed tag. Off by default. */
  allowUnseeded?: boolean;
  seedTagSlug: string;
}

/**
 * Applies edits to posts that already exist.
 *
 * Mirrors `publishPosts`: one failed item is recorded and the rest proceed.
 */
export async function updatePosts(
  client: GhostClient,
  items: UpdateContent[],
  options: UpdateOptions
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  const uploadCache = new Map<string, HostedImage>();

  for (const [index, item] of items.entries()) {
    let result: SeedResult;
    try {
      result = await updateOne(client, item, uploadCache, options);
    } catch (err) {
      logger.warn(`failed to update post ${item.id}:`, err);
      result = {
        id: item.id,
        title: item.title ?? item.id,
        status: item.status ?? 'published',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    options.onProgress?.(index + 1, items.length, result);
  }

  return results;
}

async function updateOne(
  client: GhostClient,
  item: UpdateContent,
  cache: Map<string, HostedImage>,
  options: UpdateOptions
): Promise<SeedResult> {
  const existing = await client.getPost(item.id);

  // Re-check the tag on the record Ghost actually returned, never on the
  // caller's claim. An id copied from the wrong list would otherwise overwrite
  // a real article, and there is no undo for that.
  const seeded = existing.tags?.some(
    (tag) => tag.slug === options.seedTagSlug || tag.name === SEED_TAG
  );
  if (!seeded && !options.allowUnseeded) {
    throw new Error(
      `post "${existing.title}" does not carry ${SEED_TAG}; ` +
        'themeseed did not create it. Pass allowUnseeded to edit it anyway.'
    );
  }

  const payload: Record<string, unknown> = {};
  if (item.title !== undefined) payload['title'] = item.title;
  if (item.excerpt !== undefined)
    payload['custom_excerpt'] = truncateExcerpt(item.excerpt);
  if (item.status !== undefined) payload['status'] = item.status;

  // Ghost clears a feature image when the field is sent as null, which is why
  // the neutral model distinguishes null from absent.
  if (item.featureImage === null) {
    payload['feature_image'] = null;
    payload['feature_image_alt'] = null;
    payload['feature_image_caption'] = null;
  } else if (item.featureImage) {
    const hosted = await hostImage(client, item.featureImage, cache, options);
    payload['feature_image'] = hosted.url;
    payload['feature_image_alt'] = truncateAlt(
      item.featureImage.alt ?? hosted.alt ?? item.title ?? existing.title
    );
    if (item.featureImage.caption)
      payload['feature_image_caption'] = item.featureImage.caption;
  }

  if (item.blocks) {
    const hosted = new Map<string, HostedImage>();
    for (const ref of collectImageRefs({ blocks: item.blocks })) {
      try {
        hosted.set(imageKey(ref), await hostImage(client, ref, cache, options));
      } catch (err) {
        logger.warn(`skipping image ${ref.location}:`, err);
      }
    }
    payload['lexical'] = blocksToLexical(item.blocks, (ref) => hosted.get(imageKey(ref)));
  } else if (item.insertImage) {
    if (!existing.lexical) {
      throw new Error('post has no Lexical body to insert an image into');
    }
    const hosted = await hostImage(client, item.insertImage, cache, options);
    payload['lexical'] = insertImageCard(existing.lexical, hosted, {
      alt: item.insertImage.alt ?? item.title ?? existing.title,
      ...(item.insertImage.caption ? { caption: item.insertImage.caption } : {}),
    });
  }

  if (Object.keys(payload).length === 0) {
    // Nothing to do is not an error, but pretending an edit happened would be.
    return toSeedResult(existing);
  }

  const updated = await withRetry(
    () => client.updatePost(item.id, payload, existing.updated_at ?? ''),
    options.maxRetries ?? 2,
    `update post "${existing.title}"`
  );

  return toSeedResult(updated);
}

/** Uploads an image ref, reusing anything already hosted in this run. */
async function hostImage(
  client: GhostClient,
  ref: ImageRef,
  cache: Map<string, HostedImage>,
  options: PublishOptions
): Promise<HostedImage> {
  const key = imageKey(ref);
  const cached = cache.get(key);
  if (cached) return cached;
  const uploaded = await uploadImageRef(client, ref, options.maxRetries ?? 2);
  cache.set(key, uploaded);
  return uploaded;
}

async function publishOne(
  client: GhostClient,
  item: SeedContent,
  cache: Map<string, HostedImage>,
  options: PublishOptions
): Promise<SeedResult> {
  const refs = collectImageRefs(item);
  const hosted = new Map<string, HostedImage>();

  for (const ref of refs) {
    const key = imageKey(ref);
    const cached = cache.get(key);
    if (cached) {
      hosted.set(key, cached);
      continue;
    }
    try {
      const uploaded = await uploadImageRef(client, ref, options.maxRetries ?? 2);
      cache.set(key, uploaded);
      hosted.set(key, uploaded);
    } catch (err) {
      // A missing image degrades the post; it does not invalidate it. The
      // Lexical builder drops blocks whose images failed to resolve.
      logger.warn(`skipping image ${ref.location}:`, err);
    }
  }

  const resolve = (ref: ImageRef): HostedImage | undefined => hosted.get(imageKey(ref));
  const lexical = blocksToLexical(item.blocks, resolve);

  const featureImage = item.featureImage ? resolve(item.featureImage) : undefined;

  const payload: Record<string, unknown> = {
    title: item.title,
    lexical,
    status: item.status,
    // Ghost creates missing tags automatically when they are given by name,
    // so the seed tag needs no separate provisioning step.
    tags: [SEED_TAG, ...item.tags].map((name) => ({ name })),
  };

  if (item.slug) payload['slug'] = item.slug;
  if (item.excerpt) payload['custom_excerpt'] = truncateExcerpt(item.excerpt);
  if (featureImage) {
    payload['feature_image'] = featureImage.url;
    payload['feature_image_alt'] = truncateAlt(
      item.featureImage?.alt ?? featureImage.alt ?? item.title
    );
    if (item.featureImage?.caption)
      payload['feature_image_caption'] = item.featureImage.caption;
  }
  if (item.publishedAt && item.status === 'published') {
    payload['published_at'] = item.publishedAt;
  }

  const created = await withRetry(
    () => client.createPost(payload),
    options.maxRetries ?? 2,
    `create post "${item.title}"`
  );

  return toSeedResult(created, item, Boolean(featureImage));
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

function collectImageRefs(
  item: Pick<SeedContent, 'blocks'> & { featureImage?: ImageRef }
): ImageRef[] {
  const refs: ImageRef[] = [];
  if (item.featureImage) refs.push(item.featureImage);
  for (const block of item.blocks) {
    if (block.type === 'image') refs.push(block.image);
    else if (block.type === 'gallery') refs.push(...block.images);
  }
  // De-duplicate so the same picture used twice uploads once.
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = imageKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageKey(ref: ImageRef): string {
  return `${ref.kind}:${ref.location}`;
}

async function uploadImageRef(
  client: GhostClient,
  ref: ImageRef,
  maxRetries: number
): Promise<HostedImage> {
  // Retry the fetch *and* the validation together. Stock CDNs intermittently
  // answer with a 5xx or an HTML error page, and a single unlucky response
  // would otherwise cost that post its feature image permanently — which is
  // exactly what a "14/15 posts have a feature image" run looks like.
  const { bytes, info } = await withRetry(
    async () => {
      const data =
        ref.kind === 'file'
          ? await readLocalImage(ref.location)
          : await downloadImage(ref.location);
      const probed = probeImage(data);
      if (!probed) {
        throw new Error(
          `${ref.location} is not a valid image (${data.byteLength} bytes)`
        );
      }
      return { bytes: data, info: probed };
    },
    // Local files are not flaky; a bad one will still be bad on the third try.
    ref.kind === 'file' ? 0 : maxRetries,
    `fetch ${ref.location}`
  );

  const filename = filenameFor(ref, info.format);
  const uploaded = await withRetry(
    () => client.uploadImage(bytes, filename, info.mimeType),
    maxRetries,
    `upload ${filename}`
  );

  return {
    url: uploaded.url,
    width: info.width,
    height: info.height,
    ...(ref.alt ? { alt: ref.alt } : {}),
    ...(ref.caption ? { caption: ref.caption } : {}),
    fileName: filename,
  };
}

async function readLocalImage(location: string): Promise<Uint8Array> {
  const buffer = await fs.readFile(location);
  return new Uint8Array(buffer);
}

async function downloadImage(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'themeseed/0.1' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function filenameFor(ref: ImageRef, format: ImageFormat): string {
  const base =
    ref.kind === 'file'
      ? path.basename(ref.location).replace(/\.\w+$/, '')
      : (new URL(ref.location).pathname.split('/').pop() ?? 'image').replace(
          /\.\w+$/,
          ''
        );
  const safe = (base || 'image').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  return `${safe}.${extensionFor(format)}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function toSeedResult(
  post: GhostPost,
  item?: Pick<SeedContent, 'blocks'>,
  hasFeatureImage?: boolean
): SeedResult {
  const blockTypes = item ? uniqueBlockTypes(item) : undefined;
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    status: normaliseStatus(post.status),
    ...(post.url ? { url: post.url } : {}),
    ...(blockTypes ? { blockTypes } : {}),
    hasFeatureImage: hasFeatureImage ?? Boolean(post.feature_image),
    ...(post.created_at ? { createdAt: post.created_at } : {}),
  };
}

function uniqueBlockTypes(item: Pick<SeedContent, 'blocks'>): ContentBlockType[] {
  return [...new Set(item.blocks.map((block) => block.type))];
}

/** Ghost's `sent` status has no neutral equivalent; treat it as published. */
function normaliseStatus(status: GhostPost['status']): SeedResult['status'] {
  return status === 'sent' ? 'published' : status;
}

/** Ghost rejects custom excerpts over 300 characters. */
function truncateExcerpt(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 297).trimEnd()}…`;
}

/** Ghost caps feature_image_alt at 191 characters. */
function truncateAlt(text: string): string {
  return text.length <= 191 ? text : `${text.slice(0, 188).trimEnd()}…`;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retries: number,
  label: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = 400 * 2 ** attempt;
      logger.debug(
        `${label} failed (attempt ${attempt + 1}/${retries + 1}); retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pages and tags
// ---------------------------------------------------------------------------

/**
 * Publishes static pages.
 *
 * Ghost keeps pages in the posts table with `type: 'page'`, but the API will
 * not accept `type` on `/posts/` — the endpoint decides, so this goes to
 * `/pages/`.
 *
 * Same failure contract as `publishPosts`: one bad page is recorded and the
 * rest continue.
 */
export async function publishPages(
  client: GhostClient,
  items: SeedPage[],
  options: PublishOptions = {}
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  const uploadCache = new Map<string, HostedImage>();

  for (const [index, item] of items.entries()) {
    let result: SeedResult;
    try {
      const hosted = new Map<string, HostedImage>();
      for (const ref of collectImageRefs(item)) {
        try {
          hosted.set(imageKey(ref), await hostImage(client, ref, uploadCache, options));
        } catch (err) {
          logger.warn(`image for page "${item.title}" could not be uploaded:`, err);
        }
      }
      const resolve = (ref: ImageRef) => hosted.get(imageKey(ref));

      // A supplied body is final markup; converting it into blocks and back
      // could only change it, so it goes over as html and Ghost converts.
      const bodyField = item.suppliedBody
        ? { html: item.suppliedBody }
        : { lexical: blocksToLexical(item.blocks, resolve) };

      const created = await client.createPage({
        title: item.title,
        slug: item.slug,
        ...bodyField,
        status: item.status,
        ...(item.excerpt ? { custom_excerpt: truncateExcerpt(item.excerpt) } : {}),
        ...(item.featureImage && resolve(item.featureImage)
          ? { feature_image: resolve(item.featureImage)!.url }
          : {}),
        // Pages carry the marker too, so a wipe finds everything it made.
        tags: [{ name: SEED_TAG }],
      });
      result = toSeedResult(created, item);
    } catch (err) {
      logger.warn(`failed to create page "${item.title}":`, err);
      result = {
        id: `failed-page-${index}`,
        title: item.title,
        status: item.status,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    options.onProgress?.(index + 1, items.length, result);
  }

  return results;
}

/** Creates tags as entities so an archive page has something to render. */
export async function publishTags(
  client: GhostClient,
  items: SeedTag[],
  options: PublishOptions = {}
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];

  for (const [index, item] of items.entries()) {
    let result: SeedResult;
    try {
      const created = await client.createTag({
        name: item.name,
        slug: item.slug,
        ...(item.description ? { description: item.description } : {}),
      });
      result = {
        id: created.id,
        title: created.name ?? item.name,
        slug: created.slug ?? item.slug,
        status: 'published',
      };
    } catch (err) {
      logger.warn(`failed to create tag "${item.name}":`, err);
      result = {
        id: `failed-tag-${index}`,
        title: item.name,
        status: 'published',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    options.onProgress?.(index + 1, items.length, result);
  }

  return results;
}
