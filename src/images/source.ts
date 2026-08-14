/**
 * One interface, three interchangeable ways to get a picture.
 *
 * The content generator asks for "a photo of a standing desk, landscape,
 * ≥1600px" and does not care whether that arrives from a folder on disk, a
 * stock API, or an image model. Callers pick the source by name; nothing
 * downstream branches on which one they picked.
 */

import type { ImageRef, ImageRequest, ImageSourceKind } from '../core/types.js';

export interface ImageSource {
  readonly kind: ImageSourceKind;

  /**
   * True when this source is usable right now — key present, directory exists,
   * adapter reachable. The factory uses this to fail fast with a clear message
   * instead of half-way through a 15-post run.
   */
  isAvailable(): Promise<boolean>;

  /** Why `isAvailable()` returned false. Empty string when it returned true. */
  unavailableReason(): Promise<string>;

  /**
   * Fetch `count` distinct images for a request. May return fewer than asked
   * for; callers must handle a short result rather than assuming the length.
   * Returns refs that are ready to upload — for remote sources that means the
   * URL resolves, for `ai` it means the bytes are already on disk.
   */
  fetch(request: ImageRequest, count: number): Promise<ImageRef[]>;
}

/** Shared helper: turn an aspect ratio into the orientation stock APIs want. */
export function orientationFor(request: ImageRequest): 'landscape' | 'portrait' | 'square' {
  if (request.orientation) return request.orientation;
  const ratio = request.aspectRatio;
  if (ratio === undefined) return 'landscape';
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}
