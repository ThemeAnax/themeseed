/**
 * The Ghost *file* export path: neutral `SeedBundle` in, a Ghost import
 * archive out.
 *
 * This is the sibling of `posts.ts`. Both translate the same neutral model
 * into the same Ghost shapes; they differ only in where the result goes —
 * `posts.ts` POSTs to the Admin API, this writes files a human can carry.
 *
 * Why it exists: an archive can bundle its own images. Ghost's importer reads
 * an `images/` directory out of the zip and re-hosts every file under
 * `/content/images/`, so a theme shipped this way has no runtime dependency on
 * whichever stock CDN the pictures came from. A bare JSON can only carry image
 * URLs, which Ghost stores verbatim.
 *
 * It deliberately does not go through `CmsProvider`: that contract is built
 * around a live site, and `GhostProvider` refuses to construct without an
 * Admin API key. A file export has no site, no URL and no credentials.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { slugify } from '../../content/generator.js';
import { logger } from '../../core/logger.js';
import { createZip } from '../../core/zip.js';
import { SEED_TAG } from '../../core/types.js';
import type {
  ContentBlock,
  ImageRef,
  SeedBundle,
  SeedContent,
  SeedPage,
} from '../../core/types.js';
import { extensionFor, probeImage } from '../../images/inspect.js';
import { blocksToLexical, type HostedImage, type ImageResolver } from './lexical.js';

/** Ghost's export files record the schema they came from. */
const GHOST_EXPORT_VERSION = '5.0.0';

/**
 * The five roles a real Ghost install has.
 *
 * Ghost's own export also lists its integration roles — "DB Backup
 * Integration", "Scheduler Integration" and so on. Those describe that
 * instance's internals, not the content, and carrying them into a theme's
 * demo import is noise at best.
 */
const STAFF_ROLES = [
  'Administrator',
  'Editor',
  'Author',
  'Contributor',
  'Owner',
] as const;

/** Ghost's slug for the internal `#themeseed` tag; wipe filters on this. */
const SEED_TAG_SLUG = 'hash-themeseed';

export interface BuildArchiveOptions {
  /** Resolves an `ImageRef` to its path inside the archive. */
  resolveImage?: ImageResolver;
  /** Fixed clock, so a test can assert exact timestamps. */
  now?: Date;
}

export interface GhostArchive {
  /** Archive-relative path → contents. Text for JSON, bytes for images. */
  files: Record<string, string | Uint8Array>;
}

/**
 * Ghost ids are BSON ObjectId hex strings. They only have to be unique within
 * the file — the importer assigns real ones — so a counter is enough, and it
 * keeps output deterministic for tests.
 */
function idFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return n.toString(16).padStart(24, '0');
  };
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

/** No images hosted: the body still renders, minus the pictures. */
const resolveNothing: ImageResolver = () => undefined;

