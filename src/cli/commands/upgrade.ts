/**
 * `themeseed upgrade` — check the private registry for a newer release and
 * install it.
 *
 * The install is delegated to npm rather than reimplemented: npm knows about
 * the user's auth, proxy, prefix and permissions, and getting any of those
 * wrong here would break the upgrade path in ways that are hard to debug from
 * a bug report.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { readVersion } from '../../core/version.js';
import { cancelled, fail, note, success, spinner as makeSpinner } from '../ui.js';
import { DEFAULT_REGISTRY, PACKAGE_NAME } from './install.js';

const run = promisify(execFile);

export interface UpgradeFlags {
  registry?: string;
  yes?: boolean;
  /** Report the available version without installing. */
  check?: boolean;
}

export async function upgradeCommand(flags: UpgradeFlags = {}): Promise<void> {
  const registry = flags.registry ?? DEFAULT_REGISTRY;
  const current = await readVersion();

  const spinner = makeSpinner();
  spinner.start(`Checking ${registry} for a newer ${PACKAGE_NAME}`);

  let latest: string;
  try {
    const { stdout } = await run(
      'npm',
      ['view', `${PACKAGE_NAME}@latest`, 'version', '--registry', registry],
      { timeout: 60_000 }
    );
    latest = stdout.trim();
  } catch (err) {
    spinner.stop(pc.red('Could not reach the registry'));
    fail(errorText(err));
    note(
      `If this is an auth failure, log in first:\n  ${pc.cyan(`npm login --registry ${registry} --scope @indianic`)}`
    );
    process.exitCode = 1;
    return;
  }

  spinner.stop(`Installed ${pc.bold(current)} · latest ${pc.bold(latest)}`);

  if (!latest) {
    fail('The registry returned no version.');
    process.exitCode = 1;
    return;
  }

  const comparison = compareVersions(current, latest);
  if (comparison >= 0) {
    success(
      comparison === 0
        ? 'Already on the latest version.'
        : `Local build (${current}) is ahead of the registry.`
    );
    return;
  }

  if (flags.check) {
    note(
      `Update available: ${current} → ${latest}. Run ${pc.cyan('themeseed upgrade')} to install.`
    );
    return;
  }

  if (!flags.yes) {
    const confirmed = await p.confirm({
      message: `Upgrade ${current} → ${latest}?`,
      initialValue: true,
    });
    if (p.isCancel(confirmed)) cancelled();
    if (!confirmed) {
      note('Cancelled.');
      return;
    }
  }

  const install = makeSpinner();
  install.start(`Installing ${PACKAGE_NAME}@${latest}`);
  try {
    await run(
      'npm',
      ['install', '-g', `${PACKAGE_NAME}@${latest}`, '--registry', registry],
      {
        timeout: 300_000,
      }
    );
    install.stop(`Upgraded to ${latest}`);
    success(`themeseed is now ${latest}.`);
    note(
      'If you registered the MCP server with a global binary path, restart your editors.'
    );
  } catch (err) {
    install.stop(pc.red('Upgrade failed'));
    fail(errorText(err));
    note(
      `You may need elevated permissions, or a different npm prefix:\n` +
        `  ${pc.cyan(`npm install -g ${PACKAGE_NAME}@${latest} --registry ${registry}`)}`
    );
    process.exitCode = 1;
  }
}

function errorText(err: unknown): string {
  const anyErr = err as { stderr?: string; message?: string };
  const stderr = anyErr.stderr?.trim();
  if (stderr) return stderr.split('\n').slice(0, 4).join('\n');
  return anyErr.message ?? String(err);
}

/**
 * Semver comparison covering the parts that matter here: numeric core, and
 * prereleases sorting below their release. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = '', prerelease = ''] = version.replace(/^v/, '').split('-', 2);
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, prerelease };
  };

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (left.prerelease === right.prerelease) return 0;
  // 1.0.0-beta < 1.0.0
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}
