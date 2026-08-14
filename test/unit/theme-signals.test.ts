import { describe, expect, it } from 'vitest';

import {
  buildAspectRatioClassMap,
  detectCardCss,
  dominantFeatureImageRatio,
  inferWordCount,
  mergeSignals,
  parseAspectRatio,
  type ThemeSignalSet,
} from '../../src/providers/ghost/theme/signals.js';

describe('detectCardCss', () => {
  it('recognises the card classes a theme has styled', () => {
    const css = '.kg-gallery-container{}.kg-embed-card{}.kg-width-wide{}';
    expect(detectCardCss(css)).toMatchObject({
      gallery: true,
      embed: true,
      wide: true,
      bookmark: false,
    });
  });

  it('reports nothing for a stylesheet with no card rules', () => {
    const signals = detectCardCss('body{margin:0}.post-title{font-size:2rem}');
    expect(signals.gallery).toBe(false);
    expect(signals.embed).toBe(false);
    expect(signals.bookmark).toBe(false);
  });
});

describe('parseAspectRatio', () => {
  it.each([
    ['aspect-ratio: 21/9', 2.33],
    ['aspect-ratio:16 / 9', 1.78],
    ['aspect-ratio: 1.5', 1.5],
  ])('parses %s', (input, expected) => {
    expect(parseAspectRatio(input)).toBeCloseTo(expected, 2);
  });

  it('returns undefined when there is no ratio, and survives a zero divisor', () => {
    expect(parseAspectRatio('color: red')).toBeUndefined();
    expect(parseAspectRatio('aspect-ratio: 3/0')).toBeUndefined();
  });
});

describe('buildAspectRatioClassMap', () => {
  it('maps single-class selectors to their ratio', () => {
    const map = buildAspectRatioClassMap('.r32{aspect-ratio:3/2}.r11{aspect-ratio:1/1}');
    expect(map.get('r32')).toBeCloseTo(1.5, 2);
    expect(map.get('r11')).toBe(1);
  });

  it('ignores compound selectors it cannot resolve without a cascade', () => {
    const map = buildAspectRatioClassMap('.card .media{aspect-ratio:4/3}');
    expect(map.size).toBe(0);
  });
});

describe('dominantFeatureImageRatio', () => {
  const css = '.r32{aspect-ratio:3/2}.r219{aspect-ratio:21/9}.r11{aspect-ratio:1/1}';

  it('picks the ratio used most often on feature-image markup', () => {
    // Two cards at 3:2 and one hero at 21:9 — the reader meets 3:2 more often.
    const markup = `
      <div class="card-media r219"><img src="{{img_url feature_image}}"></div>
      <div class="card-media r32"><img src="{{img_url feature_image}}"></div>
      <div class="card-media r32"><img src="{{img_url feature_image}}"></div>
    `;
    expect(dominantFeatureImageRatio(markup, css)?.ratio).toBeCloseTo(1.5, 2);
  });

  it('ignores ratios on markup unrelated to images, such as avatars', () => {
    const markup = `
      <span class="avatar r11"></span>
      <span class="avatar r11"></span>
      <div class="card-media r32"><img src="{{img_url feature_image}}"></div>
    `;
    expect(dominantFeatureImageRatio(markup, css)?.ratio).toBeCloseTo(1.5, 2);
  });

  it('returns undefined when nothing is measurable', () => {
    expect(dominantFeatureImageRatio('<p>no images here</p>', css)).toBeUndefined();
  });
});

describe('inferWordCount', () => {
  it('treats a table of contents as the strongest long-form signal', () => {
    const withToc = inferWordCount({ hasTableOfContents: true });
    const without = inferWordCount({});
    expect(withToc.target).toBeGreaterThan(without.target);
  });

  it('produces a coherent min/target/max band', () => {
    const band = inferWordCount({ hasReadingTime: true });
    expect(band.min).toBeLessThan(band.target);
    expect(band.target).toBeLessThan(band.max);
  });

  it('caps the target for a narrow measure', () => {
    const narrow = inferWordCount({ hasTableOfContents: true, contentWidth: 'narrow' });
    expect(narrow.target).toBeLessThanOrEqual(900);
  });
});

describe('mergeSignals', () => {
  const high: ThemeSignalSet = {
    strategy: 'local',
    confidence: 0.9,
    evidence: ['read from disk'],
    capabilities: { supportsGallery: true, supportsFeatureImage: true },
  };
  const low: ThemeSignalSet = {
    strategy: 'rendered',
    confidence: 0.6,
    evidence: ['guessed from html'],
    capabilities: { supportsGallery: false, supportsVideoEmbed: true },
  };

  it('lets the higher-confidence strategy win a contested field', () => {
    const merged = mergeSignals('casper', [low, high]);
    expect(merged.capabilities.supportsGallery).toBe(true);
  });

  it('lets a lower-confidence strategy fill fields nobody else measured', () => {
    const merged = mergeSignals('casper', [high, low]);
    expect(merged.capabilities.supportsVideoEmbed).toBe(true);
  });

  it('reports zero confidence and safe defaults when nothing could be measured', () => {
    const merged = mergeSignals('casper', []);
    expect(merged.confidence).toBe(0);
    // Cards default off: an unstyled gallery looks broken, a missing one does not.
    expect(merged.capabilities.supportsGallery).toBe(false);
    expect(merged.capabilities.supportsFeatureImage).toBe(true);
  });

  it('records which strategies contributed, highest confidence first', () => {
    const merged = mergeSignals('casper', [low, high]);
    expect(merged.analyzedVia).toEqual(['local', 'rendered']);
  });

  it('attributes every evidence line to its strategy', () => {
    const merged = mergeSignals('casper', [high]);
    expect(merged.evidence[0]).toContain('[local]');
  });

  it('scores partial coverage below full coverage', () => {
    const sparse = mergeSignals('casper', [
      {
        strategy: 's',
        confidence: 0.9,
        evidence: [],
        capabilities: { supportsGallery: true },
      },
    ]);
    const rich = mergeSignals('casper', [high, low]);
    expect(sparse.confidence).toBeLessThan(rich.confidence);
  });
});
