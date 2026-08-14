/**
 * Generated imagery, behind a pluggable adapter.
 *
 * Two adapters ship:
 *   openai     — real image generation via the Images API (needs OPENAI_API_KEY)
 *   procedural — deterministic abstract artwork rendered locally, no key,
 *                no network
 *
 * A word on `procedural`, because the honesty matters: it is **not** AI. It is
 * a gradient-and-geometry generator that exists so `imageSource: "ai"` still
 * produces correctly-sized, valid, visually-varied images when no generation
 * key is configured — which keeps the tool usable out of the box and the
 * integration tests hermetic. Every image it produces carries a `credit` that
 * says exactly what it is, so it can never be mistaken for generated art.
 *
 * Adding a new backend (Replicate, Stability, a local diffusion server) means
 * implementing `AiImageAdapter` and registering it in `selectAiAdapter`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ThemeseedError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { ImageRef, ImageRequest } from '../core/types.js';
import { probeImage } from './inspect.js';
import { encodePng, hashString, seededRandom } from './png.js';
import { orientationFor, type ImageSource } from './source.js';

export type AiAdapterName = 'openai' | 'procedural';

export interface GeneratedImage {
  bytes: Uint8Array;
  /** File extension without the dot. */
  extension: string;
  /** Provenance, surfaced on every `ImageRef`. */
  credit: string;
}

export interface AiImageAdapter {
  readonly name: AiAdapterName;
  isConfigured(): boolean;
  configurationHint(): string;
  generate(request: ImageRequest, count: number): Promise<GeneratedImage[]>;
}

export interface AiImageSourceOptions {
  adapter?: AiAdapterName | AiImageAdapter;
  openaiApiKey?: string;
  /** Where generated files are written. Defaults to a temp directory. */
  outputDir?: string;
  fetchImpl?: typeof fetch;
}

export class AiImageSource implements ImageSource {
  readonly kind = 'ai' as const;

  private readonly adapter: AiImageAdapter;
  private readonly outputDir: string;

  constructor(options: AiImageSourceOptions = {}) {
    this.adapter =
      typeof options.adapter === 'object' ? options.adapter : selectAiAdapter(options);
    this.outputDir = options.outputDir ?? path.join(os.tmpdir(), 'themeseed-images');
  }

  get adapterName(): AiAdapterName {
    return this.adapter.name;
  }

  async isAvailable(): Promise<boolean> {
    return this.adapter.isConfigured();
  }

  async unavailableReason(): Promise<string> {
    return this.adapter.isConfigured() ? '' : this.adapter.configurationHint();
  }

  async fetch(request: ImageRequest, count: number): Promise<ImageRef[]> {
    if (!this.adapter.isConfigured()) {
      throw new ThemeseedError(
        `AI image adapter "${this.adapter.name}" is not configured`,
        {
          code: 'AI_NOT_CONFIGURED',
          hint: this.adapter.configurationHint(),
        }
      );
    }

    const generated = await this.adapter.generate(request, count);
    await fs.mkdir(this.outputDir, { recursive: true });

    const refs: ImageRef[] = [];
    for (const [index, image] of generated.entries()) {
      // Never hand a provider bytes we have not verified are an image; a failed
      // generation that returns a JSON error body would otherwise be uploaded.
      const info = probeImage(image.bytes);
      if (!info) {
        logger.warn(
          `${this.adapter.name} returned data that is not a valid image; skipping`
        );
        continue;
      }
      const name = `${hashString(`${request.query}#${index}`).toString(36)}.${image.extension}`;
      const file = path.join(this.outputDir, name);
      await fs.writeFile(file, image.bytes);
      refs.push({
        kind: 'file',
        location: file,
        width: info.width,
        height: info.height,
        alt: request.query,
        credit: image.credit,
        source: 'ai',
      });
    }
    return refs;
  }
}

export function selectAiAdapter(options: AiImageSourceOptions = {}): AiImageAdapter {
  const requested =
    (typeof options.adapter === 'string' ? options.adapter : undefined) ??
    (process.env.THEMESEED_AI_IMAGE_ADAPTER as AiAdapterName | undefined);
  const openaiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;

  if (requested === 'openai') return new OpenAiImageAdapter(openaiKey, options.fetchImpl);
  if (requested === 'procedural') return new ProceduralImageAdapter();
  if (openaiKey) return new OpenAiImageAdapter(openaiKey, options.fetchImpl);

  logger.debug(
    'no image-generation key configured; the "ai" source will render procedural placeholders'
  );
  return new ProceduralImageAdapter();
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

class OpenAiImageAdapter implements AiImageAdapter {
  readonly name = 'openai' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly doFetch: typeof fetch = fetch
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  configurationHint(): string {
    return 'Set OPENAI_API_KEY to generate images, or set THEMESEED_AI_IMAGE_ADAPTER=procedural for keyless placeholders.';
  }

  async generate(request: ImageRequest, count: number): Promise<GeneratedImage[]> {
    const response = await this.doFetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: buildPrompt(request),
        n: Math.min(count, 10),
        size: sizeFor(request),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ThemeseedError(`Image generation failed with HTTP ${response.status}`, {
        code: 'AI_GENERATION_FAILED',
        hint: body.slice(0, 200),
      });
    }

    const data = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    const images: GeneratedImage[] = [];

    for (const entry of data.data ?? []) {
      if (entry.b64_json) {
        images.push({
          bytes: new Uint8Array(Buffer.from(entry.b64_json, 'base64')),
          extension: 'png',
          credit: 'Image generated with OpenAI gpt-image-1',
        });
      } else if (entry.url) {
        const download = await this.doFetch(entry.url);
        if (!download.ok) continue;
        images.push({
          bytes: new Uint8Array(await download.arrayBuffer()),
          extension: 'png',
          credit: 'Image generated with OpenAI gpt-image-1',
        });
      }
    }
    return images;
  }
}

