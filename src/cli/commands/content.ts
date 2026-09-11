/**
 * Content commands: analyze, seed, list, wipe.
 *
 * These are the CLI mirror of the MCP tools, and both call `seedSite` so they
 * cannot drift apart.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { resolveSite } from '../../config/sites.js';
import { randomTopic } from '../../content/topics.js';
import { describeError } from '../../core/errors.js';
import { exportSite } from '../../core/export.js';
import { seedSite } from '../../core/seed.js';
import { updatePost, type FeatureImageAction } from '../../core/update.js';
import type { PublishStatus, RequestedImageSource } from '../../core/types.js';
import { createProvider } from '../../providers/registry.js';
import {
  cancelled,
  fail,
  heading,
  note,
  success,
  warn,
  yesNo,
  spinner as makeSpinner,
  assertInteractive,
} from '../ui.js';

export async function analyzeCommand(
  slug: string | undefined,
  flags: { json?: boolean } = {}
): Promise<void> {
  const { slug: resolved, site } = await resolveSite(slug);
  const provider = createProvider(site);

  const spinner = flags.json ? null : makeSpinner();
  spinner?.start(`Analyzing the active theme on "${resolved}"`);
  const capabilities = await provider.analyzeTheme();
  spinner?.stop(`Theme: ${pc.bold(capabilities.themeName)}`);

  if (flags.json) {
    console.log(JSON.stringify(capabilities, null, 2));
    return;
  }

  heading(
    `${capabilities.themeName}${capabilities.themeVersion ? ` v${capabilities.themeVersion}` : ''}`
  );
  if (capabilities.description) console.log(pc.dim(capabilities.description));

  console.log('');
  const rows: Array<[string, string]> = [
    [
      'feature image',
      yesNo(capabilities.supportsFeatureImage) +
        (capabilities.featureImageAspectRatio
          ? pc.dim(` (ratio ≈ ${capabilities.featureImageAspectRatio})`)
          : ''),
    ],
    ['gallery card', yesNo(capabilities.supportsGallery)],
    ['video embed', yesNo(capabilities.supportsVideoEmbed)],
    ['bookmark card', yesNo(capabilities.supportsBookmarkCard)],
    ['wide images', yesNo(capabilities.supportsWideImages)],
    ['shows tags', yesNo(capabilities.displaysTags)],
    [
      'shows author',
      yesNo(capabilities.displaysAuthor) +
        (capabilities.displaysAuthorImage ? pc.dim(' (with avatar)') : ''),
    ],
    ['reading time', yesNo(capabilities.displaysReadingTime)],
    [
      'target length',
      pc.bold(`~${capabilities.expectedWordCount.target}`) +
        pc.dim(
          ` words (${capabilities.expectedWordCount.min}–${capabilities.expectedWordCount.max})`
        ),
    ],
  ];
  if (capabilities.postsPerPage)
    rows.push(['posts per page', String(capabilities.postsPerPage)]);

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`);

  console.log('');
  const confidenceColor =
    capabilities.confidence >= 0.7
      ? pc.green
      : capabilities.confidence >= 0.4
        ? pc.yellow
        : pc.red;
  console.log(
    `  confidence ${confidenceColor(String(capabilities.confidence))} ${pc.dim(`via ${capabilities.analyzedVia.join(', ') || 'nothing measurable'}`)}`
  );

  if (capabilities.confidence < 0.7 && site.platform === 'ghost') {
    warn(
      "Ghost's Admin API will not serve theme files, so remote analysis is inferred from the rendered site."
    );
    note(
      `For an exact reading, re-add the site with ${pc.cyan('--themes-dir /path/to/ghost/content/themes')}.`
    );
  }

  console.log(pc.dim('\n  evidence:'));
  for (const line of capabilities.evidence) console.log(pc.dim(`    - ${line}`));
  console.log('');
}

export interface SeedFlags {
  topic?: string;
  count?: number;
  imageSource?: string;
  status?: string;
  draft?: boolean;
  yes?: boolean;
  noVideo?: boolean;
  studyTheme?: boolean;
  author?: string;
  seed?: number;
}

export async function seedCommand(
  slug: string | undefined,
  flags: SeedFlags = {}
): Promise<void> {
  const { slug: resolved, site } = await resolveSite(slug);

  let topic = flags.topic;
  if (!topic) {
    assertInteractive('A topic', 'Pass --topic "your subject".');
    const value = await p.text({
      message: 'What is this publication about?',
      placeholder: 'SaaS productivity blog — or leave blank for a random subject',
    });
    if (p.isCancel(value)) cancelled();
    // Blank is a real answer, not a mistake: previewing a theme needs realistic
    // copy, not copy about anything in particular. The MCP tool treats an empty
    // elicitation the same way.
    topic = (value as string)?.trim() || randomTopic();
  }

  const count = flags.count ?? 12;
  const status: PublishStatus = flags.draft
    ? 'draft'
    : ((flags.status as PublishStatus) ?? 'published');
  const imageSource = (flags.imageSource as RequestedImageSource) ?? 'auto';

  if (!flags.yes) {
    assertInteractive('Confirmation', 'Pass --yes to seed without confirming.');
    const confirmed = await p.confirm({
      message: `Create ${count} ${status} post(s) about "${topic}" on ${pc.bold(resolved)} (${site.url})?`,
      initialValue: true,
    });
    if (p.isCancel(confirmed)) cancelled();
    if (!confirmed) {
      note('Cancelled.');
      return;
    }
  }

  const spinner = makeSpinner();
  spinner.start(flags.studyTheme ? 'Analyzing the theme' : 'Preparing');

  try {
    const report = await seedSite({
      site,
      topic,
      count,
      imageSource,
      status,
      includeVideo: !flags.noVideo,
      studyTheme: Boolean(flags.studyTheme),
      ...(flags.author ? { authorName: flags.author } : {}),
      ...(flags.seed !== undefined ? { seed: flags.seed } : {}),
      onProgress: (phase, done, total, detail) => {
        if (phase === 'analyzing' && done === total) spinner.message(`Theme: ${detail}`);
        else if (phase === 'generating')
          spinner.message(`Writing ${done}/${total} — ${truncate(detail)}`);
        else if (phase === 'publishing')
          spinner.message(`Publishing ${done}/${total} — ${truncate(detail)}`);
      },
    });

    spinner.stop(`Created ${report.created} of ${count} post(s) on "${resolved}"`);

    console.log('');
    if (flags.studyTheme) {
      console.log(`  theme            ${pc.bold(report.capabilities.themeName)}`);
    }
    console.log(`  feature images   ${report.generation.withFeatureImage}`);
    console.log(`  inline images    ${report.generation.withInlineImage}`);
    console.log(
      `  galleries        ${report.generation.withGallery}${report.generation.skipped.gallery ? pc.dim(` — skipped, ${report.generation.skipped.gallery}`) : ''}`
    );
    console.log(
      `  video embeds     ${report.generation.withVideo}${report.generation.skipped.video ? pc.dim(` — skipped, ${report.generation.skipped.video}`) : ''}`
    );

    if (report.generation.skipped.images) {
      console.log('');
      warn(`images: ${report.generation.skipped.images}`);
    }

    if (report.failed > 0) {
      console.log('');
      warn(`${report.failed} post(s) failed:`);
      for (const result of report.results.filter((r) => r.error)) {
        console.log(`    ${pc.red('✖')} ${result.title}: ${result.error}`);
      }
      process.exitCode = 1;
    }

    console.log('');
    note(`Remove all of it later with ${pc.cyan(`themeseed wipe ${resolved}`)}.`);
  } catch (err) {
    spinner.stop(pc.red('Failed'));
    fail(describeError(err));
    process.exitCode = 1;
  }
}

export interface UpdateFlags {
  title?: string;
  excerpt?: string;
  status?: string;
  featureImage?: string;
  addBodyImage?: boolean;
  imageQuery?: string;
  imageSource?: string;
  allowUnseeded?: boolean;
}

export async function updateCommand(
  id: string,
  slug: string | undefined,
  flags: UpdateFlags = {}
): Promise<void> {
  const { slug: resolved, site } = await resolveSite(slug);

  const featureImage = (flags.featureImage as FeatureImageAction) ?? 'keep';
  const spinner = makeSpinner();
  spinner.start(`Updating ${id} on "${resolved}"`);

  try {
    const report = await updatePost({
      site,
      id,
      featureImage,
      addBodyImage: Boolean(flags.addBodyImage),
      allowUnseeded: Boolean(flags.allowUnseeded),
      imageSource: (flags.imageSource as RequestedImageSource) ?? 'auto',
      ...(flags.title !== undefined ? { title: flags.title } : {}),
      ...(flags.excerpt !== undefined ? { excerpt: flags.excerpt } : {}),
      ...(flags.status !== undefined ? { status: flags.status as PublishStatus } : {}),
      ...(flags.imageQuery !== undefined ? { imageQuery: flags.imageQuery } : {}),
    });

    if (report.result.error) {
      spinner.stop(`Could not update ${id}`);
      fail(report.result.error);
      return;
    }

    spinner.stop(`Updated "${report.result.title}"`);
    console.log('');
    if (featureImage === 'remove') console.log('  feature image    removed');
    else if (featureImage === 'replace')
      console.log(
        `  feature image    ${report.featureImageAttached ? 'replaced' : pc.yellow('not replaced')}`
      );
    if (flags.addBodyImage)
      console.log(
        `  body image       ${report.bodyImageAttached ? 'added' : pc.yellow('not added')}`
      );
    if (report.result.url) console.log(`  url              ${report.result.url}`);

    if (report.imageError) {
      console.log('');
      warn(`images: ${report.imageError}`);
    }
  } catch (err) {
    spinner.stop('Update failed');
    fail(describeError(err));
  }
}

export async function listCommand(
  slug: string | undefined,
  flags: { json?: boolean } = {}
): Promise<void> {
  const { slug: resolved, site } = await resolveSite(slug);
  const provider = createProvider(site);
  const results = await provider.listSeeded();

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    note(`No themeseed content on "${resolved}".`);
    return;
  }

  heading(`${results.length} seeded post(s) on "${resolved}"`);
  for (const result of results) {
    console.log(`  ${pc.dim(result.status.padEnd(9))} ${result.title}`);
    if (result.url) console.log(`  ${' '.repeat(9)} ${pc.dim(result.url)}`);
  }
  console.log('');
}

export async function wipeCommand(
  slug: string | undefined,
  flags: { yes?: boolean } = {}
): Promise<void> {
  const { slug: resolved, site } = await resolveSite(slug);
  const provider = createProvider(site);

  const pending = await provider.listSeeded();
  if (pending.length === 0) {
    note(`Nothing to remove on "${resolved}".`);
    return;
  }

  if (!flags.yes) {
    // Deleting without an explicit --yes in a script would be indefensible.
    assertInteractive('Confirmation', 'Pass --yes to wipe without confirming.');
    const confirmed = await p.confirm({
      message: `Permanently delete ${pending.length} themeseed post(s) from ${pc.bold(resolved)}? Content themeseed did not create is untouched.`,
      initialValue: false,
    });
    if (p.isCancel(confirmed)) cancelled();
    if (!confirmed) {
      note('Cancelled.');
      return;
    }
  }

  const spinner = makeSpinner();
  spinner.start(`Removing ${pending.length} post(s)`);
  const summary = await provider.wipeSeeded();
  const remaining = await provider.listSeeded();
  spinner.stop(`Removed ${summary.removed} post(s)`);

  if (summary.failed?.length) {
    warn(`${summary.failed.length} could not be removed:`);
    for (const failure of summary.failed)
      console.log(`    ${pc.red('✖')} ${failure.id}: ${failure.error}`);
    process.exitCode = 1;
  }
  if (remaining.length === 0) success('Site is clean.');
  else warn(`${remaining.length} seeded post(s) remain.`);
}

function truncate(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ExportFlags {
  topic?: string;
  count?: number;
  out?: string;
  imageSource?: string;
  draft?: boolean;
  author?: string;
  noVideo?: boolean;
  seed?: number;
  pages?: string;
  yes?: boolean;
}

/**
 * Writes demo content to a file rather than to a site.
 *
 * Takes no site argument on purpose: there is nothing to connect to. That is
 * the whole point — a theme author packaging demo content has no Ghost of the
 * customer's to publish into.
 */
