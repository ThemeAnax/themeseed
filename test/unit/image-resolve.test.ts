import { describe, expect, it } from 'vitest';

import {
  createImageSource,
  createRequestedImageSource,
  resolveImageSourceKind,
} from '../../src/images/index.js';
import { NoneImageSource } from '../../src/images/none-source.js';

describe('resolveImageSourceKind', () => {
  it('prefers AI when an AI key is set, because it matches the topic best', () => {
    expect(resolveImageSourceKind('auto', { XAI_API_KEY: 'k' })).toBe('ai');
  });

  it('prefers AI over stock when both are set', () => {
    expect(
      resolveImageSourceKind('auto', { XAI_API_KEY: 'k', UNSPLASH_ACCESS_KEY: 'k' })
    ).toBe('ai');
  });

  it('falls back to stock when only a stock key is set', () => {
    expect(resolveImageSourceKind('auto', { PEXELS_API_KEY: 'k' })).toBe('stock');
  });

  it('resolves to none when nothing is configured', () => {
    expect(resolveImageSourceKind('auto', {})).toBe('none');
  });

  it('passes an explicit kind through untouched, whatever is configured', () => {
    expect(resolveImageSourceKind('stock', {})).toBe('stock');
    expect(resolveImageSourceKind('ai', {})).toBe('ai');
    expect(resolveImageSourceKind('local', { XAI_API_KEY: 'k' })).toBe('local');
    expect(resolveImageSourceKind('none', { XAI_API_KEY: 'k' })).toBe('none');
  });
});

describe('NoneImageSource', () => {
  it('is always usable', async () => {
    const source = new NoneImageSource();
    expect(source.kind).toBe('none');
    expect(await source.isAvailable()).toBe(true);
    expect(await source.unavailableReason()).toBe('');
  });

  it('returns no images rather than failing', async () => {
    const source = new NoneImageSource();
    expect(await source.fetch({ query: 'anything' }, 5)).toEqual([]);
  });

  it('is what the factory builds for "none"', () => {
    expect(createImageSource('none').kind).toBe('none');
  });
});

describe('createRequestedImageSource', () => {
  it('never fails for auto — it degrades to no images', async () => {
    const source = await createRequestedImageSource('auto', {}, {});
    expect(source.kind).toBe('none');
  });

  it('fails loudly for an explicit source that cannot run', async () => {
    // An explicit choice was the caller's decision; degrading it silently
    // would hide a typo in a key behind pictureless posts.
    await expect(
      createRequestedImageSource('local', { local: { directory: '/no/such/dir' } }, {})
    ).rejects.toThrow(/not usable/i);
  });
});
