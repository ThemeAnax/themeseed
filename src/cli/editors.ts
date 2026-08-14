/**
 * Detects MCP-capable tools on this machine and registers themeseed with them.
 *
 * Each tool stores MCP servers in its own file, in its own shape. The shapes
 * are close enough to look identical and different enough that assuming would
 * corrupt configs, so each target declares its own path and writer.
 *
 * Two rules everything here follows:
 *   1. Never rewrite a config we did not parse. If the file exists but is not
 *      valid JSON, refuse rather than clobber someone's setup.
 *   2. Merge, never replace. Other servers in the file must survive untouched.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ThemeseedError } from '../core/errors.js';

export interface McpTarget {
  id: string;
  /** Name shown in the picker. */
  label: string;
  /** Absolute path to the tool's MCP config file. */
  configPath: string;
  /**
   * Paths whose existence proves the tool is installed. The config file itself
   * may not exist yet on a fresh install, so this is checked separately.
   */
  detectPaths: string[];
  /** Where in the JSON tree servers live, e.g. ['mcpServers']. */
  serversKey: string[];
  notes?: string;
}

export interface DetectedTarget extends McpTarget {
  installed: boolean;
  /** themeseed is already registered in this tool. */
  alreadyConfigured: boolean;
}

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const home = (): string => os.homedir();

/**
 * Config locations, current as of 2026. macOS and Linux paths differ for the
 * Electron apps; Windows uses APPDATA.
 */
export function knownTargets(): McpTarget[] {
  const h = home();
  const platform = process.platform;

  const appSupport = (name: string): string =>
    platform === 'darwin'
      ? path.join(h, 'Library', 'Application Support', name)
      : platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming'), name)
        : path.join(h, '.config', name);

  const vsCodeUser = appSupport('Code');
  const cursorUser = appSupport('Cursor');
  const windsurfUser = appSupport('Windsurf');

  return [
    {
      id: 'claude-code',
      label: 'Claude Code (CLI)',
      configPath: path.join(h, '.claude.json'),
      detectPaths: [path.join(h, '.claude'), path.join(h, '.claude.json')],
      serversKey: ['mcpServers'],
      notes: 'Registers globally for all projects.',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      configPath: path.join(appSupport('Claude'), 'claude_desktop_config.json'),
      detectPaths: [appSupport('Claude')],
      serversKey: ['mcpServers'],
      notes: 'Requires restarting Claude Desktop to take effect.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      configPath: path.join(h, '.cursor', 'mcp.json'),
      detectPaths: [path.join(h, '.cursor'), cursorUser],
      serversKey: ['mcpServers'],
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      configPath: path.join(h, '.codeium', 'windsurf', 'mcp_config.json'),
      detectPaths: [path.join(h, '.codeium', 'windsurf'), windsurfUser],
      serversKey: ['mcpServers'],
    },
    {
      id: 'vscode',
      label: 'VS Code (Copilot / MCP)',
      configPath: path.join(vsCodeUser, 'User', 'mcp.json'),
      detectPaths: [vsCodeUser],
      serversKey: ['servers'],
      notes: 'VS Code nests servers under "servers" rather than "mcpServers".',
    },
    {
      id: 'cline',
      label: 'Cline (VS Code extension)',
      configPath: path.join(
        vsCodeUser,
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      ),
      detectPaths: [path.join(vsCodeUser, 'User', 'globalStorage', 'saoudrizwan.claude-dev')],
      serversKey: ['mcpServers'],
    },
    {
      id: 'zed',
      label: 'Zed',
      configPath: path.join(h, '.config', 'zed', 'settings.json'),
      detectPaths: [path.join(h, '.config', 'zed')],
      serversKey: ['context_servers'],
      notes: 'Zed calls them context servers.',
    },
  ];
}

export async function detectTargets(serverName = 'themeseed'): Promise<DetectedTarget[]> {
  const results: DetectedTarget[] = [];

  for (const target of knownTargets()) {
    const installed = await anyExists([...target.detectPaths, target.configPath]);
    const alreadyConfigured = installed ? await hasServer(target, serverName) : false;
    results.push({ ...target, installed, alreadyConfigured });
  }

  return results;
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function hasServer(target: McpTarget, serverName: string): Promise<boolean> {
  const config = await readConfig(target.configPath);
  if (!config) return false;
  const servers = getIn(config, target.serversKey);
  return Boolean(servers && typeof servers === 'object' && serverName in (servers as object));
}

/**
 * Reads a config file. Returns null when absent; throws when present but
 * unparseable, because silently replacing a broken config loses real settings.
 */
async function readConfig(configPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new ThemeseedError(`${configPath} exists but is not valid JSON`, {
      code: 'BAD_EDITOR_CONFIG',
      hint: 'Fix or move that file, then run `themeseed install` again. It was left untouched.',
      cause: err,
    });
  }
}

export interface InstallResult {
  target: DetectedTarget | McpTarget;
  configPath: string;
  action: 'created' | 'updated' | 'unchanged';
  backupPath?: string;
}

/** Adds (or refreshes) the themeseed server entry in one tool's config. */
export async function installIntoTarget(
  target: McpTarget,
  entry: ServerEntry,
  serverName = 'themeseed'
): Promise<InstallResult> {
  const existing = await readConfig(target.configPath);
  const config = existing ?? {};
  const created = existing === null;

  const servers = ensureIn(config, target.serversKey);
  const before = JSON.stringify(servers[serverName] ?? null);
  servers[serverName] = { ...entry };
  const after = JSON.stringify(servers[serverName]);

  if (!created && before === after) {
    return { target, configPath: target.configPath, action: 'unchanged' };
  }

  // Back up anything we are about to modify. Cheap insurance against a bad
  // merge in a file the user cares about.
  let backupPath: string | undefined;
  if (!created) {
    backupPath = `${target.configPath}.themeseed-backup`;
    await fs.copyFile(target.configPath, backupPath);
  }

  await fs.mkdir(path.dirname(target.configPath), { recursive: true });
  const tmp = `${target.configPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target.configPath);

  return {
    target,
    configPath: target.configPath,
    action: created ? 'created' : 'updated',
    ...(backupPath ? { backupPath } : {}),
  };
}

export async function uninstallFromTarget(
  target: McpTarget,
  serverName = 'themeseed'
): Promise<boolean> {
  const config = await readConfig(target.configPath);
  if (!config) return false;
  const servers = getIn(config, target.serversKey) as Record<string, unknown> | undefined;
  if (!servers || !(serverName in servers)) return false;

  delete servers[serverName];
  const tmp = `${target.configPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target.configPath);
  return true;
}

/**
 * How a tool should launch the server.
 *
 * `npx -y` is the default because it works whether or not the package is
 * installed globally, and picks up updates without the user re-running
 * `themeseed install`. A globally-installed binary is used when one is found,
 * since that starts faster and works offline.
 */
export function serverEntryFor(options: {
  globalBinary?: string;
  registry?: string;
  packageName?: string;
  version?: string;
}): ServerEntry {
  if (options.globalBinary) {
    return { command: options.globalBinary, args: [] };
  }
  const spec = `${options.packageName ?? '@indianic/themeseed'}${options.version ? `@${options.version}` : ''}`;
  const entry: ServerEntry = {
    command: 'npx',
    args: ['-y', '--package', spec, 'themeseed-mcp'],
  };
  if (options.registry) {
    entry.env = { npm_config_registry: options.registry };
  }
  return entry;
}

// ---------------------------------------------------------------------------

function getIn(object: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = object;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureIn(object: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let current = object;
  for (const key of keys) {
    const next = current[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}