export async function exportCommand(flags: ExportFlags = {}): Promise<void> {
  const outDir = flags.out ?? './demo-content';

  let topic = flags.topic;
  if (!topic) {
    assertInteractive('A topic', 'Pass --topic "your subject".');
    const value = await p.text({
      message: 'What is this publication about?',
      placeholder: 'SaaS productivity blog — or leave blank for a random subject',
    });
    if (p.isCancel(value)) cancelled();
    topic = (value as string)?.trim() || randomTopic();
  }

  const count = flags.count ?? 12;
  // "about,privacy-policy,authors:no-body" — the suffix marks a page whose
  // body a theme template supplies, so generating one would be wasted.
  const pages = (flags.pages ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [slug, marker] = entry.split(':');
      return {
        slug: slug!,
        ...(marker === 'no-body' ? { needsBody: false } : {}),
      };
    });

  if (!flags.yes) {
    p.log.info(
      `${count} posts${pages.length ? ` and ${pages.length} pages` : ''} about "${topic}" -> ${outDir}`
    );
  }

  const spinner = p.spinner();
  spinner.start('Generating and writing the archive');

  const report = await exportSite({
    platform: 'ghost',
    topic,
    count,
    outDir,
    imageSource: (flags.imageSource as RequestedImageSource) ?? 'auto',
    status: flags.draft ? 'draft' : 'published',
    ...(pages.length ? { pages } : {}),
    ...(flags.author ? { authorName: flags.author } : {}),
    ...(flags.noVideo ? { includeVideo: false } : {}),
    ...(flags.seed !== undefined ? { seed: flags.seed } : {}),
    onProgress: (phase, done, total, detail) =>
      spinner.message(`${phase} ${done}/${total} — ${detail}`),
  });

  spinner.stop(`Wrote ${report.zipPath}`);

  p.log.success(
    [
      `posts   ${report.stats.posts}`,
      `pages   ${report.stats.pages}`,
      `tags    ${report.stats.tags}`,
      `authors ${report.stats.authors}`,
      `images  ${report.stats.images} bundled${
        report.stats.failedImages ? `, ${report.stats.failedImages} failed` : ''
      }`,
    ].join('\n')
  );

  p.log.info(
    'Import it in Ghost Admin → Settings → Import content. The images travel with it.'
  );
}
