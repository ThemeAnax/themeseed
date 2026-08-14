/**
 * Reads the active theme's source files straight off disk.
 *
 * This is by far the most accurate way to analyze a Ghost theme, and it is
 * only possible when themeseed runs on the same machine as Ghost. It exists
 * because Ghost's Admin API `/themes/` endpoint rejects API-token auth
 * outright (`NoPermissionError` — it is staff-session only), so there is no
 * remote way to download the theme package. When the directory is not
 * available we fall back to `rendered-theme-source.ts`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../../../core/logger.js';
import {
  detectCardCss,
  dominantFeatureImageRatio,
  inferWordCount,
  type MeasurableCapabilities,
  type ThemeAnalysisStrategy,
  type ThemeSignalSet,
} from './signals.js';

/** Theme package.json — only the parts we read. */
interface ThemePackage {
  name?: string;
  version?: string;
  description?: string;
  config?: {
    posts_per_page?: number;
    card_assets?: boolean | string[] | { include?: string[]; exclude?: string[] };
    custom?: Record<string, { type?: string; options?: string[]; default?: unknown }>;
  };
}

export interface LocalThemeSourceOptions {
  themeName: string;
  /** Explicit `content/themes` directory, if the user configured one. */
  themesDir?: string;
  /** Overridable for tests. */
  homeDir?: string;
}

export class LocalThemeSource implements ThemeAnalysisStrategy {
  readonly name = 'local-theme-files';

  constructor(private readonly options: LocalThemeSourceOptions) {}

  async analyze(): Promise<ThemeSignalSet | null> {
    const dir = await this.resolveThemeDir();
    if (!dir) return null;

    const evidence: string[] = [`read theme sources from ${dir}`];
    const capabilities: Partial<MeasurableCapabilities> = {
      themeName: this.options.themeName,
    };

    const pkg = await this.readPackage(dir, evidence, capabilities);
    const templates = await this.readTemplates(dir);
    if (!templates.combined) {
      evidence.push('no .hbs templates found; treating directory as unusable');
      return null;
    }
    const css = await this.readBuiltCss(dir);

    this.applyTemplateSignals(templates, css, capabilities, evidence);
    this.applyCardSignals(pkg, css, capabilities, evidence);
    this.applyWordCount(pkg, templates, capabilities, evidence);

    return {
      strategy: this.name,
      // Reading the actual source the CMS renders from is as close to ground
      // truth as this tool gets. Held below 1.0 because Handlebars is dynamic:
      // a block behind a custom setting may never render for this user.
      confidence: 0.9,
      evidence,
      capabilities,
    };
  }

  // -- directory resolution -------------------------------------------------

  private async resolveThemeDir(): Promise<string | null> {
    for (const base of this.candidateThemeDirs()) {
      const candidate = path.join(base, this.options.themeName);
      if (await isDirectory(candidate)) {
        return candidate;
      }
    }
    logger.debug(
      `local theme analysis skipped: no directory for "${this.options.themeName}" in any known location`
    );
    return null;
  }

  private candidateThemeDirs(): string[] {
    const home = this.options.homeDir ?? os.homedir();
    const explicit = [this.options.themesDir, process.env.GHOST_THEMES_DIR].filter(
      (v): v is string => Boolean(v)
    );
    // Conventional layouts: ghost-cli local installs, Docker/apt installs, and
    // a source checkout. Deliberately a short, boring list — guessing wildly at
    // filesystem paths is how a tool ends up analyzing the wrong site's theme.
    return [
      ...explicit,
      path.join(process.cwd(), 'content', 'themes'),
      path.join(process.cwd(), 'themes'),
      '/var/lib/ghost/content/themes',
      path.join(home, 'ghost', 'content', 'themes'),
    ];
  }

  // -- readers --------------------------------------------------------------

