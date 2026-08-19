/**
 * The user's provider keys, at ~/.themeseed/.env.
 *
 * They live here rather than in a project's .env because the MCP server is
 * launched by an editor, in whatever directory that editor happens to have
 * open. A relative lookup finds a different file every time, or none; an
 * absolute one in the config directory finds the same file always.
 *
 * The template ships every variable already present but commented out, so a
 * user can fill the file in by hand. That makes the upsert below load-bearing:
 * setting a key must rewrite its commented line rather than append a second
 * one, or the file grows a duplicate every time the wizard runs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import { ConfigError } from '../core/errors.js';
import { IMAGE_PROVIDERS, providersByCategory } from '../images/providers.js';
import { configDir } from './sites.js';

export function envPath(): string {
  return path.join(configDir(), '.env');
}

/** Loads the file into process.env. Existing variables win. */
export function loadUserEnv(): void {
  dotenv.config({ path: envPath(), quiet: true });
}

/**
 * Writes the commented template when no file exists. Returns whether it wrote.
 * Never overwrites: this file holds secrets.
 */
export async function ensureEnvFile(): Promise<boolean> {
  const file = envPath();
  try {
    await fs.access(file);
    return false;
  } catch {
    // Absent, so write it.
  }
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeAtomic(file, buildTemplate());
  return true;
}

/** Keys that carry a non-blank value. Commented lines are not values. */
export async function readEnvValues(): Promise<Record<string, string>> {
  const body = await readOrEmpty();
  const parsed = dotenv.parse(body);
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value.trim().length > 0) values[key] = value;
  }
  return values;
}

/**
 * Sets or clears variables, preserving every comment in the file.
 *
 * A null value comments the variable out and discards what it held, which is
 * what `themeseed images --remove` needs: the key should stop working and stop
 * being readable, while the documentation line stays for next time.
 */
export async function setEnvValues(
  updates: Record<string, string | null>
): Promise<void> {
  await ensureEnvFile();
  const file = envPath();
  const lines = (await readOrEmpty()).split('\n');

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^\\s*#?\\s*${escapeForRegExp(key)}\\s*=`);
    const rendered = value === null ? `# ${key}=` : `${key}=${quote(value)}`;
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) lines[index] = rendered;
    else lines.push(rendered);
  }

  const body = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  await writeAtomic(file, body);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readOrEmpty(): Promise<string> {
  try {
    return await fs.readFile(envPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new ConfigError(`Could not read ${envPath()}`, { cause: err });
  }
}

/** Write-then-rename, so an interrupted save cannot truncate working keys. */
async function writeAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** dotenv splits on whitespace unless the value is quoted. */
function quote(value: string): string {
  if (!/[\s#'"]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildTemplate(): string {
  const section = (title: string): string =>
    `# --- ${title} ${'-'.repeat(Math.max(0, 74 - title.length))}`;

  const lines: string[] = [
    '# themeseed — your configuration.',
    '#',
    '# Every setting is listed below and commented out. Uncomment a line and',
    '# fill in a value, or let `themeseed init` and `themeseed images` write',
    '# them for you. Sites you seed live in sites.json alongside this file.',
    '#',
    '# This file holds API keys. It is readable only by you, and themeseed',
    '# never overwrites it.',
    '',
    section('Stock photo providers'),
    '# Real photographs, searched by topic. With no key set, stock lookups fall',
    '# back to keyless Lorem Picsum, which cannot search and returns unrelated',
    '# images. Set one of these to get pictures that match the post.',
    '',
  ];

  for (const provider of providersByCategory('stock')) {
    lines.push(`# ${provider.label} — ${provider.note}`);
    if (provider.signupUrl) lines.push(`#   ${provider.signupUrl}`);
    lines.push(`# ${provider.envKey}=`, '');
  }

  lines.push(
    '# Which stock provider to prefer when both keys are set: unsplash | pexels',
    '# THEMESEED_STOCK_PROVIDER=',
    '',
    section('AI image generation'),
    '# Generated imagery. Whichever key is present is used, unless the adapter',
    '# is named explicitly below.',
    ''
  );

  for (const provider of providersByCategory('ai')) {
    lines.push(`# ${provider.label} — ${provider.note}`);
    if (provider.signupUrl) lines.push(`#   ${provider.signupUrl}`);
    if (provider.envKey) lines.push(`# ${provider.envKey}=`);
    lines.push('');
  }

  const adapterIds = providersByCategory('ai').map((provider) => provider.id);
  lines.push(
    `# Force one adapter: ${adapterIds.join(' | ')}`,
    '# THEMESEED_AI_IMAGE_ADAPTER=',
    '# Override the model an adapter uses, e.g. gemini-3-pro-image, fal-ai/flux/dev',
    '# THEMESEED_AI_IMAGE_MODEL=',
    '',
    section('Local images'),
    ''
  );

  for (const provider of providersByCategory('local')) {
    lines.push(`# ${provider.label} — ${provider.note}`, `# ${provider.envKey}=`, '');
  }

  lines.push(
    section('Content engine'),
    '# How post prose is written: "template" (default, offline, deterministic)',
    "# or \"anthropic\" (better prose, needs a key). An MCP host's own model is",
    '# used when one is available, whatever this says.',
    '# THEMESEED_CONTENT_ENGINE=',
    '# ANTHROPIC_API_KEY=',
    ''
  );

  // Guards against a provider added to the table but forgotten here.
  for (const provider of IMAGE_PROVIDERS) {
    if (
      provider.envKey &&
      !lines.some((line) => line.startsWith(`# ${provider.envKey}=`))
    ) {
      lines.push(`# ${provider.envKey}=`);
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
