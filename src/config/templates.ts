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
          adminApiKey:
            '000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000',
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
