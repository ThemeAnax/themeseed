/**
 * Site management commands: add-site, remove-site, list-sites.
 *
 * Credentials are prompted for with a masked input rather than accepted as an
 * argument by default — a key typed as `--key sk_...` ends up in shell history
 * and in `ps` output. The flag exists for scripting, and says so.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  addSite,
  assertValidPlatform,
  assertValidSlug,
  listSitesSafe,
  loadSites,
  removeSite,
  saveSites,
} from '../../config/sites.js';
import { describeError } from '../../core/errors.js';
import { IMPLEMENTED_PLATFORMS, type Platform } from '../../core/types.js';
import { createProvider, implementedPlatforms } from '../../providers/registry.js';
import type { SiteConfig } from '../../providers/provider.js';
import {
  cancelled,
  fail,
  note,
  success,
  spinner as makeSpinner,
  assertInteractive,
} from '../ui.js';

export interface AddSiteFlags {
  slug?: string;
  platform?: string;
  url?: string;
  key?: string;
  themesDir?: string;
  yes?: boolean;
}

export async function addSiteCommand(flags: AddSiteFlags = {}): Promise<void> {
  const interactive = !flags.slug || !flags.url || !flags.key;
  if (interactive) {
    assertInteractive(
      'Site details',
      'Pass --slug, --url and --key (and --platform) to add a site without prompts.'
    );
    p.intro(pc.bgCyan(pc.black(' themeseed — add a site ')));
  }

  const slug = flags.slug ?? (await promptSlug());
  assertValidSlug(slug);

  const platform = (flags.platform ?? (await promptPlatform())) as Platform;
  assertValidPlatform(platform);

  const url = normaliseUrl(flags.url ?? (await promptUrl()));
  const credentials = await collectCredentials(platform, flags.key);

  // Only ever ask about this when the invocation was already interactive. A
  // fully-flagged `add-site` is how scripts and CI call this, and prompting
  // there exits silently on a non-TTY instead of saving the site.
  const themesDir =
    flags.themesDir ??
    (interactive && platform === 'ghost' && process.stdout.isTTY
      ? await promptThemesDir(url)
      : undefined);

  const site: SiteConfig = {
    platform,
    url,
    credentials,
    ...(themesDir ? { options: { themesDir } } : {}),
  };

  const spinner = makeSpinner();
  spinner.start('Verifying credentials');
  try {
    const provider = createProvider(site);
    const info = await provider.verifyConnection();
    spinner.stop(
      `Connected to ${pc.bold(info.title)}${info.version ? ` (${platform} ${info.version})` : ''}`
    );
  } catch (err) {
    spinner.stop(pc.red('Could not connect'));
    fail(describeError(err));
    if (interactive) p.outro(pc.red('Site not saved.'));
    process.exitCode = 1;
    return;
  }

  await addSite(slug, site);
  success(`Saved site "${slug}".`);
  note(`Try: ${pc.cyan(`themeseed analyze ${slug}`)}`);
  if (interactive) p.outro('Done.');
}

async function promptSlug(): Promise<string> {
  const value = await p.text({
    message: 'Short name for this site',
    placeholder: 'client-blog',
    validate: (input) => {
      if (!input) return 'Required.';
      try {
        assertValidSlug(input);
        return undefined;
      } catch (err) {
        return describeError(err);
      }
    },
  });
  if (p.isCancel(value)) cancelled();
  return value as string;
}

async function promptPlatform(): Promise<string> {
  const available = implementedPlatforms();
  const value = await p.select({
    message: 'Which CMS?',
    options: available.map((platform) => ({
      value: platform,
      label: platform,
      hint: 'supported',
    })),
  });
  if (p.isCancel(value)) cancelled();
  return value as string;
}

async function promptUrl(): Promise<string> {
  const value = await p.text({
    message: 'Site URL',
    placeholder: 'https://blog.example.com',
    validate: (input) => {
      if (!input) return 'Required.';
      try {
        new URL(normaliseUrl(input));
        return undefined;
      } catch {
        return 'Must be a valid URL.';
      }
    },
  });
  if (p.isCancel(value)) cancelled();
  return value as string;
}

async function collectCredentials(
  platform: Platform,
  keyFlag: string | undefined
): Promise<Record<string, string>> {
  if (platform !== 'ghost') {
    // Other platforms are not implemented yet; the registry rejects them
    // before this point, so this is a guard rather than a real path.
    return keyFlag ? { apiKey: keyFlag } : {};
  }

  if (keyFlag) return { adminApiKey: keyFlag };

  p.note(
    'Ghost Admin → Settings → Integrations → Add custom integration.\n' +
      'Copy the ' +
      pc.bold('Admin API key') +
      ' (not the Content API key).\n' +
      'It looks like: 65f1a2…:9c4d…',
    'Where to find this'
  );

  const value = await p.password({
    message: 'Ghost Admin API key',
    validate: (input) => {
      if (!input) return 'Required.';
      if (!input.includes(':'))
        return 'Expected "<id>:<secret>" — this looks like a Content API key.';
      return undefined;
    },
  });
  if (p.isCancel(value)) cancelled();
  return { adminApiKey: value as string };
}

/**
 * Ghost's Admin API refuses to serve theme files, so reading them off disk is
 * the only way to analyze a theme accurately. Only worth asking about when the
 * site is plausibly on this machine.
 */