  private async readPackage(
    dir: string,
    evidence: string[],
    capabilities: Partial<MeasurableCapabilities>
  ): Promise<ThemePackage> {
    try {
      const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as ThemePackage;
      if (pkg.version) capabilities.themeVersion = pkg.version;
      if (pkg.description) capabilities.description = pkg.description;
      if (typeof pkg.config?.posts_per_page === 'number') {
        capabilities.postsPerPage = pkg.config.posts_per_page;
        evidence.push(
          `package.json config.posts_per_page = ${pkg.config.posts_per_page}`
        );
      }
      return pkg;
    } catch {
      evidence.push('no readable package.json in theme directory');
      return {};
    }
  }

  private async readTemplates(dir: string): Promise<{
    combined: string;
    post: string;
    index: string;
  }> {
    const files = await collectFiles(dir, '.hbs', 3);
    let combined = '';
    let post = '';
    let index = '';
    for (const file of files) {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      combined += `\n${text}`;
      const base = path.basename(file);
      if (base === 'post.hbs') post = text;
      if (base === 'index.hbs') index = text;
    }
    return { combined, post, index };
  }

  private async readBuiltCss(dir: string): Promise<string> {
    const files = await collectFiles(dir, '.css', 4);
    let css = '';
    for (const file of files) {
      // Skip Ghost's own bundled card stylesheet if a theme vendored it — its
      // presence says nothing about whether *this* theme styled the cards.
      if (/cards(\.min)?\.css$/.test(file)) continue;
      try {
        css += `\n${await fs.readFile(file, 'utf8')}`;
      } catch {
        continue;
      }
    }
    return css;
  }

  // -- signal extraction ----------------------------------------------------

