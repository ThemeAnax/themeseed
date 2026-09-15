/**
 * The WordPress *file* export path: neutral `SeedBundle` in, a WXR import file
 * out (`demo-content.xml`, WXR 1.2 — the format Tools → Import → WordPress
 * reads).
 *
 * WordPress's importer works differently from Ghost's, and this file follows
 * WordPress's model rather than imitating the Ghost archive:
 *
 * - A WXR carries no bytes. Images travel as `attachment` items whose
 *   `wp:attachment_url` the importer downloads over HTTP when the user ticks
 *   "Download and import file attachments". After that the importer re-hosts
 *   the file in the media library and rewrites the old URL wherever it appears
 *   in post content — so the imported site ends up serving its own copies,
 *   the same end state the Ghost archive reaches by a different road.
 * - That only works for images that HAVE a public URL (`ImageRef.kind:
 *   'url'`, which is what the stock source produces). A `file` ref points at
 *   the exporter's own disk, which the customer's WordPress can never reach;
 *   those are reported in `failed` with the fix, never silently dropped.
 * - Tag feature images and author avatars have no slot in WXR at all, so they
 *   are ignored — nothing to report, the format simply does not carry them.
 * - Menus: block themes keep menus as `wp_navigation` posts, so the bundle's
 *   navigation exports as one of those per menu. After import it appears in
 *   the Site Editor's navigation picker, where the owner attaches it to the
 *   header — WXR cannot do that attachment itself.
 *
 * It deliberately does not go through `CmsProvider`: that contract is built
 * around a live site, and a file export has no site, no URL and no
 * credentials.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { slugify } from '../../content/generator.js';
import { SEED_TAG } from '../../core/types.js';
import type {
  ContentBlock,
  ImageRef,
  NavItem,
  SeedBundle,
  SeedContent,
  SeedPage,
} from '../../core/types.js';
import { blocksToGutenberg, type WxrImage, type WxrImageResolver } from './gutenberg.js';

const WXR_VERSION = '1.2';

/** The import filename. Fixed so install instructions can name it. */
const WXR_NAME = 'demo-content.xml';

/**
 * Placeholder origin for guids and channel links. The importer treats guids
 * as opaque identifiers and never fetches them, so the domain only has to be
 * consistent — and obviously not a real site.
 */
const BASE_URL = 'https://demo.example.com';

/**
 * The marker every item this tool creates carries, as hidden post meta.
 * WordPress has no Ghost-style internal tag; a leading-underscore meta key is
 * its convention for "machine data, not shown in custom fields". A future
 * live provider's wipe filters on this.
 */
const SEED_META_KEY = '_themeseed';

export interface WxrAttachment {
  id: number;
  url: string;
  title: string;
  alt?: string;
}

export interface CollectedWxrImages {
  attachments: WxrAttachment[];
  resolve: WxrImageResolver;
  /** Attachment id for a ref, for `_thumbnail_id` wiring. */
  attachmentIdFor: (ref: ImageRef) => number | undefined;
  /** Refs a WXR cannot carry, with the reason. Reported, never fatal. */
  failed: Array<{ location: string; error: string }>;
}

function imageKey(ref: ImageRef): string {
  return `${ref.kind}:${ref.location}`;
}

function imageTitle(ref: ImageRef): string {
  const fromUrl = (() => {
    try {
      return new URL(ref.location).pathname.split('/').pop() ?? '';
    } catch {
      return '';
    }
  })();
  const stem = (ref.alt || fromUrl || 'image').replace(/\.\w+$/, '');
  return stem.slice(0, 80) || 'image';
}

/**
 * Registers every URL-backed image the bundle references as one attachment,
 * de-duplicated, and reports the refs the format cannot carry. Pure: no
 * fetching — the customer's importer does the downloading.
 */
