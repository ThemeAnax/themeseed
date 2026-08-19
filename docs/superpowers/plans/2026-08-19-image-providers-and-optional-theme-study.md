# Image Providers, Generated Config Files and Optional Theme Study — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prompt for image providers on first run, store their keys in `~/.themeseed/.env` so the MCP server actually finds them, make images optional, and stop analyzing the theme unless the caller asks.

**Architecture:** One table of image providers (`src/images/providers.ts`) feeds four consumers: the generated `.env` template, the `init` wizard, `themeseed images`, and automatic source selection. Keys move from an unreliable working-directory `.env` to `~/.themeseed/.env`, loaded by both entry points. Two defaults flip: `imageSource` resolves to `auto` (AI key, else stock key, else no images) and `studyTheme` defaults to false, using neutral capabilities instead of a theme read.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20+, vitest, commander, @clack/prompts, dotenv, zod, @modelcontextprotocol/sdk.

**Spec:** `docs/superpowers/specs/2026-08-19-image-providers-and-optional-theme-study-design.md`

---

## Conventions for every task

- Run unit tests with `npm test` (the `unit` vitest project). A single file: `npx vitest run --project unit test/unit/<file>.test.ts`.
- Full gate before any commit that finishes a task: `npm run verify` (typecheck + eslint + unit tests).
- This codebase uses `exactOptionalPropertyTypes`. Never assign `undefined` to an optional property; spread it conditionally, e.g. `...(value ? { key: value } : {})`. Existing code does this everywhere — copy the pattern.
- All relative imports carry a `.js` extension, even from `.ts` files. This is required by NodeNext resolution.
- Every test that touches the config directory must set `process.env.THEMESEED_CONFIG_DIR` to a fresh temp dir in `beforeEach` and restore it in `afterEach`. `test/unit/config-and-cli.test.ts:28-38` is the pattern to copy.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/images/providers.ts` | The one table of image providers: id, label, category, env var, signup URL. Plus `hasAiKey` / `hasStockKey` / `configuredProviders`. |
| `src/config/env.ts` | `~/.themeseed/.env`: locate, create from template, load, read, comment-preserving upsert. |
| `src/config/templates.ts` | Generates `~/.themeseed/sites.example.json`. |
| `src/images/none-source.ts` | `NoneImageSource` — always available, returns no images. |
| `src/core/theme-defaults.ts` | `genericCapabilities(platform)` — neutral `ThemeCapabilities` used when nobody asked for a theme read. |
| `src/cli/commands/images.ts` | `themeseed images` and the shared wizard that `init` also calls. |
| `test/unit/providers.test.ts` | Provider table and key detection. |
| `test/unit/env.test.ts` | `.env` create, load, read, upsert. |
| `test/unit/templates.test.ts` | `sites.example.json` is valid, copyable JSON. |
| `test/unit/image-resolve.test.ts` | `auto` resolution matrix and `NoneImageSource`. |
| `test/unit/theme-defaults.test.ts` | Neutral capabilities and `studyTheme` gating in `seedSite`. |

**Modify:**

| File | Change |
| --- | --- |
| `src/core/types.ts` | `ImageSourceKind` gains `'none'`; add `RequestedImageSource`. |
| `src/images/index.ts` | `'none'` case, `resolveImageSourceKind`, `createRequestedImageSource`, re-exports. |
| `src/core/seed.ts` | `studyTheme` gate; `imageSource` widens to `RequestedImageSource`. |
| `src/mcp/index.ts` | `loadUserEnv()` instead of bare `dotenv.config()`. |
| `src/cli/index.ts` | Same swap, plus `--study-theme`, new `-i` values, new `images` command. |
| `src/mcp/server.ts` | `studyTheme` input, widened `imageSource` enum, corrected server `instructions`. |
| `src/cli/commands/content.ts` | `studyTheme` flag, `RequestedImageSource` cast, default `auto`. |
| `src/cli/commands/init.ts` | Write config templates, then run the image wizard. |
| `README.md`, `CHANGELOG.md`, `package.json` | Docs and the 0.2.0 bump. |

**Note on a spec name:** the spec called the template writer `ensureSitesExample()`. This plan uses `writeSitesExample()`, because `ensure` implies "only if missing" and this file is deliberately regenerated every run. Same behaviour as specified, honest name.

---

## Task 1: The image provider table

One table, four consumers. Everything downstream reads from here so the wizard, the `.env` template, `--list` and auto-selection cannot disagree about what exists.

**Files:**
- Create: `src/images/providers.ts`
- Test: `test/unit/providers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/providers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROVIDERS,
  configuredProviders,
  findProvider,
  hasAiKey,
  hasStockKey,
  providersByCategory,
} from '../../src/images/providers.js';

