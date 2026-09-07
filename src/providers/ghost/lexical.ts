/**
 * Converts the platform-neutral block model into Ghost's Lexical editor state.
 *
 * This file is the Ghost-specific half of rule 2 in the architecture: the
 * generator never produces Lexical, and nothing outside this directory ever
 * sees it. A WordPress provider would have a `gutenberg.ts` in exactly this
 * shape and the generator would not change by a line.
 *
 * Every node shape here was verified by round-tripping a post through a real
 * Ghost 6 instance and reading back the rendered HTML — notably `alt` (not
 * `altText`, which Ghost accepts and then silently renders as `alt=""`).
 *
 * Pure: no network, no filesystem. Images must already be hosted; callers pass
 * a resolver that maps a neutral `ImageRef` to its uploaded URL.
 */

import type { ContentBlock, ImageRef } from '../../core/types.js';
import type { LexicalNode, LexicalRoot, LexicalTextNode } from './types.js';

/** An image after it has been uploaded to Ghost. */
export interface HostedImage {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  fileName?: string;
}

export type ImageResolver = (ref: ImageRef) => HostedImage | undefined;

/** Ghost lays galleries out three per row; the `row` index drives that. */
const GALLERY_IMAGES_PER_ROW = 3;

export function blocksToLexical(blocks: ContentBlock[], resolve: ImageResolver): string {
  const children: LexicalNode[] = [];

  for (const block of blocks) {
    const node = blockToNode(block, resolve);
    if (Array.isArray(node)) children.push(...node);
    else if (node) children.push(node);
  }

  // Ghost's editor is unhappy with a completely empty root, and a post with no
  // body is not useful demo content anyway.
  if (children.length === 0) children.push(paragraph(''));

  const root: LexicalRoot = {
    root: {
      type: 'root',
      version: 1,
      children,
      direction: 'ltr',
      format: '',
      indent: 0,
    },
  };
  return JSON.stringify(root);
}