export function collectWxrImages(
  bundle: SeedBundle,
  nextId: () => number
): CollectedWxrImages {
  const attachments: WxrAttachment[] = [];
  const byKey = new Map<string, WxrAttachment>();
  const failed: Array<{ location: string; error: string }> = [];
  const failedKeys = new Set<string>();

  const register = (ref?: ImageRef) => {
    if (!ref) return;
    const key = imageKey(ref);
    if (byKey.has(key) || failedKeys.has(key)) return;
    if (ref.kind !== 'url') {
      failedKeys.add(key);
      failed.push({
        location: ref.location,
        error:
          'a WXR file cannot carry local image files — the WordPress importer downloads ' +
          'images by URL. Use a URL-backed image source (stock), or imageSource "none".',
      });
      return;
    }
    const attachment: WxrAttachment = {
      id: nextId(),
      url: ref.location,
      title: imageTitle(ref),
      ...(ref.alt ? { alt: ref.alt } : {}),
    };
    byKey.set(key, attachment);
    attachments.push(attachment);
  };

  const fromBlocks = (blocks: ContentBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'image') register(block.image);
      else if (block.type === 'gallery') block.images.forEach(register);
    }
  };

  for (const post of bundle.posts) {
    register(post.featureImage);
    fromBlocks(post.blocks);
  }
  for (const page of bundle.pages ?? []) {
    register(page.featureImage);
    fromBlocks(page.blocks);
  }
  // Tag images and author avatars are NOT registered: WXR has no field for
  // them, so an attachment would import as an orphan in the media library.

  const resolve: WxrImageResolver = (ref) => {
    const hit = byKey.get(imageKey(ref));
    if (!hit) return undefined;
    const image: WxrImage = { url: hit.url };
    if (ref.width !== undefined) image.width = ref.width;
    if (ref.height !== undefined) image.height = ref.height;
    if (ref.alt !== undefined) image.alt = ref.alt;
    if (ref.caption !== undefined) image.caption = ref.caption;
    return image;
  };

  return {
    attachments,
    resolve,
    attachmentIdFor: (ref) => byKey.get(imageKey(ref))?.id,
    failed,
  };
}

// ---------------------------------------------------------------------------
// XML building blocks
// ---------------------------------------------------------------------------

function escXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CDATA-wraps text; a literal `]]>` inside is split across two sections. */
function cdata(text: string): string {
  const safe = text.replace(/\]\]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

/** ISO timestamp → WordPress's `YYYY-MM-DD HH:MM:SS`, in UTC. */
function wpDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

function rfc2822(iso: string): string {
  return new Date(iso).toUTCString();
}

interface PostMeta {
  key: string;
  value: string;
}

