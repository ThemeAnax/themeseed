/**
 * The image source that sources no images.
 *
 * Images are an enhancement, not a requirement: a run with no provider
 * configured should publish text-only posts rather than fail, or fill the
 * theme with stock photographs unrelated to the topic. Modelling that as a
 * source keeps the decision in one place — nothing downstream needs a null
 * check on `imageSource`.
 */

import type { ImageRef, ImageRequest } from '../core/types.js';
import type { ImageSource } from './source.js';

export class NoneImageSource implements ImageSource {
  readonly kind = 'none' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async unavailableReason(): Promise<string> {
    return '';
  }

  // The parameters go unused but must be declared: a zero-arity override makes
  // every `fetch(request, count)` call site a type error.
  async fetch(_request: ImageRequest, _count: number): Promise<ImageRef[]> {
    return [];
  }
}
