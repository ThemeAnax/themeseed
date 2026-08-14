/**
 * The autonomous integration loop.
 *
 * Seeds a real Ghost instance, then verifies the result by reading it back
 * through Ghost's Admin API — deliberately *not* through themeseed's own
 * `listSeeded`, so a bug that affects both writing and reading cannot hide.
 * Repeats until three consecutive clean runs, then wipes and confirms zero.
 *
 *   npm run test:loop -- [--count 15] [--runs 3] [--image-source stock]
 *
 * Every iteration appends a verdict to test-loop.log.
 */

import 'dotenv/config';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { seedSite } from '../src/core/seed.js';
import type { ImageSourceKind, ThemeCapabilities } from '../src/core/types.js';
import { describeError } from '../src/core/errors.js';
import { GhostClient } from '../src/providers/ghost/client.js';
import { createProvider } from '../src/providers/registry.js';
import type { SiteConfig } from '../src/providers/provider.js';

const LOG_FILE = path.resolve('test-loop.log');

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const POST_COUNT = Number(flag('count', '15'));
const REQUIRED_CLEAN_RUNS = Number(flag('runs', '3'));
const IMAGE_SOURCE = flag('image-source', 'stock') as ImageSourceKind;
const MAX_ITERATIONS = Number(flag('max-iterations', '8'));

const endpoint = process.env.GHOST_TEST_BLOG_ENDPOINT;
const adminApiKey = process.env.GHOST_TEST_BLOG_KEY;

if (!endpoint || !adminApiKey) {
  console.error('GHOST_TEST_BLOG_ENDPOINT and GHOST_TEST_BLOG_KEY must be set in .env');
  process.exit(1);
}

const site: SiteConfig = {
  platform: 'ghost',
  url: endpoint,
  credentials: { adminApiKey },
  ...(process.env.GHOST_THEMES_DIR ? { options: { themesDir: process.env.GHOST_THEMES_DIR } } : {}),
};

const client = new GhostClient({ url: endpoint, adminApiKey });
const provider = createProvider(site);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function log(line: string): Promise<void> {
  console.log(line);
  await fs.appendFile(LOG_FILE, `${line}\n`);
}