interface WxrItem {
  id: number;
  title: string;
  slug: string;
  type: 'post' | 'page' | 'attachment' | 'wp_navigation';
  status: string;
  content: string;
  excerpt?: string;
  creator: string;
  /** ISO. Defaults to `now`. */
  date?: string;
  parent?: number;
  attachmentUrl?: string;
  commentStatus?: 'open' | 'closed';
  tags?: string[];
  meta?: PostMeta[];
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface BuildWxrOptions {
  /** Fixed clock, so a test can assert exact timestamps. */
  now?: Date;
  /** Channel title; shows up in the importer's confirmation screen. */
  siteTitle?: string;
}

export interface WxrDocument {
  xml: string;
  attachments: WxrAttachment[];
  failed: Array<{ location: string; error: string }>;
}

/**
 * Ids only have to be unique within the file — the importer assigns real
 * ones — so a counter keeps output deterministic for tests. Starting above
 * zero mirrors what a real export looks like.
 */
function idFactory(start = 100): () => number {
  let n = start;
  return () => {
    n += 1;
    return n;
  };
}

export function buildWordPressWxr(
  bundle: SeedBundle,
  options: BuildWxrOptions = {}
): WxrDocument {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const nextId = idFactory();

  const images = collectWxrImages(bundle, nextId);

  // -- authors ---------------------------------------------------------------
  // Registered by slug so a post crediting an undeclared name still gets a
  // real wp:author row — the importer refuses creators it has no row for.
  const authors = new Map<string, { login: string; name: string; bio?: string }>();
  for (const author of bundle.authors ?? []) {
    authors.set(author.slug, {
      login: author.slug,
      name: author.name,
      ...(author.bio ? { bio: author.bio } : {}),
    });
  }
  const creatorFor = (name?: string): string => {
    if (!name) {
      if (!authors.has('themeseed')) {
        authors.set('themeseed', { login: 'themeseed', name: 'Themeseed Demo' });
      }
      return 'themeseed';
    }
    const slug = slugify(name);
    if (!authors.has(slug)) authors.set(slug, { login: slug, name });
    return slug;
  };

  // -- tags ------------------------------------------------------------------
  const tags = new Map<string, { slug: string; name: string; description?: string }>();
  for (const tag of bundle.tags ?? []) {
    tags.set(tag.slug, {
      slug: tag.slug,
      name: tag.name,
      ...(tag.description ? { description: tag.description } : {}),
    });
  }
  const tagFor = (name: string): string => {
    const slug = slugify(name);
    if (!tags.has(slug)) tags.set(slug, { slug, name });
    return slug;
  };

  // -- items -----------------------------------------------------------------
  const seedMeta: PostMeta = { key: SEED_META_KEY, value: SEED_TAG };
  const items: WxrItem[] = [];

  const bodyFor = (entry: SeedContent | SeedPage): string => {
    const supplied = 'suppliedBody' in entry ? entry.suppliedBody : undefined;
    // A supplied body is already final markup — typically serialized block
    // grammar the caller authored. Re-deriving it would only risk changing it.
    if (supplied) return supplied;
    if ('needsBody' in entry && entry.needsBody === false) return '';
    return blocksToGutenberg(entry.blocks, images.resolve);
  };

  for (const post of bundle.posts) {
    const meta: PostMeta[] = [seedMeta];
    if (post.featureImage) {
      const thumbId = images.attachmentIdFor(post.featureImage);
      if (thumbId !== undefined) meta.push({ key: '_thumbnail_id', value: String(thumbId) });
    }
    items.push({
      id: nextId(),
      title: post.title,
      slug: post.slug ?? slugify(post.title),
      type: 'post',
      status: post.status === 'published' ? 'publish' : 'draft',
      content: bodyFor(post),
      ...(post.excerpt ? { excerpt: post.excerpt } : {}),
      creator: creatorFor(post.authorName),
      date: post.publishedAt ?? nowIso,
      commentStatus: 'open',
      tags: post.tags.map(tagFor),
      meta,
    });
  }

  for (const page of bundle.pages ?? []) {
    const meta: PostMeta[] = [seedMeta];
    if (page.featureImage) {
      const thumbId = images.attachmentIdFor(page.featureImage);
      if (thumbId !== undefined) meta.push({ key: '_thumbnail_id', value: String(thumbId) });
    }
    items.push({
      id: nextId(),
      title: page.title,
      slug: page.slug,
      type: 'page',
      status: page.status === 'published' ? 'publish' : 'draft',
      content: bodyFor(page),
      ...(page.excerpt ? { excerpt: page.excerpt } : {}),
      creator: creatorFor(undefined),
      date: nowIso,
      commentStatus: 'closed',
      meta: meta,
    });
  }

  for (const attachment of images.attachments) {
    items.push({
      id: attachment.id,
      title: attachment.title,
      slug: slugify(attachment.title),
      type: 'attachment',
      // 'inherit' is the one status WordPress gives attachments; anything
      // else and the importer skips the download.
      status: 'inherit',
      content: '',
      creator: creatorFor(undefined),
      date: nowIso,
      attachmentUrl: attachment.url,
      commentStatus: 'closed',
      meta: [
        seedMeta,
        ...(attachment.alt
          ? [{ key: '_wp_attachment_image_alt', value: attachment.alt }]
          : []),
      ],
    });
  }

  const navigation = (title: string, slug: string, links: NavItem[]): WxrItem => ({
    id: nextId(),
    title,
    slug,
    type: 'wp_navigation',
    status: 'publish',
    content: links
      .map(
        (link) =>
          `<!-- wp:navigation-link ${JSON.stringify({
            label: link.label,
            url: link.url,
            kind: 'custom',
          })} /-->`
      )
      .join('\n'),
    creator: creatorFor(undefined),
    date: nowIso,
    commentStatus: 'closed',
    meta: [seedMeta],
  });

  if (bundle.site?.navigation?.length) {
    items.push(navigation('Primary navigation', 'primary-navigation', bundle.site.navigation));
  }
  if (bundle.site?.secondaryNavigation?.length) {
    items.push(
      navigation('Secondary navigation', 'secondary-navigation', bundle.site.secondaryNavigation)
    );
  }

  // -- render ----------------------------------------------------------------
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" ?>');
  lines.push(
    '<rss version="2.0"',
    '\txmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"',
    '\txmlns:content="http://purl.org/rss/1.0/modules/content/"',
    '\txmlns:wfw="http://wellformedweb.org/CommentAPI/"',
    '\txmlns:dc="http://purl.org/dc/elements/1.1/"',
    `\txmlns:wp="http://wordpress.org/export/${WXR_VERSION}/">`,
    '<channel>'
  );
  lines.push(`\t<title>${escXml(options.siteTitle ?? 'themeseed demo content')}</title>`);
  lines.push(`\t<link>${BASE_URL}</link>`);
  lines.push('\t<description>Demo content generated by themeseed</description>');
  lines.push(`\t<pubDate>${rfc2822(nowIso)}</pubDate>`);
  lines.push('\t<language>en-US</language>');
  lines.push(`\t<wp:wxr_version>${WXR_VERSION}</wp:wxr_version>`);
  lines.push(`\t<wp:base_site_url>${BASE_URL}</wp:base_site_url>`);
  lines.push(`\t<wp:base_blog_url>${BASE_URL}</wp:base_blog_url>`);

  let authorId = 0;
  for (const author of authors.values()) {
    authorId += 1;
    lines.push(
      '\t<wp:author>' +
        `<wp:author_id>${authorId}</wp:author_id>` +
        `<wp:author_login>${cdata(author.login)}</wp:author_login>` +
        `<wp:author_email>${cdata(`${author.login}@example.com`)}</wp:author_email>` +
        `<wp:author_display_name>${cdata(author.name)}</wp:author_display_name>` +
        '<wp:author_first_name><![CDATA[]]></wp:author_first_name>' +
        '<wp:author_last_name><![CDATA[]]></wp:author_last_name>' +
        '</wp:author>'
    );
  }

  let termId = 0;
  for (const tag of tags.values()) {
    termId += 1;
    lines.push(
      '\t<wp:tag>' +
        `<wp:term_id>${termId}</wp:term_id>` +
        `<wp:tag_slug>${cdata(tag.slug)}</wp:tag_slug>` +
        `<wp:tag_name>${cdata(tag.name)}</wp:tag_name>` +
        (tag.description ? `<wp:tag_description>${cdata(tag.description)}</wp:tag_description>` : '') +
        '</wp:tag>'
    );
  }

  for (const item of items) {
    const date = item.date ?? nowIso;
    lines.push('\t<item>');
    lines.push(`\t\t<title>${cdata(item.title)}</title>`);
    lines.push(`\t\t<link>${BASE_URL}/${escXml(item.slug)}/</link>`);
    lines.push(`\t\t<pubDate>${rfc2822(date)}</pubDate>`);
    lines.push(`\t\t<dc:creator>${cdata(item.creator)}</dc:creator>`);
    lines.push(`\t\t<guid isPermaLink="false">${BASE_URL}/?p=${item.id}</guid>`);
    lines.push('\t\t<description></description>');
    lines.push(`\t\t<content:encoded>${cdata(item.content)}</content:encoded>`);
    lines.push(`\t\t<excerpt:encoded>${cdata(item.excerpt ?? '')}</excerpt:encoded>`);
    lines.push(`\t\t<wp:post_id>${item.id}</wp:post_id>`);
    lines.push(`\t\t<wp:post_date>${cdata(wpDate(date))}</wp:post_date>`);
    lines.push(`\t\t<wp:post_date_gmt>${cdata(wpDate(date))}</wp:post_date_gmt>`);
    lines.push(`\t\t<wp:comment_status>${cdata(item.commentStatus ?? 'closed')}</wp:comment_status>`);
    lines.push('\t\t<wp:ping_status><![CDATA[closed]]></wp:ping_status>');
    lines.push(`\t\t<wp:post_name>${cdata(item.slug)}</wp:post_name>`);
    lines.push(`\t\t<wp:status>${cdata(item.status)}</wp:status>`);
    lines.push(`\t\t<wp:post_parent>${item.parent ?? 0}</wp:post_parent>`);
    lines.push('\t\t<wp:menu_order>0</wp:menu_order>');
    lines.push(`\t\t<wp:post_type>${cdata(item.type)}</wp:post_type>`);
    lines.push('\t\t<wp:post_password><![CDATA[]]></wp:post_password>');
    lines.push('\t\t<wp:is_sticky>0</wp:is_sticky>');
    if (item.attachmentUrl) {
      lines.push(`\t\t<wp:attachment_url>${cdata(item.attachmentUrl)}</wp:attachment_url>`);
    }
    for (const slug of item.tags ?? []) {
      const tag = tags.get(slug)!;
      lines.push(
        `\t\t<category domain="post_tag" nicename="${escXml(slug)}">${cdata(tag.name)}</category>`
      );
    }
    for (const meta of item.meta ?? []) {
      lines.push(
        '\t\t<wp:postmeta>' +
          `<wp:meta_key>${cdata(meta.key)}</wp:meta_key>` +
          `<wp:meta_value>${cdata(meta.value)}</wp:meta_value>` +
          '</wp:postmeta>'
      );
    }
    lines.push('\t</item>');
  }

  lines.push('</channel>', '</rss>', '');

  return { xml: lines.join('\n'), attachments: images.attachments, failed: images.failed };
}

// ---------------------------------------------------------------------------
// Writing the files
// ---------------------------------------------------------------------------

export interface ExportWxrOptions extends BuildWxrOptions {
  /** Directory the files are written to. Created if missing. */
  outDir: string;
}

export interface ExportWxrResult {
  /** The WXR file — the artifact install instructions point at. */
  artifactPath: string;
  stats: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    /** Attachments the importer will download — referenced, not bundled. */
    images: number;
    failedImages: number;
  };
  /** Images a WXR cannot carry — reported, never fatal. */
  failed: Array<{ location: string; error: string }>;
}

