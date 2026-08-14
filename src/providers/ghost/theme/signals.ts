/**
 * A theme analysis strategy produces a `ThemeSignalSet`: the subset of
 * capabilities it could actually measure, plus how much it should be trusted
 * and why.
 *
 * Keeping "what we found" separate from "how sure we are" is what lets the
 * analyzer combine a precise-but-unavailable source (the theme's .hbs files on
 * disk) with an always-available-but-inferential one (the rendered site)
 * without either silently overwriting the other.
 */

import type { ThemeCapabilities } from '../../../core/types.js';

/** The measurable subset — bookkeeping fields are added by the analyzer. */
export type MeasurableCapabilities = Omit<
  ThemeCapabilities,
  'platform' | 'confidence' | 'evidence' | 'analyzedVia'
>;

export interface ThemeSignalSet {
  /** Stable identifier, e.g. "local-theme-files". Appears in `analyzedVia`. */
  strategy: string;
  /** 0..1 trust in this strategy's readings, used to order the merge. */
  confidence: number;
  evidence: string[];
  capabilities: Partial<MeasurableCapabilities>;
}

export interface ThemeAnalysisStrategy {
  readonly name: string;
  /** Returns null when the strategy cannot run at all (e.g. no theme dir). */
  analyze(): Promise<ThemeSignalSet | null>;
}

/**
 * Conservative fallback used when nothing could be measured. Chosen so that
 * content generated against it renders acceptably in essentially any theme:
 * a feature image (nearly universal) but no gallery or embed cards, which are
 * the two things that look broken when unstyled.
 */
export function defaultCapabilities(themeName: string): MeasurableCapabilities {
  return {
    themeName,
    supportsFeatureImage: true,
    supportsGallery: false,
    supportsVideoEmbed: false,
    supportsBookmarkCard: false,
    supportsCodeBlocks: true,
    supportsWideImages: false,
    displaysTags: true,
    displaysAuthor: true,
    displaysAuthorImage: false,
    displaysExcerpt: false,
    displaysReadingTime: false,
    expectedWordCount: { min: 500, target: 800, max: 1200 },
  };
}

const MEASURABLE_KEYS: Array<keyof MeasurableCapabilities> = [
  'themeName',
  'themeVersion',
  'description',
  'supportsFeatureImage',
  'featureImageAspectRatio',
  'supportsGallery',
  'supportsVideoEmbed',
  'supportsBookmarkCard',
  'supportsCodeBlocks',
  'supportsWideImages',
  'displaysTags',
  'displaysAuthor',
  'displaysAuthorImage',
  'displaysExcerpt',
  'displaysReadingTime',
  'expectedWordCount',
  'postsPerPage',
];

/**
 * Highest-confidence strategy wins each field; lower-confidence strategies
 * fill only what is still missing. Fields nobody measured fall back to
 * `defaultCapabilities` and drag the reported confidence down.
 */