function blockToNode(
  block: ContentBlock,
  resolve: ImageResolver
): LexicalNode | LexicalNode[] | null {
  switch (block.type) {
    case 'paragraph':
      return paragraph(block.text);

    case 'heading':
      return {
        type: 'extended-heading',
        version: 1,
        tag: `h${block.level}` as 'h2' | 'h3' | 'h4',
        children: [textNode(block.text)],
        direction: 'ltr',
        format: '',
        indent: 0,
      };

    case 'image': {
      const hosted = resolve(block.image);
      // An image we could not host would render as a broken <img>. Dropping the
      // block leaves the post shorter but intact, which is the better failure.
      if (!hosted) return null;
      return {
        type: 'image',
        version: 1,
        src: hosted.url,
        width: hosted.width ?? null,
        height: hosted.height ?? null,
        title: '',
        alt: block.alt ?? hosted.alt ?? '',
        caption: block.caption ?? hosted.caption ?? '',
        cardWidth: 'regular',
        href: '',
      };
    }

    case 'gallery': {
      const images = block.images
        .map((ref, index) => {
          const hosted = resolve(ref);
          if (!hosted) return null;
          return {
            fileName: hosted.fileName ?? fileNameFor(hosted.url, index),
            row: Math.floor(index / GALLERY_IMAGES_PER_ROW),
            width: hosted.width ?? 1200,
            height: hosted.height ?? 800,
            src: hosted.url,
            alt: ref.alt ?? hosted.alt ?? '',
          };
        })
        .filter((image): image is NonNullable<typeof image> => image !== null);

      // A "gallery" of one is just an image, and Ghost renders it in a grid
      // meant for several — so fall back rather than ship something that looks
      // like a layout bug.
      if (images.length === 0) return null;
      if (images.length === 1) {
        const only = images[0]!;
        return {
          type: 'image',
          version: 1,
          src: only.src,
          width: only.width,
          height: only.height,
          title: '',
          alt: only.alt,
          caption: block.caption ?? '',
          cardWidth: 'regular',
          href: '',
        };
      }

      return {
        type: 'gallery',
        version: 1,
        images,
        caption: block.caption ?? '',
      };
    }

    case 'video':
      return {
        type: 'embed',
        version: 1,
        url: block.url,
        embedType: 'video',
        html: videoIframe(block.url, block.title),
        metadata: {
          title: block.title ?? '',
          author_name: block.authorName ?? '',
          provider_name: block.provider === 'vimeo' ? 'Vimeo' : 'YouTube',
          thumbnail_url: block.thumbnailUrl ?? '',
        },
        caption: block.title ?? '',
      };

    case 'quote': {
      const nodes: LexicalNode[] = [
        {
          type: 'quote',
          version: 1,
          children: [textNode(block.text)],
          direction: 'ltr',
          format: '',
          indent: 0,
        },
      ];
      // Ghost's quote card has no attribution field, so the credit follows as
      // its own line — which is what Ghost's own editor produces too.
      if (block.attribution) nodes.push(paragraph(`— ${block.attribution}`));
      return nodes;
    }

    case 'list':
      return {
        type: 'list',
        version: 1,
        listType: block.ordered ? 'number' : 'bullet',
        tag: block.ordered ? 'ol' : 'ul',
        start: 1,
        direction: 'ltr',
        format: '',
        indent: 0,
        children: block.items.map((item, index) => ({
          type: 'listitem',
          version: 1,
          value: index + 1,
          children: [textNode(item)],
          direction: 'ltr',
          format: '',
          indent: 0,
        })),
      };

    case 'code':
      return {
        type: 'codeblock',
        version: 1,
        code: block.code,
        language: block.language ?? '',
        caption: '',
      };

    case 'divider':
      return { type: 'horizontalrule', version: 1 };

    default: {
      // Exhaustiveness guard: a new block type added to the neutral model shows
      // up here at compile time rather than vanishing silently at runtime.
      const _never: never = block;
      void _never;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------

function textNode(text: string): LexicalTextNode {
  return {
    type: 'extended-text',
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text,
    version: 1,
  };
}

function paragraph(text: string) {
  return {
    type: 'paragraph' as const,
    version: 1 as const,
    children: [textNode(text)],
    direction: 'ltr' as const,
    format: '' as const,
    indent: 0 as const,
  };
}

function fileNameFor(url: string, index: number): string {
  const last = url.split('/').pop()?.split('?')[0];
  return last || `image-${index + 1}.jpg`;
}

/**
 * Builds the embed HTML Ghost stores alongside the URL.
 *
 * Ghost renders the stored `html` verbatim rather than re-resolving the oEmbed
 * at render time, so this must be a working iframe, not a placeholder.
 */
export function videoIframe(url: string, title?: string): string {
  const safeTitle = escapeHtml(title ?? 'Embedded video');
  const youtubeId = extractYouTubeId(url);
  if (youtubeId) {
    return (
      `<iframe width="560" height="315" src="https://www.youtube.com/embed/${youtubeId}?feature=oembed" ` +
      `frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
      `allowfullscreen title="${safeTitle}"></iframe>`
    );
  }
  const vimeoId = extractVimeoId(url);
  if (vimeoId) {
    return (
      `<iframe src="https://player.vimeo.com/video/${vimeoId}" width="560" height="315" ` +
      `frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen ` +
      `title="${safeTitle}"></iframe>`
    );
  }
  return `<iframe src="${escapeHtml(url)}" width="560" height="315" frameborder="0" allowfullscreen title="${safeTitle}"></iframe>`;
}

export function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function extractVimeoId(url: string): string | null {
  return url.match(/vimeo\.com\/(?:video\/)?(\d+)/)?.[1] ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Splices one image card into an existing Lexical document.
 *
 * Used by the update path to give an already-published post a body image
 * without touching its prose. Rebuilding the document from blocks is not an
 * option: Ghost stores Lexical, and there is no lossless way back to the
 * neutral block model, so anything not represented there would be silently
 * dropped. Editing the tree in place changes exactly one thing.
 *
 * The card lands after the first paragraph rather than at the top, matching
 * where the generator places body images, so an updated post looks like one
 * that was seeded with an image in the first place. A document with no
 * paragraph — a stub, or something unexpected — gets the card appended, which
 * is still valid rather than a failure.
 */
export function insertImageCard(
  lexical: string,
  hosted: HostedImage,
  options: { alt?: string; caption?: string } = {}
): string {
  const doc = JSON.parse(lexical) as {
    root?: { children?: unknown[] };
  };
  const children = doc.root?.children;
  if (!Array.isArray(children)) {
    throw new Error('post body is not a Lexical document with a root');
  }

  const card = {
    type: 'image',
    version: 1,
    src: hosted.url,
    width: hosted.width ?? null,
    height: hosted.height ?? null,
    title: '',
    alt: options.alt ?? hosted.alt ?? '',
    caption: options.caption ?? hosted.caption ?? '',
    cardWidth: 'regular',
    href: '',
  };

  const firstParagraph = children.findIndex(
    (node) => (node as { type?: string } | null)?.type === 'paragraph'
  );
  const at = firstParagraph === -1 ? children.length : firstParagraph + 1;
  children.splice(at, 0, card);

  return JSON.stringify(doc);
}