describe('IMAGE_PROVIDERS', () => {
  it('gives every provider a unique id', () => {
    const ids = IMAGE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names an env var for everything except the keyless procedural adapter', () => {
    for (const provider of IMAGE_PROVIDERS) {
      if (provider.id === 'procedural') expect(provider.envKey).toBeNull();
      else expect(provider.envKey).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('finds a provider by id and returns undefined for an unknown one', () => {
    expect(findProvider('unsplash')?.label).toBe('Unsplash');
    expect(findProvider('nope')).toBeUndefined();
  });

  it('groups by category', () => {
    expect(providersByCategory('stock').map((p) => p.id)).toEqual(['unsplash', 'pexels']);
    expect(providersByCategory('local').map((p) => p.id)).toEqual(['local']);
    expect(providersByCategory('ai')).toContainEqual(
      expect.objectContaining({ id: 'grok' })
    );
  });
});

describe('key detection', () => {
  it('reports nothing configured for an empty environment', () => {
    expect(hasStockKey({})).toBe(false);
    expect(hasAiKey({})).toBe(false);
    expect(configuredProviders({})).toEqual([]);
  });

  it('detects a stock key without claiming an AI key', () => {
    const env = { UNSPLASH_ACCESS_KEY: 'abc' };
    expect(hasStockKey(env)).toBe(true);
    expect(hasAiKey(env)).toBe(false);
    expect(configuredProviders(env).map((p) => p.id)).toEqual(['unsplash']);
  });

  it('detects an AI key', () => {
    expect(hasAiKey({ XAI_API_KEY: 'abc' })).toBe(true);
  });

  it('ignores a variable set to an empty or whitespace-only string', () => {
    // A commented-out line that someone uncommented but never filled in reads
    // as "" here. Treating that as configured sends every request unauthorised.
    expect(hasStockKey({ UNSPLASH_ACCESS_KEY: '' })).toBe(false);
    expect(hasStockKey({ UNSPLASH_ACCESS_KEY: '   ' })).toBe(false);
  });

  it('does not treat the keyless procedural adapter as a configured provider', () => {
    expect(configuredProviders({}).map((p) => p.id)).not.toContain('procedural');
  });

  it('does not treat a local image directory as an AI or stock key', () => {
    const env = { THEMESEED_LOCAL_IMAGE_DIR: '/tmp/pics' };
    expect(hasStockKey(env)).toBe(false);
    expect(hasAiKey(env)).toBe(false);
    expect(configuredProviders(env).map((p) => p.id)).toEqual(['local']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --project unit test/unit/providers.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/images/providers.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/images/providers.ts`:

```ts
/**
 * The one description of every image provider themeseed can be configured with.
 *
 * Four things read this table: the generated `~/.themeseed/.env` template, the
 * `themeseed init` wizard, `themeseed images --list`, and the `auto` image
 * source resolver. Keeping them on one list is the point — a provider added in
 * four places is a provider that ends up documented in three.
 */

export type ProviderCategory = 'stock' | 'ai' | 'local';

export interface ImageProviderInfo {
  id: string;
  label: string;
  category: ProviderCategory;
  /**
   * Environment variable holding the credential. Null for providers that need
   * none, which cannot be "configured" and are skipped by configuredProviders.
   */
  envKey: string | null;
  /** Where a key comes from. Empty when none is needed. */
  signupUrl: string;
  /** One line, shown in the .env template and as a wizard hint. */
  note: string;
}

export const IMAGE_PROVIDERS: readonly ImageProviderInfo[] = [
  {
    id: 'unsplash',
    label: 'Unsplash',
    category: 'stock',
    envKey: 'UNSPLASH_ACCESS_KEY',
    signupUrl: 'https://unsplash.com/developers',
    note: 'Free developer tier. Best match quality of the two stock APIs.',
  },
  {
    id: 'pexels',
    label: 'Pexels',
    category: 'stock',
    envKey: 'PEXELS_API_KEY',
    signupUrl: 'https://www.pexels.com/api/',
    note: 'Free, generous rate limit, no attribution requirement.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'ai',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    note: 'OpenAI Images API. Paid per image.',
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    category: 'ai',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai/',
    note: 'grok-imagine-image. Paid per image.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    category: 'ai',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    note: 'Needs billing enabled on the project, or every call returns 429.',
  },
  {
    id: 'fal',
    label: 'fal.ai',
    category: 'ai',
    envKey: 'FAL_KEY',
    signupUrl: 'https://fal.ai/dashboard/keys',
    note: 'Hosted open models. The key is "<id>:<secret>".',
  },
  {
    id: 'procedural',
    label: 'Procedural placeholders',
    category: 'ai',
    envKey: null,
    signupUrl: '',
    note: 'Locally generated placeholder art. Needs no key, and is not AI.',
  },
  {
    id: 'local',
    label: 'Local folder',
    category: 'local',
    envKey: 'THEMESEED_LOCAL_IMAGE_DIR',
    signupUrl: '',
    note: 'A directory of images on this machine.',
  },
] as const;

export type ProviderEnv = Record<string, string | undefined>;

export function findProvider(id: string): ImageProviderInfo | undefined {
  return IMAGE_PROVIDERS.find((provider) => provider.id === id);
}

export function providersByCategory(
  category: ProviderCategory
): ImageProviderInfo[] {
  return IMAGE_PROVIDERS.filter((provider) => provider.category === category);
}

/**
 * True when this provider's credential is present and not blank. A variable
 * uncommented but left empty is the common half-configured state, and treating
 * it as configured sends every request out unauthorised.
 */
export function isConfigured(
  provider: ImageProviderInfo,
  env: ProviderEnv = process.env
): boolean {
  if (!provider.envKey) return false;
  return (env[provider.envKey] ?? '').trim().length > 0;
}

export function configuredProviders(env: ProviderEnv = process.env): ImageProviderInfo[] {
  return IMAGE_PROVIDERS.filter((provider) => isConfigured(provider, env));
}

export function hasStockKey(env: ProviderEnv = process.env): boolean {
  return providersByCategory('stock').some((provider) => isConfigured(provider, env));
}

export function hasAiKey(env: ProviderEnv = process.env): boolean {
  return providersByCategory('ai').some((provider) => isConfigured(provider, env));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --project unit test/unit/providers.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/images/providers.ts test/unit/providers.test.ts
git commit -m "feat(images): add the provider table that drives config and selection"
```

---

## Task 2: `~/.themeseed/.env`

The file that fixes the original bug. Note the upsert requirement: the template ships every key already present but commented out, so setting a key must rewrite that line in place rather than append a second one.

**Files:**
- Create: `src/config/env.ts`
- Test: `test/unit/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/env.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureEnvFile,
  envPath,
  loadUserEnv,
  readEnvValues,
  setEnvValues,
} from '../../src/config/env.js';

let tempDir: string;
const originalConfigDir = process.env.THEMESEED_CONFIG_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-env-'));
  process.env.THEMESEED_CONFIG_DIR = tempDir;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.THEMESEED_CONFIG_DIR;
  else process.env.THEMESEED_CONFIG_DIR = originalConfigDir;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('envPath', () => {
  it('sits next to sites.json in the config directory', () => {
    expect(envPath()).toBe(path.join(tempDir, '.env'));
  });
});

describe('ensureEnvFile', () => {
  it('creates a template containing every provider variable, commented out', async () => {
    expect(await ensureEnvFile()).toBe(true);
    const body = await fs.readFile(envPath(), 'utf8');
    for (const key of ['UNSPLASH_ACCESS_KEY', 'PEXELS_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GOOGLE_API_KEY', 'FAL_KEY', 'THEMESEED_LOCAL_IMAGE_DIR']) {
      expect(body).toContain(`# ${key}=`);
    }
    // Commented out means nothing is actually set yet.
    expect(await readEnvValues()).toEqual({});
  });

  it('documents the content engine without prompting for it', async () => {
    await ensureEnvFile();
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body).toContain('# THEMESEED_CONTENT_ENGINE=');
    expect(body).toContain('# ANTHROPIC_API_KEY=');
  });

  it('never overwrites an existing file, because it holds secrets', async () => {
    await fs.writeFile(envPath(), 'UNSPLASH_ACCESS_KEY=mine\n');
    expect(await ensureEnvFile()).toBe(false);
    expect(await fs.readFile(envPath(), 'utf8')).toBe('UNSPLASH_ACCESS_KEY=mine\n');
  });

  it('creates the file readable only by its owner', async () => {
    await ensureEnvFile();
    const stat = await fs.stat(envPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('setEnvValues', () => {
  it('uncomments an existing key in place instead of appending a duplicate', async () => {
    await ensureEnvFile();
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'abc123' });
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body.match(/^#?\s*UNSPLASH_ACCESS_KEY=/gm)).toHaveLength(1);
    expect(body).toContain('UNSPLASH_ACCESS_KEY=abc123');
    expect(await readEnvValues()).toEqual({ UNSPLASH_ACCESS_KEY: 'abc123' });
  });

  it('leaves the surrounding comments and section headers alone', async () => {
    await ensureEnvFile();
    const before = await fs.readFile(envPath(), 'utf8');
    await setEnvValues({ PEXELS_API_KEY: 'xyz' });
    const after = await fs.readFile(envPath(), 'utf8');
    const comments = (body: string) =>
      body.split('\n').filter((line) => line.startsWith('#') && !/^#\s*[A-Z]/.test(line));
    expect(comments(after)).toEqual(comments(before));
  });

  it('replaces a value that is already set', async () => {
    await ensureEnvFile();
    await setEnvValues({ FAL_KEY: 'first' });
    await setEnvValues({ FAL_KEY: 'second' });
    expect(await readEnvValues()).toEqual({ FAL_KEY: 'second' });
  });

  it('appends a key the template does not mention', async () => {
    await ensureEnvFile();
    await setEnvValues({ SOMETHING_NEW: 'value' });
    expect(await readEnvValues()).toEqual({ SOMETHING_NEW: 'value' });
  });

  it('comments a key back out when given null, discarding the value', async () => {
    await ensureEnvFile();
    await setEnvValues({ XAI_API_KEY: 'secret' });
    await setEnvValues({ XAI_API_KEY: null });
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body).not.toContain('secret');
    expect(body).toContain('# XAI_API_KEY=');
    expect(await readEnvValues()).toEqual({});
  });

  it('quotes a value containing spaces so dotenv reads it back whole', async () => {
    await ensureEnvFile();
    await setEnvValues({ THEMESEED_LOCAL_IMAGE_DIR: '/Users/me/My Pictures' });
    expect(await readEnvValues()).toEqual({
      THEMESEED_LOCAL_IMAGE_DIR: '/Users/me/My Pictures',
    });
  });

  it('creates the file first when it does not exist yet', async () => {
    await setEnvValues({ PEXELS_API_KEY: 'abc' });
    expect(await readEnvValues()).toEqual({ PEXELS_API_KEY: 'abc' });
  });

  it('writes several keys in one call', async () => {
    await ensureEnvFile();
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'a', FAL_KEY: 'b' });
    expect(await readEnvValues()).toEqual({ UNSPLASH_ACCESS_KEY: 'a', FAL_KEY: 'b' });
  });
});

describe('loadUserEnv', () => {
  it('puts the file contents into process.env', async () => {
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'from-file' });
    loadUserEnv();
    expect(process.env.UNSPLASH_ACCESS_KEY).toBe('from-file');
  });

  it('does not override a variable already exported in the process', async () => {
    // Someone who exports a key in their shell for one run means it.
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'from-file' });
    process.env.UNSPLASH_ACCESS_KEY = 'from-shell';
    loadUserEnv();
    expect(process.env.UNSPLASH_ACCESS_KEY).toBe('from-shell');
  });

  it('does nothing and does not throw when the file is absent', () => {
    expect(() => loadUserEnv()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --project unit test/unit/env.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/config/env.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/config/env.ts`:

```ts
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
  const section = (title: string, rule = true): string =>
    rule ? `# --- ${title} ${'-'.repeat(Math.max(0, 74 - title.length))}` : `# ${title}`;

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
    '# or "anthropic" (better prose, needs a key). An MCP host\'s own model is',
    '# used when one is available, whatever this says.',
    '# THEMESEED_CONTENT_ENGINE=',
    '# ANTHROPIC_API_KEY=',
    ''
  );

  // Guards against a provider added to the table but forgotten here.
  for (const provider of IMAGE_PROVIDERS) {
    if (provider.envKey && !lines.some((line) => line.startsWith(`# ${provider.envKey}=`))) {
      lines.push(`# ${provider.envKey}=`);
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --project unit test/unit/env.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add src/config/env.ts test/unit/env.test.ts
git commit -m "feat(config): store provider keys in ~/.themeseed/.env"
```

---

## Task 3: The documented `sites.json` template

**Files:**
- Create: `src/config/templates.ts`
- Test: `test/unit/templates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/templates.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  sitesExamplePath,
  writeSitesExample,
} from '../../src/config/templates.js';

let tempDir: string;
const originalConfigDir = process.env.THEMESEED_CONFIG_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-tpl-'));
  process.env.THEMESEED_CONFIG_DIR = tempDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.THEMESEED_CONFIG_DIR;
  else process.env.THEMESEED_CONFIG_DIR = originalConfigDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('writeSitesExample', () => {
  it('writes strict JSON that JSON.parse accepts', async () => {
    await writeSitesExample();
    const body = await fs.readFile(sitesExamplePath(), 'utf8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('documents every field of a site entry', async () => {
    await writeSitesExample();
    const parsed = JSON.parse(await fs.readFile(sitesExamplePath(), 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.defaultSite).toBeTypeOf('string');

    const site = parsed.sites[parsed.defaultSite];
    expect(site.platform).toBe('ghost');
    expect(site.url).toBeTypeOf('string');
    expect(site.credentials.adminApiKey).toBeTypeOf('string');
    expect(site.options.themesDir).toBeTypeOf('string');

    // Documentation rides on "//" keys, because JSON has no comments.
    for (const field of ['platform', 'url', 'credentials', 'options']) {
      expect(site[`//${field}`]).toBeTypeOf('string');
    }
  });

  it('is regenerated on every call, since it holds no user data', async () => {
    await writeSitesExample();
    await fs.writeFile(sitesExamplePath(), '{"stale": true}');
    await writeSitesExample();
    const parsed = JSON.parse(await fs.readFile(sitesExamplePath(), 'utf8'));
    expect(parsed.stale).toBeUndefined();
    expect(parsed.version).toBe(1);
  });

  it('does not overwrite the live sites.json', async () => {
    await fs.writeFile(path.join(tempDir, 'sites.json'), '{"version":1,"sites":{}}');
    await writeSitesExample();
    expect(await fs.readFile(path.join(tempDir, 'sites.json'), 'utf8')).toBe(
      '{"version":1,"sites":{}}'
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --project unit test/unit/templates.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/config/templates.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/config/templates.ts`:

```ts
/**
 * The documented sites.json template at ~/.themeseed/sites.example.json.
 *
 * JSON has no comments, so documentation rides on "//" keys. The file stays
 * strict JSON on purpose: a user can copy it to sites.json, delete the "//"
 * lines, and have a working config, rather than translating a comment syntax
 * the loader would reject.
 *
 * It carries no user data, so it is regenerated on every init — the shipped
 * documentation should describe the installed version, not the one that
 * happened to be installed first.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { IMPLEMENTED_PLATFORMS, PLATFORMS } from '../core/types.js';
import { configDir } from './sites.js';

export function sitesExamplePath(): string {
  return path.join(configDir(), 'sites.example.json');
}

export async function writeSitesExample(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(buildExample(), null, 2)}\n`;
  const file = sitesExamplePath();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, body, { mode: 0o644 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o644);
}

function buildExample(): Record<string, unknown> {
  return {
    '//': [
      'Template for sites.json in this same directory.',
      'Copy this file to sites.json, delete every "//" key, and fill in your values.',
      '`themeseed add-site` writes sites.json for you; this file exists so you can',
      'see and edit every field by hand.',
    ].join(' '),
    version: 1,
    '//defaultSite':
      'Slug used when a command omits one. Must match a key under "sites".',
    defaultSite: 'my-blog',
    '//sites':
      'One entry per site. The key is the slug you pass to commands, e.g. ' +
      '`themeseed seed my-blog`. Lowercase letters, digits and hyphens only.',
    sites: {
      'my-blog': {
        '//platform': `One of: ${PLATFORMS.join(', ')}. Implemented today: ${IMPLEMENTED_PLATFORMS.join(', ')}.`,
        platform: 'ghost',
        '//url': 'Base URL of the site, with no trailing slash.',
        url: 'https://blog.example.com',
        '//credentials':
          'Ghost: adminApiKey in "<id>:<hex secret>" form, from Ghost Admin -> ' +
          'Settings -> Integrations -> Add custom integration.',
        credentials: {
          adminApiKey: '000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000',
        },
        '//options':
          'Optional. themesDir is an absolute path to the CMS themes directory on ' +
          'this machine. For Ghost it makes `themeseed seed --study-theme` ' +
          'source-accurate, because the Admin API refuses to serve theme files to ' +
          'an API token.',
        options: {
          themesDir: '/var/www/ghost/content/themes',
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --project unit test/unit/templates.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add src/config/templates.ts test/unit/templates.test.ts
git commit -m "feat(config): generate a documented sites.example.json"
```

---

## Task 4: Load the user's `.env` in both entry points

The actual bugfix. Before this task the keys exist and nothing reads them.

**Files:**
- Modify: `src/mcp/index.ts:11,15` and `src/cli/index.ts:17,34`

- [ ] **Step 1: Swap the loader in the MCP entry point**

In `src/mcp/index.ts`, delete the `import dotenv from 'dotenv';` line and the `dotenv.config({ quiet: true });` call. Add to the import block:

```ts
import { loadUserEnv } from '../config/env.js';
```

and replace the removed call with:

```ts
// Provider keys come from ~/.themeseed/.env, not the working directory: an
// editor launches this server wherever it likes, and a relative lookup there
// finds a different file every time, or none.
loadUserEnv();
```

- [ ] **Step 2: Swap the loader in the CLI entry point**

In `src/cli/index.ts`, delete `import dotenv from 'dotenv';` and `dotenv.config({ quiet: true });`. Add `import { loadUserEnv } from '../config/env.js';` to the import block and call `loadUserEnv();` in its place, so both surfaces read the same file.

- [ ] **Step 3: Confirm nothing else depended on the working-directory load**

Run: `grep -rn "dotenv" src/ test/`
Expected: no `dotenv` import left in `src/cli/index.ts` or `src/mcp/index.ts`; `src/config/env.ts` uses it; `test/e2e/ghost.e2e.test.ts:13` still has its own `import 'dotenv/config';`, which is what keeps `GHOST_TEST_BLOG_ENDPOINT` and `GHOST_TEST_BLOG_KEY` working for the e2e suite. Leave that line alone.

- [ ] **Step 4: Verify the CLI still starts**

Run: `npm run build && node dist/cli/index.js --version`
Expected: prints the version with no dotenv error.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run verify
git add src/cli/index.ts src/mcp/index.ts
git commit -m "fix(config): read provider keys from ~/.themeseed/.env, not the cwd

An editor launches themeseed-mcp in whatever directory it has open, so the
bare dotenv.config() call resolved to an unrelated .env or to nothing at all.
Stock lookups then degraded silently to keyless Lorem Picsum."
```

---

## Task 5: Optional images — the `none` source and `auto` resolution

**Files:**
- Create: `src/images/none-source.ts`
- Modify: `src/core/types.ts:145` (the `ImageSourceKind` line), `src/images/index.ts`
- Test: `test/unit/image-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/image-resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createImageSource,
  createRequestedImageSource,
  resolveImageSourceKind,
} from '../../src/images/index.js';
import { NoneImageSource } from '../../src/images/none-source.js';

describe('resolveImageSourceKind', () => {
  it('prefers AI when an AI key is set, because it matches the topic best', () => {
    expect(resolveImageSourceKind('auto', { XAI_API_KEY: 'k' })).toBe('ai');
  });

  it('prefers AI over stock when both are set', () => {
    expect(
      resolveImageSourceKind('auto', { XAI_API_KEY: 'k', UNSPLASH_ACCESS_KEY: 'k' })
    ).toBe('ai');
  });

  it('falls back to stock when only a stock key is set', () => {
    expect(resolveImageSourceKind('auto', { PEXELS_API_KEY: 'k' })).toBe('stock');
  });

  it('resolves to none when nothing is configured', () => {
    expect(resolveImageSourceKind('auto', {})).toBe('none');
  });

  it('passes an explicit kind through untouched, whatever is configured', () => {
    expect(resolveImageSourceKind('stock', {})).toBe('stock');
    expect(resolveImageSourceKind('ai', {})).toBe('ai');
    expect(resolveImageSourceKind('local', { XAI_API_KEY: 'k' })).toBe('local');
    expect(resolveImageSourceKind('none', { XAI_API_KEY: 'k' })).toBe('none');
  });
});

describe('NoneImageSource', () => {
  it('is always usable', async () => {
    const source = new NoneImageSource();
    expect(source.kind).toBe('none');
    expect(await source.isAvailable()).toBe(true);
    expect(await source.unavailableReason()).toBe('');
  });

  it('returns no images rather than failing', async () => {
    const source = new NoneImageSource();
    expect(await source.fetch({ query: 'anything' }, 5)).toEqual([]);
  });

  it('is what the factory builds for "none"', () => {
    expect(createImageSource('none').kind).toBe('none');
  });
});

describe('createRequestedImageSource', () => {
  it('never fails for auto — it degrades to no images', async () => {
    const source = await createRequestedImageSource('auto', {}, {});
    expect(source.kind).toBe('none');
  });

  it('fails loudly for an explicit source that cannot run', async () => {
    // An explicit choice was the caller's decision; degrading it silently
    // would hide a typo in a key behind pictureless posts.
    await expect(
      createRequestedImageSource('local', { local: { directory: '/no/such/dir' } }, {})
    ).rejects.toThrow(/not usable/i);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --project unit test/unit/image-resolve.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/images/none-source.js"`.

- [ ] **Step 3: Widen the types**

In `src/core/types.ts`, replace the line `export type ImageSourceKind = 'local' | 'stock' | 'ai';` with:

```ts
export type ImageSourceKind = 'local' | 'stock' | 'ai' | 'none';

/**
 * What a caller may ask for. `auto` picks a kind from whichever provider keys
 * are configured, so it is a request and never an answer — `ImageRef.source`
 * records the kind that actually produced the bytes.
 */
export type RequestedImageSource = ImageSourceKind | 'auto';
```

- [ ] **Step 4: Write the none source**

Create `src/images/none-source.ts`:

```ts
/**
 * The image source that sources no images.
 *
 * Images are an enhancement, not a requirement: a run with no provider
 * configured should publish text-only posts rather than fail, or fill the
 * theme with stock photographs unrelated to the topic. Modelling that as a
 * source keeps the decision in one place — nothing downstream needs a null
 * check on `imageSource`.
 */

import type { ImageRef, ImageRequest } from '../core/types.js';
import type { ImageSource } from './source.js';

export class NoneImageSource implements ImageSource {
  readonly kind = 'none' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async unavailableReason(): Promise<string> {
    return '';
  }

  // The parameters go unused but must be declared: a zero-arity override makes
  // every `fetch(request, count)` call site a type error. eslint.config.js
  // ignores arguments prefixed with an underscore.
  async fetch(_request: ImageRequest, _count: number): Promise<ImageRef[]> {
    return [];
  }
}
```

- [ ] **Step 5: Wire it into the factory**

In `src/images/index.ts`, extend the existing type import from `../core/types.js`
so it reads:

```ts
import type { ImageSourceKind, RequestedImageSource } from '../core/types.js';
```

Do not add a second import statement for that module. Then add these two beside
the other imports:

```ts
import { hasAiKey, hasStockKey, type ProviderEnv } from './providers.js';
import { NoneImageSource } from './none-source.js';
```

Add a case to the `switch` in `createImageSource`, above `default:`:

```ts
    case 'none':
      return new NoneImageSource();
```

Append these two functions after `createUsableImageSource`:

```ts
/**
 * Turns a request into a concrete kind. `auto` prefers AI, because a generated
 * image matches the post's subject exactly; stock is second, because a searched
 * photograph is at least topical; no images is better than the keyless stock
 * fallback, which returns pictures of nothing in particular.
 */
export function resolveImageSourceKind(
  requested: RequestedImageSource,
  env: ProviderEnv = process.env
): ImageSourceKind {
  if (requested !== 'auto') return requested;
  if (hasAiKey(env)) return 'ai';
  if (hasStockKey(env)) return 'stock';
  return 'none';
}

/**
 * Builds the source a caller asked for.
 *
 * `auto` chose the kind itself, so it must not then fail on that choice. An
 * explicit kind was the caller's decision, and a decision that cannot run is
 * an error worth reporting rather than quietly downgrading.
 */
export async function createRequestedImageSource(
  requested: RequestedImageSource,
  options: ImageSourceOptions = {},
  env: ProviderEnv = process.env
): Promise<ImageSource> {
  const kind = resolveImageSourceKind(requested, env);
  return requested === 'auto'
    ? createImageSource(kind, options)
    : createUsableImageSource(kind, options);
}
```

Add to the export block at the bottom of the file:

```ts
export { NoneImageSource } from './none-source.js';
export {
  IMAGE_PROVIDERS,
  configuredProviders,
  findProvider,
  hasAiKey,
  hasStockKey,
  isConfigured,
  providersByCategory,
} from './providers.js';
export type { ImageProviderInfo, ProviderCategory, ProviderEnv } from './providers.js';
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run --project unit test/unit/image-resolve.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Run the full gate**

Run: `npm run verify`
Expected: PASS. If `tsc` reports a non-exhaustive switch anywhere that branches on `ImageSourceKind`, add the `'none'` branch there — that error is the compiler finding a caller this task missed, and it must be fixed rather than cast away.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/images/none-source.ts src/images/index.ts test/unit/image-resolve.test.ts
git commit -m "feat(images): make images optional via a none source and auto resolution"
```

---

## Task 6: Optional theme study

**Files:**
- Create: `src/core/theme-defaults.ts`
- Modify: `src/core/seed.ts:22-45` (the `SeedRequest` interface) and `:52-80` (the body of `seedSite`)
- Test: `test/unit/theme-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/theme-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { seedSite } from '../../src/core/seed.js';
import { genericCapabilities } from '../../src/core/theme-defaults.js';
import type {
  SeedContent,
  SeedResult,
  ThemeCapabilities,
} from '../../src/core/types.js';
import type { CmsProvider, SiteConfig } from '../../src/providers/provider.js';
import { registerProvider } from '../../src/providers/registry.js';

describe('genericCapabilities', () => {
  it('reports zero confidence, because nothing was measured', () => {
    const capabilities = genericCapabilities('ghost');
    expect(capabilities.confidence).toBe(0);
    expect(capabilities.analyzedVia).toEqual(['defaults']);
    expect(capabilities.evidence.join(' ')).toMatch(/no theme analysis/i);
  });

  it('assumes the safe half of every choice', () => {
    const capabilities = genericCapabilities('ghost');
    // Present in nearly every theme.
    expect(capabilities.supportsFeatureImage).toBe(true);
    expect(capabilities.displaysTags).toBe(true);
    expect(capabilities.displaysAuthor).toBe(true);
    // A card the theme cannot style looks worse than its absence.
    expect(capabilities.supportsGallery).toBe(false);
    expect(capabilities.supportsVideoEmbed).toBe(false);
    expect(capabilities.supportsBookmarkCard).toBe(false);
    expect(capabilities.supportsWideImages).toBe(false);
  });

  it('carries the platform it was asked about', () => {
    expect(genericCapabilities('wordpress').platform).toBe('wordpress');
  });
});

// A counting stand-in. registerProvider is exported, so this needs no module
// mocking — it registers under a platform that has no real implementation.
let analyzeCalls = 0;

const measured: ThemeCapabilities = {
  ...genericCapabilities('wordpress'),
  themeName: 'measured-theme',
  confidence: 0.9,
  analyzedVia: ['test'],
};

function fakeProvider(): CmsProvider {
  return {
    platform: 'wordpress',
    async verifyConnection() {
      return { title: 'Fake', url: 'https://fake.test' };
    },
    async analyzeTheme() {
      analyzeCalls += 1;
      return measured;
    },
    async createContent(items: SeedContent[]): Promise<SeedResult[]> {
      return items.map((item, index) => ({
        id: `fake-${index}`,
        title: item.title,
        status: item.status,
        hasFeatureImage: Boolean(item.featureImage),
      }));
    },
    async listSeeded() {
      return [];
    },
    async wipeSeeded() {
      return { removed: 0 };
    },
  };
}

registerProvider('wordpress', fakeProvider);

const site: SiteConfig = {
  platform: 'wordpress',
  url: 'https://fake.test',
  credentials: {},
};

const request = {
  site,
  topic: 'test topic',
  count: 1,
  imageSource: 'none' as const,
  includeVideo: false,
};

describe('seedSite theme study', () => {
  it('does not read the theme when nobody asked', async () => {
    analyzeCalls = 0;
    const report = await seedSite(request);
    expect(analyzeCalls).toBe(0);
    expect(report.capabilities.analyzedVia).toEqual(['defaults']);
    expect(report.created).toBe(1);
  });

  it('reads the theme when studyTheme is true', async () => {
    analyzeCalls = 0;
    const report = await seedSite({ ...request, studyTheme: true });
    expect(analyzeCalls).toBe(1);
    expect(report.capabilities.themeName).toBe('measured-theme');
  });

  it('still prefers capabilities the caller supplied', async () => {
    analyzeCalls = 0;
    const supplied = { ...measured, themeName: 'supplied' };
    const report = await seedSite({ ...request, studyTheme: true, capabilities: supplied });
    expect(analyzeCalls).toBe(0);
    expect(report.capabilities.themeName).toBe('supplied');
  });

  it('publishes without images when the source is none', async () => {
    const report = await seedSite(request);
    expect(report.generation.withFeatureImage).toBe(0);
    expect(report.failed).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --project unit test/unit/theme-defaults.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/theme-defaults.js"`.

- [ ] **Step 3: Write the defaults**

Create `src/core/theme-defaults.ts`:

```ts
/**
 * What to assume about a theme nobody asked us to read.
 *
 * Reading a theme costs a round trip and is worth paying for only when the
 * user wants content shaped to that theme's design. Without it, assume the
 * conservative half of every choice: a feature image, tags and an author,
 * because nearly every theme shows those; no galleries, video embeds, bookmark
 * cards or wide images, because a card the theme cannot style looks worse than
 * its absence.
 *
 * `confidence: 0` and `analyzedVia: ['defaults']` mark this as assumed rather
 * than measured, which is also how callers tell it apart from an analysis that
 * ran and found nothing.
 */

import type { Platform, ThemeCapabilities } from './types.js';

export function genericCapabilities(platform: Platform): ThemeCapabilities {
  return {
    platform,
    themeName: 'unknown',

    supportsFeatureImage: true,
    featureImageAspectRatio: 1.5,

    supportsGallery: false,
    supportsVideoEmbed: false,
    supportsBookmarkCard: false,
    supportsCodeBlocks: true,
    supportsWideImages: false,

    displaysTags: true,
    displaysAuthor: true,
    displaysAuthorImage: false,
    displaysExcerpt: true,
    displaysReadingTime: false,

    expectedWordCount: { min: 500, target: 850, max: 1200 },

    confidence: 0,
    evidence: [
      'no theme analysis was requested — these are generic defaults, not measurements',
      'run `themeseed seed --study-theme`, or `themeseed analyze`, to read the real theme',
    ],
    analyzedVia: ['defaults'],
  };
}
```

- [ ] **Step 4: Gate the analysis in seedSite**

In `src/core/seed.ts`, add to the imports:

```ts
import { genericCapabilities } from './theme-defaults.js';
```

and add `RequestedImageSource` to the type import from `./types.js`, removing `ImageSourceKind` from it if nothing else in the file uses it.

In the `SeedRequest` interface, replace `imageSource?: ImageSourceKind;` with:

```ts
  /** Defaults to `auto`: AI if a key is set, else stock, else no images. */
  imageSource?: RequestedImageSource;
```

and add, next to `capabilities`:

```ts
  /**
   * Read the site's real theme and shape content to it. Off by default: the
   * analysis costs a round trip and only pays for itself when the caller
   * actually wants content matched to the theme's design.
   */
  studyTheme?: boolean;
```

Replace the whole opening block of `seedSite` — from `request.onProgress?.('analyzing', ...)` down to and including the `if (capabilities.confidence < 0.35) { ... }` block — with:

```ts
  const studyTheme = request.studyTheme ?? false;

  if (studyTheme) request.onProgress?.('analyzing', 0, 1, 'reading the active theme');
  const capabilities =
    request.capabilities ??
    (studyTheme
      ? await provider.analyzeTheme()
      : genericCapabilities(request.site.platform));
  request.onProgress?.(
    'analyzing',
    1,
    1,
    studyTheme
      ? `${capabilities.themeName} (confidence ${capabilities.confidence})`
      : 'using generic defaults (pass studyTheme to read the theme)'
  );

  // Only an analysis that ran can be low confidence. Warning about defaults
  // would nag every run about a reading nobody asked for.
  if (studyTheme && !request.capabilities && capabilities.confidence < 0.35) {
    logger.warn(
      `theme analysis for "${capabilities.themeName}" is low confidence (${capabilities.confidence}); ` +
        'content will use conservative defaults. Point --themes-dir at the Ghost install for an accurate reading.'
    );
  }
```

Then replace the two lines that build the image source:

```ts
  const imageSourceKind = request.imageSource ?? 'stock';
  const imageSource = await createUsableImageSource(
    imageSourceKind,
    request.imageSourceOptions ?? {}
  );
```

with:

```ts
  const imageSource = await createRequestedImageSource(
    request.imageSource ?? 'auto',
    request.imageSourceOptions ?? {}
  );
```

and change the import from `../images/index.js` to bring in `createRequestedImageSource` instead of `createUsableImageSource`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run --project unit test/unit/theme-defaults.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run verify
git add src/core/theme-defaults.ts src/core/seed.ts test/unit/theme-defaults.test.ts
git commit -m "feat(core): make theme analysis opt-in via studyTheme"
```

---

## Task 7: Surface both options on the CLI and MCP

**Files:**
- Modify: `src/cli/commands/content.ts:109-120` (`SeedFlags`) and `:143`, `:158-166`
- Modify: `src/cli/index.ts` (the `seed` command definition)
- Modify: `src/mcp/server.ts:28-32` (`instructions`), and the `generate_posts` tool

- [ ] **Step 1: Add the CLI flags**

In `src/cli/commands/content.ts`, add to `SeedFlags`:

```ts
  studyTheme?: boolean;
```

Change the `ImageSourceKind` type import to `RequestedImageSource`, and replace:

```ts
  const imageSource = (flags.imageSource as ImageSourceKind) ?? 'stock';
```

with:

```ts
  const imageSource = (flags.imageSource as RequestedImageSource) ?? 'auto';
```

Pass the flag through in the `seedSite({ ... })` call, beside `includeVideo`:

```ts
      studyTheme: Boolean(flags.studyTheme),
```

The spinner currently starts with `spinner.start('Analyzing the theme')`, which would now be a lie on a default run. Replace it with:

```ts
  const spinner = makeSpinner();
  spinner.start(flags.studyTheme ? 'Analyzing the theme' : 'Preparing');
```

- [ ] **Step 2: Register the flags in the command definition**

In `src/cli/index.ts`, in the `seed` command, replace the image-source option and add the study flag:

```ts
  .option(
    '-i, --image-source <source>',
    'auto | local | stock | ai | none. auto uses AI if a key is set, else stock, else no images',
    'auto'
  )
  .option(
    '--study-theme',
    "Read the site's active theme and shape content to it (costs an extra round trip)"
  )
```

- [ ] **Step 3: Check it by hand**

Run: `npm run build && node dist/cli/index.js seed --help`
Expected: `-i, --image-source <source>` shows `(default: "auto")`, and `--study-theme` is listed.

- [ ] **Step 4: Update the MCP server instructions**

In `src/mcp/server.ts`, replace the `instructions` string with:

```ts
      instructions:
        'themeseed fills a CMS with realistic demo content so a theme can be previewed with ' +
        'real-looking articles, images, galleries and video embeds. Call generate_posts directly; ' +
        'it needs no setup call first. Call analyze_theme only when the user asks about the theme, ' +
        'and set generate_posts.studyTheme when they want content shaped to the theme\'s design. ' +
        'Images are optional: with no provider key configured, posts publish without them. ' +
        'Everything it creates is tagged #themeseed and can be removed with wipe_seeded. ' +
        'Ghost is supported today.',
```

- [ ] **Step 5: Update the generate_posts schema**

In `src/mcp/server.ts`, replace the `imageSource` field of `generate_posts` with:

```ts
        imageSource: z
          .enum(['auto', 'local', 'stock', 'ai', 'none'])
          .default('auto')
          .describe(
            'auto = AI if an AI key is configured, else stock if a stock key is, else no images. ' +
              'local = a folder on disk (THEMESEED_LOCAL_IMAGE_DIR); stock = Unsplash/Pexels, ' +
              'falling back to keyless Lorem Picsum; ai = a generated image; none = text only. ' +
              'Keys live in ~/.themeseed/.env; the user sets them with `themeseed images`.'
          ),
```

and add, after `includeVideo`:

```ts
        studyTheme: z
          .boolean()
          .default(false)
          .describe(
            "Read the site's active theme first and shape content to what it can display. " +
              'Set this when the user asks for content that matches their theme or design; ' +
              'leave it false otherwise, because the analysis costs an extra round trip.'
          ),
```

Pass it through in the `seedSite({ ... })` call in the same handler:

```ts
        studyTheme: args.studyTheme,
```

- [ ] **Step 6: Report honestly when no theme was read**

Still in `generate_posts`, the summary line names the theme. On a default run that name is `unknown`, which reads as a failure rather than a choice. Replace the first line of `lines` with:

```ts
        `Created ${report.created} of ${args.count} posts on "${slug}"${
          args.studyTheme ? ` (theme: ${report.capabilities.themeName})` : ''
        }.`,
```

Apply the same treatment in `src/cli/commands/content.ts`, replacing the theme line of the summary:

```ts
    if (flags.studyTheme) {
      console.log(`  theme            ${pc.bold(report.capabilities.themeName)}`);
    }
```

- [ ] **Step 7: Run the full gate and commit**

```bash
npm run verify
git add src/cli/index.ts src/cli/commands/content.ts src/mcp/server.ts
git commit -m "feat: expose studyTheme and the auto/none image sources on both surfaces"
```

---

## Task 8: The image provider wizard

The half of the request the user actually noticed: being asked. One wizard, called from `init` and from a new standalone command.

**Files:**
- Create: `src/cli/commands/images.ts`
- Modify: `src/cli/commands/init.ts`, `src/cli/index.ts`

- [ ] **Step 1: Write the command module**

Create `src/cli/commands/images.ts`:

```ts
/**
 * `themeseed images` — configure where pictures come from.
 *
 * The same wizard runs during `themeseed init` and on demand afterwards, so
 * there is one flow to maintain and one place a key can be entered. Keys are
 * taken through a masked prompt rather than an argument by default: a key
 * typed as `--key sk-...` lands in shell history and in `ps` output.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { readEnvValues, setEnvValues, envPath, ensureEnvFile } from '../../config/env.js';
import { ConfigError } from '../../core/errors.js';
import {
  IMAGE_PROVIDERS,
  findProvider,
  hasAiKey,
  hasStockKey,
  isConfigured,
  providersByCategory,
  type ImageProviderInfo,
} from '../../images/providers.js';
import { assertInteractive, cancelled, note, success } from '../ui.js';

export interface ImagesFlags {
  list?: boolean;
  set?: string;
  key?: string;
  remove?: string;
}

export async function imagesCommand(flags: ImagesFlags = {}): Promise<void> {
  if (flags.list) return listProviders();
  if (flags.remove) return removeProvider(flags.remove);
  if (flags.set) return setProvider(flags.set, flags.key);

  assertInteractive(
    'A terminal',
    'Use `themeseed images --set <provider> --key <value>` to configure without prompts.'
  );
  p.intro(pc.bgCyan(pc.black(' themeseed — image sources ')));
  await runImageWizard();
  p.outro(`Saved to ${pc.cyan(envPath())}`);
}

/**
 * The shared wizard. `init` calls this between editor setup and site setup,
 * inside its own intro/outro, which is why it prints neither.
 */
export async function runImageWizard(): Promise<void> {
  await ensureEnvFile();
  const current = await readEnvValues();

  p.note(
    'themeseed can illustrate posts three ways. Every one of them is optional:\n' +
      'with none configured, posts publish as text, which is a fair preview of a\n' +
      'theme too. You can add these later with `themeseed images`.',
    'Image sources'
  );

  const categories = await p.multiselect({
    message: 'Which image sources do you want to set up?',
    options: [
      {
        value: 'stock',
        label: 'Stock photos',
        hint: `Unsplash or Pexels${hasStockKey(current) ? ' — configured' : ''}`,
      },
      {
        value: 'ai',
        label: 'AI generated',
        hint: `OpenAI, Grok, Gemini or fal${hasAiKey(current) ? ' — configured' : ''}`,
      },
      {
        value: 'local',
        label: 'A folder on this machine',
        hint: 'Images you already have',
      },
    ],
    initialValues: [],
    required: false,
  });
  if (p.isCancel(categories)) cancelled();

  const chosen = categories as Array<'stock' | 'ai' | 'local'>;
  if (chosen.length === 0) {
    note('Skipped. Posts will publish without images until you add a provider.');
    note(`Add one any time with ${pc.cyan('themeseed images')}.`);
    return;
  }

  for (const category of chosen) {
    const candidates = providersByCategory(category).filter(
      (provider) => provider.envKey !== null
    );

    let provider: ImageProviderInfo | undefined = candidates[0];
    if (candidates.length > 1) {
      const picked = await p.select({
        message: `Which ${category === 'ai' ? 'AI' : category} provider?`,
        options: candidates.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
          hint: isConfigured(candidate, current)
            ? 'already configured — will replace'
            : candidate.note,
        })),
      });
      if (p.isCancel(picked)) cancelled();
      provider = findProvider(picked as string);
    }
    if (!provider?.envKey) continue;

    if (provider.signupUrl) note(`Get a key at ${pc.cyan(provider.signupUrl)}`);

    const isPath = provider.category === 'local';
    const value = isPath
      ? await p.text({
          message: 'Path to the folder',
          placeholder: '/Users/you/Pictures/seed',
          validate: (input) => (input ? undefined : 'Required.'),
        })
      : await p.password({
          message: `${provider.label} key`,
          validate: (input) => (input ? undefined : 'Required.'),
        });
    if (p.isCancel(value)) cancelled();

    await setEnvValues({ [provider.envKey]: (value as string).trim() });
    success(`${provider.label} saved.`);
  }
}

async function listProviders(): Promise<void> {
  const current = await readEnvValues();
  console.log(`\n${pc.bold('Image providers')} ${pc.dim(envPath())}\n`);

  for (const category of ['stock', 'ai', 'local'] as const) {
    console.log(pc.dim(`  ${category}`));
    for (const provider of providersByCategory(category)) {
      const state = !provider.envKey
        ? pc.dim('no key needed')
        : isConfigured(provider, current)
          ? pc.green(mask(current[provider.envKey] ?? ''))
          : pc.dim('not set');
      console.log(`    ${provider.label.padEnd(24)} ${state}`);
    }
  }

  const auto = hasAiKey(current) ? 'ai' : hasStockKey(current) ? 'stock' : 'none';
  console.log(`\n  ${pc.bold('auto')} currently resolves to ${pc.cyan(auto)}`);
  if (auto === 'none') {
    console.log(pc.dim('  Posts will publish without images. Run `themeseed images`.'));
  }
  console.log('');
}

async function setProvider(id: string, value?: string): Promise<void> {
  const provider = requireProvider(id);
  if (!provider.envKey) {
    throw new ConfigError(`${provider.label} needs no key`, {
      hint: 'It is always available. There is nothing to configure.',
    });
  }
  if (!value) {
    throw new ConfigError(`--key is required with --set ${id}`, {
      hint:
        provider.category === 'local'
          ? 'Pass the directory path, e.g. --set local --key /Users/you/Pictures'
          : `Pass the API key, e.g. --set ${id} --key <key>. Run \`themeseed images\` to be prompted instead, which keeps it out of shell history.`,
    });
  }
  await setEnvValues({ [provider.envKey]: value.trim() });
  success(`${provider.label} saved to ${envPath()}`);
}

async function removeProvider(id: string): Promise<void> {
  const provider = requireProvider(id);
  if (!provider.envKey) {
    throw new ConfigError(`${provider.label} has no key to remove`, {
      hint: 'It needs no configuration.',
    });
  }
  await setEnvValues({ [provider.envKey]: null });
  success(`${provider.label} removed from ${envPath()}`);
}

function requireProvider(id: string): ImageProviderInfo {
  const provider = findProvider(id);
  if (!provider) {
    throw new ConfigError(`Unknown image provider "${id}"`, {
      hint: `Known providers: ${IMAGE_PROVIDERS.map((entry) => entry.id).join(', ')}`,
    });
  }
  return provider;
}

/** Shows enough of a key to recognise it, and not enough to use it. */
function mask(value: string): string {
  if (value.length <= 8) return `set (${value.length} chars)`;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
```

- [ ] **Step 2: Register the command**

In `src/cli/index.ts`, add the import:

```ts
import { imagesCommand } from './commands/images.js';
```

and register the command in the setup section, after `mcp-config`:

```ts
program
  .command('images')
  .description('Configure where post images come from (stock, AI or a local folder)')
  .option('--list', 'Show which providers are configured')
  .option('--set <provider>', 'Configure one provider without prompting')
  .option(
    '--key <value>',
    'API key for --set, or a directory path for `--set local`. Prefer the prompt — a key passed as a flag lands in shell history'
  )
  .option('--remove <provider>', 'Forget a provider key')
  .action((options) => imagesCommand(options));
```

- [ ] **Step 3: Add the step to init**

In `src/cli/commands/init.ts`, add the imports:

```ts
import { ensureEnvFile, envPath } from '../../config/env.js';
import { sitesExamplePath, writeSitesExample } from '../../config/templates.js';
import { runImageWizard } from './images.js';
```

Add `skipImages?: boolean;` to `InitFlags`.

In `initCommand`, immediately after the `p.note(...)` "What this is" block, add:

```ts
  await writeConfigFiles();
```

and between the editor step and the site step, add:

```ts
  if (!flags.skipImages && !flags.yes) {
    await runImageWizard();
  }
```

Add this function beside the other step functions:

```ts
/**
 * Puts the config files on disk before anything else runs, so the wizard has
 * somewhere to write and a user who skips every prompt still ends up with a
 * documented file to fill in by hand.
 */
async function writeConfigFiles(): Promise<void> {
  const created = await ensureEnvFile();
  await writeSitesExample();
  p.note(
    `${created ? 'Created' : 'Found'} ${envPath()}\n` +
      `Wrote   ${sitesExamplePath()}\n\n` +
      'Every setting is listed in both files, commented out, so you can fill\n' +
      'them in by hand at any time.',
    'Configuration'
  );
}
```

Finally, update the closing `p.outro` so it points at the new command:

```ts
  p.outro(
    `Done. Run ${pc.cyan('themeseed --help')} to see everything, ` +
      `${pc.cyan('themeseed images')} to add image providers, or ` +
      `${pc.cyan('themeseed seed --topic "..."')} to fill a site.`
  );
```

- [ ] **Step 4: Register the init flag**

In `src/cli/index.ts`, add to the `init` command:

```ts
  .option('--skip-images', 'Do not prompt for image providers')
```

- [ ] **Step 5: Check the non-interactive paths by hand**

```bash
npm run build
export THEMESEED_CONFIG_DIR=$(mktemp -d)
node dist/cli/index.js images --list
node dist/cli/index.js images --set unsplash --key test-key-123456
node dist/cli/index.js images --list
node dist/cli/index.js images --remove unsplash
node dist/cli/index.js images --set nope --key x
cat "$THEMESEED_CONFIG_DIR/.env" | head -20
unset THEMESEED_CONFIG_DIR
```

Expected: the first `--list` shows everything unset and `auto currently resolves to none`; after `--set`, Unsplash shows a masked key and auto resolves to `stock`; after `--remove` it is unset again; `--set nope` fails with `Unknown image provider "nope"` and lists the known ids; the `.env` head shows the commented template with `UNSPLASH_ACCESS_KEY` commented out again and appearing exactly once.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run verify
git add src/cli/commands/images.ts src/cli/commands/init.ts src/cli/index.ts
git commit -m "feat(cli): ask for image providers in init and add themeseed images"
```

---

## Task 9: Documentation and the 0.2.0 release

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `.env.example`

- [ ] **Step 1: Bump the version**

In `package.json`, set `"version": "0.2.0"`. The minor bump reflects two changed defaults rather than pure addition.

- [ ] **Step 2: Write the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add:

```markdown
### Added

- `themeseed images` configures stock, AI and local image providers at any time,
  with `--list`, `--set`, `--remove` and an interactive wizard.
- `themeseed init` now asks which image providers to set up, and writes
  `~/.themeseed/.env` and `~/.themeseed/sites.example.json`. Both list every
  setting, commented out, so they can be filled in by hand. `--skip-images`
  skips the prompt.
- `imageSource: "none"` publishes posts without images, and `"auto"` picks a
  source from whichever provider keys are configured.
- `studyTheme` on `generate_posts`, and `themeseed seed --study-theme`, read the
  active theme and shape content to it.

### Changed

- **Provider keys now load from `~/.themeseed/.env`** instead of the current
  working directory. The MCP server is launched by an editor in whatever
  directory it has open, so the old lookup found an unrelated `.env` or none at
  all, and stock lookups degraded silently to keyless Lorem Picsum.
- **`imageSource` defaults to `auto`, not `stock`.** With no key configured,
  posts publish without images rather than with unrelated placeholder
  photography. Passing `stock` or `ai` explicitly still fails loudly when the
  key is missing.
- **Theme analysis no longer runs on every seed.** It costs a round trip and
  now happens only when `studyTheme` is set, or when `analyze_theme` /
  `themeseed analyze` is called directly.
```

- [ ] **Step 3: Document the config directory in the README**

In `README.md`, after the installation section, add:

````markdown
## Configuration

Everything lives in `~/.themeseed/`:

| File | What it holds |
| --- | --- |
| `sites.json` | The sites you seed, with their credentials. Written by `themeseed add-site`. |
| `.env` | Image and AI provider keys. Written by `themeseed init` and `themeseed images`. |
| `sites.example.json` | A documented template for `sites.json`, with every field explained. |

`themeseed init` creates all three. Every setting appears in `.env` already,
commented out, so you can fill it in with an editor instead of a prompt.

Set `THEMESEED_CONFIG_DIR` to move the directory elsewhere.

### Image providers

Images are optional. With nothing configured, posts publish as text — a fair
preview of a theme in its own right.

```bash
themeseed images                 # interactive
themeseed images --list          # what is configured, and what "auto" picks
themeseed images --set unsplash --key <key>
themeseed images --set local --key /Users/you/Pictures/seed
themeseed images --remove unsplash
```

| Source | Providers | Key |
| --- | --- | --- |
| Stock | Unsplash, Pexels | `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY` |
| AI | OpenAI, xAI Grok, Google Gemini, fal.ai | `OPENAI_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY`, `FAL_KEY` |
| Local | A folder on this machine | `THEMESEED_LOCAL_IMAGE_DIR` |

`--image-source auto` (the default) uses AI when an AI key is set, stock when a
stock key is, and no images otherwise. `local`, `stock`, `ai` and `none` force
the choice; the first three fail loudly when their key is missing.

### Theme-aware content

By default themeseed generates content against neutral assumptions: a feature
image, tags, an author, and about 850 words. Reading the real theme costs an
extra round trip, so it is opt-in:

```bash
themeseed seed blog --topic "SaaS productivity" --study-theme
themeseed analyze blog          # read the theme without publishing anything
```

Over MCP, set `studyTheme: true` on `generate_posts`. For Ghost, point
`themesDir` at the install's themes directory to make the reading
source-accurate — the Ghost Admin API refuses to serve theme files to an API
token.
````

- [ ] **Step 4: Correct the repo's own `.env.example`**

`.env.example` documents provider keys that now belong in `~/.themeseed/.env`.
Delete its "Image sources" and "Content engine" sections, keep the
`GHOST_TEST_BLOG_*` and `GHOST_THEMES_DIR` block the e2e suite reads, and add
after the header:

```
# Provider keys for normal use do NOT live here. They live in
# ~/.themeseed/.env — run `themeseed images` to set them, or edit that file.
```

- [ ] **Step 5: Verify every claim the README makes**

```bash
npm run verify
npm run build
export THEMESEED_CONFIG_DIR=$(mktemp -d)
node dist/cli/index.js images --list
node dist/cli/index.js images --set unsplash --key test-key-123456
node dist/cli/index.js images --list
node dist/cli/index.js seed --help
node dist/cli/index.js --help
unset THEMESEED_CONFIG_DIR
```

Expected: `npm run verify` passes with every test green; `auto` resolves to
`none` before the key and `stock` after; `seed --help` lists `--study-theme`
and defaults `-i` to `auto`; the top-level help lists `images`.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json .env.example
git commit -m "docs: document the config directory, image providers and --study-theme"
```

---

## Done

Two follow-ups, both out of scope here and worth deciding separately:

1. **Publishing 0.2.0** to `npm.indianic.in` and tagging the GitHub release. The
   spec covers the code, not the release run.
2. **A `list_image_providers` MCP tool**, so a host model can tell a user "no
   image provider is configured, run `themeseed images`" instead of quietly
   publishing text-only posts. Deliberately left out: it adds a tool for a
   message the model can already infer from `generate_posts` returning zero
   feature images.