export function buildGhostArchive(
  bundle: SeedBundle,
  options: BuildArchiveOptions = {}
): GhostArchive {
  const nextId = idFactory();
  const now = options.now ?? new Date();
  const stamp = iso(now);
  const resolve = options.resolveImage ?? resolveNothing;

  /** A hero, tag image or avatar becomes an archive path, or null. */
  const hostedUrl = (ref?: ImageRef) => (ref ? (resolve(ref)?.url ?? null) : null);

  const body = (item: SeedContent | SeedPage) => {
    const supplied = 'suppliedBody' in item ? item.suppliedBody : undefined;
    // A supplied body is already final markup. Ghost turns html into lexical
    // on import, so handing it over as html is the faithful route — inventing
    // blocks to re-serialise would only risk changing it.
    return supplied
      ? { html: supplied }
      : { lexical: blocksToLexical(item.blocks, resolve) };
  };

  // Tags and authors are registered by slug so a post referencing one by name
  // collapses onto the declared entity rather than creating a duplicate.
  const tags = new Map<string, Record<string, unknown>>();
  const users = new Map<string, Record<string, unknown>>();

  /**
   * The marker every piece of content this tool creates carries, so a later
   * `themeseed wipe` can find its own work and nothing else.
   *
   * Ghost slugifies an internal tag `#themeseed` to `hash-themeseed` and
   * filters on the slug, not the name — the same trap the live provider
   * documents. `internal` visibility keeps it out of the reader-facing tag
   * list while staying filterable.
   */
  const seedTagId = nextId();
  tags.set(SEED_TAG_SLUG, {
    id: seedTagId,
    name: SEED_TAG,
    slug: SEED_TAG_SLUG,
    description: null,
    feature_image: null,
    visibility: 'internal',
    created_at: stamp,
    updated_at: stamp,
  });

  for (const tag of bundle.tags ?? []) {
    tags.set(tag.slug, {
      id: nextId(),
      name: tag.name,
      slug: tag.slug,
      description: tag.description ?? null,
      feature_image: hostedUrl(tag.featureImage),
      visibility: 'public',
      created_at: stamp,
      updated_at: stamp,
    });
  }

  for (const author of bundle.authors ?? []) {
    users.set(author.slug, {
      id: nextId(),
      name: author.name,
      slug: author.slug,
      email: `${author.slug}@example.com`,
      bio: author.bio ?? null,
      profile_image: hostedUrl(author.avatar),
      status: 'active',
      created_at: stamp,
      updated_at: stamp,
    });
  }

  /** A post may reference a tag or author the bundle never declared. */
  const tagFor = (name: string) => {
    const slug = slugify(name);
    if (!tags.has(slug)) {
      tags.set(slug, {
        id: nextId(),
        name,
        slug,
        description: null,
        feature_image: null,
        visibility: 'public',
        created_at: stamp,
        updated_at: stamp,
      });
    }
    return tags.get(slug)!;
  };

  const userFor = (name: string) => {
    const slug = slugify(name);
    if (!users.has(slug)) {
      users.set(slug, {
        id: nextId(),
        name,
        slug,
        email: `${slug}@example.com`,
        bio: null,
        profile_image: null,
        status: 'active',
        created_at: stamp,
        updated_at: stamp,
      });
    }
    return users.get(slug)!;
  };

  const postsTags: Array<Record<string, unknown>> = [];
  const postsAuthors: Array<Record<string, unknown>> = [];

  const posts = [
    ...bundle.posts.map((post, index) => {
      const id = nextId();
      post.tags.forEach((name, order) =>
        postsTags.push({
          id: nextId(),
          post_id: id,
          tag_id: tagFor(name)['id'],
          sort_order: order,
        })
      );
      postsTags.push({
        id: nextId(),
        post_id: id,
        tag_id: seedTagId,
        sort_order: post.tags.length,
      });
      if (post.authorName) {
        postsAuthors.push({
          id: nextId(),
          post_id: id,
          author_id: userFor(post.authorName)['id'],
          sort_order: 0,
        });
      }
      return {
        id,
        title: post.title,
        slug: post.slug ?? slugify(post.title),
        ...body(post),
        feature_image: hostedUrl(post.featureImage),
        ...(post.excerpt ? { custom_excerpt: post.excerpt } : {}),
        // Themes build hero and "featured" sections from this flag, and a
        // demo import with none leaves those sections empty — which reads as
        // a broken theme rather than as unconfigured content. Every third
        // post is chosen by position, not chance, so a short run still gets
        // one.
        featured: index % 3 === 0,
        type: 'post',
        status: post.status,
        visibility: 'public',
        created_at: stamp,
        updated_at: stamp,
        published_at: post.publishedAt ?? stamp,
      };
    }),
    ...(bundle.pages ?? []).map((page) => {
      const id = nextId();
      postsTags.push({ id: nextId(), post_id: id, tag_id: seedTagId, sort_order: 0 });
      return {
        id,
        title: page.title,
        slug: page.slug,
        ...body(page),
        feature_image: hostedUrl(page.featureImage),
        ...(page.excerpt ? { custom_excerpt: page.excerpt } : {}),
        // A page never belongs in a featured collection.
        featured: false,
        type: 'page',
        status: page.status,
        visibility: 'public',
        created_at: stamp,
        updated_at: stamp,
        published_at: stamp,
      };
    }),
  ];

  const roles = STAFF_ROLES.map((name) => ({
    id: nextId(),
    name,
    description: name,
    created_at: stamp,
    updated_at: stamp,
  }));
  // Everyone lands as Author: enough to hold a byline, and it never hands a
  // demo account the keys to the site.
  const authorRoleId = roles.find((r) => r.name === 'Author')!.id;
  const rolesUsers = [...users.values()].map((user) => ({
    id: nextId(),
    role_id: authorRoleId,
    user_id: user['id'],
  }));

  // Ghost stores every setting's value as text, so a menu goes in as a JSON
  // string. Handing it a real array imports as nothing, silently.
  const settings: Array<Record<string, unknown>> = [];
  const setting = (key: string, value: unknown) =>
    settings.push({
      id: nextId(),
      key,
      value: JSON.stringify(value),
      type: 'site',
      created_at: stamp,
      updated_at: stamp,
    });

  if (bundle.site?.navigation) setting('navigation', bundle.site.navigation);
  if (bundle.site?.secondaryNavigation) {
    setting('secondary_navigation', bundle.site.secondaryNavigation);
  }

  const content = {
    db: [
      {
        meta: { exported_on: now.getTime(), version: GHOST_EXPORT_VERSION },
        data: {
          posts,
          tags: [...tags.values()],
          posts_tags: postsTags,
          users: [...users.values()],
          posts_authors: postsAuthors,
          roles,
          roles_users: rolesUsers,
          // Omitted rather than empty: an empty settings table is a table
          // Ghost still walks, and it reads as "configured with nothing".
          ...(settings.length ? { settings } : {}),
        },
      },
    ],
  };

  return { files: { 'content.json': `${JSON.stringify(content, null, 2)}\n` } };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Ghost's importer reads an `images/` directory out of the archive and
 * re-hosts everything in it under `/content/images/`, preserving the path
 * below that. Mirroring Ghost's own `<year>/<month>/` layout keeps an imported
 * archive indistinguishable from content uploaded through the editor.
 */
const IMAGE_ROOT = 'images';

export interface CollectImagesOptions {
  /** Injected so tests need no network. Defaults to disk-or-download. */
  fetchBytes?: (ref: ImageRef) => Promise<Uint8Array>;
  now?: Date;
}

export interface CollectedImages {
  /** Archive-relative path → bytes. */
  files: Record<string, Uint8Array>;
  /** Maps a neutral ref to its path inside the archive. */
  resolve: ImageResolver;
  /** Refs that could not be fetched, with the reason. */
  failed: Array<{ location: string; error: string }>;
}

async function defaultFetchBytes(ref: ImageRef): Promise<Uint8Array> {
  if (ref.kind === 'file') return new Uint8Array(await fs.readFile(ref.location));
  const response = await fetch(ref.location, {
    headers: { 'User-Agent': 'themeseed' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${ref.location}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Two URLs pointing at the same picture must not be stored twice. */
function imageKey(ref: ImageRef): string {
  return `${ref.kind}:${ref.location}`;
}

function baseNameFor(ref: ImageRef): string {
  const raw =
    ref.kind === 'file'
      ? path.basename(ref.location)
      : (new URL(ref.location).pathname.split('/').pop() ?? 'image');
  const stem = raw.replace(/\.\w+$/, '');
  return (stem || 'image').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
}

/** Every image the bundle references, de-duplicated, in encounter order. */
function allImageRefs(bundle: SeedBundle): ImageRef[] {
  const refs: ImageRef[] = [];
  const push = (ref?: ImageRef) => {
    if (ref) refs.push(ref);
  };

  const fromBlocks = (item: { blocks: ContentBlock[] }) => {
    for (const block of item.blocks) {
      if (block.type === 'image') push(block.image);
      else if (block.type === 'gallery') block.images.forEach(push);
    }
  };

  for (const post of bundle.posts) {
    push(post.featureImage);
    fromBlocks(post);
  }
  for (const page of bundle.pages ?? []) {
    push(page.featureImage);
    fromBlocks(page);
  }
  for (const tag of bundle.tags ?? []) push(tag.featureImage);
  for (const author of bundle.authors ?? []) push(author.avatar);

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = imageKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function collectArchiveImages(
  bundle: SeedBundle,
  options: CollectImagesOptions = {}
): Promise<CollectedImages> {
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const now = options.now ?? new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  const files: Record<string, Uint8Array> = {};
  const hosted = new Map<string, HostedImage>();
  const failed: Array<{ location: string; error: string }> = [];
  const usedNames = new Set<string>();

  for (const ref of allImageRefs(bundle)) {
    try {
      const bytes = await fetchBytes(ref);
      const info = probeImage(bytes);
      if (!info) throw new Error('not a recognisable image');

      // Two different pictures can share a filename; the second must not
      // overwrite the first inside the archive.
      let name = `${baseNameFor(ref)}.${extensionFor(info.format)}`;
      for (let n = 2; usedNames.has(name); n += 1) {
        name = `${baseNameFor(ref)}-${n}.${extensionFor(info.format)}`;
      }
      usedNames.add(name);

      files[`${IMAGE_ROOT}/${year}/${month}/${name}`] = bytes;
      hosted.set(imageKey(ref), {
        url: `/content/${IMAGE_ROOT}/${year}/${month}/${name}`,
        ...(info.width ? { width: info.width } : {}),
        ...(info.height ? { height: info.height } : {}),
        ...(ref.alt ? { alt: ref.alt } : {}),
        ...(ref.caption ? { caption: ref.caption } : {}),
        fileName: name,
      });
    } catch (err) {
      // One dead URL must not cost the run its other images.
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(`could not bundle image ${ref.location}: ${error}`);
      failed.push({ location: ref.location, error });
    }
  }

  return { files, resolve: (ref) => hosted.get(imageKey(ref)), failed };
}

// ---------------------------------------------------------------------------
// Writing the archive
// ---------------------------------------------------------------------------

export interface ExportArchiveOptions extends CollectImagesOptions {
  /** Directory the archive is written to. Created if missing. */
  outDir: string;
}

export interface ExportArchiveResult {
  zipPath: string;
  stats: {
    posts: number;
    pages: number;
    tags: number;
    authors: number;
    images: number;
    failedImages: number;
  };
  /** Images that could not be bundled — reported, never fatal. */
  failed: Array<{ location: string; error: string }>;
}

/** The archive filename. Fixed so install instructions can name it. */
const ARCHIVE_NAME = 'content-export.zip';

/**
 * Turns a bundle into one importable Ghost archive on disk.
 *
 * Images are fetched first and the content is built against their archive
 * paths, so nothing in the JSON ever refers to the CDN the picture came from.
 */
export async function exportGhostArchive(
  bundle: SeedBundle,
  options: ExportArchiveOptions
): Promise<ExportArchiveResult> {
  const images = await collectArchiveImages(bundle, options);
  const archive = buildGhostArchive(bundle, {
    resolveImage: images.resolve,
    ...(options.now ? { now: options.now } : {}),
  });

  await fs.mkdir(options.outDir, { recursive: true });
  const zipPath = path.join(options.outDir, ARCHIVE_NAME);
  await fs.writeFile(zipPath, createZip({ ...archive.files, ...images.files }));

  return {
    zipPath,
    stats: {
      posts: bundle.posts.length,
      pages: bundle.pages?.length ?? 0,
      tags: bundle.tags?.length ?? 0,
      authors: bundle.authors?.length ?? 0,
      images: Object.keys(images.files).length,
      failedImages: images.failed.length,
    },
    failed: images.failed,
  };
}
