/**
 * Manual probe: run the theme analyzer against the Ghost instance in .env and
 * print what it found. Not part of the test suite — this is the tool you reach
 * for when a theme reports something surprising and you want the evidence.
 *
 *   npx tsx scripts/probe-theme.ts [--themes-dir /path/to/content/themes]
 */

import 'dotenv/config';

import { GhostClient } from '../src/providers/ghost/client.js';
import { analyzeGhostTheme } from '../src/providers/ghost/theme/index.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = process.env.GHOST_TEST_BLOG_ENDPOINT;
const key = process.env.GHOST_TEST_BLOG_KEY;

if (!url || !key) {
  console.error('Set GHOST_TEST_BLOG_ENDPOINT and GHOST_TEST_BLOG_KEY in .env first.');
  process.exit(1);
}

const client = new GhostClient({ url, adminApiKey: key });

const site = await client.getSite();
console.log(`site:  ${site.title} (Ghost ${site.version}) at ${site.url}`);

const themesDir = arg('themes-dir') ?? process.env.GHOST_THEMES_DIR;
const started = Date.now();
const capabilities = await analyzeGhostTheme(client, url, themesDir ? { themesDir } : {});
const elapsed = Date.now() - started;

const { evidence, ...summary } = capabilities;
console.log(`\ncapabilities (${elapsed}ms):`);
console.log(JSON.stringify(summary, null, 2));
console.log('\nevidence:');
for (const line of evidence) console.log(`  - ${line}`);
