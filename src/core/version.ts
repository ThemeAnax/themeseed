/**
 * Reads the package version at runtime.
 *
 * Read from package.json rather than baked in by the build, so `npm version`
 * is the single source of truth and a stale constant can never disagree with
 * what the registry actually published.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export async function readVersion(): Promise<string> {
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from both `dist/core/` and `src/core/` (tsx during development).
  const candidates = [
    path.resolve(here, '..', '..', 'package.json'),
    path.resolve(here, '..', '..', '..', 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === '@indianic/themeseed' && parsed.version) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      continue;
    }
  }

  cached = '0.0.0-unknown';
  return cached;
}
