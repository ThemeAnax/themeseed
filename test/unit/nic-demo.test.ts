import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeseedError } from '../../src/core/errors.js';
import type { ImageRef } from '../../src/core/types.js';
import { encodePng, hashString } from '../../src/images/png.js';
import type { ImageSource } from '../../src/images/source.js';
import { exportNicDemo, NicDemoUsageError } from '../../src/nic-demo/index.js';
import {
  validateContentSchema,
  validateRequestSchema,
} from '../../src/nic-demo/schema.js';
import type {
  MediaFile,
  NicContent,
  NicContentRequest,
  NicCredits,
} from '../../src/nic-demo/types.js';
import { validateNicContent } from '../../src/nic-demo/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixtures = path.join(here, 'fixtures', 'nic-demo');
const NOW = new Date('2026-10-13T12:00:00Z');

let work: string;
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'nic-demo-test-'));
});
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

async function fixtureRequest(): Promise<NicContentRequest> {
  return JSON.parse(
    await fs.readFile(path.join(fixtures, 'content-request.json'), 'utf8')
  );
}

/**
 * Offline "AI" source: refs point at in-memory pictures (see `memoryBytes`).
 * The real procedural adapter renders ~1000px PNGs, which makes a 30-image run
 * take tens of seconds — far too slow for a unit test that checks structure.
 */
function offlineAi(): ImageSource {
  return {
    kind: 'ai',
    isAvailable: async () => true,
    unavailableReason: async () => '',
    fetch: async (request, count): Promise<ImageRef[]> =>
      Array.from({ length: count }, (_, i) => ({
        kind: 'file' as const,
        location: `mem://${hashString(`${request.query}#${i}`)}`,
        source: 'ai' as const,
        credit: 'Image generated with test-model',
      })),
  };
}

/** A tiny, distinct PNG per `mem://<hash>` location. */
async function memoryBytes(ref: ImageRef): Promise<Uint8Array> {
  const n = Number(ref.location.replace('mem://', ''));
  return encodePng(48 + (n % 9), 36, (x, y) => ({
    r: (n + x) % 256,
    g: (n >> 3) % 256,
    b: (y * 5) % 256,
  }));
}

function run(
  request: NicContentRequest,
  overrides: Partial<Parameters<typeof exportNicDemo>[0]> = {}
) {
  return exportNicDemo({
    request: request as unknown as Record<string, unknown>,
    outDir: path.join(work, 'theme', 'demo'),
    creditsPath: path.join(work, 'work', 'credits.json'),
    imageSource: offlineAi(),
    fetchBytes: memoryBytes,
    now: NOW,
    env: {},
    ...overrides,
  });
}

async function readOutput(): Promise<{
  content: NicContent;
  credits: NicCredits;
  media: string[];
}> {
  const demo = path.join(work, 'theme', 'demo');
  const content = JSON.parse(
    await fs.readFile(path.join(demo, 'posts.json'), 'utf8')
  ) as NicContent;
  const credits = JSON.parse(
    await fs.readFile(path.join(work, 'work', 'credits.json'), 'utf8')
  ) as NicCredits;
  const media = (await fs.readdir(path.join(demo, 'content-media'))).sort();
  return { content, credits, media };
}

async function allMedia(): Promise<MediaFile[]> {
  const dir = path.join(work, 'theme', 'demo', 'content-media');
  return Promise.all(
    (await fs.readdir(dir)).map(async (name) => ({
      name,
      bytes: new Uint8Array(await fs.readFile(path.join(dir, name))),
    }))
  );
}

function bigRequest(): NicContentRequest {
  return {
    format: 'nic-content-request/1',
    theme: 'sunmile-holidays',
    target: 'themeforest',
    site: {
      name: 'Sunmile Holidays',
      topic: 'boutique travel agency — tailor-made holidays',
    },
    images: { source: 'ai' },
    types: {
      post: {
        count: 6,
        seeds: [
          {
            key: 'seed-post',
            title: 'A seeded post',
            excerpt: 'Verbatim excerpt.',
            content: '<p>Verbatim body.</p>',
            image_size: [420, 360],
          },
        ],
      },
      team: {
        count: 4,
        seeds: [
          {
            key: 'ana',
            title: 'Ana Lima',
            meta: { nic_role: 'Bali & Indonesia', nic_bogus: 'x' },
          },
        ],
      },
      portfolio: { count: 5 },
      testimonial: { count: 5 },
      service: { count: 4 },
      product: { count: 7 },
    },
  };
}