/** Reads the seeded posts back through Ghost's own API and checks them. */
async function verify(capabilities: ThemeCapabilities): Promise<Check[]> {
  const posts = await client.listPosts({
    filter: 'tag:hash-themeseed',
    formats: 'html',
    limit: 'all',
  });

  const checks: Check[] = [];

  checks.push({
    name: 'post count',
    ok: posts.length === POST_COUNT,
    detail: `${posts.length}/${POST_COUNT} posts tagged #themeseed`,
  });

  const withFeature = posts.filter((post) => Boolean(post.feature_image));
  if (capabilities.supportsFeatureImage) {
    checks.push({
      name: 'feature images',
      ok: withFeature.length === posts.length && posts.length > 0,
      detail: `${withFeature.length}/${posts.length} posts have a feature image`,
    });
  } else {
    checks.push({
      name: 'feature images',
      ok: true,
      detail: 'skipped — theme does not display feature images',
    });
  }

  const html = posts.map((post) => post.html ?? '').join('\n');

  const galleries = countMatches(html, /kg-gallery-card/g);
  checks.push(
    capabilities.supportsGallery
      ? {
          name: 'gallery card',
          ok: galleries >= 1,
          detail: `${galleries} gallery card(s) rendered`,
        }
      : {
          name: 'gallery card',
          ok: galleries === 0,
          detail:
            galleries === 0
              ? 'skipped — theme has no gallery styles, and none were added'
              : `${galleries} gallery card(s) added despite the theme not supporting them`,
        }
  );

  const embeds = countMatches(html, /kg-embed-card/g);
  checks.push(
    capabilities.supportsVideoEmbed
      ? { name: 'video embed', ok: embeds >= 1, detail: `${embeds} video embed(s) rendered` }
      : {
          name: 'video embed',
          ok: embeds === 0,
          detail:
            embeds === 0
              ? 'skipped — theme has no embed styles, and none were added'
              : `${embeds} embed(s) added despite the theme not supporting them`,
        }
  );

  // A post whose body is a single paragraph would pass every check above while
  // being useless for previewing a theme, so length is checked too.
  const shortPosts = posts.filter(
    (post) => wordCount(post.html ?? '') < capabilities.expectedWordCount.min
  );
  checks.push({
    name: 'article length',
    ok: shortPosts.length === 0,
    detail:
      shortPosts.length === 0
        ? `all posts ≥ ${capabilities.expectedWordCount.min} words`
        : `${shortPosts.length} post(s) under ${capabilities.expectedWordCount.min} words`,
  });

  // Broken images are the most common silent failure; catch empty srcs.
  const brokenImages = countMatches(html, /<img[^>]+src=["']["']/g);
  checks.push({
    name: 'image srcs',
    ok: brokenImages === 0,
    detail: brokenImages === 0 ? 'no empty image srcs' : `${brokenImages} empty image src(s)`,
  });

  return checks;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function wordCount(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await log(`\n===== test-loop started ${new Date().toISOString()} =====`);
  await log(
    `target=${endpoint} count=${POST_COUNT} imageSource=${IMAGE_SOURCE} requiredCleanRuns=${REQUIRED_CLEAN_RUNS}`
  );

  let consecutiveClean = 0;
  let iteration = 0;

  while (consecutiveClean < REQUIRED_CLEAN_RUNS && iteration < MAX_ITERATIONS) {
    iteration += 1;
    const started = Date.now();
    await log(`\n--- iteration ${iteration} ---`);

    try {
      // Start from a known state so a count check means what it says.
      const preWipe = await provider.wipeSeeded();
      if (preWipe.removed > 0) await log(`  cleared ${preWipe.removed} leftover post(s)`);

      const report = await seedSite({
        site,
        topic: 'SaaS productivity blog',
        count: POST_COUNT,
        imageSource: IMAGE_SOURCE,
        status: 'published',
        // Vary the seed per iteration so consecutive passes are not three
        // repeats of one identical dataset.
        seed: iteration * 7919,
      });

      await log(
        `  seeded: created=${report.created} failed=${report.failed} theme=${report.capabilities.themeName} ` +
          `(confidence ${report.capabilities.confidence})`
      );
      if (report.failed > 0) {
        for (const result of report.results.filter((r) => r.error)) {
          await log(`    ! ${result.title}: ${result.error}`);
        }
      }

      const checks = await verify(report.capabilities);
      for (const check of checks) {
        await log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
      }

      const passed = checks.every((check) => check.ok) && report.failed === 0;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);

      if (passed) {
        consecutiveClean += 1;
        await log(`  RESULT: PASS (${seconds}s) — ${consecutiveClean}/${REQUIRED_CLEAN_RUNS} consecutive clean runs`);
      } else {
        consecutiveClean = 0;
        await log(`  RESULT: FAIL (${seconds}s) — consecutive counter reset`);
      }
    } catch (err) {
      consecutiveClean = 0;
      await log(`  RESULT: ERROR — ${describeError(err)}`);
    }
  }

  if (consecutiveClean < REQUIRED_CLEAN_RUNS) {
    await log(`\n===== test-loop FAILED after ${iteration} iteration(s) =====`);
    process.exit(1);
  }

  await log(`\n--- final wipe ---`);
  const summary = await provider.wipeSeeded();
  const remaining = await client.listPosts({ filter: 'tag:hash-themeseed', limit: 'all' });
  const wipeClean = remaining.length === 0;

  await log(`  removed ${summary.removed} post(s); ${remaining.length} remain`);
  await log(`  [${wipeClean ? 'PASS' : 'FAIL'}] wipe verification`);
  await log(
    `\n===== test-loop ${wipeClean ? 'PASSED' : 'FAILED'}: ${consecutiveClean} consecutive clean runs =====`
  );

  process.exit(wipeClean ? 0 : 1);
}

main().catch(async (err) => {
  await log(`FATAL: ${describeError(err)}`);
  process.exit(1);
});
