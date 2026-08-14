/**
 * Multi-site, multi-platform configuration at ~/.themeseed/sites.json.
 *
 * Only one site is acted on per invocation, but the file holds any number of
 * them across any number of platforms. It lives in the user's home directory,
 * never in a repo — it contains API keys, and repos get pushed.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from '../core/errors.js';
import { PLATFORMS, type Platform } from '../core/types.js';
import type { SiteConfig } from '../providers/provider.js';

export interface SitesFile {
  /** Schema version, so future migrations have something to branch on. */
  version: 1;
  sites: Record<string, SiteConfig>;
  /** Slug used when a command omits one. */
  defaultSite?: string;
}

const EMPTY: SitesFile = { version: 1, sites: {} };

export function configDir(): string {
  return process.env.THEMESEED_CONFIG_DIR || path.join(os.homedir(), '.themeseed');
}

export function sitesPath(): string {
  return path.join(configDir(), 'sites.json');
}

export async function loadSites(): Promise<SitesFile> {
  const file = sitesPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, sites: {} };
    throw new ConfigError(`Could not read ${file}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON`, {
      hint: 'Fix or delete the file, then run `themeseed add-site` again.',
      cause: err,
    });
  }

  const data = parsed as Partial<SitesFile>;
  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.sites !== 'object' ||
    !data.sites
  ) {
    throw new ConfigError(`${file} does not look like a themeseed config`, {
      hint: 'Expected an object with a "sites" key.',
    });
  }
  return {
    version: 1,
    sites: data.sites,
    ...(data.defaultSite ? { defaultSite: data.defaultSite } : {}),
  };
}

export async function saveSites(data: SitesFile): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = sitesPath();
  const tmp = `${file}.tmp`;
  // Write-then-rename so an interrupted save cannot truncate a working config.
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  // rename preserves the temp file's mode, but be explicit in case it existed.
  await fs.chmod(file, 0o600);
}

export async function getSite(slug: string): Promise<SiteConfig> {
  const data = await loadSites();
  const site = data.sites[slug];
  if (!site) {
    const known = Object.keys(data.sites);
    throw new ConfigError(`No site configured with slug "${slug}"`, {
      hint: known.length
        ? `Known sites: ${known.join(', ')}`
        : 'Add one with `themeseed add-site`.',
    });
  }
  return site;
}

/** Resolves an explicit slug, else the default, else the only configured site. */
export async function resolveSite(
  slug?: string
): Promise<{ slug: string; site: SiteConfig }> {
  const data = await loadSites();
  const slugs = Object.keys(data.sites);

  if (slug) {
    const site = data.sites[slug];
    if (!site) {
      throw new ConfigError(`No site configured with slug "${slug}"`, {
        hint: slugs.length
          ? `Known sites: ${slugs.join(', ')}`
          : 'Add one with `themeseed add-site`.',
      });
    }
    return { slug, site };
  }

  if (data.defaultSite) {
    const site = data.sites[data.defaultSite];
    if (site) return { slug: data.defaultSite, site };
  }
  if (slugs.length === 1) {
    const only = slugs[0]!;
    return { slug: only, site: data.sites[only]! };
  }
  throw new ConfigError(
    slugs.length === 0
      ? 'No sites configured yet.'
      : 'Multiple sites configured; specify one.',
    {
      hint:
        slugs.length === 0
          ? 'Run `themeseed init` or `themeseed add-site`.'
          : `Pass a slug: ${slugs.join(', ')}`,
    }
  );
}

export async function addSite(slug: string, site: SiteConfig): Promise<void> {
  assertValidSlug(slug);
  assertValidPlatform(site.platform);
  const data = await loadSites();
  data.sites[slug] = site;
  if (!data.defaultSite) data.defaultSite = slug;
  await saveSites(data);
}

export async function removeSite(slug: string): Promise<boolean> {
  const data = await loadSites();
  if (!(slug in data.sites)) return false;
  delete data.sites[slug];
  if (data.defaultSite === slug) {
    const remaining = Object.keys(data.sites);
    if (remaining[0]) data.defaultSite = remaining[0];
    else delete data.defaultSite;
  }
  await saveSites(data);
  return true;
}

/** Site list with credentials stripped — safe to print or return over MCP. */
export async function listSitesSafe(): Promise<
  Array<{ slug: string; platform: Platform; url: string; isDefault: boolean }>
> {
  const data = await loadSites();
  return Object.entries(data.sites).map(([slug, site]) => ({
    slug,
    platform: site.platform,
    url: site.url,
    isDefault: data.defaultSite === slug,
  }));
}

export function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
    throw new ConfigError(`Invalid site slug "${slug}"`, {
      hint: 'Use lowercase letters, digits and hyphens, e.g. "my-blog".',
    });
  }
}

export function assertValidPlatform(platform: string): asserts platform is Platform {
  if (!PLATFORMS.includes(platform as Platform)) {
    throw new ConfigError(`Unknown platform "${platform}"`, {
      hint: `Supported: ${PLATFORMS.join(', ')}`,
    });
  }
}
