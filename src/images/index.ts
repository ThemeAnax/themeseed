/**
 * Image source selection.
 *
 * Callers name a source (`local`, `stock`, `ai`); this hands back something
 * implementing `ImageSource` and nothing downstream branches again.
 */

import { ThemeseedError } from '../core/errors.js';
import type { ImageSourceKind } from '../core/types.js';
import { AiImageSource, type AiImageSourceOptions } from './ai-source.js';
import { LocalImageSource, type LocalImageSourceOptions } from './local-source.js';
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
    default: {
      const _never: never = kind;
      throw new ThemeseedError(`Unknown image source "${String(_never)}"`, {
        code: 'UNKNOWN_IMAGE_SOURCE',
        hint: 'Choose one of: local, stock, ai.',
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

export { AiImageSource, ProceduralImageAdapter, selectAiAdapter } from './ai-source.js';
export type { AiAdapterName, AiImageAdapter, GeneratedImage } from './ai-source.js';
export { LocalImageSource } from './local-source.js';
export { selectStockProvider, StockImageSource } from './stock-source.js';
export type { StockProvider, StockProviderName } from './stock-source.js';
export { extensionFor, isValidImage, mimeTypeFor, probeImage } from './inspect.js';
export type { ImageFormat, ImageInfo } from './inspect.js';
export { orientationFor } from './source.js';
export type { ImageSource } from './source.js';
