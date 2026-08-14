/**
 * Makes the built CLI entry points executable.
 *
 * tsc does not preserve the executable bit, so a freshly built `dist/` has
 * bins that npm links but the shell refuses to run.
 */

import { chmod } from 'node:fs/promises';

const bins = ['dist/cli/index.js', 'dist/mcp/index.js'];

for (const bin of bins) {
  try {
    await chmod(bin, 0o755);
  } catch (err) {
    console.error(`could not chmod ${bin}: ${err.message}`);
    process.exitCode = 1;
  }
}
