/**
 * End-to-end tests against a real Ghost instance.
 *
 * Nothing here is mocked. The point is to catch the things a mock cannot: that
 * Ghost accepts our Lexical, that its renderer produces the card markup themes
 * style, that uploads survive, and that the wipe filter matches exactly our own
 * content and nothing else.
 *
 * Requires GHOST_TEST_BLOG_ENDPOINT and GHOST_TEST_BLOG_KEY. Point them at a
 * disposable instance — these tests create and delete posts.
 */

import 'dotenv/config';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedSite } from '../../src/core/seed.js';
import { SEED_TAG } from '../../src/core/types.js';
import { GhostClient } from '../../src/providers/ghost/client.js';
import { GhostProvider } from '../../src/providers/ghost/index.js';
import type { SiteConfig } from '../../src/providers/provider.js';

const endpoint = process.env.GHOST_TEST_BLOG_ENDPOINT;
const adminApiKey = process.env.GHOST_TEST_BLOG_KEY;
const ready = Boolean(endpoint && adminApiKey);

// Contributors without a Ghost instance should get a clear skip, not red tests.
const describeGhost = ready ? describe : describe.skip;
if (!ready) {
  console.warn(
    '\n[e2e] skipped: set GHOST_TEST_BLOG_ENDPOINT and GHOST_TEST_BLOG_KEY in .env to run these.\n'
  );
}

const site: SiteConfig = {
  platform: 'ghost',
  url: endpoint ?? 'http://localhost:2368',
  credentials: { adminApiKey: adminApiKey ?? '' },
  ...(process.env.GHOST_THEMES_DIR
    ? { options: { themesDir: process.env.GHOST_THEMES_DIR } }
    : {}),
};

