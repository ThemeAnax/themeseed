import { describe, expect, it } from 'vitest';

import { RenderedThemeSource } from '../../src/providers/ghost/theme/rendered-theme-source.js';

/**
 * Ghost's own fallback when a post carries no feature image of its own. Reading
 * this as the post's hero is what made theme analysis self-poisoning.
 */
const PUBLICATION_COVER = 'https://static.ghost.org/v5.0.0/images/publication-cover.jpg';

interface PageOptions {
  ogImage?: string;
  bodyImage?: string;
}

function page({ ogImage, bodyImage }: PageOptions = {}): string {
  return [
    '<html><head>',
    ogImage ? `<meta property="og:image" content="${ogImage}">` : '',
    '</head><body>',
    bodyImage ? `<img src="${bodyImage}">` : '',
    '<article><h1>A post</h1><p>Words.</p></article>',
    '</body></html>',
  ].join('');
}

/** Serves a home page and one post page, with no network involved. */
function fetchStub(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = pages[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  }) as unknown as typeof fetch;
}

const SITE = 'https://blog.example.com';
const POST = `${SITE}/a-post/`;

describe('RenderedThemeSource feature-image detection', () => {
  it('does not conclude the theme hides heroes from a post that has none', async () => {
    // The regression. A site seeded with image-less posts served exactly this:
    // og:image present (the publication cover), no matching image in the body.
    // The old reading — "has a hero, refuses to show it" — turned every such
    // post into proof the theme could not display feature images at all, which
    // then suppressed feature images on every later seed run.
    const source = new RenderedThemeSource({
      siteUrl: SITE,
      themeName: 'bastian',
      samplePostUrl: POST,
      fetchImpl: fetchStub({
        [SITE]: page({ ogImage: PUBLICATION_COVER }),
        [POST]: page({ ogImage: PUBLICATION_COVER }),
      }),
    });

    const result = await source.analyze();

    expect(result?.capabilities.supportsFeatureImage).toBeUndefined();
    expect(result?.evidence.join(' ')).toContain('could not be measured');
  });

  it('treats an og:image identical to the home page as the site cover', async () => {
    const selfHostedCover = `${SITE}/content/images/cover.jpg`;
    const source = new RenderedThemeSource({
      siteUrl: SITE,
      themeName: 'bastian',
      samplePostUrl: POST,
      fetchImpl: fetchStub({
        [SITE]: page({ ogImage: selfHostedCover }),
        [POST]: page({ ogImage: selfHostedCover }),
      }),
    });

    const result = await source.analyze();

    expect(result?.capabilities.supportsFeatureImage).toBeUndefined();
  });

  it('confirms hero support when the post image is rendered in the body', async () => {
    const hero = `${SITE}/content/images/2026/09/hero-shot.jpg`;
    const source = new RenderedThemeSource({
      siteUrl: SITE,
      themeName: 'casper',
      samplePostUrl: POST,
      sampleHasFeatureImage: true,
      fetchImpl: fetchStub({
        [SITE]: page({ ogImage: `${SITE}/content/images/cover.jpg` }),
        [POST]: page({ ogImage: hero, bodyImage: hero }),
      }),
    });

    const result = await source.analyze();

    expect(result?.capabilities.supportsFeatureImage).toBe(true);
  });

  it('reports a genuine hero-less theme when the post demonstrably has one', async () => {
    // The reading the old code was reaching for, now only made when the caller
    // has confirmed the sampled post actually carries a feature image.
    const hero = `${SITE}/content/images/2026/09/hero-shot.jpg`;
    const source = new RenderedThemeSource({
      siteUrl: SITE,
      themeName: 'minimal',
      samplePostUrl: POST,
      sampleHasFeatureImage: true,
      fetchImpl: fetchStub({
        [SITE]: page(),
        [POST]: page({ ogImage: hero }),
      }),
    });

    const result = await source.analyze();

    expect(result?.capabilities.supportsFeatureImage).toBe(false);
  });
});
