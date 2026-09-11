import { describe, expect, it } from 'vitest';

import { generateSeedContent } from '../../src/content/generator.js';
import { genericCapabilities } from '../../src/core/theme-defaults.js';
import { NoneImageSource } from '../../src/images/none-source.js';

const base = () => ({
  topic: 'independent design journal',
  count: 2,
  capabilities: genericCapabilities('ghost'),
  imageSource: new NoneImageSource(),
  videoFinder: null,
  seed: 7,
});

describe('generateSeedContent — the existing shape', () => {
  it('still returns posts under the same key, so library callers keep working', async () => {
    const summary = await generateSeedContent(base());
    expect(summary.posts).toHaveLength(2);
    expect(summary.stats).toBeTypeOf('object');
  });
});

describe('generateSeedContent — pages', () => {
  it('returns no pages when none were asked for', async () => {
    const summary = await generateSeedContent(base());
    expect(summary.pages ?? []).toHaveLength(0);
  });

  it('writes a real body for a page that needs one', async () => {
    // The hand-built `people` export shipped privacy-policy and terms-of-use
    // with zero words, so the customer imported blank pages.
    const summary = await generateSeedContent({
      ...base(),
      pages: [{ slug: 'privacy-policy', title: 'Privacy Policy' }],
    });
    const [page] = summary.pages!;
    expect(page!.slug).toBe('privacy-policy');
    expect(page!.blocks.length).toBeGreaterThan(0);
  });

  it('leaves the body empty when the theme renders that page from a template', async () => {
    const summary = await generateSeedContent({
      ...base(),
      pages: [{ slug: 'authors', title: 'Authors', needsBody: false }],
    });
    expect(summary.pages![0]!.blocks).toHaveLength(0);
  });

  it('passes a supplied body through untouched', async () => {
    const html = '<figure class="kg-card kg-image-card"><img src="x.png"></figure>';
    const summary = await generateSeedContent({
      ...base(),
      pages: [{ slug: 'style-guide', title: 'Style guide', suppliedBody: html }],
    });
    expect(summary.pages![0]!.suppliedBody).toBe(html);
    expect(summary.pages![0]!.blocks).toHaveLength(0);
  });

  it('derives a title from the slug when none was given', async () => {
    const summary = await generateSeedContent({ ...base(), pages: [{ slug: 'terms-of-use' }] });
    expect(summary.pages![0]!.title).toBe('Terms Of Use');
  });
});

describe('generateSeedContent — tag and author entities', () => {
  it('returns a tag entity for every tag its posts reference', async () => {
    const summary = await generateSeedContent(base());
    const referenced = new Set(summary.posts.flatMap((p) => p.tags));
    expect(new Set(summary.tags!.map((t) => t.name))).toEqual(referenced);
  });

  it('gives each tag a description, which the tag archive renders', async () => {
    // Every tag in the `people` export had description: null.
    const summary = await generateSeedContent(base());
    for (const tag of summary.tags!) {
      expect(tag.description).toBeTruthy();
    }
  });

  it('returns an author entity with a bio when an author was named', async () => {
    const summary = await generateSeedContent({ ...base(), authorName: 'Maya Iyer' });
    const [author] = summary.authors!;
    expect(author).toMatchObject({ name: 'Maya Iyer', slug: 'maya-iyer' });
    expect(author!.bio).toBeTruthy();
  });

  it('returns no authors when no author was named', async () => {
    const summary = await generateSeedContent(base());
    expect(summary.authors ?? []).toHaveLength(0);
  });
});
