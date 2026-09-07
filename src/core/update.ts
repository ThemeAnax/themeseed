/**
 * Editing a post that already exists.
 *
 * Seeding is a one-shot operation, so for a long time the only way to fix a
 * post was to delete it and seed again — which is fine for one post and absurd
 * for the twenty-fourth of twenty-five, where a stock provider hit its hourly
 * quota and the last three published with no images. This module exists for
 * exactly that repair: source the missing image, attach it, leave everything
 * else alone.
 *
 * Like `seedSite`, both surfaces call this rather than the provider directly,
 * so the CLI and the MCP tool cannot drift apart.
 */

import { createRequestedImageSource, type ImageSourceOptions } from '../images/index.js';
import type { ImageSource } from '../images/source.js';
import { createProvider } from '../providers/registry.js';
import type { CmsProvider, SiteConfig } from '../providers/provider.js';
import { logger } from './logger.js';
import type {
  ImageRef,
  PublishStatus,
  RequestedImageSource,
  SeedResult,
  UpdateContent,
} from './types.js';

/** What to do with a post's hero image. */
export type FeatureImageAction = 'keep' | 'remove' | 'replace';

export interface UpdatePostRequest {
  site: SiteConfig;
  /** CMS id, as reported by `list_seeded`. */
  id: string;
  title?: string;
  excerpt?: string;
  status?: PublishStatus;
  /** Defaults to leaving the hero untouched. */
  featureImage?: FeatureImageAction;
  /** Splice one image into the body, leaving the existing prose alone. */
  addBodyImage?: boolean;
  /** What to search for. Defaults to the post's title. */
  imageQuery?: string;
  imageSource?: RequestedImageSource;
  imageSourceOptions?: ImageSourceOptions;
  /** Edit a post themeseed did not create. Off by default. */
  allowUnseeded?: boolean;
}

export interface UpdateReport {
  result: SeedResult;
  featureImageAttached: boolean;
  bodyImageAttached: boolean;
  /**
   * Why an image could not be sourced, when one was asked for.
   *
   * Reported rather than logged. A provider that has hit its quota fails every
   * lookup in a run, and routing that to stderr alone is how twenty-five posts
   * came back "created: 25, failed: 0" with nothing in them.
   */
  imageError?: string;
}

export async function updatePost(request: UpdatePostRequest): Promise<UpdateReport> {
  const provider: CmsProvider = createProvider(request.site);

  const featureAction = request.featureImage ?? 'keep';
  const needsImage = featureAction === 'replace' || request.addBodyImage === true;

  const imageSource = needsImage
    ? await createRequestedImageSource(
        request.imageSource ?? 'auto',
        request.imageSourceOptions ?? {}
      )
    : undefined;

  const query = request.imageQuery ?? request.title ?? '';
  let imageError: string | undefined;

  let featureImage: ImageRef | null | undefined;
  if (featureAction === 'remove') featureImage = null;
  else if (featureAction === 'replace' && imageSource) {
    const [image, error] = await sourceOne(imageSource, query, 1600, 'feature');
    if (image) featureImage = image;
    else imageError ??= error;
  }

  let insertImage: ImageRef | undefined;
  if (request.addBodyImage && imageSource) {
    const [image, error] = await sourceOne(imageSource, query, 1400, 'body');
    if (image) insertImage = image;
    else imageError ??= error;
  }

  const item: UpdateContent = {
    id: request.id,
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.excerpt !== undefined ? { excerpt: request.excerpt } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    ...(featureImage !== undefined ? { featureImage } : {}),
    ...(insertImage ? { insertImage } : {}),
  };

  const [result] = await provider.updateContent([item], {
    ...(request.allowUnseeded !== undefined
      ? { allowUnseeded: request.allowUnseeded }
      : {}),
  });

  if (!result) {
    throw new Error('provider returned no result for the update');
  }

  return {
    result,
    featureImageAttached: Boolean(featureImage),
    bodyImageAttached: Boolean(insertImage),
    ...(imageError ? { imageError } : {}),
  };
}

/**
 * One image, or the reason there is none.
 *
 * Returns the failure instead of throwing so a hero that could not be found
 * does not also abandon the title change the caller asked for in the same call.
 */
async function sourceOne(
  source: ImageSource,
  query: string,
  minWidth: number,
  role: 'feature' | 'body'
): Promise<[ImageRef | undefined, string | undefined]> {
  try {
    const images = await source.fetch({ query, minWidth, role }, 1);
    if (images[0]) return [images[0], undefined];
    return [undefined, `image source "${source.kind}" returned no ${role} image`];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`could not source a ${role} image for "${query}":`, err);
    return [undefined, message];
  }
}
