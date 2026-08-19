import { describe, expect, it } from 'vitest';

import { seedSite } from '../../src/core/seed.js';
import { genericCapabilities } from '../../src/core/theme-defaults.js';
import type { SeedContent, SeedResult, ThemeCapabilities } from '../../src/core/types.js';
import type { CmsProvider, SiteConfig } from '../../src/providers/provider.js';
import { registerProvider } from '../../src/providers/registry.js';

describe('genericCapabilities', () => {
  it('reports zero confidence, because nothing was measured', () => {
    const capabilities = genericCapabilities('ghost');
    expect(capabilities.confidence).toBe(0);
    expect(capabilities.analyzedVia).toEqual(['defaults']);
    expect(capabilities.evidence.join(' ')).toMatch(/no theme analysis/i);
  });

  it('assumes the safe half of every choice', () => {
    const capabilities = genericCapabilities('ghost');
    // Present in nearly every theme.
    expect(capabilities.supportsFeatureImage).toBe(true);
    expect(capabilities.displaysTags).toBe(true);
    expect(capabilities.displaysAuthor).toBe(true);
    // A card the theme cannot style looks worse than its absence.
    expect(capabilities.supportsGallery).toBe(false);
    expect(capabilities.supportsVideoEmbed).toBe(false);
    expect(capabilities.supportsBookmarkCard).toBe(false);
    expect(capabilities.supportsWideImages).toBe(false);
  });

  it('carries the platform it was asked about', () => {
    expect(genericCapabilities('wordpress').platform).toBe('wordpress');
  });
});

// A counting stand-in. registerProvider is exported, so this needs no module
// mocking — it registers under a platform that has no real implementation.
let analyzeCalls = 0;

const measured: ThemeCapabilities = {
  ...genericCapabilities('wordpress'),
  themeName: 'measured-theme',
  confidence: 0.9,
  analyzedVia: ['test'],
};

function fakeProvider(): CmsProvider {
  return {
    platform: 'wordpress',
    async verifyConnection() {
      return { title: 'Fake', url: 'https://fake.test' };
    },
    async analyzeTheme() {
      analyzeCalls += 1;
      return measured;
    },
    async createContent(items: SeedContent[]): Promise<SeedResult[]> {
      return items.map((item, index) => ({
        id: `fake-${index}`,
        title: item.title,
        status: item.status,
        hasFeatureImage: Boolean(item.featureImage),
      }));
    },
    async listSeeded() {
      return [];
    },
    async wipeSeeded() {
      return { removed: 0 };
    },
  };
}

registerProvider('wordpress', fakeProvider);

const site: SiteConfig = {
  platform: 'wordpress',
  url: 'https://fake.test',
  credentials: {},
};

const request = {
  site,
  topic: 'test topic',
  count: 1,
  imageSource: 'none' as const,
  includeVideo: false,
};

describe('seedSite theme study', () => {
  it('does not read the theme when nobody asked', async () => {
    analyzeCalls = 0;
    const report = await seedSite(request);
    expect(analyzeCalls).toBe(0);
    expect(report.capabilities.analyzedVia).toEqual(['defaults']);
    expect(report.created).toBe(1);
  });

  it('reads the theme when studyTheme is true', async () => {
    analyzeCalls = 0;
    const report = await seedSite({ ...request, studyTheme: true });
    expect(analyzeCalls).toBe(1);
    expect(report.capabilities.themeName).toBe('measured-theme');
  });

  it('still prefers capabilities the caller supplied', async () => {
    analyzeCalls = 0;
    const supplied = { ...measured, themeName: 'supplied' };
    const report = await seedSite({
      ...request,
      studyTheme: true,
      capabilities: supplied,
    });
    expect(analyzeCalls).toBe(0);
    expect(report.capabilities.themeName).toBe('supplied');
  });

  it('publishes without images when the source is none', async () => {
    const report = await seedSite(request);
    expect(report.generation.withFeatureImage).toBe(0);
    expect(report.failed).toBe(0);
  });
});
