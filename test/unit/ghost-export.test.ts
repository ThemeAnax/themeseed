import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SeedBundle } from '../../src/core/types.js';
import { encodePng } from '../../src/images/png.js';
import {
  buildGhostArchive,
  collectArchiveImages,
  exportGhostArchive,
} from '../../src/providers/ghost/export.js';

/** Smallest bundle that still exercises a post, a page, a tag and an author. */
function bundle(overrides: Partial<SeedBundle> = {}): SeedBundle {
  return {
    posts: [
      {
        title: 'A first post',
        slug: 'a-first-post',
        blocks: [{ type: 'paragraph', text: 'Hello.' }],
        tags: ['Design'],
        status: 'published',
        authorName: 'Maya Iyer',
      },
    ],
    ...overrides,
  };
}

function data(b: SeedBundle) {
  const archive = buildGhostArchive(b);
  return JSON.parse(archive.files['content.json'] as string).db[0].data as Record<
    string,
    Array<Record<string, unknown>>
  >;
}

describe('buildGhostArchive', () => {
  it('writes content.json at the archive root, where Ghost looks for it', () => {
    const archive = buildGhostArchive(bundle());
    expect(Object.keys(archive.files)).toContain('content.json');
  });

  it('wraps the tables in the db[0].data envelope Ghost imports', () => {
    const parsed = JSON.parse(
      buildGhostArchive(bundle()).files['content.json'] as string,
    );
    expect(parsed.db).toHaveLength(1);
    expect(parsed.db[0].meta).toMatchObject({ version: expect.any(String) });
    expect(parsed.db[0].data).toBeTypeOf('object');
  });

  it('emits posts with a lexical body, not html', () => {
    // Ghost converts html to lexical on import, which is a lossy extra step.
    // themeseed already produces lexical, so it should ship it directly.
    const [post] = data(bundle()).posts!;
    expect(post!['lexical']).toBeTypeOf('string');
    expect(post!['html']).toBeUndefined();
  });

  it('carries pages in the posts table with type "page"', () => {
    const d = data(
      bundle({
        pages: [
          {
            title: 'About',
            slug: 'about',
            blocks: [{ type: 'paragraph', text: 'About us.' }],
            status: 'published',
          },
        ],
      }),
    );
    const about = d.posts!.find((p) => p['slug'] === 'about');
    expect(about).toMatchObject({ type: 'page', title: 'About' });
  });

  it('uses a supplied page body verbatim instead of generating one', () => {
    const d = data(
      bundle({
        pages: [
          {
            title: 'Style guide',
            slug: 'style-guide',
            blocks: [],
            status: 'published',
            suppliedBody: '<figure class="kg-card kg-image-card"><img src="x.jpg"></figure>',
          },
        ],
      }),
    );
    const page = d.posts!.find((p) => p['slug'] === 'style-guide');
    expect(page!['html']).toContain('kg-image-card');
  });
});

describe('buildGhostArchive — taxonomy and people', () => {
  const withEntities = () =>
    data(
      bundle({
        tags: [{ name: 'Design', slug: 'design', description: 'On craft.' }],
        authors: [{ name: 'Maya Iyer', slug: 'maya-iyer', bio: 'Writes about type.' }],
      }),
    );

  it('emits tags as records carrying their description', () => {
    // Found by slug, not by position: the internal seed marker is registered
    // first so a later wipe can find this content.
    const tag = withEntities().tags!.find((t) => t['slug'] === 'design');
    expect(tag).toMatchObject({ name: 'Design', slug: 'design', description: 'On craft.' });
  });

  it('emits authors as users carrying their bio', () => {
    const [user] = withEntities().users!;
    expect(user).toMatchObject({ name: 'Maya Iyer', slug: 'maya-iyer', bio: 'Writes about type.' });
  });

  it('joins each post to its tags, since Ghost stores that separately', () => {
    const d = withEntities();
    const postId = d.posts!.find((p) => p['type'] === 'post')!['id'];
    const tagId = d.tags!.find((t) => t['slug'] === 'design')!['id'];
    expect(d.posts_tags).toContainEqual(expect.objectContaining({ post_id: postId, tag_id: tagId }));
  });

  it('joins each post to its author', () => {
    const d = withEntities();
    const postId = d.posts!.find((p) => p['type'] === 'post')!['id'];
    const userId = d.users!.find((u) => u['slug'] === 'maya-iyer')!['id'];
    expect(d.posts_authors).toContainEqual(
      expect.objectContaining({ post_id: postId, author_id: userId }),
    );
  });

  it('creates a tag a post references even when the bundle never declared it', () => {
    // A post tagged "Design" with no matching SeedTag must still import with
    // that tag attached, rather than silently losing it.
    const d = data(bundle());
    expect(d.tags!.map((t) => t['slug'])).toContain('design');
  });

  it('ships only the real staff roles, not Ghost internal integration roles', () => {
    // A previous hand-built export carried "DB Backup Integration" and friends.
    expect(withEntities().roles!.map((r) => r['name'])).toEqual([
      'Administrator',
      'Editor',
      'Author',
      'Contributor',
      'Owner',
    ]);
  });

  it('assigns every author a role, or Ghost imports a user who cannot log in', () => {
    const d = withEntities();
    const userId = d.users!.find((u) => u['slug'] === 'maya-iyer')!['id'];
    expect(d.roles_users).toContainEqual(expect.objectContaining({ user_id: userId }));
  });
});

