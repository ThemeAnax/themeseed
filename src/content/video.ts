/**
 * Finds real YouTube videos for a topic.
 *
 * The hard rule: never invent a video id. A fabricated id produces an embed
 * that renders as "Video unavailable", which is worse than no video at all —
 * it looks like the theme is broken. So every candidate is confirmed through
 * YouTube's public oEmbed endpoint, which only answers for videos that exist
 * and are embeddable, and the title/author/thumbnail come from that response
 * rather than being guessed.
 *
 * No API key is involved: search reads the public results page, verification
 * uses the documented oEmbed endpoint.
 */

import { logger } from '../core/logger.js';
import type { VideoBlock } from '../core/types.js';

export interface VideoSearchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How many search hits to verify before giving up. */
  maxCandidates?: number;
}

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  provider_name?: string;
  html?: string;
}

export class YouTubeVideoFinder {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxCandidates: number;
  /** Ids already handed out, so a run does not embed the same video twice. */
  private readonly used = new Set<string>();

  constructor(options: VideoSearchOptions = {}) {
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxCandidates = options.maxCandidates ?? 6;
  }

  /** Returns a verified video block, or null when nothing could be confirmed. */
  async find(query: string): Promise<VideoBlock | null> {
    let ids: string[];
    try {
      ids = await this.search(query);
    } catch (err) {
      logger.debug(`YouTube search failed for "${query}":`, err);
      return null;
    }

    for (const id of ids.slice(0, this.maxCandidates)) {
      if (this.used.has(id)) continue;
      const url = `https://www.youtube.com/watch?v=${id}`;
      const metadata = await this.verify(url);
      if (!metadata) continue;

      this.used.add(id);
      return {
        type: 'video',
        url,
        provider: 'youtube',
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.author_name ? { authorName: metadata.author_name } : {}),
        ...(metadata.thumbnail_url ? { thumbnailUrl: metadata.thumbnail_url } : {}),
      };
    }

    logger.debug(`no embeddable YouTube video confirmed for "${query}"`);
    return null;
  }

  /**
   * Scrapes video ids out of the public results page. YouTube serves its
   * results as a JSON blob inside the HTML; `"videoId":"..."` is the stable
   * part of that payload across its many layout changes.
   */
  private async search(query: string): Promise<string[]> {
    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', query);
    // Filter to videos only, so playlists and channels do not become candidates.
    url.searchParams.set('sp', 'EgIQAQ%3D%3D');

    const html = await this.text(url.toString(), {
      // Without a browser-like UA YouTube serves a consent interstitial with
      // no results in it.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const match of html.matchAll(/"videoId":"([\w-]{11})"/g)) {
      const id = match[1]!;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  /**
   * oEmbed is the verification step. A 404 means the video does not exist; a
   * 401 means the owner disabled embedding. Either way it must not be used.
   */
  private async verify(watchUrl: string): Promise<OEmbedResponse | null> {
    const url = new URL('https://www.youtube.com/oembed');
    url.searchParams.set('url', watchUrl);
    url.searchParams.set('format', 'json');

    try {
      const body = await this.text(url.toString(), {});
      const data = JSON.parse(body) as OEmbedResponse;
      return data.title ? data : null;
    } catch {
      return null;
    }
  }

  private async text(url: string, headers: Record<string, string>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