describeGhost('Ghost provider (live)', () => {
  const client = new GhostClient({ url: site.url, adminApiKey: adminApiKey ?? '' });
  const provider = new GhostProvider(site);

  // Leftovers from an interrupted run would corrupt every count assertion.
  beforeAll(async () => {
    await provider.wipeSeeded();
  });

  afterAll(async () => {
    await provider.wipeSeeded();
  });

  it('connects and identifies the site', async () => {
    const info = await provider.verifyConnection();
    expect(info.title).toBeTruthy();
    expect(info.version).toMatch(/^\d+\./);
  });

  it('rejects a bad admin key rather than reporting a false success', async () => {
    // Ghost answers GET /site/ without authentication, so verifying with that
    // endpoint alone would accept any key at all.
    const bad = new GhostProvider({
      ...site,
      credentials: { adminApiKey: '1234abcd:00ff00ff00ff00ff' },
    });
    await expect(bad.verifyConnection()).rejects.toThrow(/401|Admin API key/i);
  });

  it('analyzes the active theme with evidence', async () => {
    const capabilities = await provider.analyzeTheme();

    expect(capabilities.platform).toBe('ghost');
    expect(capabilities.themeName).toBeTruthy();
    expect(capabilities.analyzedVia.length).toBeGreaterThan(0);
    expect(capabilities.evidence.length).toBeGreaterThan(0);
    expect(capabilities.confidence).toBeGreaterThan(0);
    expect(capabilities.expectedWordCount.min).toBeLessThan(
      capabilities.expectedWordCount.target
    );
  });

  it('starts from an empty seeded set', async () => {
    expect(await provider.listSeeded()).toHaveLength(0);
  });

  describe('seed, verify and wipe', () => {
    const COUNT = 3;

    it('publishes posts Ghost renders with the cards the theme supports', async () => {
      const report = await seedSite({
        site,
        topic: 'SaaS productivity blog',
        count: COUNT,
        imageSource: 'ai',
        imageSourceOptions: { ai: { adapter: 'procedural' } },
        status: 'published',
        // Procedural images and no video keep this test hermetic and quick;
        // the network-dependent paths are exercised by `npm run test:loop`.
        includeVideo: false,
        seed: 424242,
      });

      expect(report.failed).toBe(0);
      expect(report.created).toBe(COUNT);

      // Read back through Ghost's own API, not through listSeeded, so a bug
      // affecting both write and read cannot hide.
      const posts = await client.listPosts({
        filter: 'tag:hash-themeseed',
        formats: 'html',
        limit: 'all',
      });
      expect(posts).toHaveLength(COUNT);

      for (const post of posts) {
        expect(post.status).toBe('published');
        expect(post.tags?.some((tag) => tag.name === SEED_TAG)).toBe(true);
        expect(post.html ?? '').not.toMatch(/<img[^>]+src=["']["']/);
        expect(wordCount(post.html ?? '')).toBeGreaterThanOrEqual(
          report.capabilities.expectedWordCount.min
        );
      }

      if (report.capabilities.supportsFeatureImage) {
        expect(posts.every((post) => Boolean(post.feature_image))).toBe(true);
      }

      const html = posts.map((post) => post.html ?? '').join('\n');
      if (report.capabilities.supportsGallery && report.generation.withGallery > 0) {
        expect(html).toContain('kg-gallery-card');
      }
      if (!report.capabilities.supportsGallery) {
        // The whole point of analyzing the theme first.
        expect(html).not.toContain('kg-gallery-card');
      }
    }, 180_000);

    it('lists exactly what it created', async () => {
      const seeded = await provider.listSeeded();
      expect(seeded).toHaveLength(COUNT);
      expect(seeded.every((result) => result.id)).toBe(true);
    });

    it('leaves content it did not create alone', async () => {
      const untagged = await client.createPost({
        title: 'themeseed e2e bystander — should survive',
        status: 'draft',
        // Ghost rejects a root with no children — which is exactly why
        // blocksToLexical always emits at least one paragraph.
        lexical: JSON.stringify({
          root: {
            type: 'root',
            version: 1,
            children: [
              {
                type: 'paragraph',
                version: 1,
                direction: 'ltr',
                format: '',
                indent: 0,
                children: [
                  {
                    type: 'text',
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: 'Not created by themeseed.',
                    version: 1,
                  },
                ],
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
          },
        }),
      });

      try {
        const summary = await provider.wipeSeeded();
        expect(summary.removed).toBe(COUNT);
        expect(await provider.listSeeded()).toHaveLength(0);

        // The bystander must still be there. This is the one unforgivable bug.
        const survivors = await client.listPosts({ filter: `id:${untagged.id}` });
        expect(survivors).toHaveLength(1);
      } finally {
        await client.deletePost(untagged.id);
      }
    }, 120_000);
  });

  it('records a per-item error instead of losing the whole batch', async () => {
    // A post whose only image is unreachable should still be created, minus
    // the image, rather than aborting the run.
    const results = await provider.createContent([
      {
        title: 'themeseed e2e degraded image',
        blocks: [
          { type: 'paragraph', text: 'Body copy survives.' },
          {
            type: 'image',
            image: {
              kind: 'url',
              location: 'https://127.0.0.1:9/definitely-not-there.jpg',
            },
          },
        ],
        tags: [],
        status: 'draft',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBeUndefined();
    const created = await client.listPosts({
      filter: `id:${results[0]!.id}`,
      formats: 'html',
    });
    expect(created[0]?.html ?? '').toContain('Body copy survives');
    expect(created[0]?.html ?? '').not.toContain('<img');
  }, 120_000);

  it('uploads a real image and serves it back', async () => {
    const { encodePng } = await import('../../src/images/png.js');
    const bytes = encodePng(120, 80, (x, y) => ({ r: x, g: y, b: 128 }));
    const uploaded = await client.uploadImage(bytes, 'themeseed-e2e.png', 'image/png');

    expect(uploaded.url).toMatch(/^https?:\/\//);
    const response = await fetch(uploaded.url);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('image');
  }, 60_000);

  it('reads images from a local directory and publishes them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-e2e-local-'));
    try {
      const { encodePng } = await import('../../src/images/png.js');
      const { LocalImageSource } = await import('../../src/images/local-source.js');
      await fs.writeFile(
        path.join(dir, 'standing-desk-morning.png'),
        encodePng(600, 400, () => ({ r: 200, g: 120, b: 90 }))
      );

      const source = new LocalImageSource({ directory: dir });
      expect(await source.isAvailable()).toBe(true);

      const refs = await source.fetch({ query: 'office', aspectRatio: 1.5 }, 1);
      expect(refs).toHaveLength(1);
      // Descriptive filenames make better alt text than the query does.
      expect(refs[0]?.alt).toBe('standing desk morning');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function wordCount(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
