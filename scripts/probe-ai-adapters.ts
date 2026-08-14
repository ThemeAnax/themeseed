/**
 * Manual probe: try every configured AI image adapter and report whether it
 * returns a decodable image at roughly the requested aspect ratio.
 *
 *   npx tsx scripts/probe-ai-adapters.ts [--ratio 1.5]
 *
 * Adapters with no key are reported as unconfigured rather than failed.
 * Generating images costs money on every backend here — this asks for one
 * image per adapter, deliberately.
 */

import 'dotenv/config';

import { AiImageSource } from '../src/images/ai-source.js';
import type { AiAdapterName } from '../src/images/ai-source.js';
import { probeImage } from '../src/images/inspect.js';
import { describeError } from '../src/core/errors.js';
import { promises as fs } from 'node:fs';

const ratioIndex = process.argv.indexOf('--ratio');
const aspectRatio = ratioIndex >= 0 ? Number(process.argv[ratioIndex + 1]) : 1.5;

const request = {
  query:
    'a contemporary concrete apartment building, editorial architectural photography',
  aspectRatio,
  minWidth: 1200,
  role: 'feature' as const,
};

const adapters: AiAdapterName[] = ['openai', 'grok', 'gemini', 'fal', 'procedural'];
let ok = 0;

for (const name of adapters) {
  const source = new AiImageSource({ adapter: name });
  process.stdout.write(`${name.padEnd(11)} `);

  if (!(await source.isAvailable())) {
    console.log(`SKIP  ${await source.unavailableReason()}`);
    continue;
  }

  try {
    const started = Date.now();
    const refs = await source.fetch(request, 1);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (refs.length === 0) {
      console.log('FAIL  returned no images');
      continue;
    }
    const ref = refs[0]!;
    const bytes = new Uint8Array(await fs.readFile(ref.location));
    const info = probeImage(bytes);
    if (!info) {
      console.log('FAIL  bytes are not a decodable image');
      continue;
    }
    const actual = info.width / info.height;
    console.log(
      `OK    ${info.format} ${info.width}x${info.height} ` +
        `ratio ${actual.toFixed(2)} (asked ${aspectRatio}) ` +
        `${(bytes.length / 1024) | 0}KB ${elapsed}s`
    );
    console.log(`${' '.repeat(12)}${ref.credit}`);
    ok += 1;
  } catch (err) {
    console.log(`FAIL  ${describeError(err).split('\n')[0]}`);
  }
}

console.log(`\n${ok} adapter(s) produced a valid image.`);
