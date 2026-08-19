import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROVIDERS,
  configuredProviders,
  findProvider,
  hasAiKey,
  hasStockKey,
  providersByCategory,
} from '../../src/images/providers.js';

describe('IMAGE_PROVIDERS', () => {
  it('gives every provider a unique id', () => {
    const ids = IMAGE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names an env var for everything except the keyless procedural adapter', () => {
    for (const provider of IMAGE_PROVIDERS) {
      if (provider.id === 'procedural') expect(provider.envKey).toBeNull();
      else expect(provider.envKey).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('finds a provider by id and returns undefined for an unknown one', () => {
    expect(findProvider('unsplash')?.label).toBe('Unsplash');
    expect(findProvider('nope')).toBeUndefined();
  });

  it('groups by category', () => {
    expect(providersByCategory('stock').map((p) => p.id)).toEqual(['unsplash', 'pexels']);
    expect(providersByCategory('local').map((p) => p.id)).toEqual(['local']);
    expect(providersByCategory('ai')).toContainEqual(
      expect.objectContaining({ id: 'grok' })
    );
  });
});

describe('key detection', () => {
  it('reports nothing configured for an empty environment', () => {
    expect(hasStockKey({})).toBe(false);
    expect(hasAiKey({})).toBe(false);
    expect(configuredProviders({})).toEqual([]);
  });

  it('detects a stock key without claiming an AI key', () => {
    const env = { UNSPLASH_ACCESS_KEY: 'abc' };
    expect(hasStockKey(env)).toBe(true);
    expect(hasAiKey(env)).toBe(false);
    expect(configuredProviders(env).map((p) => p.id)).toEqual(['unsplash']);
  });

  it('detects an AI key', () => {
    expect(hasAiKey({ XAI_API_KEY: 'abc' })).toBe(true);
  });

  it('ignores a variable set to an empty or whitespace-only string', () => {
    // A commented-out line that someone uncommented but never filled in reads
    // as "" here. Treating that as configured sends every request unauthorised.
    expect(hasStockKey({ UNSPLASH_ACCESS_KEY: '' })).toBe(false);
    expect(hasStockKey({ UNSPLASH_ACCESS_KEY: '   ' })).toBe(false);
  });

  it('does not treat the keyless procedural adapter as a configured provider', () => {
    expect(configuredProviders({}).map((p) => p.id)).not.toContain('procedural');
  });

  it('does not treat a local image directory as an AI or stock key', () => {
    const env = { THEMESEED_LOCAL_IMAGE_DIR: '/tmp/pics' };
    expect(hasStockKey(env)).toBe(false);
    expect(hasAiKey(env)).toBe(false);
    expect(configuredProviders(env).map((p) => p.id)).toEqual(['local']);
  });
});