async function promptThemesDir(url: string): Promise<string | undefined> {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|.*\.local)([:/]|$)/i.test(
    url
  );
  if (!isLocal) return undefined;

  const wants = await p.confirm({
    message:
      'This looks like a local Ghost install. Point themeseed at its themes folder for a more accurate theme analysis?',
    initialValue: true,
  });
  if (p.isCancel(wants)) cancelled();
  if (!wants) return undefined;

  const value = await p.text({
    message: 'Path to content/themes',
    placeholder: '/path/to/ghost/content/themes',
  });
  if (p.isCancel(value)) cancelled();
  return (value as string) || undefined;
}

// ---------------------------------------------------------------------------

export async function removeSiteCommand(
  slug: string | undefined,
  flags: { yes?: boolean } = {}
): Promise<void> {
  const sites = await listSitesSafe();
  if (sites.length === 0) {
    note('No sites configured.');
    return;
  }

  let target = slug;
  if (!target) {
    assertInteractive('A site slug', 'Pass the slug: themeseed remove-site <slug>.');
    const value = await p.select({
      message: 'Remove which site?',
      options: sites.map((site) => ({
        value: site.slug,
        label: site.slug,
        hint: site.url,
      })),
    });
    if (p.isCancel(value)) cancelled();
    target = value as string;
  }

  if (!flags.yes) {
    assertInteractive('Confirmation', 'Pass --yes to remove without confirming.');
    const confirmed = await p.confirm({
      message: `Forget "${target}"? This only removes local configuration — no content is deleted.`,
      initialValue: false,
    });
    if (p.isCancel(confirmed)) cancelled();
    if (!confirmed) {
      note('Cancelled.');
      return;
    }
  }

  const removed = await removeSite(target);
  if (removed) success(`Removed "${target}".`);
  else fail(`No site configured with slug "${target}".`);
}

export async function listSitesCommand(): Promise<void> {
  const sites = await listSitesSafe();
  if (sites.length === 0) {
    note('No sites configured yet. Run `themeseed init` or `themeseed add-site`.');
    return;
  }

  const width = Math.max(...sites.map((site) => site.slug.length));
  console.log('');
  for (const site of sites) {
    const marker = site.isDefault ? pc.green('*') : ' ';
    console.log(
      `${marker} ${pc.bold(site.slug.padEnd(width))}  ${pc.dim(site.platform.padEnd(9))}  ${site.url}`
    );
  }
  console.log(pc.dim('\n* = default site, used when no slug is given.'));

  // Only worth mentioning when a configured site's platform has no provider —
  // otherwise it is noise on every invocation.
  const unsupported = sites.filter(
    (site) => !IMPLEMENTED_PLATFORMS.includes(site.platform)
  );
  if (unsupported.length > 0) {
    console.log(
      pc.yellow(
        `! ${unsupported.map((s) => s.slug).join(', ')} use platforms with no provider yet ` +
          `(implemented: ${IMPLEMENTED_PLATFORMS.join(', ')}).`
      )
    );
  }
  console.log('');
}

export async function setDefaultSiteCommand(slug: string): Promise<void> {
  const data = await loadSites();
  if (!(slug in data.sites)) {
    fail(`No site configured with slug "${slug}".`);
    process.exitCode = 1;
    return;
  }
  data.defaultSite = slug;
  await saveSites(data);
  success(`Default site is now "${slug}".`);
}

function normaliseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
