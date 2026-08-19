import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sitesExamplePath, writeSitesExample } from '../../src/config/templates.js';

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