export function mergeSignals(
  themeName: string,
  sets: ThemeSignalSet[]
): {
  capabilities: MeasurableCapabilities;
  confidence: number;
  evidence: string[];
  analyzedVia: string[];
} {
  const ordered = [...sets].sort((a, b) => b.confidence - a.confidence);
  const fallback = defaultCapabilities(themeName);
  const merged: Record<string, unknown> = { ...fallback };
  const evidence: string[] = [];
  const measured = new Set<string>();

  // Optional fields are absent from the fallback, so seed them as unmeasured
  // rather than letting `undefined` read as a deliberate value.
  for (const set of ordered) {
    for (const key of MEASURABLE_KEYS) {
      const value = set.capabilities[key];
      if (value === undefined) continue;
      if (measured.has(key)) continue;
      merged[key] = value;
      measured.add(key);
    }
    for (const line of set.evidence) evidence.push(`[${set.strategy}] ${line}`);
  }

  // Confidence: how much of the surface we actually measured, scaled by the
  // trust of the strategies that did the measuring. A theme name alone should
  // not read as a confident analysis.
  const coverage = measured.size / MEASURABLE_KEYS.length;
  const bestConfidence = ordered.length
    ? Math.max(...ordered.map((s) => s.confidence))
    : 0;
  const confidence =
    ordered.length === 0 ? 0 : round2(Math.min(1, coverage * 0.5 + bestConfidence * 0.5));

  return {
    capabilities: merged as MeasurableCapabilities,
    confidence,
    evidence,
    analyzedVia: ordered.map((s) => s.strategy),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Shared detectors — used by both the local-files and rendered-site strategies
// ---------------------------------------------------------------------------

/**
 * Ghost ships card styles in `cards.min.css`, but themes that want the cards to
 * match their own design restyle the `kg-*` classes themselves. Either way, the
 * presence of a card's selectors in the theme's own stylesheet is direct
 * evidence that the card was designed for, not merely tolerated.
 */
export interface CardCssSignals {
  gallery: boolean;
  embed: boolean;
  bookmark: boolean;
  code: boolean;
  wide: boolean;
  image: boolean;
}

export function detectCardCss(css: string): CardCssSignals {
  return {
    gallery: /\.kg-gallery-(container|row|image)\b/.test(css),
    embed: /\.kg-embed-card\b/.test(css),
    bookmark: /\.kg-bookmark-(card|container)\b/.test(css),
    code: /\.kg-code-card\b/.test(css) || /\bpre\s*(>|\s)?\s*code\b/.test(css),
    wide: /\.kg-width-(wide|full)\b/.test(css),
    image: /\.kg-image(-card)?\b/.test(css),
  };
}

/** Turns the first `aspect-ratio: 21/9` (or `16 / 9`, or `1.5`) into a number. */
export function parseAspectRatio(source: string): number | undefined {
  const match = source.match(
    /aspect-ratio\s*:\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/
  );
  if (!match) return undefined;
  return ratioFrom(match[1], match[2]);
}

function ratioFrom(w: string | undefined, h: string | undefined): number | undefined {
  const width = Number(w);
  const height = h === undefined ? 1 : Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0)
    return undefined;
  return round2(width / height);
}

/**
 * Maps CSS utility classes to the aspect ratio they set, e.g. `.r32 {
 * aspect-ratio: 3/2 }` → `{ r32: 1.5 }`.
 *
 * Themes overwhelmingly express image shape this way rather than with inline
 * styles, so resolving classes is what makes ratio detection work at all.
 */
export function buildAspectRatioClassMap(css: string): Map<string, number> {
  const map = new Map<string, number>();
  const rulePattern = /([^{}]+)\{([^{}]*aspect-ratio[^{}]*)\}/g;
  for (const rule of css.matchAll(rulePattern)) {
    const [, selectorList = '', body = ''] = rule;
    const ratio = parseAspectRatio(body);
    if (ratio === undefined) continue;
    for (const selector of selectorList.split(',')) {
      // Only take simple single-class selectors. Anything more specific is
      // contextual and we cannot tell whether it applies without a real
      // cascade, so counting it would produce confident nonsense.
      const match = selector.trim().match(/^\.([A-Za-z0-9_-]+)$/);
      if (match?.[1]) map.set(match[1], ratio);
    }
  }
  return map;
}

/**
 * The aspect ratio a theme actually displays feature images at.
 *
 * Naively taking the first `aspect-ratio` in a template gets this wrong often:
 * templates carry ratios for avatars, related-post thumbnails and optional
 * layout branches the user has not selected. So instead we count only ratios
 * attached to markup that references the feature image, and return the most
 * frequent one — the shape the reader encounters most.
 */
export function dominantFeatureImageRatio(
  markup: string,
  css: string
): { ratio: number; occurrences: number; source: 'class' | 'inline' } | undefined {
  const classRatios = buildAspectRatioClassMap(css);
  const counts = new Map<number, { count: number; source: 'class' | 'inline' }>();

  const tally = (ratio: number, source: 'class' | 'inline') => {
    const existing = counts.get(ratio);
    if (existing) existing.count += 1;
    else counts.set(ratio, { count: 1, source });
  };

  // Collect the ratio-bearing elements first, so each one's search window can
  // be cut off at the next one. Without that boundary a 1:1 avatar counts the
  // feature image of the card that happens to follow it in the file.
  interface Candidate {
    start: number;
    inline?: number;
    classes: number[];
  }
  const candidates: Candidate[] = [];

  for (const tag of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const element = tag[0];
    const inline = parseAspectRatio(element);
    const classAttr = element.match(/class\s*=\s*["']([^"']+)["']/)?.[1];
    const classes = (classAttr?.split(/\s+/) ?? [])
      .map((name) => classRatios.get(name))
      .filter((ratio): ratio is number => ratio !== undefined);

    if (inline === undefined && classes.length === 0) continue;
    candidates.push({
      start: tag.index ?? 0,
      ...(inline !== undefined ? { inline } : {}),
      classes,
    });
  }

  for (const [index, candidate] of candidates.entries()) {
    // A ratio belongs to the feature image when the image reference appears
    // after this element's opening tag and before the next sized element.
    const nextStart = candidates[index + 1]?.start ?? markup.length;
    const end = Math.min(nextStart, candidate.start + 500);
    const window = markup.slice(candidate.start, end);
    if (!/feature_image|img_url|og:image/.test(window)) continue;

    if (candidate.inline !== undefined) tally(candidate.inline, 'inline');
    for (const ratio of candidate.classes) tally(ratio, 'class');
  }

  let best:
    { ratio: number; occurrences: number; source: 'class' | 'inline' } | undefined;
  for (const [ratio, info] of counts) {
    if (!best || info.count > best.occurrences) {
      best = { ratio, occurrences: info.count, source: info.source };
    }
  }
  return best;
}

/**
 * Word-count target, inferred from layout affordances rather than guessed.
 *
 * A table of contents is the strongest tell a theme expects long, headed
 * articles — nobody builds a TOC for 400-word posts. Reading-time and a wide
 * measure point the same way more weakly.
 */
export function inferWordCount(hints: {
  hasTableOfContents?: boolean;
  hasReadingTime?: boolean;
  contentWidth?: 'narrow' | 'standard' | 'wide' | 'full';
}): { min: number; target: number; max: number } {
  let target = 800;
  if (hints.hasTableOfContents) target = 1400;
  else if (hints.hasReadingTime) target = 1100;
  if (hints.contentWidth === 'narrow') target = Math.min(target, 900);
  if (hints.contentWidth === 'full') target = Math.max(target, 1200);
  return {
    min: Math.round(target * 0.65),
    target,
    max: Math.round(target * 1.45),
  };
}
