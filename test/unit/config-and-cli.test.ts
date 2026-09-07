import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addSite,
  assertValidSlug,
  listSitesSafe,
  loadSites,
  removeSite,
  resolveSite,
  sitesPath,
} from '../../src/config/sites.js';
import { ConfigError, ProviderError, describeError } from '../../src/core/errors.js';
import { compareVersions } from '../../src/cli/commands/upgrade.js';
import {
  installIntoTarget,
  serverEntryFor,
  uninstallFromTarget,
} from '../../src/cli/editors.js';
import { parseAdminApiKey } from '../../src/providers/ghost/client.js';
import { createProvider } from '../../src/providers/registry.js';
import { maskSecret } from '../../src/core/logger.js';

let tempDir: string;
const originalConfigDir = process.env.THEMESEED_CONFIG_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-test-'));
  process.env.THEMESEED_CONFIG_DIR = tempDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.THEMESEED_CONFIG_DIR;
  else process.env.THEMESEED_CONFIG_DIR = originalConfigDir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

const ghostSite = {
  platform: 'ghost' as const,
  url: 'https://example.com',
  credentials: { adminApiKey: 'abc123:def456' },
};

/**
 * The text a user actually sees for a thrown error — message plus hint.
 * Asserting on `message` alone would miss the half of the guidance that
 * ThemeseedError deliberately puts in `hint`.
 */
function userTextOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return describeError(err);
  }
  throw new Error('expected the call to throw, but it did not');
}

