import { describe, expect, it } from 'vitest';

import type { ContentBlock, ImageRef } from '../../src/core/types.js';
import {
  blocksToLexical,
  extractVimeoId,
  extractYouTubeId,
  videoIframe,
  type HostedImage,
  type ImageResolver,
} from '../../src/providers/ghost/lexical.js';

const hosted: HostedImage = {
  url: 'https://cdn.example.com/a.jpg',
  width: 1600,
  height: 1067,
  fileName: 'a.jpg',
};

const ref = (location: string): ImageRef => ({ kind: 'url', location });
const resolveAll: ImageResolver = () => hosted;
/** Stands in for an image that failed to download or upload. */
const resolveNone: ImageResolver = () => undefined;

function parse(blocks: ContentBlock[], resolve = resolveAll) {
  return JSON.parse(blocksToLexical(blocks, resolve)) as {
    root: { children: Array<Record<string, unknown>> };
  };
}

describe('blocksToLexical', () => {
  it('never produces an empty root, which Ghost rejects', () => {
    const { root } = parse([]);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it('maps headings to Ghost extended-heading nodes with the right tag', () => {
    const { root } = parse([{ type: 'heading', level: 3, text: 'Section' }]);
    expect(root.children[0]).toMatchObject({ type: 'extended-heading', tag: 'h3' });
  });

  it('uses "alt" rather than "altText" on image cards', () => {
    // Ghost accepts altText and then renders alt="", which silently ships
    // inaccessible images. Verified against a live Ghost 6 instance.
    const { root } = parse([{ type: 'image', image: ref('a'), alt: 'a cat' }]);
    expect(root.children[0]).toMatchObject({ type: 'image', alt: 'a cat' });
    expect(root.children[0]).not.toHaveProperty('altText');
  });

  it('drops image blocks whose image could not be hosted', () => {
    const { root } = parse(
      [
        { type: 'paragraph', text: 'kept' },
        { type: 'image', image: ref('a') },
      ],
      resolveNone
    );
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ type: 'paragraph' });
  });

  it('assigns gallery rows three images at a time', () => {
    const images = Array.from({ length: 4 }, (_, i) => ref(`img-${i}`));
    const { root } = parse([{ type: 'gallery', images }]);
    const gallery = root.children[0] as { images: Array<{ row: number }> };
    expect(gallery.images.map((image) => image.row)).toEqual([0, 0, 0, 1]);
  });

  it('degrades a one-image gallery to an image card', () => {
    // Ghost's gallery grid is built for several images; one renders lopsided.
    const { root } = parse([{ type: 'gallery', images: [ref('only')], caption: 'c' }]);
    expect(root.children[0]).toMatchObject({ type: 'image', caption: 'c' });
  });

  it('drops a gallery entirely when no image resolved', () => {
    const { root } = parse(
      [{ type: 'gallery', images: [ref('a'), ref('b')] }],
      resolveNone
    );
    expect(root.children.filter((child) => child['type'] === 'gallery')).toHaveLength(0);
  });

  it('emits quote attribution as a following paragraph', () => {
    // Ghost's quote card has no attribution field of its own.
    const { root } = parse([{ type: 'quote', text: 'q', attribution: 'Ada' }]);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ type: 'quote' });
    expect(JSON.stringify(root.children[1])).toContain('Ada');
  });

  it('maps ordered and unordered lists to the tags Ghost expects', () => {
    const { root: ordered } = parse([{ type: 'list', ordered: true, items: ['a'] }]);
    expect(ordered.children[0]).toMatchObject({ listType: 'number', tag: 'ol' });

    const { root: bullet } = parse([{ type: 'list', ordered: false, items: ['a'] }]);
    expect(bullet.children[0]).toMatchObject({ listType: 'bullet', tag: 'ul' });
  });

  it('builds a real embed card for a video block', () => {
    const { root } = parse([
      {
        type: 'video',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        provider: 'youtube',
        title: 'Test',
      },
    ]);
    const card = root.children[0] as { type: string; embedType: string; html: string };
    expect(card.type).toBe('embed');
    expect(card.embedType).toBe('video');
    // Ghost renders the stored html verbatim, so it must be a working iframe.
    expect(card.html).toContain('youtube.com/embed/dQw4w9WgXcQ');
  });

  it('escapes video titles so a quote cannot break out of the iframe attribute', () => {
    const html = videoIframe('https://youtu.be/dQw4w9WgXcQ', 'a "quoted" <title>');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).not.toContain('<title>');
  });
});

describe('video id extraction', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts %s', (url, expected) => {
    expect(extractYouTubeId(url)).toBe(expected);
  });

  it('returns null for a non-YouTube url', () => {
    expect(extractYouTubeId('https://example.com/video')).toBeNull();
  });

  it('extracts vimeo ids', () => {
    expect(extractVimeoId('https://vimeo.com/123456789')).toBe('123456789');
  });
});
