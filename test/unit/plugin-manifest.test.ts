import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (relative: string): Record<string, never> =>
  JSON.parse(readFileSync(path.join(root, relative), 'utf8')) as Record<string, never>;

const pkg = read('package.json') as unknown as { name: string; version: string };
const plugin = read('.claude-plugin/plugin.json') as unknown as {
  name: string;
  version: string;
};
const marketplace = read('.claude-plugin/marketplace.json') as unknown as {
  name: string;
  metadata: { version: string };
  plugins: Array<{ name: string; source: string; version: string }>;
};
const mcp = read('.mcp.json') as unknown as {
  mcpServers: Record<string, { command: string; args: string[] }>;
};

/**
 * The plugin is installed straight from the repository, so these files are the
 * shipped artefact — nothing rebuilds or rewrites them on the way out. A
 * version left behind here is a version every plugin user sees.
 */
describe('Claude Code plugin manifests', () => {
  it('declares the same version as the package', () => {
    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.metadata.version).toBe(pkg.version);
    expect(marketplace.plugins[0]?.version).toBe(pkg.version);
  });

  it('names the plugin consistently across both manifests', () => {
    expect(plugin.name).toBe('themeseed');
    expect(marketplace.plugins[0]?.name).toBe('themeseed');
  });

  it('sources the plugin from the repository root', () => {
    expect(marketplace.plugins[0]?.source).toBe('.');
  });

  // Hardcoding a path would work on the machine that wrote it and nowhere else:
  // plugins land in different directories per install method and OS.
  it('locates the server through CLAUDE_PLUGIN_ROOT', () => {
    const server = mcp.mcpServers['themeseed'];
    expect(server?.command).toBe('node');
    expect(server?.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/plugin/themeseed-mcp.mjs');
  });

  it('ships the bundled server the manifest points at', () => {
    const bundle = readFileSync(path.join(root, 'plugin/themeseed-mcp.mjs'), 'utf8');
    // One shebang, on line 1, or Node refuses the file outright.
    expect(bundle.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(bundle.split('\n').filter((line) => line.startsWith('#!'))).toHaveLength(1);
    // The CommonJS dependencies need a real `require` in scope.
    expect(bundle).toContain('createRequire');
  });
});
