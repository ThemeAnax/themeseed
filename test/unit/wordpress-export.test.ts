import { describe, expect, it } from 'vitest';

import {
  blocksToGutenberg,
  resolveNoImages,
  type WxrImageResolver,
} from '../../src/providers/wordpress/gutenberg.js';
import { buildWordPressWxr } from '../../src/providers/wordpress/export.js';
import type { ContentBlock, ImageRef, SeedBundle } from '../../src/core/types.js';

const urlRef = (location: string, alt?: string): ImageRef => ({
  kind: 'url',
  location,
  ...(alt ? { alt } : {}),
});

const resolveByLocation: WxrImageResolver = (ref) =>
  ref.kind === 'url' ? { url: ref.location } : undefined;

const NOW = new Date('2026-09-15T10:00:00.000Z');

function bundle(overrides: Partial<SeedBundle> = {}): SeedBundle {
  return {
    posts: [
      {
        title: 'First post',
        slug: 'first-post',
        excerpt: 'The excerpt.',
        blocks: [{ type: 'paragraph', text: 'Hello.' }],
        tags: ['Design'],
        status: 'published',
        publishedAt: '2026-09-01T08:00:00.000Z',
        authorName: 'Priya Nair',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gutenberg serialization
// ---------------------------------------------------------------------------

describe('blocksToGutenberg', () => {
  it('serializes prose in the comment-delimited grammar the editor expects', () => {
    const blocks: ContentBlock[] = [
      { type: 'heading', level: 2, text: 'Section' },
      { type: 'paragraph', text: 'Body text.' },
    ];
    const html = blocksToGutenberg(blocks, resolveNoImages);
    // Level 2 is the default and must not be serialized as an attribute.
    expect(html).toContain('<!-- wp:heading -->');
    expect(html).toContain('<h2 class="wp-block-heading">Section</h2>');
    expect(html).toContain('<!-- wp:paragraph -->\n<p>Body text.</p>\n<!-- /wp:paragraph -->');
  });

  it('carries non-default heading levels as attributes', () => {
    const html = blocksToGutenberg(
      [{ type: 'heading', level: 3, text: 'Sub' }],
      resolveNoImages
    );
    expect(html).toContain('<!-- wp:heading {"level":3} -->');
    expect(html).toContain('<h3 class="wp-block-heading">Sub</h3>');
  });

  it('escapes text so markup in prose cannot break the block HTML', () => {
    const html = blocksToGutenberg(
      [{ type: 'paragraph', text: 'a < b & "c"' }],
      resolveNoImages
    );
    expect(html).toContain('<p>a &lt; b &amp; "c"</p>');
  });

  it('drops an image block whose ref cannot be resolved to a URL', () => {
    const html = blocksToGutenberg(
      [
        { type: 'paragraph', text: 'Kept.' },
        { type: 'image', image: { kind: 'file', location: '/tmp/x.jpg' } },
      ],
      resolveNoImages
    );
    expect(html).toContain('Kept.');
    expect(html).not.toContain('wp:image');
  });

  it('renders a resolved image with its caption in the save() shape', () => {
    const html = blocksToGutenberg(
      [
        {
          type: 'image',
          image: urlRef('https://pics.example.com/a.jpg', 'A machine'),
          caption: 'Photo by X',
        },
      ],
      resolveByLocation
    );
    expect(html).toContain('<!-- wp:image {"sizeSlug":"large","linkDestination":"none"} -->');
    expect(html).toContain('src="https://pics.example.com/a.jpg"');
    expect(html).toContain('alt="A machine"');
    expect(html).toContain('<figcaption class="wp-element-caption">Photo by X</figcaption>');
  });

  it('refuses a gallery that resolved below two images', () => {
    const html = blocksToGutenberg(
      [
        {
          type: 'gallery',
          images: [urlRef('https://pics.example.com/only.jpg')],
        },
      ],
      resolveByLocation
    );
    expect(html).not.toContain('wp:gallery');
  });

  it('nests gallery images the way core/gallery saves them', () => {
    const html = blocksToGutenberg(
      [
        {
          type: 'gallery',
          images: [
            urlRef('https://pics.example.com/1.jpg'),
            urlRef('https://pics.example.com/2.jpg'),
          ],
        },
      ],
      resolveByLocation
    );
    expect(html).toContain('<!-- wp:gallery {"linkTo":"none"} -->');
    expect(html).toContain('wp-block-gallery has-nested-images');
    expect(html.match(/<!-- wp:image /g)).toHaveLength(2);
  });

  it('serializes a video as a core embed with the aspect-ratio classes', () => {
    const html = blocksToGutenberg(
      [{ type: 'video', url: 'https://www.youtube.com/watch?v=abc', provider: 'youtube' }],
      resolveNoImages
    );
    expect(html).toContain('"providerNameSlug":"youtube"');
    expect(html).toContain('is-provider-youtube wp-block-embed-youtube');
    expect(html).toContain('wp-embed-aspect-16-9 wp-has-aspect-ratio');
  });

  it('serializes lists, quotes, code and dividers', () => {
    const html = blocksToGutenberg(
      [
        { type: 'list', ordered: true, items: ['One', 'Two'] },
        { type: 'quote', text: 'Said.', attribution: 'Who' },
        { type: 'code', code: 'if (a < b) {}' },
        { type: 'divider' },
      ],
      resolveNoImages
    );
    expect(html).toContain('<!-- wp:list {"ordered":true} -->');
    expect(html).toContain('<ol class="wp-block-list">');
    expect(html.match(/<!-- wp:list-item -->/g)).toHaveLength(2);
    expect(html).toContain('<blockquote class="wp-block-quote">');
    expect(html).toContain('<cite>Who</cite>');
    expect(html).toContain('<code>if (a &lt; b) {}</code>');
    expect(html).toContain('<hr class="wp-block-separator has-alpha-channel-opacity"/>');
  });

  it('never emits an empty body', () => {
    expect(blocksToGutenberg([], resolveNoImages)).toContain('<!-- wp:paragraph -->');
  });
});

// ---------------------------------------------------------------------------
// The WXR document
// ---------------------------------------------------------------------------

describe('buildWordPressWxr', () => {
  it('declares WXR 1.2 and carries the post as an item', () => {
    const doc = buildWordPressWxr(bundle(), { now: NOW });
    expect(doc.xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    expect(doc.xml).toContain('<title><![CDATA[First post]]></title>');
    expect(doc.xml).toContain('<wp:post_name><![CDATA[first-post]]></wp:post_name>');
    expect(doc.xml).toContain('<wp:status><![CDATA[publish]]></wp:status>');
    expect(doc.xml).toContain('<wp:post_date><![CDATA[2026-09-01 08:00:00]]></wp:post_date>');
  });

  it('registers the crediting author and the referenced tag', () => {
    const doc = buildWordPressWxr(bundle(), { now: NOW });
    expect(doc.xml).toContain('<wp:author_login><![CDATA[priya-nair]]></wp:author_login>');
    expect(doc.xml).toContain('<dc:creator><![CDATA[priya-nair]]></dc:creator>');
    expect(doc.xml).toContain(
      '<category domain="post_tag" nicename="design"><![CDATA[Design]]></category>'
    );
    expect(doc.xml).toContain('<wp:tag_slug><![CDATA[design]]></wp:tag_slug>');
  });

  it('turns a URL feature image into an attachment wired via _thumbnail_id', () => {
    const doc = buildWordPressWxr(
      bundle({
        posts: [
          {
            ...bundle().posts[0]!,
            featureImage: urlRef('https://pics.example.com/hero.jpg', 'Hero'),
          },
        ],
      }),
      { now: NOW }
    );
    expect(doc.attachments).toHaveLength(1);
    const id = doc.attachments[0]!.id;
    expect(doc.xml).toContain(
      `<wp:attachment_url><![CDATA[https://pics.example.com/hero.jpg]]></wp:attachment_url>`
    );
    expect(doc.xml).toContain('<wp:status><![CDATA[inherit]]></wp:status>');
    expect(doc.xml).toContain(
      `<wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[${id}]]></wp:meta_value>`
    );
  });

  it('reports a file-backed image as failed with the fix, rather than dropping it silently', () => {
    const doc = buildWordPressWxr(
      bundle({
        posts: [
          {
            ...bundle().posts[0]!,
            featureImage: { kind: 'file', location: '/tmp/hero.png' },
          },
        ],
      }),
      { now: NOW }
    );
    expect(doc.attachments).toHaveLength(0);
    expect(doc.failed).toHaveLength(1);
    expect(doc.failed[0]!.error).toMatch(/cannot carry local image files/i);
    expect(doc.xml).not.toContain('_thumbnail_id');
  });

  it('registers one attachment for an image used twice', () => {
    const image = urlRef('https://pics.example.com/shared.jpg');
    const doc = buildWordPressWxr(
      bundle({
        posts: [
          { ...bundle().posts[0]!, featureImage: image },
          {
            title: 'Second post',
            slug: 'second-post',
            blocks: [{ type: 'image', image }],
            tags: [],
            status: 'published',
          },
        ],
      }),
      { now: NOW }
    );
    expect(doc.attachments).toHaveLength(1);
  });

  it('uses a supplied page body verbatim and leaves a template-rendered page empty', () => {
    const doc = buildWordPressWxr(
      bundle({
        pages: [
          {
            title: 'Style guide',
            slug: 'style-guide',
            blocks: [],
            status: 'published',
            suppliedBody: '<!-- wp:paragraph -->\n<p>FINAL</p>\n<!-- /wp:paragraph -->',
          },
          {
            title: 'Authors',
            slug: 'authors',
            blocks: [{ type: 'paragraph', text: 'never shown' }],
            status: 'published',
            needsBody: false,
          },
        ],
      }),
      { now: NOW }
    );
    expect(doc.xml).toContain('<p>FINAL</p>');
    expect(doc.xml).not.toContain('never shown');
  });

  it('marks everything it creates with the hidden _themeseed meta', () => {
    const doc = buildWordPressWxr(bundle(), { now: NOW });
    expect(doc.xml).toContain('<wp:meta_key><![CDATA[_themeseed]]></wp:meta_key>');
  });

  it('maps draft status onto draft, not publish', () => {
    const doc = buildWordPressWxr(
      bundle({ posts: [{ ...bundle().posts[0]!, status: 'draft' }] }),
      { now: NOW }
    );
    expect(doc.xml).toContain('<wp:status><![CDATA[draft]]></wp:status>');
  });

  it('survives a literal ]]> inside a supplied body', () => {
    // Generated prose is HTML-escaped long before it reaches the CDATA writer,
    // but a suppliedBody arrives verbatim — that is the path that can carry a
    // raw ]]> and truncate the section if it is not split.
    const doc = buildWordPressWxr(
      bundle({
        pages: [
          {
            title: 'Snippets',
            slug: 'snippets',
            blocks: [],
            status: 'published',
            suppliedBody: '<!-- wp:code -->\n<pre class="wp-block-code"><code>x = "]]>"</code></pre>\n<!-- /wp:code -->',
          },
        ],
      }),
      { now: NOW }
    );
    expect(doc.xml).toContain(']]]]><![CDATA[>');
  });
});