const IMPORT_GUIDE = `# Importing the demo content

1. In WordPress admin, go to **Tools → Import → WordPress** and install the
   importer when prompted (the official "WordPress Importer" plugin).
2. Upload \`${WXR_NAME}\`.
3. On the assignment screen, map the demo authors onto a real user.
4. Tick **"Download and import file attachments"** — this is what fetches the
   images from their source URLs into your media library. WordPress then
   rewrites the image URLs in the imported content to your own copies, so the
   site does not stay dependent on the source CDN.
5. Menus import as Navigation entries: open **Appearance → Editor →
   Navigation** and pick "Primary navigation" for the header (block themes
   cannot attach a menu from an import file).

Everything imported carries hidden \`_themeseed\` post meta, so it can be
identified and removed later without touching real content.
`;

/**
 * Turns a bundle into one importable WXR on disk, plus the import guide.
 *
 * No network: unlike the Ghost archive, nothing is fetched here — the
 * customer's own importer downloads each attachment from its source URL at
 * import time (see the module docblock for why).
 */
export async function exportWordPressWxr(
  bundle: SeedBundle,
  options: ExportWxrOptions
): Promise<ExportWxrResult> {
  const document = buildWordPressWxr(bundle, options);

  await fs.mkdir(options.outDir, { recursive: true });
  const artifactPath = path.join(options.outDir, WXR_NAME);
  await fs.writeFile(artifactPath, document.xml, 'utf8');
  await fs.writeFile(path.join(options.outDir, 'IMPORT.md'), IMPORT_GUIDE, 'utf8');

  return {
    artifactPath,
    stats: {
      posts: bundle.posts.length,
      pages: bundle.pages?.length ?? 0,
      tags: bundle.tags?.length ?? 0,
      authors: bundle.authors?.length ?? 0,
      images: document.attachments.length,
      failedImages: document.failed.length,
    },
    failed: document.failed,
  };
}
