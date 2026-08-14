/**
 * Ghost Admin API client.
 *
 * Ghost authenticates Admin API integrations with a short-lived HS256 JWT
 * signed from an "Admin API key" of the form `<id>:<hex secret>`. The token is
 * minted per request (they are cheap and expire in five minutes) rather than
 * cached, which removes a whole class of clock-skew and staleness bugs.
 */

import crypto from 'node:crypto';
import { basename } from 'node:path';

import { ProviderError } from '../../core/errors.js';
import type { GhostPost, GhostSite, GhostTag, GhostUploadedImage } from './types.js';

/** Ghost rejects tokens with a lifetime over 5 minutes. */
const TOKEN_TTL_SECONDS = 300;

export interface GhostClientOptions {
  url: string;
  adminApiKey: string;
  /**
   * Ghost's API versioning header. v5.0 is accepted by Ghost 5 and 6 alike,
   * so it is the safest default for a tool that must work across installs.
   */
  acceptVersion?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class GhostClient {
  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly acceptVersion: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GhostClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
    const { id, secret } = parseAdminApiKey(options.adminApiKey);
    this.keyId = id;
    this.keySecret = secret;
    this.acceptVersion = options.acceptVersion ?? 'v5.0';
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** Mints a fresh admin JWT. Exposed for tests; not part of the public API. */
  createToken(now: number = Math.floor(Date.now() / 1000)): string {
    const header = base64url(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: this.keyId })
    );
    const payload = base64url(
      JSON.stringify({ iat: now, exp: now + TOKEN_TTL_SECONDS, aud: '/admin/' })
    );
    const signature = crypto
      .createHmac('sha256', Buffer.from(this.keySecret, 'hex'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Ghost ${this.createToken()}`,
      'Accept-Version': this.acceptVersion,
      Accept: 'application/json',
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/ghost/api/admin${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const hasBody = init.body !== undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: this.headers(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ProviderError(
          `Ghost request timed out after ${this.timeoutMs}ms: ${method} ${path}`,
          {
            code: 'GHOST_TIMEOUT',
            hint: 'Is the site reachable and awake?',
          }
        );
      }
      throw new ProviderError(`Could not reach Ghost at ${this.baseUrl}`, {
        code: 'GHOST_UNREACHABLE',
        hint: 'Check the site URL and that the instance is running.',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    return this.parse<T>(response, `${method} ${path}`);
  }

  private async parse<T>(response: Response, context: string): Promise<T> {
    const text = await response.text();

    if (!response.ok) {
      throw new ProviderError(ghostErrorMessage(text, response.status, context), {
        code: 'GHOST_API_ERROR',
        status: response.status,
        hint: hintForStatus(response.status),
      });
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ProviderError(`Ghost returned a non-JSON response for ${context}`, {
        code: 'GHOST_BAD_RESPONSE',
        cause: err,
      });
    }
  }

  // -- endpoints ------------------------------------------------------------

  async getSite(): Promise<GhostSite> {
    const data = await this.request<{ site: GhostSite }>('GET', '/site/');
    return data.site;
  }

  /**
   * Settings come back as a `{key, value}[]`; flattened to a map for callers.
   * This is where `active_theme` lives — the Admin API's `/themes/` endpoint
   * refuses API-token auth, so this is the only token-readable source for it.
   */
  async getSettings(): Promise<Record<string, unknown>> {
    const data = await this.request<{ settings: Array<{ key: string; value: unknown }> }>(
      'GET',
      '/settings/'
    );
    const map: Record<string, unknown> = {};
    for (const entry of data.settings ?? []) map[entry.key] = entry.value;
    return map;
  }

  async listPosts(
    query: Record<string, string | number | undefined> = {}
  ): Promise<GhostPost[]> {
    const data = await this.request<{ posts: GhostPost[] }>('GET', '/posts/', {
      query: { limit: 'all', ...query },
    });
    return data.posts ?? [];
  }

  async createPost(post: Record<string, unknown>): Promise<GhostPost> {
    // `source=html` would make Ghost convert HTML for us, but we build Lexical
    // directly so that cards (gallery, embed, bookmark) survive intact — the
    // HTML converter flattens them into plain <figure>/<img> markup.
    const data = await this.request<{ posts: GhostPost[] }>('POST', '/posts/', {
      body: { posts: [post] },
    });
    const created = data.posts?.[0];
    if (!created)
      throw new ProviderError('Ghost accepted the post but returned no record');
    return created;
  }

  async deletePost(id: string): Promise<void> {
    await this.request<void>('DELETE', `/posts/${encodeURIComponent(id)}/`);
  }

  async listTags(
    query: Record<string, string | number | undefined> = {}
  ): Promise<GhostTag[]> {
    const data = await this.request<{ tags: GhostTag[] }>('GET', '/tags/', {
      query: { limit: 'all', ...query },
    });
    return data.tags ?? [];
  }

  async createTag(tag: { name: string; description?: string }): Promise<GhostTag> {
    const data = await this.request<{ tags: GhostTag[] }>('POST', '/tags/', {
      body: { tags: [tag] },
    });
    const created = data.tags?.[0];
    if (!created)
      throw new ProviderError('Ghost accepted the tag but returned no record');
    return created;
  }

  /**
   * Uploads image bytes and returns the URL Ghost will serve them from.
   * Uses the platform `FormData`/`Blob` so there is no multipart dependency.
   */
  async uploadImage(
    bytes: Uint8Array,
    filename: string,
    contentType: string
  ): Promise<GhostUploadedImage> {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer: a Uint8Array view over a pooled Node
    // Buffer would otherwise hand Blob the whole underlying pool.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append('file', new Blob([copy], { type: contentType }), basename(filename));
    form.append('purpose', 'image');
    form.append('ref', basename(filename));

    const url = `${this.baseUrl}/ghost/api/admin/images/upload/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));

