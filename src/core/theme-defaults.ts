/**
 * What to assume about a theme nobody asked us to read.
 *
 * Reading a theme costs a round trip and is worth paying for only when the
 * user wants content shaped to that theme's design. Without it, assume the
 * conservative half of every choice: a feature image, tags and an author,
 * because nearly every theme shows those; no galleries, video embeds, bookmark
 * cards or wide images, because a card the theme cannot style looks worse than
 * its absence.
 *
 * `confidence: 0` and `analyzedVia: ['defaults']` mark this as assumed rather
 * than measured, which is also how callers tell it apart from an analysis that
 * ran and found nothing.
 */

import type { Platform, ThemeCapabilities } from './types.js';

export function genericCapabilities(platform: Platform): ThemeCapabilities {
  return {
    platform,
    themeName: 'unknown',

    supportsFeatureImage: true,
    featureImageAspectRatio: 1.5,

    supportsGallery: false,
    supportsVideoEmbed: false,
    supportsBookmarkCard: false,
    supportsCodeBlocks: true,
    supportsWideImages: false,

    displaysTags: true,
    displaysAuthor: true,
    displaysAuthorImage: false,
    displaysExcerpt: true,
    displaysReadingTime: false,

    expectedWordCount: { min: 500, target: 850, max: 1200 },

    confidence: 0,
    evidence: [
      'no theme analysis was requested — these are generic defaults, not measurements',
      'run `themeseed seed --study-theme`, or `themeseed analyze`, to read the real theme',
    ],
    analyzedVia: ['defaults'],
  };
}