  private applyTemplateSignals(
    templates: { combined: string; post: string },
    css: string,
    capabilities: Partial<MeasurableCapabilities>,
    evidence: string[]
  ): void {
    const all = templates.combined;
    const post = templates.post || all;

    // Checked across every template, not just post.hbs: a theme whose post
    // header is text-only still shows feature images on index and tag cards,
    // and generating posts without one would leave those archives grey.
    const hasFeatureImage =
      /\{\{#if\s+feature_image\}\}|\{\{\s*img_url\s+feature_image/.test(all);
    capabilities.supportsFeatureImage = hasFeatureImage;
    evidence.push(
      hasFeatureImage
        ? `templates reference feature_image${
            /feature_image/.test(post)
              ? ''
              : ' (in listing templates only, not on the post page)'
          }`
        : 'no template references feature_image'
    );

    const dominant = dominantFeatureImageRatio(all, css);
    if (dominant) {
      capabilities.featureImageAspectRatio = dominant.ratio;
      evidence.push(
        `feature image aspect-ratio ≈ ${dominant.ratio} ` +
          `(most common of the ratios attached to feature images; ${dominant.occurrences} ` +
          `occurrence(s), via ${dominant.source})`
      );
    }

    capabilities.displaysTags = /\{\{#foreach\s+tags|\{\{#if\s+tags\}\}|primary_tag/.test(
      all
    );
    capabilities.displaysAuthor = /\{\{#primary_author\}\}|\{\{#foreach\s+authors/.test(
      all
    );
    capabilities.displaysAuthorImage = /profile_image/.test(all);
    capabilities.displaysExcerpt = /custom_excerpt|\{\{excerpt/.test(all);
    capabilities.displaysReadingTime = /\{\{\s*reading_time/.test(all);

    evidence.push(
      `template markers — tags:${capabilities.displaysTags} author:${capabilities.displaysAuthor} ` +
        `authorImage:${capabilities.displaysAuthorImage} excerpt:${capabilities.displaysExcerpt} ` +
        `readingTime:${capabilities.displaysReadingTime}`
    );
  }

  private applyCardSignals(
    pkg: ThemePackage,
    css: string,
    capabilities: Partial<MeasurableCapabilities>,
    evidence: string[]
  ): void {
    const cardAssets = pkg.config?.card_assets;
    const cardsEnabled = cardAssetsEnabled(cardAssets);
    const fromCss = detectCardCss(css);

    // `card_assets: true` means Ghost injects its own card stylesheet, so every
    // card renders correctly even if the theme never mentions it. That is a
    // stronger guarantee than finding selectors, so it wins outright.
    if (cardsEnabled === 'all') {
      capabilities.supportsGallery = true;
      capabilities.supportsVideoEmbed = true;
      capabilities.supportsBookmarkCard = true;
      capabilities.supportsCodeBlocks = true;
      capabilities.supportsWideImages = true;
      evidence.push(
        'package.json config.card_assets enables Ghost card styles for all cards'
      );
      return;
    }

    if (Array.isArray(cardsEnabled)) {
      capabilities.supportsGallery = cardsEnabled.includes('gallery') || fromCss.gallery;
      capabilities.supportsVideoEmbed = cardsEnabled.includes('embed') || fromCss.embed;
      capabilities.supportsBookmarkCard =
        cardsEnabled.includes('bookmark') || fromCss.bookmark;
      capabilities.supportsCodeBlocks = true;
      capabilities.supportsWideImages = fromCss.wide;
      evidence.push(`card_assets allow-list: ${cardsEnabled.join(', ')}`);
      return;
    }

    capabilities.supportsGallery = fromCss.gallery;
    capabilities.supportsVideoEmbed = fromCss.embed;
    capabilities.supportsBookmarkCard = fromCss.bookmark;
    capabilities.supportsCodeBlocks = fromCss.code;
    capabilities.supportsWideImages = fromCss.wide;
    evidence.push(
      `card support inferred from theme CSS selectors — gallery:${fromCss.gallery} ` +
        `embed:${fromCss.embed} bookmark:${fromCss.bookmark} wide:${fromCss.wide}`
    );
  }

  private applyWordCount(
    pkg: ThemePackage,
    templates: { combined: string; post: string },
    capabilities: Partial<MeasurableCapabilities>,
    evidence: string[]
  ): void {
    const post = templates.post || templates.combined;
    const custom = pkg.config?.custom ?? {};

    // A TOC that is merely an option the user could turn on is weaker evidence
    // than one the theme ships on by default, but both mean the theme was
    // designed for articles long enough to need one.
    const tocSetting = custom['table_of_contents'];
    const tocDefaultOff =
      typeof tocSetting?.default === 'string' && tocSetting.default === 'off';
    const hasToc =
      (/\bid="toc|class="toc\b|toc-slot|toc-links/.test(post) || Boolean(tocSetting)) &&
      !tocDefaultOff;

    const widthSetting = custom['content_width'];
    const contentWidth =
      typeof widthSetting?.default === 'string'
        ? (widthSetting.default as 'narrow' | 'standard' | 'wide' | 'full')
        : undefined;

    capabilities.expectedWordCount = inferWordCount({
      hasTableOfContents: hasToc,
      hasReadingTime: capabilities.displaysReadingTime ?? false,
      ...(contentWidth ? { contentWidth } : {}),
    });
    evidence.push(
      `word count from layout — toc:${hasToc} readingTime:${capabilities.displaysReadingTime} ` +
        `width:${contentWidth ?? 'unknown'} → target ${capabilities.expectedWordCount.target}`
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type CardAssetsConfig = NonNullable<ThemePackage['config']>['card_assets'];

/** `true` → all cards; an array → only those cards; `false`/absent → none. */
function cardAssetsEnabled(value: CardAssetsConfig): 'all' | string[] | null {
  if (value === true) return 'all';
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.include)) return value.include;
    // An exclude-list still enables everything else.
    if (Array.isArray(value.exclude)) return 'all';
  }
  return null;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Recursive file walk with a depth cap, skipping node_modules and dotfiles. */
async function collectFiles(
  root: string,
  extension: string,
  maxDepth: number
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(extension)) found.push(full);
    }
  }

  await walk(root, 0);
  return found;
}
