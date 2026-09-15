/**
 * Converts the platform-neutral block model into WordPress's serialized
 * Gutenberg block grammar — the `<!-- wp:name {attrs} -->` comment-delimited
 * HTML that lands in `post_content`.
 *
 * This file is the WordPress-specific half of rule 2 in the architecture: the
 * generator never produces Gutenberg markup, and nothing outside this
 * directory ever sees it. It is the `gutenberg.ts` that ghost/lexical.ts's own
 * docblock predicted.
 *
 * Two things matter about the output:
 *
 * - The HTML inside each block must be exactly what the block's `save()`
 *   would produce, or the editor flags the block as invalid the first time
 *   someone opens the imported post. Class names like `wp-block-heading` and
 *   `wp-element-caption` are part of that contract, not decoration.
 * - Attribute JSON omits every value that equals the block's default (a level
 *   2 heading carries no `"level"`), because that is how WordPress itself
 *   serializes and diff-noise against real exports helps nobody.
 *
 * Pure: no network, no filesystem. Images must already have a public URL —
 * callers pass a resolver that maps a neutral `ImageRef` to one. A WXR cannot
 * carry bytes, so unlike Ghost there is no archive path to point at: the URL
 * is remote, and the WordPress importer downloads and re-hosts it at import
 * time (see export.ts for how attachments make that happen).
 */

import type { ContentBlock, ImageRef } from '../../core/types.js';

/** An image the WXR can reference: a public URL, plus what we know about it. */
export interface WxrImage {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
}

export type WxrImageResolver = (ref: ImageRef) => WxrImage | undefined;

/** Resolves nothing: every image block is dropped, the prose still renders. */
export const resolveNoImages: WxrImageResolver = () => undefined;

export function blocksToGutenberg(blocks: ContentBlock[], resolve: WxrImageResolver): string {
  const rendered: string[] = [];

  for (const block of blocks) {
    const html = blockToHtml(block, resolve);
    if (html) rendered.push(html);
  }

  // A post with no body imports fine but previews nothing; an empty paragraph
  // at least gives the editor a caret. Mirrors lexical.ts's empty-root guard.
  if (rendered.length === 0) rendered.push(paragraph(''));

  return rendered.join('\n\n');
}

function blockToHtml(block: ContentBlock, resolve: WxrImageResolver): string | null {
  switch (block.type) {
    case 'paragraph':
      return paragraph(block.text);

    case 'heading': {
      const attrs = block.level === 2 ? '' : ` ${JSON.stringify({ level: block.level })}`;
      const tag = `h${block.level}`;
      return `<!-- wp:heading${attrs} -->\n<${tag} class="wp-block-heading">${escapeHtml(block.text)}</${tag}>\n<!-- /wp:heading -->`;
    }

    case 'image': {
      const hosted = resolve(block.image);
      // No URL, no block: an <img> with an empty src renders as a broken
      // rectangle, which is worse than the missing picture.
      if (!hosted) return null;
      return imageBlock(hosted, block.alt ?? block.image.alt, block.caption);
    }

    case 'gallery': {
      const hosted: Array<{ resolved: WxrImage; alt?: string }> = [];
      for (const image of block.images) {
        const resolved = resolve(image);
        if (resolved) {
          hosted.push({ resolved, ...(image.alt !== undefined ? { alt: image.alt } : {}) });
        }
      }
      // WordPress lays a gallery out as a grid; below two images that grid is
      // a lopsided single picture. Same floor the generator itself applies.
      if (hosted.length < 2) return null;
      const inner = hosted
        .map((entry) => imageBlock(entry.resolved, entry.alt, undefined))
        .join('\n\n');
      const caption = block.caption
        ? `<figcaption class="blocks-gallery-caption wp-element-caption">${escapeHtml(block.caption)}</figcaption>`
        : '';
      return `<!-- wp:gallery {"linkTo":"none"} -->\n<figure class="wp-block-gallery has-nested-images columns-default is-cropped">${inner}${caption}</figure>\n<!-- /wp:gallery -->`;
    }

    case 'video': {
      // The core embed block: WordPress resolves the oEmbed server-side on
      // render, so the serialized form is just the URL in a wrapper. The
      // aspect-ratio classes are what the editor adds for a video embed, and
      // leaving them out makes the block "invalid" on first open.
      const attrs = JSON.stringify({
        url: block.url,
        type: 'video',
        providerNameSlug: block.provider,
        responsive: true,
        className: 'wp-embed-aspect-16-9 wp-has-aspect-ratio',
      });
      return `<!-- wp:embed ${attrs} -->\n<figure class="wp-block-embed is-type-video is-provider-${block.provider} wp-block-embed-${block.provider} wp-embed-aspect-16-9 wp-has-aspect-ratio"><div class="wp-block-embed__wrapper">\n${escapeHtml(block.url)}\n</div></figure>\n<!-- /wp:embed -->`;
    }

    case 'quote': {
      const cite = block.attribution ? `<cite>${escapeHtml(block.attribution)}</cite>` : '';
      return `<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>${escapeHtml(block.text)}</p>\n<!-- /wp:paragraph -->${cite}</blockquote>\n<!-- /wp:quote -->`;
    }

    case 'list': {
      const attrs = block.ordered ? ' {"ordered":true}' : '';
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items
        .map(
          (item) =>
            `<!-- wp:list-item -->\n<li>${escapeHtml(item)}</li>\n<!-- /wp:list-item -->`
        )
        .join('\n\n');
      return `<!-- wp:list${attrs} -->\n<${tag} class="wp-block-list">${items}</${tag}>\n<!-- /wp:list -->`;
    }

    case 'code':
      // The language is not part of core/code's attributes; it rides along as
      // a class the way the editor's own "add class" does, so a syntax
      // highlighter can pick it up without the block becoming invalid.
      return `<!-- wp:code -->\n<pre class="wp-block-code"><code>${escapeHtml(block.code)}</code></pre>\n<!-- /wp:code -->`;

    case 'divider':
      return `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;

    default:
      return null;
  }
}

function paragraph(text: string): string {
  return `<!-- wp:paragraph -->\n<p>${escapeHtml(text)}</p>\n<!-- /wp:paragraph -->`;
}

function imageBlock(hosted: WxrImage, alt: string | undefined, caption?: string): string {
  const captionHtml = caption
    ? `<figcaption class="wp-element-caption">${escapeHtml(caption)}</figcaption>`
    : '';
  return `<!-- wp:image {"sizeSlug":"large","linkDestination":"none"} -->\n<figure class="wp-block-image size-large"><img src="${escapeAttr(hosted.url)}" alt="${escapeAttr(alt ?? hosted.alt ?? '')}"/>${captionHtml}</figure>\n<!-- /wp:image -->`;
}

/** &, < and > in text nodes. Quotes are fine outside attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Attribute values additionally need their quotes neutralised. */
function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