describe('request validation', () => {
  it('accepts the committed mcphub fixture request', async () => {
    expect(validateRequestSchema(await fixtureRequest())).toEqual([]);
  });

  it('rejects a wrong format, unknown type and unknown field with readable lines', async () => {
    const bad = {
      ...(await fixtureRequest()),
      format: 'nope',
      types: { page: { count: 1 } },
    };
    const problems = validateRequestSchema(bad);
    expect(problems.join('\n')).toMatch(/format/);
    expect(problems.join('\n')).toMatch(/page/);
  });

  it('raises a usage error (exit 2) for an invalid request, a missing file and duplicate seed keys', async () => {
    await expect(run({ nope: true } as never)).rejects.toBeInstanceOf(NicDemoUsageError);
    await expect(run(path.join(work, 'missing.json') as never)).rejects.toBeInstanceOf(
      NicDemoUsageError
    );
    const dup = await fixtureRequest();
    dup.types.post = {
      count: 3,
      seeds: [
        { key: 'a', title: 'A' },
        { key: 'a', title: 'B' },
      ],
    };
    await expect(run(dup)).rejects.toThrow(/appears twice/);
  });

  it('refuses a --credits path inside --out', async () => {
    await expect(
      run(await fixtureRequest(), {
        creditsPath: path.join(work, 'theme', 'demo', 'credits.json'),
      })
    ).rejects.toThrow(/inside --out/);
  });
});

