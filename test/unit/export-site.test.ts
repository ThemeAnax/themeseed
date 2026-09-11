import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exportSite } from '../../src/core/export.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'themeseed-site-'));
  dirs.push(dir);
  return dir;
}

const base = (outDir: string) => ({
  platform: 'ghost' as const,
  topic: 'independent design journal',
  count: 2,
  outDir,
  imageSource: 'none' as const,
  includeVideo: false,
  seed: 3,
});

function content(zipPath: string) {
  return JSON.parse(execFileSync('unzip', ['-p', zipPath, 'content.json'], { encoding: 'utf8' }))
    .db[0].data as Record<string, Array<Record<string, unknown>>>;
}

describe('exportSite', () => {
  it('produces an importable archive without any site or credentials', async () => {
    // The whole reason this exists next to seedSite: no Admin API key, no URL.
    const outDir = await scratch();
    const report = await exportSite(base(outDir));
    await expect(fs.stat(report.zipPath)).resolves.toBeDefined();
  });

  it('generates the posts it was asked for and puts them in the archive', async () => {
    const outDir = await scratch();
    const report = await exportSite(base(outDir));
    expect(content(report.zipPath).posts!.filter((p) => p['type'] === 'post')).toHaveLength(2);
  });

  it('writes the requested pages, giving a body only where one is wanted', async () => {
    const outDir = await scratch();
    const report = await exportSite({
      ...base(outDir),
      pages: [{ slug: 'about' }, { slug: 'authors', needsBody: false }],
    });
    const pages = content(report.zipPath).posts!.filter((p) => p['type'] === 'page');
    expect(pages.map((p) => p['slug']).sort()).toEqual(['about', 'authors']);
  });

  it('carries the navigation it was handed into the settings table', async () => {
    const outDir = await scratch();
    const report = await exportSite({
      ...base(outDir),
      site: { navigation: [{ label: 'Home', url: '/' }] },
    });
    const row = content(report.zipPath).settings!.find((s) => s['key'] === 'navigation');
    expect(JSON.parse(row!['value'] as string)).toEqual([{ label: 'Home', url: '/' }]);
  });

  it('reports what it wrote, including images that could not be fetched', async () => {
    const outDir = await scratch();
    const report = await exportSite(base(outDir));
    expect(report.stats).toMatchObject({ posts: 2, failedImages: 0 });
  });

  it('uses conservative capabilities when no theme reading was supplied', async () => {
    // No live site means no analyzeTheme; the run must still work.
    const outDir = await scratch();
    const report = await exportSite(base(outDir));
    expect(report.capabilities.analyzedVia).toContain('defaults');
  });
});
