/**
 * Writes the package. By the time this runs everything is validated and in
 * memory, so a failure here can only be the filesystem.
 *
 * Isolation rule (spec §10): `posts.json` and `content-media/` are replaced
 * wholesale and nothing else inside `outDir` is touched. Both are staged under
 * hidden names in `outDir` and renamed into place, so an interrupted run leaves
 * the previous package intact rather than half of each.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MediaFile, NicContent, NicCredits } from './types.js';

export interface WriteArgs {
  outDir: string;
  creditsPath: string;
  content: NicContent;
  media: MediaFile[];
  credits: NicCredits;
}

export async function writeNicPackage(args: WriteArgs): Promise<string[]> {
  const { outDir } = args;
  await fs.mkdir(outDir, { recursive: true });

  const stamp = `${process.pid}-${Date.now()}`;
  const stagedPosts = path.join(outDir, `.posts.json.${stamp}.tmp`);
  const stagedMedia = path.join(outDir, `.content-media.${stamp}.tmp`);

  try {
    await fs.writeFile(stagedPosts, `${JSON.stringify(args.content, null, 2)}\n`);
    await fs.mkdir(stagedMedia, { recursive: true });
    for (const file of args.media)
      await fs.writeFile(path.join(stagedMedia, file.name), file.bytes);

    // The old folder goes first so files of a previous run cannot linger.
    await fs.rm(path.join(outDir, 'content-media'), { recursive: true, force: true });
    await fs.rename(stagedMedia, path.join(outDir, 'content-media'));
    await fs.rename(stagedPosts, path.join(outDir, 'posts.json'));
  } finally {
    await fs.rm(stagedPosts, { force: true });
    await fs.rm(stagedMedia, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(args.creditsPath), { recursive: true });
  const stagedCredits = `${args.creditsPath}.${stamp}.tmp`;
  try {
    await fs.writeFile(stagedCredits, `${JSON.stringify(args.credits, null, 2)}\n`);
    await fs.rename(stagedCredits, args.creditsPath);
  } finally {
    await fs.rm(stagedCredits, { force: true });
  }

  return ['posts.json', ...args.media.map((file) => `content-media/${file.name}`).sort()];
}
