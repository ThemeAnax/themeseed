/**
 * Content commands: analyze, seed, list, wipe.
 *
 * These are the CLI mirror of the MCP tools, and both call `seedSite` so they
 * cannot drift apart.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { resolveSite } from '../../config/sites.js';
import { describeError } from '../../core/errors.js';
import { seedSite } from '../../core/seed.js';
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
      placeholder: 'SaaS productivity blog',
      validate: (input) => (input ? undefined : 'Required.'),
    });
    if (p.isCancel(value)) cancelled();
    topic = value as string;
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
