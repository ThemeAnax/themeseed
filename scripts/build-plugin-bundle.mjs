/**
 * Bundles the MCP server into one self-contained file for the Claude Code plugin.
 *
 * The plugin is installed straight from this public GitHub repository —
 * `/plugin marketplace add ThemeAnax/themeseed` clones it and runs what it
 * finds. There is no install step in between: Claude Code does not run
 * `npm install` for a plugin, and the npm package itself lives on a private
 * registry that most people installing the plugin cannot read.
 *
 * So the server has to arrive ready to run, with every dependency inlined and
 * nothing to fetch. That is the one and only reason a build artifact is
 * committed here: `plugin/themeseed-mcp.mjs` is regenerated on every release
 * by `npm run build:plugin`, which `npm run release:check` verifies is current.
 *
 * Node built-ins stay external — they are present wherever Node is.
 */

import { build } from 'esbuild';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../plugin/themeseed-mcp.mjs', import.meta.url);
const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);

/**
 * `dotenv` is CommonJS and calls `require('fs')`. In ESM output esbuild
 * replaces that with a shim that throws — but the shim defers to a real
 * `require` if one is in scope, so defining one from `createRequire` is all it
 * takes. Without this the server dies on its first line at startup.
 */
const PRELUDE = [
  "import { createRequire as __themeseedCreateRequire } from 'node:module';",
  'const require = __themeseedCreateRequire(import.meta.url);',
].join('\n');

const result = await build({
  entryPoints: ['src/mcp/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Keep it readable enough that someone can audit what they are about to run
  // against their own CMS credentials. The size saved by minifying is not worth
  // making a committed artifact opaque.
  minify: false,
  metafile: true,
  logLevel: 'warning',
  // Written by hand below, because the prelude has to sit above the bundle but
  // below the shebang, and a shebang is only a shebang on line 1.
  write: false,
  outfile: 'plugin/themeseed-mcp.mjs',
});

const output = result.outputFiles?.[0];
if (!output) throw new Error('esbuild produced no output');

// The entry point carries its own shebang, which esbuild preserves wherever it
// lands. Strip every copy and put exactly one back, first.
const body = output.text.replace(/^#!.*\n/gm, '');
const file = `#!/usr/bin/env node\n${PRELUDE}\n${body}`;

await mkdir(new URL('../plugin/', import.meta.url), { recursive: true });
await writeFile(OUT, file);
await chmod(OUT, 0o755);

console.log(
  `plugin/themeseed-mcp.mjs — themeseed ${pkg.version}, ${(Buffer.byteLength(file) / 1024).toFixed(0)} kB`
);