async function userTextOfAsync(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return describeError(err);
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('sites config', () => {
  it('returns an empty config when no file exists', async () => {
    const data = await loadSites();
    expect(data.sites).toEqual({});
  });

  it('round-trips a site and makes the first one default', async () => {
    await addSite('one', ghostSite);
    const data = await loadSites();
    expect(data.sites['one']).toMatchObject(ghostSite);
    expect(data.defaultSite).toBe('one');
  });

  it('writes the file with owner-only permissions', async () => {
    await addSite('one', ghostSite);
    const stat = await fs.stat(sitesPath());
    // The file holds API keys; it must not be world- or group-readable.
    expect(stat.mode & 0o077).toBe(0);
  });

  it('never exposes credentials through listSitesSafe', async () => {
    await addSite('one', ghostSite);
    const listed = await listSitesSafe();
    expect(JSON.stringify(listed)).not.toContain('def456');
  });

  it('reassigns the default when the default site is removed', async () => {
    await addSite('one', ghostSite);
    await addSite('two', { ...ghostSite, url: 'https://two.example.com' });
    await removeSite('one');
    const data = await loadSites();
    expect(data.defaultSite).toBe('two');
  });

  it('resolves the only site when no slug is given', async () => {
    await addSite('solo', ghostSite);
    expect((await resolveSite()).slug).toBe('solo');
  });

  it('refuses to guess between several sites', async () => {
    await addSite('one', ghostSite);
    await addSite('two', ghostSite);
    const data = await loadSites();
    delete data.defaultSite;
    await fs.writeFile(sitesPath(), JSON.stringify(data));
    await expect(resolveSite()).rejects.toThrow(ConfigError);
  });

  it('reports a missing slug with the list of known ones', async () => {
    await addSite('one', ghostSite);
    // The list lives in the hint, which is what describeError shows the user.
    expect(await userTextOfAsync(resolveSite('nope'))).toMatch(/one/);
  });

  it('refuses to overwrite a config file it could not parse', async () => {
    await fs.writeFile(sitesPath(), '{ not json');
    await expect(loadSites()).rejects.toThrow(ConfigError);
  });

  it.each(['Bad Slug', 'UPPER', 'has_underscore', '-leading', ''])(
    'rejects the invalid slug %j',
    (slug) => {
      expect(() => assertValidSlug(slug)).toThrow(ConfigError);
    }
  );

  it.each(['a', 'my-blog', 'client2'])('accepts the valid slug %j', (slug) => {
    expect(() => assertValidSlug(slug)).not.toThrow();
  });
});

describe('provider registry', () => {
  it('constructs a Ghost provider', () => {
    expect(createProvider(ghostSite).platform).toBe('ghost');
  });

  it('explains that unimplemented platforms are open for contribution', () => {
    expect(
      userTextOf(() =>
        createProvider({ platform: 'wordpress', url: 'https://x.test', credentials: {} })
      )
    ).toMatch(/CONTRIBUTING/);
  });

  it('rejects a Ghost site with no admin key, naming the fix', () => {
    expect(() =>
      createProvider({ platform: 'ghost', url: 'https://x.test', credentials: {} })
    ).toThrow(ProviderError);
  });
});

describe('parseAdminApiKey', () => {
  it('splits a well-formed key', () => {
    expect(parseAdminApiKey('abc123:deadbeef')).toEqual({
      id: 'abc123',
      secret: 'deadbeef',
    });
  });

  it('tells the user when they pasted a Content API key', () => {
    // Content API keys have no colon; this is the single most common mistake.
    // The correction lives in the hint, so assert on the rendered message.
    expect(userTextOf(() => parseAdminApiKey('abcdef0123456789'))).toMatch(/Content API/);
  });

  it('rejects non-hex and odd-length secrets', () => {
    expect(() => parseAdminApiKey('abc:zzzz')).toThrow(/hexadecimal/);
    expect(() => parseAdminApiKey('abc:abc')).toThrow(/odd length/);
  });
});

describe('maskSecret', () => {
  it('never reveals the secret half', () => {
    const masked = maskSecret('65f1a2b3c4d5:9c4dsecretvalue');
    expect(masked).not.toContain('9c4dsecretvalue');
    expect(masked).toContain('redacted');
  });

  it('handles an unset secret', () => {
    expect(maskSecret(undefined)).toBe('<unset>');
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.1', -1],
    ['1.2.0', '1.10.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0-beta.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-beta.1', 1],
  ])('%s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe('editor registration', () => {
  it('adds themeseed without disturbing other servers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'keep-me' } }, unrelated: true })
    );

    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['mcpServers'],
    };
    const result = await installIntoTarget(target, serverEntryFor({}));
    expect(result.action).toBe('updated');

    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.other.command).toBe('keep-me');
    expect(written.unrelated).toBe(true);
    expect(written.mcpServers.themeseed).toBeDefined();
  });

  it('creates a config file that does not exist yet', async () => {
    const configPath = path.join(tempDir, 'nested', 'mcp.json');
    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['mcpServers'],
    };
    expect((await installIntoTarget(target, serverEntryFor({}))).action).toBe('created');
    expect(
      JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.themeseed
    ).toBeDefined();
  });

  it("honours a nested servers key such as VS Code's", async () => {
    const configPath = path.join(tempDir, 'vscode.json');
    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['servers'],
    };
    await installIntoTarget(target, serverEntryFor({}));
    expect(
      JSON.parse(await fs.readFile(configPath, 'utf8')).servers.themeseed
    ).toBeDefined();
  });

  it('refuses to clobber a config file that is not valid JSON', async () => {
    const configPath = path.join(tempDir, 'broken.json');
    await fs.writeFile(configPath, '{ this is not json');
    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['mcpServers'],
    };

    await expect(installIntoTarget(target, serverEntryFor({}))).rejects.toThrow(
      /not valid JSON/
    );
    // The user's file must be exactly as they left it.
    expect(await fs.readFile(configPath, 'utf8')).toBe('{ this is not json');
  });

  it('reports no change on a second identical install', async () => {
    const configPath = path.join(tempDir, 'idempotent.json');
    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['mcpServers'],
    };
    const entry = serverEntryFor({});
    await installIntoTarget(target, entry);
    expect((await installIntoTarget(target, entry)).action).toBe('unchanged');
  });

  it('removes only its own entry', async () => {
    const configPath = path.join(tempDir, 'remove.json');
    const target = {
      id: 't',
      label: 'T',
      configPath,
      detectPaths: [],
      serversKey: ['mcpServers'],
    };
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    );
    await installIntoTarget(target, serverEntryFor({}));

    expect(await uninstallFromTarget(target)).toBe(true);
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.mcpServers.themeseed).toBeUndefined();
    expect(written.mcpServers.other).toBeDefined();
  });

  it('prefers a global binary over npx when one exists', () => {
    const entry = serverEntryFor({ globalBinary: '/usr/local/bin/themeseed-mcp' });
    expect(entry.command).not.toBe('npx');
    expect(entry.args).toEqual(['/usr/local/bin/themeseed-mcp']);
  });

  // The bin is a symlink to a .js with a `#!/usr/bin/env node` shebang, so
  // executing it directly needs `node` on the PATH the *editor* spawns with.
  // Under nvm that PATH frequently has no node, and the failure is invisible:
  // the entry sits at "connecting" forever with nothing to reconnect to.
  it('launches the global binary through node, not its shebang', () => {
    expect(
      serverEntryFor({
        globalBinary: '/usr/local/bin/themeseed-mcp',
        nodePath: '/opt/node/bin/node',
      })
    ).toEqual({
      command: '/opt/node/bin/node',
      args: ['/usr/local/bin/themeseed-mcp'],
    });
  });

  it('defaults the interpreter to the running node', () => {
    expect(serverEntryFor({ globalBinary: '/usr/local/bin/themeseed-mcp' }).command).toBe(
      process.execPath
    );
  });

  it('falls back to npx with the registry pinned', () => {
    const entry = serverEntryFor({ registry: 'https://npm.example.com/' });
    expect(entry.command).toBe('npx');
    expect(entry.env?.['npm_config_registry']).toBe('https://npm.example.com/');
  });
});

describe('describeError', () => {
  it('appends the hint when there is one', () => {
    const error = new ConfigError('boom', { hint: 'try this' });
    expect(describeError(error)).toContain('try this');
  });

  it('handles values that are not errors', () => {
    expect(describeError('plain string')).toBe('plain string');
  });
});
