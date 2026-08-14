/**
 * Manual probe: exercise every image source and prove the bytes each returns
 * are a real, decodable image of the expected shape.
 *
 *   npx tsx scripts/probe-images.ts
 */

import 'dotenv/config';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ImageRef, ImageSourceKind } from '../src/core/types.js';
import { createImageSource, probeImage } from '../src/images/index.js';
import { AiImageSource } from '../src/images/ai-source.js';
import { StockImageSource } from '../src/images/stock-source.js';

const request = {
  query: 'a tidy home office with a standing desk',
  aspectRatio: 1.5,
  minWidth: 1200,
  role: 'feature' as const,
};

async function bytesFor(ref: ImageRef): Promise<Uint8Array> {
  if (ref.kind === 'file') return new Uint8Array(await fs.readFile(ref.location));
  const response = await fetch(ref.location, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The `local` source needs a directory; build a throwaway one from `ai` output. */
async function seedLocalFixtures(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'themeseed-probe-local');
  await fs.mkdir(dir, { recursive: true });
  const ai = new AiImageSource({ adapter: 'procedural', outputDir: dir });
  await ai.fetch({ query: 'fixture backdrop', aspectRatio: 1.5, minWidth: 1200 }, 3);
  return dir;
}

const localDir = await seedLocalFixtures();
let failures = 0;

for (const kind of ['local', 'stock', 'ai'] as ImageSourceKind[]) {
  const source = createImageSource(kind, {
    local: { directory: localDir },
    ai: { adapter: 'procedural' },
  });

  const label =
    source instanceof StockImageSource
      ? `stock (${source.providerName})`
      : source instanceof AiImageSource
        ? `ai (${source.adapterName})`
        : kind;

  if (!(await source.isAvailable())) {
    console.log(`\n${label}: UNAVAILABLE — ${await source.unavailableReason()}`);
    failures += 1;
    continue;
  }

  console.log(`\n${label}:`);
  try {
    const refs = await source.fetch(request, 3);
    if (refs.length === 0) {
      console.log('  FAIL: returned no images');
      failures += 1;
      continue;
    }
    for (const ref of refs) {
      const bytes = await bytesFor(ref);
      const info = probeImage(bytes);
      if (!info) {
        console.log(`  FAIL: ${ref.location} is not a decodable image (${bytes.length} bytes)`);
        failures += 1;
        continue;
      }
      console.log(
        `  ok  ${info.format} ${info.width}x${info.height} ` +
          `(${(bytes.length / 1024).toFixed(0)}KB) — ${ref.credit ?? ref.alt ?? ''}`
      );
    }
  } catch (err) {
    console.log(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
    failures += 1;
  }
}

console.log(failures === 0 ? '\nAll image sources returned valid images.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
