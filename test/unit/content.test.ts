import { describe, expect, it } from 'vitest';

import type { ImageRef, ImageRequest, ThemeCapabilities } from '../../src/core/types.js';
import { profileTopic, TemplateContentEngine } from '../../src/content/engine.js';
import { generateSeedContent, slugify } from '../../src/content/generator.js';
import type { ImageSource } from '../../src/images/source.js';

/** An image source that always succeeds, so tests measure the generator only. */
class FakeImageSource implements ImageSource {
  readonly kind = 'stock' as const;
  requests: ImageRequest[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async unavailableReason(): Promise<string> {
    return '';
  }
  async fetch(request: ImageRequest, count: number): Promise<ImageRef[]> {
    this.requests.push(request);
    return Array.from({ length: count }, (_, i) => ({
      kind: 'url' as const,
      location: `https://img.test/${encodeURIComponent(request.query)}-${i}.jpg`,
      width: 1600,
      height: 1067,
    }));
  }
}

function capabilities(overrides: Partial<ThemeCapabilities> = {}): ThemeCapabilities {
  return {
    platform: 'ghost',
    themeName: 'test-theme',
    supportsFeatureImage: true,
    supportsGallery: true,
    supportsVideoEmbed: true,
    supportsBookmarkCard: false,
    supportsCodeBlocks: true,
    supportsWideImages: true,
    displaysTags: true,
    displaysAuthor: true,
    displaysAuthorImage: false,
    displaysExcerpt: true,
    displaysReadingTime: true,
    expectedWordCount: { min: 650, target: 1000, max: 1450 },
    confidence: 0.9,
    evidence: [],
    analyzedVia: ['test'],
    ...overrides,
  };
}

describe('profileTopic', () => {
  it('takes the first clause so conjunctions do not fuse two noun phrases', () => {
    // "urban cycling and city infrastructure" once produced "urban cycling city".
    expect(profileTopic('urban cycling and city infrastructure').subject).toBe(
      'urban cycling'
    );
    expect(profileTopic('coffee, tea and brewing').subject).toBe('coffee');
  });

  it('drops publication-shaped stopwords', () => {
    expect(profileTopic('a blog about SaaS productivity').subject).toBe(
      'SaaS productivity'
    );
  });

  it('preserves acronym casing', () => {
    expect(profileTopic('SaaS pricing').subject).toContain('SaaS');
  });

  it('never returns an empty subject', () => {
    expect(profileTopic('   ').subject.length).toBeGreaterThan(0);
  });
});

describe('TemplateContentEngine', () => {
  const engine = new TemplateContentEngine();

  it('returns exactly the requested number of distinct titles', async () => {
    const titles = await engine.generateTitles('SaaS productivity', 15, 1);
    expect(titles).toHaveLength(15);
    expect(new Set(titles).size).toBe(15);
  });

  it('capitalises titles that begin with the topic', async () => {
    const titles = await engine.generateTitles('urban cycling', 15, 7);
    for (const title of titles) {
      const first = title.charAt(0);
      if (/[a-zA-Z]/.test(first)) expect(first).toBe(first.toUpperCase());
    }
  });

  it('leaves a numeral-led title lower case after the number', async () => {
    const titles = await engine.generateTitles('urban cycling', 20, 3);
    const numeric = titles.filter((title) => /^\d/.test(title));
    for (const title of numeric) expect(title).toMatch(/^\d+\s[a-z]/);
  });

  it('reaches the requested word count', async () => {
    const blocks = await engine.generateBody({
      title: 'T',
      topic: 'SaaS productivity',
      targetWords: 1400,
      seed: 99,
    });
    const words = blocks
      .flatMap((block) =>
        block.type === 'paragraph' || block.type === 'heading' || block.type === 'quote'
          ? block.text
          : block.type === 'list'
            ? block.items.join(' ')
            : ''
      )
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(1400 * 0.9);
  });

  it('is deterministic for a given seed', async () => {
    const request = { title: 'T', topic: 'x', targetWords: 600, seed: 5 };
    expect(await engine.generateBody(request)).toEqual(
      await engine.generateBody(request)
    );
  });

  it('does not repeat a sentence twice in a row', async () => {
    const blocks = await engine.generateBody({
      title: 'T',
      topic: 'x',
      targetWords: 1400,
      seed: 11,
    });
    const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text);
    for (let i = 1; i < paragraphs.length; i++) {
      expect(paragraphs[i]).not.toBe(paragraphs[i - 1]);
    }
  });

  it('starts the body with a paragraph, not a heading', async () => {
    const blocks = await engine.generateBody({
      title: 'T',
      topic: 'x',
      targetWords: 400,
      seed: 1,
    });
    expect(blocks[0]?.type).toBe('paragraph');
  });
});

