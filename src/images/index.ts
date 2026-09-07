/**
 * Image source selection.
 *
 * Callers name a source (`local`, `stock`, `ai`, `none`) or ask for `auto`;
 * this hands back something implementing `ImageSource` and nothing downstream
 * branches again.
 */

import { ThemeseedError } from '../core/errors.js';
import type { ImageSourceKind, RequestedImageSource } from '../core/types.js';
import { AiImageSource, type AiImageSourceOptions } from './ai-source.js';
import { LocalImageSource, type LocalImageSourceOptions } from './local-source.js';
import { NoneImageSource } from './none-source.js';
import { hasAiKey, hasStockKey, type ProviderEnv } from './providers.js';
import type { ImageSource } from './source.js';
import { StockImageSource, type StockImageSourceOptions } from './stock-source.js';

export interface ImageSourceOptions {
  local?: LocalImageSourceOptions;
  stock?: StockImageSourceOptions;
  ai?: AiImageSourceOptions;
}

export function createImageSource(
  kind: ImageSourceKind,
  options: ImageSourceOptions = {}
): ImageSource {
  switch (kind) {
    case 'local':
      return new LocalImageSource(options.local ?? {});
    case 'stock':
      return new StockImageSource(options.stock ?? {});
    case 'ai':
      return new AiImageSource(options.ai ?? {});
    case 'none':
      return new NoneImageSource();
    default: {
      const _never: never = kind;
      throw new ThemeseedError(`Unknown image source "${String(_never)}"`, {
        code: 'UNKNOWN_IMAGE_SOURCE',
        hint: 'Choose one of: local, stock, ai, none.',
      });
    }
  }
}

/**
 * Resolves a source and confirms it can actually run, so a misconfiguration
 * surfaces before any content is generated rather than fifteen posts in.
 */
export async function createUsableImageSource(
  kind: ImageSourceKind,
  options: ImageSourceOptions = {}
): Promise<ImageSource> {
  const source = createImageSource(kind, options);
  if (!(await source.isAvailable())) {
    throw new ThemeseedError(`Image source "${kind}" is not usable`, {
      code: 'IMAGE_SOURCE_UNAVAILABLE',
      hint: await source.unavailableReason(),
    });
  }
  return source;
}

/**
 * Turns a request into a concrete kind. `auto` prefers AI, because a generated
 * image matches the post's subject exactly; stock is second, because a searched
 * photograph is at least topical; no images is better than the keyless stock
 * fallback, which returns pictures of nothing in particular.
 */
export function resolveImageSourceKind(
  requested: RequestedImageSource,
  env: ProviderEnv = process.env
): ImageSourceKind {
  if (requested !== 'auto') return requested;
  if (hasAiKey(env)) return 'ai';
  if (hasStockKey(env)) return 'stock';
  return 'none';
}

/**
 * Builds the source a caller asked for.
 *
 * `auto` chose the kind itself, so it must not then fail on that choice. An
 * explicit kind was the caller's decision, and a decision that cannot run is
 * an error worth reporting rather than quietly downgrading.
 */
export async function createRequestedImageSource(
  requested: RequestedImageSource,
  options: ImageSourceOptions = {},
  env: ProviderEnv = process.env
): Promise<ImageSource> {
  const kind = resolveImageSourceKind(requested, env);
  return requested === 'auto'
    ? createImageSource(kind, options)
    : createUsableImageSource(kind, options);
}

export {
  AiImageSource,
  ProceduralImageAdapter,
  falImageSize,
  nearestAspectLabel,
  selectAiAdapter,
} from './ai-source.js';
export type { AiAdapterName, AiImageAdapter, GeneratedImage } from './ai-source.js';
export { LocalImageSource } from './local-source.js';
export { NoneImageSource } from './none-source.js';
export {
  IMAGE_PROVIDERS,
  configuredProviders,
  findProvider,
  hasAiKey,
  hasStockKey,
  isConfigured,
  providersByCategory,
} from './providers.js';
export type { ImageProviderInfo, ProviderCategory, ProviderEnv } from './providers.js';
export {
  selectStockProvider,
  selectStockProviders,
  StockImageSource,
} from './stock-source.js';
export type { StockProvider, StockProviderName } from './stock-source.js';
export { extensionFor, isValidImage, mimeTypeFor, probeImage } from './inspect.js';
export type { ImageFormat, ImageInfo } from './inspect.js';
export { orientationFor } from './source.js';
export type { ImageSource } from './source.js';
