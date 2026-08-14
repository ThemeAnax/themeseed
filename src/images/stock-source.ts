/**
 * Stock photography, behind a swappable provider adapter.
 *
 * Three adapters ship:
 *   unsplash — query-relevant, free tier, requires an access key
 *   pexels   — query-relevant, free tier, requires an API key
 *   picsum   — Lorem Picsum: real photographs, no key, but it cannot search,
 *              so results are topically random
 *
 * Picsum exists so that `imageSource: "stock"` does something sensible with
 * zero configuration. It is genuinely useful for judging a theme's *layout*
 * (real photos, right dimensions, right file sizes) and genuinely useless for
 * judging whether images match the copy. Callers are told which adapter ran,
 * via `ImageRef.credit`, so that trade-off is never invisible.
 */

import { ThemeseedError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { ImageRef, ImageRequest } from '../core/types.js';
import { hashString } from './png.js';
import { orientationFor, type ImageSource } from './source.js';

export type StockProviderName = 'unsplash' | 'pexels' | 'picsum';

export interface StockProvider {
  readonly name: StockProviderName;
  /** Whether the adapter has what it needs (usually an API key). */
  isConfigured(): boolean;
  configurationHint(): string;
  search(request: ImageRequest, count: number): Promise<ImageRef[]>;
}

export interface StockImageSourceOptions {
  provider?: StockProviderName;
  unsplashAccessKey?: string;
  pexelsApiKey?: string;
  fetchImpl?: typeof fetch;
}

export class StockImageSource implements ImageSource {
  readonly kind = 'stock' as const;

  private readonly provider: StockProvider;

  constructor(options: StockImageSourceOptions = {}) {
    this.provider = selectStockProvider(options);
  }

  /** Which adapter this instance resolved to. Surfaced in tool output. */
  get providerName(): StockProviderName {
    return this.provider.name;
  }

  async isAvailable(): Promise<boolean> {
    return this.provider.isConfigured();
  }

  async unavailableReason(): Promise<string> {
    return this.provider.isConfigured() ? '' : this.provider.configurationHint();
  }

  async fetch(request: ImageRequest, count: number): Promise<ImageRef[]> {
    if (!this.provider.isConfigured()) {
      throw new ThemeseedError(
        `Stock provider "${this.provider.name}" is not configured`,
        {
          code: 'STOCK_NOT_CONFIGURED',
          hint: this.provider.configurationHint(),
        }
      );
    }
    return this.provider.search(request, count);
  }
}

/**
 * Picks the adapter: an explicit choice, else whichever key is present, else
 * the keyless fallback. Never silently prefers a keyed provider whose key is
 * missing — that produced confusing "0 images" runs.
 */
export function selectStockProvider(
  options: StockImageSourceOptions = {}
): StockProvider {
  const unsplashKey = options.unsplashAccessKey ?? process.env.UNSPLASH_ACCESS_KEY;
  const pexelsKey = options.pexelsApiKey ?? process.env.PEXELS_API_KEY;
  const requested =
    options.provider ??
    (process.env.THEMESEED_STOCK_PROVIDER as StockProviderName | undefined);

  const build = (name: StockProviderName): StockProvider => {
    switch (name) {
      case 'unsplash':
        return new UnsplashProvider(unsplashKey, options.fetchImpl);
      case 'pexels':
        return new PexelsProvider(pexelsKey, options.fetchImpl);
      case 'picsum':
        return new PicsumProvider(options.fetchImpl);
    }
  };

  if (requested) return build(requested);
  if (unsplashKey) return build('unsplash');
  if (pexelsKey) return build('pexels');

  logger.debug(
    'no stock API key configured; falling back to Lorem Picsum (results ignore the query)'
  );
  return build('picsum');
}

// ---------------------------------------------------------------------------
// Unsplash
// ---------------------------------------------------------------------------

interface UnsplashPhoto {
  urls: { raw?: string; full?: string; regular?: string };
  width: number;
  height: number;
  alt_description?: string | null;
  description?: string | null;
  user?: { name?: string; links?: { html?: string } };
  links?: { html?: string };
}

class UnsplashProvider implements StockProvider {
  readonly name = 'unsplash' as const;

  constructor(
    private readonly accessKey: string | undefined,
    private readonly doFetch: typeof fetch = fetch
  ) {}

  isConfigured(): boolean {
    return Boolean(this.accessKey);
  }

  configurationHint(): string {
    return 'Set UNSPLASH_ACCESS_KEY. Create a free app at https://unsplash.com/developers (50 requests/hour on the demo tier).';
  }

  async search(request: ImageRequest, count: number): Promise<ImageRef[]> {
    const url = new URL('https://api.unsplash.com/search/photos');
    url.searchParams.set('query', request.query);
    url.searchParams.set('per_page', String(Math.min(30, Math.max(count, 1))));
    url.searchParams.set('orientation', orientationFor(request));
    url.searchParams.set('content_filter', 'high');

    const response = await this.doFetch(url, {
      headers: {
        Authorization: `Client-ID ${this.accessKey}`,
        'Accept-Version': 'v1',
      },
    });
    if (!response.ok) {
      throw new ThemeseedError(`Unsplash search failed with HTTP ${response.status}`, {
        code: 'STOCK_SEARCH_FAILED',
        hint:
          response.status === 401
            ? 'The Unsplash access key was rejected.'
            : response.status === 403
              ? 'Unsplash rate limit reached (the demo tier allows 50 requests/hour).'
              : undefined,
      });
    }

    const data = (await response.json()) as { results?: UnsplashPhoto[] };
    return (data.results ?? [])
      .slice(0, count)
      .map((photo) => {
        const source = photo.urls.raw ?? photo.urls.full ?? photo.urls.regular ?? '';
        return {
          kind: 'url' as const,
          // Ask Unsplash for a sensible delivery size rather than the raw
          // original, which can be 20MB+ and slows every upload down.
          location: source ? withUnsplashSizing(source, request) : '',
          width: photo.width,
          height: photo.height,
          alt: photo.alt_description ?? photo.description ?? request.query,
          credit: photo.user?.name
            ? `Photo by ${photo.user.name} on Unsplash`
            : 'Photo via Unsplash',
          source: 'stock' as const,
        };
      })
      .filter((ref) => ref.location !== '');
  }
}

function withUnsplashSizing(rawUrl: string, request: ImageRequest): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('w', String(request.minWidth ?? 1600));
    url.searchParams.set('q', '80');
    url.searchParams.set('fm', 'jpg');
    url.searchParams.set('fit', 'max');
    return url.toString();
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------

interface PexelsPhoto {
  width: number;
  height: number;
  alt?: string;
  photographer?: string;
  src?: { large2x?: string; large?: string; original?: string };
}

class PexelsProvider implements StockProvider {
  readonly name = 'pexels' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly doFetch: typeof fetch = fetch
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  configurationHint(): string {
    return 'Set PEXELS_API_KEY. Free key at https://www.pexels.com/api/ (200 requests/hour).';
  }

  async search(request: ImageRequest, count: number): Promise<ImageRef[]> {
    const url = new URL('https://api.pexels.com/v1/search');
    url.searchParams.set('query', request.query);
    url.searchParams.set('per_page', String(Math.min(80, Math.max(count, 1))));
    url.searchParams.set('orientation', orientationFor(request));

    const response = await this.doFetch(url, {
      headers: { Authorization: this.apiKey as string },
    });
    if (!response.ok) {
      throw new ThemeseedError(`Pexels search failed with HTTP ${response.status}`, {
        code: 'STOCK_SEARCH_FAILED',
        hint: response.status === 401 ? 'The Pexels API key was rejected.' : undefined,
      });
    }

    const data = (await response.json()) as { photos?: PexelsPhoto[] };
    return (data.photos ?? [])
      .slice(0, count)
      .map((photo) => ({
        kind: 'url' as const,
        location: photo.src?.large2x ?? photo.src?.large ?? photo.src?.original ?? '',
        width: photo.width,
        height: photo.height,
        alt: photo.alt || request.query,
        credit: photo.photographer
          ? `Photo by ${photo.photographer} on Pexels`
          : 'Photo via Pexels',
        source: 'stock' as const,
      }))
      .filter((ref) => ref.location !== '');
  }
}

// ---------------------------------------------------------------------------
// Lorem Picsum (keyless)
// ---------------------------------------------------------------------------

class PicsumProvider implements StockProvider {
  readonly name = 'picsum' as const;

  constructor(private readonly doFetch: typeof fetch = fetch) {}

  isConfigured(): boolean {
    return true;
  }

  configurationHint(): string {
    return '';
  }

  async search(request: ImageRequest, count: number): Promise<ImageRef[]> {
    const { width, height } = dimensionsFor(request);

    // The seed makes each URL stable and distinct: same query and index always
    // resolves to the same photograph, so re-running a seed is idempotent.
    const refs: ImageRef[] = [];
    for (let index = 0; index < count; index++) {
      const seed = (hashString(`${request.query}#${index}`) % 1_000_000).toString(36);
      refs.push({
        kind: 'url',
        location: `https://picsum.photos/seed/${seed}/${width}/${height}`,
        width,
        height,
        alt: request.query,
        credit:
          'Photo via Lorem Picsum (not matched to the topic — set UNSPLASH_ACCESS_KEY or PEXELS_API_KEY for relevant imagery)',
        source: 'stock',
      });
    }

    // Picsum redirects to a CDN; probing the first URL catches a blocked
    // network here rather than fifteen posts later. It answers HEAD with 405,
    // so this is a GET whose body is cancelled as soon as the status is known.
    try {
      const probe = await this.doFetch(refs[0]!.location, { redirect: 'follow' });
      await probe.body?.cancel();
      if (!probe.ok) {
        throw new ThemeseedError(`Lorem Picsum returned HTTP ${probe.status}`, {
          code: 'STOCK_SEARCH_FAILED',
          hint: 'Check outbound network access, or configure Unsplash/Pexels instead.',
        });
      }
    } catch (err) {
      if (err instanceof ThemeseedError) throw err;
      throw new ThemeseedError('Could not reach Lorem Picsum', {
        code: 'STOCK_SEARCH_FAILED',
        hint: 'Check outbound network access, or use the "local" image source.',
        cause: err,
      });
    }

    return refs;
  }
}

function dimensionsFor(request: ImageRequest): { width: number; height: number } {
  const width = request.minWidth ?? 1600;
  const ratio =
    request.aspectRatio ??
    (orientationFor(request) === 'portrait'
      ? 0.75
      : orientationFor(request) === 'square'
        ? 1
        : 1.5);
  return { width, height: Math.max(1, Math.round(width / ratio)) };
}
