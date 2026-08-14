/**
 * Manual probe: confirm the YouTube finder returns real, embeddable videos.
 *
 *   npx tsx scripts/probe-video.ts "deep work" "saas pricing"
 */

import { YouTubeVideoFinder } from '../src/content/video.js';

const queries = process.argv.slice(2);
const topics = queries.length
  ? queries
  : [
      'deep work focus techniques',
      'saas pricing strategy',
      'notion productivity workflow',
    ];

const finder = new YouTubeVideoFinder();
let found = 0;

for (const query of topics) {
  const video = await finder.find(query);
  if (video) {
    found += 1;
    console.log(
      `ok   "${query}"\n     ${video.url}\n     ${video.title} — ${video.authorName}`
    );
  } else {
    console.log(`none "${query}"`);
  }
}

console.log(`\n${found}/${topics.length} queries resolved to a verified video.`);
process.exit(found > 0 ? 0 : 1);
