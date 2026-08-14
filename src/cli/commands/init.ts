/**
 * `themeseed init` — first-run setup.
 *
 * Detect MCP-capable tools, let the user confirm which to configure, write the
 * server registration into each, then offer to add a first site. Every step is
 * skippable: someone who only wants the CLI should not be forced through
 * editor configuration, and vice versa.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { listSitesSafe, sitesPath } from '../../config/sites.js';
import { describeError } from '../../core/errors.js';
import { detectTargets, installIntoTarget, serverEntryFor } from '../editors.js';
import { cancelled, fail, note, success, warn, spinner as makeSpinner } from '../ui.js';
import { DEFAULT_REGISTRY, PACKAGE_NAME, printMcpConfig } from './install.js';
import { addSiteCommand } from './sites.js';

export interface InitFlags {
  yes?: boolean;
  registry?: string;
  skipEditors?: boolean;
  skipSite?: boolean;
}

export async function initCommand(flags: InitFlags = {}): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' themeseed init ')));

  p.note(
    'themeseed fills a CMS with realistic demo content so you can judge a theme\n' +
      'against real-looking articles, images, galleries and video — instead of an\n' +
      'empty install or a wall of lorem ipsum.',
    'What this is'
  );

  if (!flags.skipEditors) {
    await configureEditors(flags);
  }

  if (!flags.skipSite) {
    await configureFirstSite(flags);
  }

  p.outro(
    `Done. Run ${pc.cyan('themeseed --help')} to see everything, or ${pc.cyan('themeseed seed --topic "..."')} to fill a site.`
  );
}

async function configureEditors(flags: InitFlags): Promise<void> {
  const spinner = makeSpinner();
  spinner.start('Looking for MCP-capable tools');
  const targets = await detectTargets();
  const installed = targets.filter((target) => target.installed);
  spinner.stop(
    installed.length
      ? `Found ${installed.length} tool${installed.length === 1 ? '' : 's'}`
      : 'No MCP-capable tools found'
  );

  if (installed.length === 0) {
    warn('None of the tools themeseed knows about are installed here.');
    note(`Checked: ${targets.map((t) => t.label).join(', ')}`);
    await printMcpConfig(flags.registry ?? DEFAULT_REGISTRY);
    return;
  }

  let chosenIds: string[];
  if (flags.yes) {
    chosenIds = installed.map((target) => target.id);
  } else {
    const selected = await p.multiselect({
      message: 'Register the themeseed MCP server with which tools?',
      options: installed.map((target) => ({
        value: target.id,
        label: target.label,
        hint: target.alreadyConfigured
          ? 'already configured — will refresh'
          : target.configPath,
      })),
      // Pre-tick everything not yet configured: the common case is "all of
      // them", and unticking is less work than ticking.
      initialValues: installed.filter((t) => !t.alreadyConfigured).map((t) => t.id),
      required: false,
    });
    if (p.isCancel(selected)) cancelled();
    chosenIds = selected as string[];
  }

  if (chosenIds.length === 0) {
    note('Skipped editor configuration.');
    return;
  }

  const entry = serverEntryFor({
    registry: flags.registry ?? DEFAULT_REGISTRY,
    packageName: PACKAGE_NAME,
  });

  const chosen = installed.filter((target) => chosenIds.includes(target.id));
  const lines: string[] = [];

  for (const target of chosen) {
    try {
      const result = await installIntoTarget(target, entry);
      lines.push(
        result.action === 'unchanged'
          ? `${pc.dim('·')} ${target.label} — already up to date`
          : `${pc.green('✔')} ${target.label} — ${result.action} ${pc.dim(result.configPath)}`
      );
      if (target.notes) lines.push(`  ${pc.dim(target.notes)}`);
    } catch (err) {
      lines.push(`${pc.red('✖')} ${target.label} — ${describeError(err)}`);
      process.exitCode = 1;
    }
  }

  p.note(lines.join('\n'), 'MCP registration');
  note('Restart those tools for the change to take effect.');
}

async function configureFirstSite(flags: InitFlags): Promise<void> {
  const existing = await listSitesSafe();
  if (existing.length > 0) {
    p.note(
      existing.map((site) => `${site.slug} — ${site.platform} at ${site.url}`).join('\n'),
      `Already configured (${sitesPath()})`
    );
    if (flags.yes) return;
    const another = await p.confirm({
      message: 'Add another site?',
      initialValue: false,
    });
    if (p.isCancel(another)) cancelled();
    if (!another) return;
  } else if (!flags.yes) {
    const wants = await p.confirm({
      message: 'Add a site to seed now?',
      initialValue: true,
    });
    if (p.isCancel(wants)) cancelled();
    if (!wants) {
      note(`Add one later with ${pc.cyan('themeseed add-site')}.`);
      return;
    }
  } else {
    note(`No site configured. Add one with ${pc.cyan('themeseed add-site')}.`);
    return;
  }

  try {
    await addSiteCommand();
  } catch (err) {
    fail(describeError(err));
    process.exitCode = 1;
  }
}

export { success };