describe('generation', () => {
  it('keeps seeds byte for byte, fills only empty fields and generates count minus seeds extras', async () => {
    const request = bigRequest();
    const report = await run(request);
    const { content } = await readOutput();

    expect(report.counts).toEqual({
      post: 6,
      team: 4,
      portfolio: 5,
      testimonial: 5,
      service: 4,
      product: 7,
    });

    const seed = content.items.post![0]!;
    expect(seed.key).toBe('seed-post');
    expect(seed.title).toBe('A seeded post');
    expect(seed.excerpt).toBe('Verbatim excerpt.');
    expect(seed.content).toBe('<p>Verbatim body.</p>');
    expect(seed.date).toBeTruthy(); // empty on the seed, so filled
    expect(seed.image).toMatch(/^content-media\//);
    expect(content.items.post).toHaveLength(6);

    const ana = content.items.team![0]!;
    expect(ana.meta?.nic_role).toBe('Bali & Indonesia');
    expect(ana.meta).not.toHaveProperty('nic_bogus');
    expect(report.warnings.join('\n')).toMatch(/nic_bogus/);
  });

  it('keeps all seeds and warns when they exceed the count', async () => {
    const request = await fixtureRequest();
    request.types.post = {
      count: 1,
      seeds: [
        { key: 'a', title: 'A' },
        { key: 'b', title: 'B' },
      ],
    };
    const report = await run(request);
    expect(report.counts.post).toBe(2);
    expect(report.warnings.join('\n')).toMatch(/exceed count/);
  });

  it('does not generate types absent from the request', async () => {
    const request = await fixtureRequest();
    request.types = { service: { count: 2 } };
    await run(request);
    const { content } = await readOutput();
    expect(Object.keys(content.items)).toEqual(['service']);
    expect(content.terms).toBeUndefined();
  });

  it('follows the meta, term, date and product rules', async () => {
    await run(bigRequest());
    const { content } = await readOutput();

    const termKeys = (tax: keyof NonNullable<NicContent['terms']>) =>
      new Set((content.terms?.[tax] ?? []).map((t) => t.key));
    for (const post of content.items.post!) {
      expect(post.meta).toBeUndefined();
      for (const key of post.terms?.category ?? [])
        expect(termKeys('category').has(key)).toBe(true);
      for (const key of post.terms?.post_tag ?? [])
        expect(termKeys('post_tag').has(key)).toBe(true);
      expect(Date.parse(`${post.date}Z`)).toBeLessThan(NOW.getTime());
    }
    for (const item of content.items.portfolio!) {
      expect(
        Object.keys(item.meta ?? {}).every((k) =>
          ['nic_client', 'nic_year', 'nic_project_url'].includes(k)
        )
      ).toBe(true);
      expect(
        termKeys('nic_portfolio_category').has(item.terms!.nic_portfolio_category![0]!)
      ).toBe(true);
    }
    for (const item of content.items.testimonial!)
      expect(item.meta?.nic_rating).toMatch(/^[1-5]$/);
    for (const item of content.items.service!)
      expect(Object.keys(item.meta ?? {})).toEqual(['nic_icon']);

    const skus = new Set<string>();
    for (const product of content.items.product!) {
      const block = product.product!;
      expect(block.type).toBe('simple');
      expect(block.sku).toMatch(/^[A-Z0-9-]{1,40}$/);
      expect(skus.has(block.sku)).toBe(false);
      skus.add(block.sku);
      expect(block.regular_price).toMatch(/^\d+\.\d{2}$/);
      if (block.sale_price !== '')
        expect(Number(block.sale_price)).toBeLessThan(Number(block.regular_price));
      expect(Date.parse(`${product.date}Z`)).toBeLessThan(NOW.getTime());
    }
    expect(content.items.product!.some((p) => p.product!.sale_price !== '')).toBe(true);
  });

  it('references body images by content-media path and never remotely', async () => {
    await run(bigRequest());
    const { content } = await readOutput();
    const generated = content.items.post![1]!;
    expect(generated.content).toMatch(/<img src="content-media\/[a-z0-9-]+\.png"/);
    expect(generated.content).not.toMatch(/https?:\/\//);
  });

  it('is deterministic for the same request and time', async () => {
    await run(bigRequest());
    const first = await fs.readFile(
      path.join(work, 'theme', 'demo', 'posts.json'),
      'utf8'
    );
    await run(bigRequest());
    expect(
      await fs.readFile(path.join(work, 'theme', 'demo', 'posts.json'), 'utf8')
    ).toBe(first);
  });
});

describe('images and credits', () => {
  it('writes no image fields and no files for images.source "none"', async () => {
    const request = bigRequest();
    request.images = { source: 'none' };
    const report = await run(request, { imageSource: undefined });
    const { content, credits } = await readOutput().catch(async () => ({
      content: JSON.parse(
        await fs.readFile(path.join(work, 'theme', 'demo', 'posts.json'), 'utf8')
      ) as NicContent,
      credits: JSON.parse(
        await fs.readFile(path.join(work, 'work', 'credits.json'), 'utf8')
      ) as NicCredits,
      media: [] as string[],
    }));
    for (const items of Object.values(content.items)) {
      for (const item of items!) {
        expect(item).not.toHaveProperty('image');
        expect(item).not.toHaveProperty('gallery');
      }
    }
    expect(credits.assets).toEqual([]);
    expect(report.written).toEqual(['posts.json']);
  });

  it('refuses stock images for themeforest and wordpress.org with a fix message', async () => {
    for (const target of ['themeforest', 'wordpress.org'] as const) {
      const request = await fixtureRequest();
      request.target = target;
      request.images = { source: 'stock' };
      const error = await run(request, { imageSource: undefined }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ThemeseedError);
      expect((error as ThemeseedError).code).toBe('STOCK_REFUSED');
      expect((error as ThemeseedError).hint).toMatch(/"ai" or "local"/);
    }
    // Nothing was written.
    await expect(
      fs.stat(path.join(work, 'theme', 'demo', 'posts.json'))
    ).rejects.toThrow();
  });

  it('does not let auto pick stock for a GPL target even when a stock key exists', async () => {
    const request = await fixtureRequest();
    request.images = { source: 'auto' };
    const report = await run(request, {
      imageSource: undefined,
      env: { UNSPLASH_ACCESS_KEY: 'x' },
    });
    expect(report.written).toEqual(['posts.json']);
    expect(report.warnings.join('\n')).toMatch(/no usable source/);
  });

  it('allows stock for client targets and credits it with its real licence and URL', async () => {
    const png = encodePng(40, 30, () => ({ r: 10, g: 120, b: 200 }));
    const stock: ImageSource = {
      kind: 'stock',
      isAvailable: async () => true,
      unavailableReason: async () => '',
      fetch: async (request, count): Promise<ImageRef[]> =>
        Array.from({ length: count }, (_, i) => ({
          kind: 'url' as const,
          location: `https://images.unsplash.com/photo-${encodeURIComponent(request.query).length}-${i}`,
          credit: 'Photo by Jane on Unsplash',
          source: 'stock' as const,
        })),
    };
    const request = await fixtureRequest();
    request.target = 'client';
    request.images = { source: 'stock' };
    request.types = { service: { count: 2 } };
    await run(request, { imageSource: stock, fetchBytes: async () => png });
    const { credits } = await readOutput();
    expect(credits.assets.length).toBeGreaterThan(0);
    expect(credits.assets[0]).toMatchObject({
      license: 'LicenseRef-Unsplash',
      author: 'Photo by Jane on Unsplash',
    });
    expect(credits.assets[0]!.source).toMatch(/^https:\/\/images\.unsplash\.com\//);
  });

  it('credits a local folder to the site name as GPL-2.0-or-later', async () => {
    const request = await fixtureRequest();
    request.images = { source: 'local' };
    const report = await run(request, {
      imageSource: undefined,
      fetchBytes: undefined,
      imageSourceOptions: {
        local: { directory: path.join(fixtures, 'demo-v2', 'content-media') },
      },
    });
    expect(report.written.length).toBeGreaterThan(1);
    const { credits } = await readOutput();
    for (const asset of credits.assets) {
      expect(asset).toMatchObject({
        license: 'GPL-2.0-or-later',
        author: 'Northwind Studio',
      });
    }
  });

  it('writes exactly one credit per file, with demo/ paths, and meets the media limits', async () => {
    await run(bigRequest());
    const { credits, media, content } = await readOutput();
    expect(credits.assets.map((a) => a.path).sort()).toEqual(
      media.map((m) => `demo/content-media/${m}`)
    );
    let total = 0;
    for (const file of await allMedia()) {
      total += file.bytes.byteLength;
      expect(file.name).toMatch(/^[a-z0-9][a-z0-9-]*\.(jpg|png|webp)$/);
      expect(file.bytes.byteLength).toBeLessThanOrEqual(500 * 1024);
    }
    expect(total).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(content.items.portfolio![0]!.gallery!.length).toBeGreaterThan(0);
  });

  it('skips an oversize image with a warning instead of shipping it', async () => {
    const big: ImageSource = {
      kind: 'ai',
      isAvailable: async () => true,
      unavailableReason: async () => '',
      fetch: async (_r, count) =>
        Array.from({ length: count }, (_, i) => ({
          kind: 'file' as const,
          location: `/x/${i}.png`,
          source: 'ai' as const,
        })),
    };
    const huge = encodePng(2400, 100, () => ({ r: 1, g: 2, b: 3 }));
    const request = await fixtureRequest();
    request.types = { service: { count: 1 } };
    await expect(
      run(request, { imageSource: big, fetchBytes: async () => huge })
    ).rejects.toMatchObject({ code: 'NO_USABLE_IMAGES' });
  });
});

describe('output validation', () => {
  it('validates every generated package against the nic-content/1 schema and cross rules', async () => {
    await run(bigRequest());
    const { content, credits } = await readOutput();
    expect(validateContentSchema(content)).toEqual([]);
    expect(
      validateNicContent(content, { media: await allMedia(), credits, now: NOW })
    ).toEqual([]);
  });

  it('catches broken references, files and prices', async () => {
    await run(bigRequest());
    const { content, credits } = await readOutput();
    const media = await allMedia();

    const broken = structuredClone(content);
    broken.items.post![0]!.terms = { category: ['does-not-exist'] };
    broken.items.product![0]!.product!.sale_price = '999999.00';
    broken.items.product![1]!.product!.sku = broken.items.product![0]!.product!.sku;
    broken.items.post![1]!.image = 'content-media/ghost.png';
    const problems = validateNicContent(broken, { media, credits, now: NOW }).join('\n');
    expect(problems).toMatch(/does-not-exist/);
    expect(problems).toMatch(/sale_price/);
    expect(problems).toMatch(/duplicate sku/);
    expect(problems).toMatch(/ghost\.png: referenced but missing/);
    expect(problems).toMatch(/never referenced/);

    const noCredit = validateNicContent(content, {
      media,
      credits: { assets: credits.assets.slice(1) },
      now: NOW,
    }).join('\n');
    expect(noCredit).toMatch(/credits: no entry for/);
  });

  it('rejects schema violations such as a bad rating or a remote image', async () => {
    const doc = {
      format: 'nic-content/1',
      generator: 't',
      theme: 'x',
      items: {
        testimonial: [
          {
            key: 'a',
            title: 'A',
            meta: { nic_rating: '9' },
            image: 'https://x.test/a.jpg',
          },
        ],
      },
    };
    expect(validateContentSchema(doc).length).toBeGreaterThan(0);
  });

  it('refuses to write when a seed makes the output invalid', async () => {
    const request = await fixtureRequest();
    request.types = {
      post: {
        count: 1,
        seeds: [{ key: 'x', title: 'X', content: '<img src="https://evil.test/a.jpg">' }],
      },
    };
    await expect(run(request)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(
      fs.stat(path.join(work, 'theme', 'demo', 'posts.json'))
    ).rejects.toThrow();
  });

  it('validates the committed mcphub fixture (content, media and credits)', async () => {
    const dir = path.join(fixtures, 'demo-v2');
    const content = JSON.parse(await fs.readFile(path.join(dir, 'posts.json'), 'utf8'));
    const credits = JSON.parse(
      await fs.readFile(path.join(fixtures, 'content-credits.json'), 'utf8')
    ) as NicCredits;
    const media: MediaFile[] = await Promise.all(
      (await fs.readdir(path.join(dir, 'content-media'))).map(async (name) => ({
        name,
        bytes: new Uint8Array(await fs.readFile(path.join(dir, 'content-media', name))),
      }))
    );
    expect(validateNicContent(content, { media, credits, now: NOW })).toEqual([]);
  });
});

describe('writing', () => {
  it('replaces posts.json and content-media wholesale and touches nothing else', async () => {
    const demo = path.join(work, 'theme', 'demo');
    await fs.mkdir(path.join(demo, 'content-media'), { recursive: true });
    await fs.mkdir(path.join(demo, 'pages'), { recursive: true });
    await fs.writeFile(path.join(demo, 'content-media', 'stale-old.png'), 'x');
    await fs.writeFile(path.join(demo, 'manifest.json'), '{"keep":true}');
    await fs.writeFile(path.join(demo, 'pages', 'home.json'), '{"page":1}');

    const first = await run(bigRequest());
    expect(first.written).not.toContain('content-media/stale-old.png');
    await expect(
      fs.stat(path.join(demo, 'content-media', 'stale-old.png'))
    ).rejects.toThrow();

    // second run with fewer images: leftovers from run one must disappear
    const smaller = bigRequest();
    smaller.types = { service: { count: 1 } };
    const second = await run(smaller);
    const names = (await fs.readdir(path.join(demo, 'content-media')))
      .map((n) => `content-media/${n}`)
      .sort();
    expect(names).toEqual(second.written.filter((w) => w !== 'posts.json'));

    expect(await fs.readFile(path.join(demo, 'manifest.json'), 'utf8')).toBe(
      '{"keep":true}'
    );
    expect(await fs.readFile(path.join(demo, 'pages', 'home.json'), 'utf8')).toBe(
      '{"page":1}'
    );
    // no staging leftovers
    expect((await fs.readdir(demo)).filter((n) => n.startsWith('.'))).toEqual([]);
    // credits live outside --out
    await expect(fs.stat(path.join(demo, 'credits.json'))).rejects.toThrow();
  });
});

describe('CLI', () => {
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(repoRoot, 'src/cli/index.ts'), 'nic-demo', ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          THEMESEED_CONFIG_DIR: path.join(work, 'cfg'),
          UNSPLASH_ACCESS_KEY: '',
          PEXELS_API_KEY: '',
        },
      }
    );

  it('exits 2 on usage errors', () => {
    expect(cli([]).status).toBe(2);
    expect(
      cli([
        '--request',
        path.join(work, 'nope.json'),
        '--out',
        work,
        '--credits',
        path.join(work, 'c.json'),
      ]).status
    ).toBe(2);
    expect(cli(['--bogus']).status).toBe(2);
  });

  it('exits 1 with a fix message on refusal, and 0 with one JSON report on success', async () => {
    const request = await fixtureRequest();
    request.images = { source: 'stock' };
    const refusal = path.join(work, 'refuse.json');
    await fs.writeFile(refusal, JSON.stringify(request));
    const args = (req: string) => [
      '--request',
      req,
      '--out',
      path.join(work, 'theme', 'demo'),
      '--credits',
      path.join(work, 'w', 'c.json'),
      '--json',
    ];

    const refused = cli(args(refusal));
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      code: 'STOCK_REFUSED',
    });
    expect(refused.stderr).toMatch(/"ai" or "local"/);

    request.images = { source: 'none' };
    const okFile = path.join(work, 'ok.json');
    await fs.writeFile(okFile, JSON.stringify(request));
    const ok = cli(args(okFile));
    expect(ok.status).toBe(0);
    const report = JSON.parse(ok.stdout);
    expect(report).toMatchObject({ ok: true, written: ['posts.json'], warnings: [] });
    expect(report.counts.post).toBe(2);
    expect(report.credits).toBe(path.join(work, 'w', 'c.json'));
  }, 30_000);
});