describe('generateSeedContent', () => {
  it('creates the requested count with feature images and tags', async () => {
    const { posts, stats } = await generateSeedContent({
      topic: 'SaaS productivity',
      count: 6,
      capabilities: capabilities(),
      imageSource: new FakeImageSource(),
      videoFinder: null,
      seed: 3,
    });

    expect(posts).toHaveLength(6);
    expect(stats.withFeatureImage).toBe(6);
    for (const post of posts) {
      expect(post.featureImage).toBeDefined();
      expect(post.tags.length).toBeGreaterThan(0);
      expect(post.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('omits galleries when the theme has no gallery styles', async () => {
    const { posts, stats } = await generateSeedContent({
      topic: 'x',
      count: 6,
      capabilities: capabilities({ supportsGallery: false }),
      imageSource: new FakeImageSource(),
      videoFinder: null,
      seed: 3,
    });

    expect(stats.withGallery).toBe(0);
    expect(stats.skipped.gallery).toBeTruthy();
    expect(posts.flatMap((p) => p.blocks).some((b) => b.type === 'gallery')).toBe(false);
  });

  it('omits video embeds when the theme has no embed styles', async () => {
    const { posts, stats } = await generateSeedContent({
      topic: 'x',
      count: 6,
      capabilities: capabilities({ supportsVideoEmbed: false }),
      imageSource: new FakeImageSource(),
      seed: 3,
    });

    expect(stats.withVideo).toBe(0);
    expect(posts.flatMap((p) => p.blocks).some((b) => b.type === 'video')).toBe(false);
  });

  it('omits feature images when the theme does not display them', async () => {
    const { posts, stats } = await generateSeedContent({
      topic: 'x',
      count: 3,
      capabilities: capabilities({ supportsFeatureImage: false }),
      imageSource: new FakeImageSource(),
      videoFinder: null,
      seed: 3,
    });
    expect(stats.withFeatureImage).toBe(0);
    expect(posts.every((post) => post.featureImage === undefined)).toBe(true);
  });

  it('requests feature images at the theme aspect ratio', async () => {
    const source = new FakeImageSource();
    await generateSeedContent({
      topic: 'x',
      count: 2,
      capabilities: capabilities({ featureImageAspectRatio: 2.33 }),
      imageSource: source,
      videoFinder: null,
      seed: 3,
    });
    const feature = source.requests.filter((request) => request.role === 'feature');
    expect(feature.length).toBeGreaterThan(0);
    for (const request of feature) expect(request.aspectRatio).toBe(2.33);
  });

  it('uses caller-supplied titles verbatim', async () => {
    const titles = ['My own headline', 'Another one'];
    const { posts } = await generateSeedContent({
      topic: 'x',
      count: 2,
      capabilities: capabilities(),
      imageSource: new FakeImageSource(),
      videoFinder: null,
      titles,
    });
    expect(posts.map((post) => post.title)).toEqual(titles);
  });

  it('never dates a post in the future, which Ghost would schedule instead', async () => {
    const { posts } = await generateSeedContent({
      topic: 'x',
      count: 8,
      capabilities: capabilities(),
      imageSource: new FakeImageSource(),
      videoFinder: null,
      seed: 3,
    });
    const now = Date.now();
    for (const post of posts) {
      expect(new Date(post.publishedAt!).getTime()).toBeLessThanOrEqual(now);
    }
  });

  it('keeps working when the image source throws', async () => {
    const broken: ImageSource = {
      kind: 'stock',
      isAvailable: async () => true,
      unavailableReason: async () => '',
      fetch: async () => {
        throw new Error('network down');
      },
    };
    const { posts, stats } = await generateSeedContent({
      topic: 'x',
      count: 3,
      capabilities: capabilities(),
      imageSource: broken,
      videoFinder: null,
      seed: 3,
    });
    // Images are an enhancement; losing them must not lose the posts.
    expect(posts).toHaveLength(3);
    expect(stats.withFeatureImage).toBe(0);
  });
});

describe('slugify', () => {
  it.each([
    ['Hello, World!', 'hello-world'],
    ['  spaced   out  ', 'spaced-out'],
    ['6 mistakes that derail X', '6-mistakes-that-derail-x'],
  ])('%s -> %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('post');
  });
});