    let response: Response;
    try {
      // Deliberately no Content-Type header — fetch must set the multipart
      // boundary itself, and setting it manually silently breaks the upload.
      response = await this.doFetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`Image upload to Ghost failed for ${filename}`, {
        code: 'GHOST_UPLOAD_FAILED',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await this.parse<{ images: GhostUploadedImage[] }>(
      response,
      'POST /images/upload/'
    );
    const image = data.images?.[0];
    if (!image?.url)
      throw new ProviderError(`Ghost returned no URL for uploaded image ${filename}`);
    return image;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function parseAdminApiKey(key: string): { id: string; secret: string } {
  const trimmed = (key ?? '').trim();
  const parts = trimmed.split(':');
  if (parts.length !== 2) {
    throw new ProviderError('Ghost Admin API key is not in "<id>:<secret>" form', {
      code: 'GHOST_BAD_KEY',
      hint: 'Copy the Admin API key from Ghost Admin → Settings → Integrations → your integration. Note this is not the Content API key.',
    });
  }
  const [id, secret] = parts as [string, string];
  if (!/^[0-9a-f]+$/i.test(id) || !/^[0-9a-f]+$/i.test(secret)) {
    throw new ProviderError('Ghost Admin API key must be hexadecimal', {
      code: 'GHOST_BAD_KEY',
      hint: 'The key looks malformed — re-copy it from Ghost Admin.',
    });
  }
  if (secret.length % 2 !== 0) {
    throw new ProviderError('Ghost Admin API key secret has an odd length', {
      code: 'GHOST_BAD_KEY',
      hint: 'The secret half is truncated — re-copy the full key.',
    });
  }
  return { id, secret };
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function ghostErrorMessage(body: string, status: number, context: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: string; context?: string }>;
    };
    const first = parsed.errors?.[0];
    if (first?.message) {
      return first.context
        ? `Ghost ${status} on ${context}: ${first.message} (${first.context})`
        : `Ghost ${status} on ${context}: ${first.message}`;
    }
  } catch {
    // fall through to the raw body
  }
  return `Ghost ${status} on ${context}: ${body.slice(0, 200) || '<empty body>'}`;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The Admin API key was rejected. Confirm it is an Admin API key (not Content API), and that the integration still exists.';
  }
  if (status === 404)
    return 'Endpoint not found — check the site URL includes any subdirectory Ghost is mounted at.';
  if (status === 422) return 'Ghost rejected the payload as invalid.';
  if (status >= 500) return 'Ghost hit an internal error; check its own logs.';
  return undefined;
}
