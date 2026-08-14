/**
 * `themeseed install` — register the MCP server with one or more editors,
 * without the full `init` flow. Used when adding a second tool later.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { describeError } from '../../core/errors.js';
import {
  detectTargets,
  installIntoTarget,
  serverEntryFor,
  uninstallFromTarget,
  type DetectedTarget,
} from '../editors.js';
import { cancelled, fail, note, success, warn } from '../ui.js';

const run = promisify(execFile);

export const DEFAULT_REGISTRY = 'https://npm.indianic.in/';
export const PACKAGE_NAME = '@indianic/themeseed';

export interface InstallFlags {
  /** Target ids to configure without prompting, e.g. `--tool claude-code`. */
  tool?: string[];
  all?: boolean;
  /** Register every detected tool without asking. */
  yes?: boolean;
  registry?: string;
}

export async function installCommand(flags: InstallFlags = {}): Promise<void> {
  const targets = await detectTargets();
  const installed = targets.filter((target) => target.installed);

  if (installed.length === 0) {
    warn('No MCP-capable tools were detected on this machine.');
    note('Looked for: ' + targets.map((t) => t.label).join(', '));
    note(
      `You can still add themeseed manually — see ${pc.cyan('themeseed mcp-config')}.`
    );
    return;
  }

  const chosen = await chooseTargets(installed, flags);
  if (chosen.length === 0) {
    note('Nothing selected.');
    return;
  }

  const entry = serverEntryFor({
    ...(await globalBinary()),
    registry: flags.registry ?? DEFAULT_REGISTRY,
    packageName: PACKAGE_NAME,
  });

  console.log('');
  for (const target of chosen) {
    try {
      const result = await installIntoTarget(target, entry);
      if (result.action === 'unchanged') {
        note(`${target.label}: already up to date (${pc.dim(result.configPath)})`);
      } else {
        success(`${target.label}: ${result.action} ${pc.dim(result.configPath)}`);
        if (result.backupPath) note(`  backup: ${pc.dim(result.backupPath)}`);
      }
      if (target.notes) note(`  ${pc.dim(target.notes)}`);
    } catch (err) {
      fail(`${target.label}: ${describeError(err)}`);
      process.exitCode = 1;
    }
  }

  console.log('');
  note('Restart the tool for it to pick up the new server.');
}

export async function uninstallCommand(flags: InstallFlags = {}): Promise<void> {
  const targets = await detectTargets();
  const configured = targets.filter((target) => target.alreadyConfigured);

  if (configured.length === 0) {
    note('themeseed is not registered with any detected tool.');
    return;
  }

  const chosen = await chooseTargets(configured, flags);
  for (const target of chosen) {
    const removed = await uninstallFromTarget(target);
    if (removed)
      success(`${target.label}: removed themeseed from ${pc.dim(target.configPath)}`);
    else note(`${target.label}: nothing to remove`);
  }
}

async function chooseTargets(
  candidates: DetectedTarget[],
  flags: InstallFlags
): Promise<DetectedTarget[]> {
  if (flags.tool?.length) {
    const wanted = new Set(flags.tool.map((id) => id.toLowerCase()));
    const matched = candidates.filter((target) => wanted.has(target.id));
    const unknown = [...wanted].filter((id) => !candidates.some((t) => t.id === id));
    for (const id of unknown) {
      warn(
        `No detected tool with id "${id}". Known ids: ${candidates.map((t) => t.id).join(', ')}`
      );
    }
    return matched;
  }

  if (flags.all || flags.yes) return candidates;

  const selected = await p.multiselect({
    message: 'Which tools should themeseed be registered with?',
    options: candidates.map((target) => ({
      value: target.id,
      label: target.label,
      hint: target.alreadyConfigured
        ? 'already configured — will refresh'
        : target.configPath,
    })),
    initialValues: candidates.filter((t) => !t.alreadyConfigured).map((t) => t.id),
    required: false,
  });
  if (p.isCancel(selected)) cancelled();

  const ids = new Set(selected as string[]);
  return candidates.filter((target) => ids.has(target.id));
}

/**
 * Prefer a globally-installed binary when one exists: it starts faster than
 * `npx` and keeps working offline.
 */
async function globalBinary(): Promise<{ globalBinary?: string }> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [
      'themeseed-mcp',
    ]);
    const found = stdout.split('\n')[0]?.trim();
    return found ? { globalBinary: found } : {};
  } catch {
    return {};
  }
}

/** Prints the JSON snippet for tools we could not detect or write to. */
export async function printMcpConfig(registry = DEFAULT_REGISTRY): Promise<void> {
  const entry = serverEntryFor({
    ...(await globalBinary()),
    registry,
    packageName: PACKAGE_NAME,
  });
  console.log('\nAdd this to your MCP client configuration:\n');
  console.log(JSON.stringify({ mcpServers: { themeseed: entry } }, null, 2));
  console.log(
    pc.dim(
      '\nVS Code nests these under "servers" rather than "mcpServers"; Zed uses "context_servers".\n'
    )
  );
}
