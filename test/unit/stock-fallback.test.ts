import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ImageRef, ImageRequest } from '../../src/core/types.js';
import {
  selectStockProviders,
  StockImageSource,
  type StockProvider,
  type StockProviderName,
} from '../../src/images/stock-source.js';

const saved = {
  unsplash: process.env.UNSPLASH_ACCESS_KEY,
  pexels: process.env.PEXELS_API_KEY,
  provider: process.env.THEMESEED_STOCK_PROVIDER,
};

beforeEach(() => {
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.THEMESEED_STOCK_PROVIDER;
});

afterEach(() => {
  for (const [key, value] of [
    ['UNSPLASH_ACCESS_KEY', saved.unsplash],
    ['PEXELS_API_KEY', saved.pexels],
    ['THEMESEED_STOCK_PROVIDER', saved.provider],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const names = (options = {}): StockProviderName[] =>
  selectStockProviders(options).map((provider) => provider.name);

describe('selectStockProviders', () => {
  it('chains every configured key so one quota does not end the run', () => {
    process.env.UNSPLASH_ACCESS_KEY = 'u';
    process.env.PEXELS_API_KEY = 'p';
    expect(names()).toEqual(['unsplash', 'pexels']);
  });

  it('puts an explicitly named provider first but keeps the others as spares', () => {
    process.env.UNSPLASH_ACCESS_KEY = 'u';
    process.env.PEXELS_API_KEY = 'p';
    expect(names({ provider: 'pexels' })).toEqual(['pexels', 'unsplash']);
  });

  it('uses only the keys that exist', () => {
    process.env.PEXELS_API_KEY = 'p';
    expect(names()).toEqual(['pexels']);
  });

  it('falls back to picsum only when nothing is configured', () => {
    expect(names()).toEqual(['picsum']);
  });

  // Picsum cannot search, so chaining it behind a keyed provider would answer a
  // query about yoga with a photograph of nothing and call the run a success.
  it('never puts picsum behind a keyed provider', () => {
    process.env.UNSPLASH_ACCESS_KEY = 'u';
    expect(names()).not.toContain('picsum');
    expect(names({ provider: 'picsum' })).toEqual(['picsum']);
  });
});

/** A provider that behaves however a test needs it to. */
function stub(
  name: StockProviderName,
  behaviour: 'ok' | 'throws' | 'empty',
  calls: string[]
): StockProvider {
  return {
    name,
    isConfigured: () => true,
    configurationHint: () => `set a key for ${name}`,
    async search(request: ImageRequest, count: number): Promise<ImageRef[]> {
      calls.push(name);
      if (behaviour === 'throws') throw new Error(`${name} rate limit reached`);
      if (behaviour === 'empty') return [];
      return Array.from({ length: count }, (_, i) => ({
        kind: 'url' as const,
        location: `https://${name}.test/${encodeURIComponent(request.query)}-${i}.jpg`,
        width: 1600,
        height: 1067,
      }));
    },
  };
}

/** Builds a source over an explicit chain, bypassing env-based selection. */
function sourceOver(providers: StockProvider[]): StockImageSource {
  const source = new StockImageSource();
  Object.defineProperty(source, 'providers', { value: providers, writable: true });
  return source;
}

const REQUEST: ImageRequest = { query: 'yoga', minWidth: 1200, role: 'body' };

describe('StockImageSource fallback', () => {
  it('moves to the next provider when the first hits its quota', async () => {
    const calls: string[] = [];
    const source = sourceOver([
      stub('unsplash', 'throws', calls),
      stub('pexels', 'ok', calls),
    ]);

    const images = await source.fetch(REQUEST, 1);

    expect(calls).toEqual(['unsplash', 'pexels']);
    expect(images[0]?.location).toContain('pexels.test');
  });

  it('moves on when a provider succeeds but returns nothing', async () => {
    const calls: string[] = [];
    const source = sourceOver([
      stub('unsplash', 'empty', calls),
      stub('pexels', 'ok', calls),
    ]);

    expect(await source.fetch(REQUEST, 1)).toHaveLength(1);
    expect(calls).toEqual(['unsplash', 'pexels']);
  });

  it('does not call the spare when the first provider works', async () => {
    const calls: string[] = [];
    const source = sourceOver([
      stub('unsplash', 'ok', calls),
      stub('pexels', 'ok', calls),
    ]);

    await source.fetch(REQUEST, 1);

    expect(calls).toEqual(['unsplash']);
  });

  // An exhausted chain must be an error, not an empty array quietly reported as
  // success — that is the failure mode this whole feature exists to remove.
  it('throws once every provider has failed', async () => {
    const calls: string[] = [];
    const source = sourceOver([
      stub('unsplash', 'throws', calls),
      stub('pexels', 'throws', calls),
    ]);

    await expect(source.fetch(REQUEST, 1)).rejects.toThrow(/rate limit reached/);
    expect(calls).toEqual(['unsplash', 'pexels']);
  });
});