function buildPrompt(request: ImageRequest): string {
  const framing =
    request.role === 'feature'
      ? 'A striking editorial hero photograph'
      : request.role === 'gallery'
        ? 'A photograph suitable for a magazine gallery'
        : 'A clean editorial photograph';
  return `${framing} illustrating: ${request.query}. Natural lighting, shallow depth of field, no text or watermarks, no visible logos.`;
}

/** The Images API accepts a fixed set of sizes; map orientation onto them. */
function sizeFor(request: ImageRequest): string {
  const orientation = orientationFor(request);
  if (orientation === 'portrait') return '1024x1536';
  if (orientation === 'square') return '1024x1024';
  return '1536x1024';
}

// ---------------------------------------------------------------------------
// Procedural (keyless fallback — deliberately not AI)
// ---------------------------------------------------------------------------

export class ProceduralImageAdapter implements AiImageAdapter {
  readonly name = 'procedural' as const;

  isConfigured(): boolean {
    return true;
  }

  configurationHint(): string {
    return '';
  }

  async generate(request: ImageRequest, count: number): Promise<GeneratedImage[]> {
    const { width, height } = dimensionsFor(request);
    const images: GeneratedImage[] = [];

    for (let index = 0; index < count; index++) {
      const seed = hashString(`${request.query}#${index}`);
      images.push({
        bytes: renderArtwork(width, height, seed),
        extension: 'png',
        credit:
          'Procedurally generated placeholder (not AI — set OPENAI_API_KEY to generate real imagery)',
      });
    }
    return images;
  }
}

/**
 * Renders a soft two-tone gradient with a few translucent geometric shapes.
 * The goal is something that reads as "a photo goes here" at thumbnail size
 * without pretending to be a photograph.
 */
function renderArtwork(width: number, height: number, seed: number): Uint8Array {
  const random = seededRandom(seed);

  // Two hues a pleasing distance apart on the wheel.
  const baseHue = random() * 360;
  const accentHue = (baseHue + 40 + random() * 80) % 360;
  const from = hslToRgb(baseHue, 0.45 + random() * 0.2, 0.72 + random() * 0.12);
  const to = hslToRgb(accentHue, 0.5 + random() * 0.2, 0.34 + random() * 0.14);

  const shapes = Array.from({ length: 3 + Math.floor(random() * 3) }, () => ({
    cx: random() * width,
    cy: random() * height,
    radius: (0.12 + random() * 0.28) * Math.min(width, height),
    color: hslToRgb((baseHue + random() * 120) % 360, 0.5, 0.5 + random() * 0.3),
    alpha: 0.12 + random() * 0.18,
  }));

  const angle = random() * Math.PI;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const span = Math.abs(dx) * width + Math.abs(dy) * height;

  return encodePng(width, height, (x, y) => {
    const t = clamp01((x * dx + y * dy) / (span || 1));
    let r = from.r + (to.r - from.r) * t;
    let g = from.g + (to.g - from.g) * t;
    let b = from.b + (to.b - from.b) * t;

    for (const shape of shapes) {
      const distance = Math.hypot(x - shape.cx, y - shape.cy);
      if (distance > shape.radius) continue;
      // Feather the edge so shapes read as soft light, not hard circles.
      const falloff = 1 - distance / shape.radius;
      const alpha = shape.alpha * falloff * falloff;
      r += (shape.color.r - r) * alpha;
      g += (shape.color.g - g) * alpha;
      b += (shape.color.b - b) * alpha;
    }

    // Ordered dithering breaks up gradient banding. Deliberately not random
    // noise: random grain is pure entropy and inflates the deflate stream by
    // roughly 10x (a 1200x800 gradient goes from ~90KB to ~900KB), while a
    // repeating 4x4 pattern costs almost nothing to compress.
    const dither = BAYER_4X4[(y & 3) * 4 + (x & 3)]! / 16 - 0.5;
    const offset = dither * 2;
    return { r: r + offset, g: g + offset, b: b + offset };
  });
}

/** Standard 4x4 Bayer threshold matrix. */
const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function dimensionsFor(request: ImageRequest): { width: number; height: number } {
  const orientation = orientationFor(request);
  const ratio =
    request.aspectRatio ??
    (orientation === 'portrait' ? 0.75 : orientation === 'square' ? 1 : 1.5);
  // 1600px wide is enough for a hero on a 2x display without making the PNG
  // encoder the slowest part of a seed run.
  const width = Math.min(request.minWidth ?? 1600, 2000);
  return { width, height: Math.max(1, Math.round(width / ratio)) };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}