describe('buildGhostArchive — site settings', () => {
  const nav = () =>
    data(
      bundle({
        site: {
          navigation: [
            { label: 'Home', url: '/' },
            { label: 'Topics', url: '/tags/' },
          ],
          secondaryNavigation: [
            { label: 'Navigation', url: '##' },
            { label: 'About', url: '/about/' },
          ],
        },
      }),
    );

  it('emits navigation as a settings row, which is where Ghost reads menus from', () => {
    const row = nav().settings!.find((s) => s['key'] === 'navigation');
    expect(row).toBeDefined();
  });

  it('serialises the menu as a JSON string, not a nested array', () => {
    // Ghost stores settings values as text; an array here imports as nothing.
    const row = nav().settings!.find((s) => s['key'] === 'navigation')!;
    expect(row['value']).toBeTypeOf('string');
    expect(JSON.parse(row['value'] as string)).toEqual([
      { label: 'Home', url: '/' },
      { label: 'Topics', url: '/tags/' },
    ]);
  });

  it('carries secondary navigation, which drives footer columns', () => {
    const row = nav().settings!.find((s) => s['key'] === 'secondary_navigation')!;
    expect(JSON.parse(row['value'] as string)[0]).toEqual({ label: 'Navigation', url: '##' });
  });

  it('omits the settings table entirely when no site config was given', () => {
    expect(data(bundle()).settings).toBeUndefined();
  });
});

describe('collectArchiveImages', () => {
  const png = encodePng(8, 6, () => ({ r: 1, g: 2, b: 3 }));
  const remote = (n: string) => ({ kind: 'url' as const, location: `https://cdn.test/${n}.jpg` });

  /** Stands in for the network; records what was asked for. */
  function fakeFetch(fails: string[] = []) {
    const asked: string[] = [];
    return {
      asked,
      fetchBytes: async (ref: { location: string }) => {
        asked.push(ref.location);
        if (fails.some((f) => ref.location.includes(f))) throw new Error('404');
        return png;
      },
    };
  }

  const withImage = () =>
    bundle({
      posts: [
        {
          title: 'Post',
          slug: 'post',
          blocks: [],
          tags: [],
          status: 'published' as const,
          featureImage: remote('hero'),
        },
      ],
    });

  it('stores the image bytes inside the archive, under images/', async () => {
    const { fetchBytes } = fakeFetch();
    const { files } = await collectArchiveImages(withImage(), { fetchBytes, now: new Date('2026-09-10') });
    const paths = Object.keys(files);
    expect(paths.some((p) => /^images\/2026\/09\/.+\.png$/.test(p))).toBe(true);
  });

  it('rewrites the reference to a Ghost-local path, dropping the remote host', async () => {
    // This is the whole point of the file export: after import the site must
    // not still be fetching from the stock CDN.
    const { fetchBytes } = fakeFetch();
    const { resolve } = await collectArchiveImages(withImage(), { fetchBytes, now: new Date('2026-09-10') });
    const hosted = resolve(remote('hero'));
    expect(hosted?.url).toMatch(/^\/content\/images\/2026\/09\/.+\.png$/);
    expect(hosted?.url).not.toContain('cdn.test');
  });

  it('downloads a repeated image once', async () => {
    const { asked, fetchBytes } = fakeFetch();
    const twice = bundle({
      posts: [
        { title: 'A', slug: 'a', blocks: [], tags: [], status: 'published' as const, featureImage: remote('hero') },
        { title: 'B', slug: 'b', blocks: [], tags: [], status: 'published' as const, featureImage: remote('hero') },
      ],
    });
    await collectArchiveImages(twice, { fetchBytes });
    expect(asked).toHaveLength(1);
  });

  it('keeps the post when its image cannot be fetched', async () => {
    // One dead URL must not cost the run fourteen good posts.
    const { fetchBytes } = fakeFetch(['hero']);
    const { files, resolve, failed } = await collectArchiveImages(withImage(), { fetchBytes });
    expect(Object.keys(files)).toHaveLength(0);
    expect(resolve(remote('hero'))).toBeUndefined();
    expect(failed).toHaveLength(1);
  });

  it('reaches images inside body blocks, not only the hero', async () => {
    const { asked, fetchBytes } = fakeFetch();
    const inBody = bundle({
      posts: [
        {
          title: 'A', slug: 'a', tags: [], status: 'published' as const,
          blocks: [{ type: 'image' as const, image: remote('inline') }],
        },
      ],
    });
    await collectArchiveImages(inBody, { fetchBytes });
    expect(asked).toEqual(['https://cdn.test/inline.jpg']);
  });
});

