import { describe, expect, it } from 'vitest';

import { isValidImage, probeImage } from '../../src/images/inspect.js';
import { encodePng, hashString, seededRandom } from '../../src/images/png.js';
import { ProceduralImageAdapter } from '../../src/images/ai-source.js';
import { selectStockProvider } from '../../src/images/stock-source.js';
import { orientationFor } from '../../src/images/source.js';

describe('probeImage', () => {
  it('reads dimensions from a PNG we encoded', () => {
    const png = encodePng(37, 19, () => ({ r: 10, g: 20, b: 30 }));
    expect(probeImage(png)).toMatchObject({ format: 'png', width: 37, height: 19 });
  });

  it('rejects an HTML error page served with an image URL', () => {
    // The most common real failure: a stock CDN answering with HTML. Uploading
    // those bytes produces posts full of broken images.
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>404</body></html>');
    expect(probeImage(html)).toBeNull();
    expect(isValidImage(html)).toBe(false);
  });

  it('rejects truncated and empty input without throwing', () => {
    expect(probeImage(new Uint8Array(0))).toBeNull();
    expect(probeImage(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it('reads a minimal JPEG header', () => {
    // SOI, then an SOF0 frame declaring 64x48.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22,
      0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(probeImage(jpeg)).toMatchObject({ format: 'jpeg', width: 64, height: 48 });
  });

  it('reads a GIF header', () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00, 0x00, 0x00,
    ]);
    expect(probeImage(gif)).toMatchObject({ format: 'gif', width: 32, height: 16 });
  });
});

describe('encodePng', () => {
  it('produces bytes that round-trip through the probe', () => {
    const png = encodePng(8, 8, (x, y) => ({ r: x * 30, g: y * 30, b: 0 }));
    expect(isValidImage(png)).toBe(true);
  });

  it('compresses flat colour far better than noise', () => {
    // This is why the procedural adapter dithers instead of adding grain:
    // random noise inflated a 1200x800 gradient roughly tenfold.
    const flat = encodePng(200, 200, () => ({ r: 128, g: 128, b: 128 }));
    const random = seededRandom(1);
    const noisy = encodePng(200, 200, () => {
      const v = random() * 255;
      return { r: v, g: v, b: v };
    });
    expect(flat.byteLength * 10).toBeLessThan(noisy.byteLength);
  });
});

describe('seeded randomness', () => {
  it('hashString is stable across calls', () => {
    expect(hashString('urban cycling')).toBe(hashString('urban cycling'));
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('seededRandom reproduces the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('ProceduralImageAdapter', () => {
  it('generates valid images at the requested aspect ratio', async () => {
    const adapter = new ProceduralImageAdapter();
    const images = await adapter.generate(
      { query: 'test', aspectRatio: 2, minWidth: 400 },
      2
    );
    expect(images).toHaveLength(2);
    for (const image of images) {
      const info = probeImage(image.bytes);
      expect(info).not.toBeNull();
      expect(info!.width / info!.height).toBeCloseTo(2, 1);
    }
  });

  it('labels its output as a placeholder rather than as generated art', async () => {
    const [image] = await new ProceduralImageAdapter().generate({ query: 'x' }, 1);
    expect(image!.credit).toMatch(/not AI/i);
  });

  it('is deterministic for the same query', async () => {
    const adapter = new ProceduralImageAdapter();
    const [a] = await adapter.generate({ query: 'same', minWidth: 100 }, 1);
    const [b] = await adapter.generate({ query: 'same', minWidth: 100 }, 1);
    expect(Buffer.from(a!.bytes)).toEqual(Buffer.from(b!.bytes));
  });
});

describe('stock provider selection', () => {
  it('falls back to the keyless provider when no key is set', () => {
    expect(selectStockProvider({}).name).toBe('picsum');
  });

  it('prefers unsplash when its key is present', () => {
    expect(selectStockProvider({ unsplashAccessKey: 'k' }).name).toBe('unsplash');
  });

  it('honours an explicit choice even when it is unconfigured', () => {
    // Silently substituting a different provider would make a misconfiguration
    // invisible; the caller should see "not configured" instead.
    const provider = selectStockProvider({ provider: 'pexels' });
    expect(provider.name).toBe('pexels');
    expect(provider.isConfigured()).toBe(false);
  });
});

describe('orientationFor', () => {
  it.each([
    [{ query: 'x', aspectRatio: 1.78 }, 'landscape'],
    [{ query: 'x', aspectRatio: 0.66 }, 'portrait'],
    [{ query: 'x', aspectRatio: 1 }, 'square'],
    [{ query: 'x' }, 'landscape'],
  ] as const)('maps %o to %s', (request, expected) => {
    expect(orientationFor(request)).toBe(expected);
  });
});
