/**
 * Analyzes the theme by looking at what the site actually serves.
 *
 * This strategy always works — including against Ghost(Pro) and any remote
 * install where the theme files are unreachable. The trick that makes it more
 * than guesswork: a Ghost theme's own stylesheet is a public asset, linked from
 * every page. Fetching it and looking for `kg-*` card selectors answers the
 * gallery / embed / bookmark / wide-image questions with real evidence rather
 * than assumption, which is most of what the content generator needs.
 *
 * Rendered HTML supplies the rest: whether a post shows a hero image, tags, an
 * author avatar, a reading time.
 */

import { logger } from '../../../core/logger.js';
import {
  buildAspectRatioClassMap,
  detectCardCss,
  dominantFeatureImageRatio,
  inferWordCount,
  parseAspectRatio,
  type MeasurableCapabilities,
  type ThemeAnalysisStrategy,
  type ThemeSignalSet,
} from './signals.js';

export interface RenderedThemeSourceOptions {
  siteUrl: string;
  themeName: string;
  /** A published post URL to inspect. Falls back to a link found on the home page. */
  samplePostUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class RenderedThemeSource implements ThemeAnalysisStrategy {
  readonly name = 'rendered-site';

  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RenderedThemeSourceOptions) {
    this.baseUrl = options.siteUrl.replace(/\/+$/, '');
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async analyze(): Promise<ThemeSignalSet | null> {
    const home = await this.get(this.baseUrl);
    if (!home) {
      logger.debug('rendered-site analysis skipped: home page unreachable');
      return null;
    }

    const evidence: string[] = [`fetched ${this.baseUrl}`];
    const capabilities: Partial<MeasurableCapabilities> = { themeName: this.options.themeName };

    const css = await this.fetchThemeStylesheets(home, evidence);
    if (css) this.applyCardSignals(css, capabilities, evidence);

    const postUrl = this.options.samplePostUrl ?? this.findPostUrl(home);
    const postHtml = postUrl ? await this.get(postUrl) : null;
    if (postHtml) {
      evidence.push(`inspected post page ${postUrl}`);
      this.applyPostSignals(postHtml, css ?? '', capabilities, evidence);
    } else {
      evidence.push('no published post available to inspect; post-level signals unmeasured');
    }

    return {
      strategy: this.name,
      // Rendered output proves what a theme *did* for one post, not what it
      // can do in general — a post without tags cannot distinguish "theme hides
      // tags" from "post has none". Lower trust than reading the source.
      confidence: 0.6,
      evidence,
      capabilities,
    };
  }

  // -- fetching -------------------------------------------------------------

  private async get(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'themeseed/0.1 (+theme-analysis)' },
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pulls every same-origin stylesheet the page links. Ghost's own
   * `cards.min.css` is skipped: it is present on sites whose theme never
   * styled a card, so counting it would make every site look gallery-capable.
   */
  private async fetchThemeStylesheets(html: string, evidence: string[]): Promise<string | null> {
    const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
      .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
      .filter((href): href is string => Boolean(href))
      .map((href) => this.absolute(href))
      .filter((href): href is string => Boolean(href))
      .filter((href) => href.startsWith(this.baseUrl))
      .filter((href) => !/cards(\.min)?\.css/.test(href));

    if (hrefs.length === 0) {
      evidence.push('no same-origin theme stylesheet linked from the home page');
      return null;
    }

    let css = '';
    const loaded: string[] = [];
    for (const href of hrefs.slice(0, 5)) {
      const text = await this.get(href);
      if (text) {
        css += `\n${text}`;
        loaded.push(href.replace(this.baseUrl, ''));
      }
    }
    if (!css) {
      evidence.push('theme stylesheets were linked but none could be fetched');
      return null;
    }
    evidence.push(`analyzed theme stylesheet(s): ${loaded.join(', ')}`);
    return css;
  }

  private absolute(href: string): string | null {
    try {
      return new URL(href, `${this.baseUrl}/`).toString();
    } catch {
      return null;
    }
  }

  /** First link that looks like a post permalink rather than a tag/author page. */
  private findPostUrl(html: string): string | null {
    const candidates = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((href): href is string => Boolean(href))
      .map((href) => this.absolute(href))
      .filter((href): href is string => Boolean(href))
      .filter((href) => href.startsWith(this.baseUrl));

    for (const href of candidates) {
      const pathname = new URL(href).pathname;
      if (pathname === '/' || pathname === '') continue;
      if (/^\/(tag|author|page|ghost|rss|about|contact|signin|signup|members)\b/.test(pathname)) continue;
      if (/\.(css|js|png|jpe?g|svg|webp|xml|ico)$/i.test(pathname)) continue;
      // Ghost permalinks are a single slug segment by default.
      if (pathname.split('/').filter(Boolean).length === 1) return href;
    }
    return null;
  }

  // -- signal extraction ----------------------------------------------------

  private applyCardSignals(
    css: string,
    capabilities: Partial<MeasurableCapabilities>,
    evidence: string[]
  ): void {
    const cards = detectCardCss(css);
    capabilities.supportsGallery = cards.gallery;
    capabilities.supportsVideoEmbed = cards.embed;
    capabilities.supportsBookmarkCard = cards.bookmark;
    capabilities.supportsWideImages = cards.wide;
    capabilities.supportsCodeBlocks = cards.code;
    evidence.push(
      `card selectors in served CSS — gallery:${cards.gallery} embed:${cards.embed} ` +
        `bookmark:${cards.bookmark} wide:${cards.wide} code:${cards.code}`
    );
  }

  private applyPostSignals(
    html: string,
    css: string,
    capabilities: Partial<MeasurableCapabilities>,
    evidence: string[]
  ): void {
    const head = html.slice(0, html.indexOf('</head>') + 7);
    const body = html.slice(head.length);

    // og:image is set from the feature image, so its presence in <head> says
    // the post *has* one; a matching <img> in <body> says the theme shows it.
    const ogImage = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(head)?.[1];
    let heroStem = '';
    if (ogImage) {
      const filename = ogImage.split('/').pop()?.split('?')[0] ?? '';
      heroStem = filename.replace(/\.\w+$/, '');
      const shown = Boolean(heroStem) && body.includes(heroStem);
      capabilities.supportsFeatureImage = shown;
      evidence.push(
        shown
          ? 'feature image appears in the rendered post body'
          : 'post has a feature image but this page does not render it'
      );
    }

    const ratio = this.heroRatio(body, css, heroStem);
    if (ratio !== undefined) {
      capabilities.featureImageAspectRatio = ratio;
      evidence.push(`feature image aspect-ratio ≈ ${ratio} from the element wrapping the hero`);
    }

    const hasTags = /\/tag\/[a-z0-9-]+/i.test(body);
    const hasAuthor = /\/author\/[a-z0-9-]+/i.test(body);
    const hasAvatar = /(profile[-_]?image|avatar)/i.test(body);
    const hasReadingTime = /\b\d+\s*min(ute)?s?\s*read\b/i.test(body);

    capabilities.displaysTags = hasTags;
    capabilities.displaysAuthor = hasAuthor;
    capabilities.displaysAuthorImage = hasAvatar;
    capabilities.displaysReadingTime = hasReadingTime;
    evidence.push(
      `rendered post markers — tags:${hasTags} author:${hasAuthor} avatar:${hasAvatar} ` +
        `readingTime:${hasReadingTime}`
    );

    const hasToc = /class=["'][^"']*\btoc\b|id=["']toc\b/i.test(body);
    capabilities.expectedWordCount = inferWordCount({
      hasTableOfContents: hasToc,
      hasReadingTime,
    });
    evidence.push(
      `word count from rendered layout — toc:${hasToc} → target ${capabilities.expectedWordCount.target}`
    );
  }

  /**
   * Finds the ratio applied to the hero image by walking backwards from the
   * `<img>` that serves it, through the ancestor opening tags, and resolving
   * their classes against the theme's CSS.
   *
   * Scanning the whole stylesheet for the first `aspect-ratio` instead would
   * just as likely return an avatar's 1:1 as the hero's shape.
   */
  private heroRatio(body: string, css: string, heroStem: string): number | undefined {
    const classRatios = buildAspectRatioClassMap(css);

    const imgIndex = heroStem ? body.indexOf(heroStem) : -1;
    if (imgIndex >= 0) {
      // ~1200 chars covers the handful of wrappers a hero is nested in.
      const before = body.slice(Math.max(0, imgIndex - 1200), imgIndex);
      const openTags = [...before.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]).reverse();
      for (const tag of openTags) {
        const inline = parseAspectRatio(tag);
        if (inline !== undefined) return inline;
        const classAttr = tag.match(/class\s*=\s*["']([^"']+)["']/)?.[1];
        for (const name of classAttr?.split(/\s+/) ?? []) {
          const ratio = classRatios.get(name);
          if (ratio !== undefined) return ratio;
        }
      }
    }

    // No hero on this page — fall back to the dominant ratio across whatever
    // image-bearing markup the page does have.
    return dominantFeatureImageRatio(body, css)?.ratio;
  }
}