describe('exportGhostArchive', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });
  async function scratch() {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'themeseed-export-'));
    dirs.push(dir);
    return dir;
  }

  const png = encodePng(8, 6, () => ({ r: 9, g: 9, b: 9 }));
  const fetchBytes = async () => png;

  it('writes one importable archive to the requested directory', async () => {
    const outDir = await scratch();
    const result = await exportGhostArchive(bundle(), { outDir, fetchBytes });
    expect(result.zipPath).toBe(path.join(outDir, 'content-export.zip'));
    await expect(fs.stat(result.zipPath)).resolves.toBeDefined();
  });

  it('puts content.json and the images inside that archive', async () => {
    const outDir = await scratch();
    const withHero = bundle({
      posts: [
        {
          title: 'P', slug: 'p', blocks: [], tags: [], status: 'published' as const,
          featureImage: { kind: 'url' as const, location: 'https://cdn.test/hero.jpg' },
        },
      ],
    });
    const { zipPath } = await exportGhostArchive(withHero, { outDir, fetchBytes });
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    expect(listing).toContain('content.json');
    expect(listing).toMatch(/images\/\d{4}\/\d{2}\/hero\.png/);
  });

  it('points the post at the bundled image, not the CDN it came from', async () => {
    const outDir = await scratch();
    const withHero = bundle({
      posts: [
        {
          title: 'P', slug: 'p', blocks: [], tags: [], status: 'published' as const,
          featureImage: { kind: 'url' as const, location: 'https://cdn.test/hero.jpg' },
        },
      ],
    });
    const { zipPath } = await exportGhostArchive(withHero, { outDir, fetchBytes });
    const json = execFileSync('unzip', ['-p', zipPath, 'content.json'], { encoding: 'utf8' });
    const post = JSON.parse(json).db[0].data.posts[0];
    expect(post.feature_image).toMatch(/^\/content\/images\//);
    expect(json).not.toContain('cdn.test');
  });

  it('reports what it bundled, so a caller can see images that failed', async () => {
    const outDir = await scratch();
    const result = await exportGhostArchive(bundle(), { outDir, fetchBytes });
    expect(result.stats).toMatchObject({ posts: 1, images: 0, failedImages: 0 });
  });
});

describe('buildGhostArchive — fields a theme actually renders', () => {
  it('carries the excerpt, which post cards display instead of truncated body', async () => {
    const d = data(
      bundle({
        posts: [
          {
            title: 'P', slug: 'p', blocks: [], tags: [], status: 'published' as const,
            excerpt: 'A short summary.',
          },
        ],
      }),
    );
    expect(d.posts![0]!['custom_excerpt']).toBe('A short summary.');
  });

  it('marks some posts featured, or a theme\'s featured section renders empty', async () => {
    const many = bundle({
      posts: Array.from({ length: 6 }, (_, i) => ({
        title: `P${i}`, slug: `p${i}`, blocks: [], tags: [], status: 'published' as const,
      })),
    });
    const featured = data(many).posts!.filter((p) => p['featured'] === true);
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.length).toBeLessThan(6);
  });

  it('never marks a page featured — only posts appear in featured collections', async () => {
    const d = data(
      bundle({ pages: [{ title: 'About', slug: 'about', blocks: [], status: 'published' }] }),
    );
    expect(d.posts!.find((p) => p['type'] === 'page')!['featured']).toBe(false);
  });
});

describe('buildGhostArchive — the archive must be removable again', () => {
  it('tags every post with the seed marker so a wipe can find it', async () => {
    // Rule 3 of the provider contract: tag everything this tool creates. The
    // export creates content too — untagged, `themeseed wipe` cannot see it
    // and the only way to undo an import is by hand, post by post.
    const d = data(bundle());
    const tagIds = d.posts_tags!.map((j) => j['tag_id']);
    const seed = d.tags!.find((t) => t['name'] === '#themeseed');
    expect(seed).toBeDefined();
    expect(tagIds).toContain(seed!['id']);
  });

  it('tags pages too, since a page is content this tool created', async () => {
    const d = data(
      bundle({ pages: [{ title: 'About', slug: 'about', blocks: [], status: 'published' }] }),
    );
    const seedId = d.tags!.find((t) => t['name'] === '#themeseed')!['id'];
    const pageId = d.posts!.find((p) => p['type'] === 'page')!['id'];
    expect(d.posts_tags).toContainEqual(
      expect.objectContaining({ post_id: pageId, tag_id: seedId }),
    );
  });

  it('gives the marker the slug Ghost derives, or the wipe filter matches nothing', async () => {
    // Ghost slugifies the internal tag "#themeseed" to "hash-themeseed" and
    // filters on slug. Getting this wrong is how a wipe silently finds zero.
    const seed = data(bundle()).tags!.find((t) => t['name'] === '#themeseed')!;
    expect(seed['slug']).toBe('hash-themeseed');
    expect(seed['visibility']).toBe('internal');
  });

  it('keeps the marker out of the visible tag list', async () => {
    const d = data(bundle());
    const publicTags = d.tags!.filter((t) => t['visibility'] === 'public');
    expect(publicTags.map((t) => t['name'])).not.toContain('#themeseed');
  });
});
