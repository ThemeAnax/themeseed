/**
 * Builds a nic-content/1 document from a content request.
 *
 * Reuses the neutral pieces — the prose engine for titles/body/excerpts, the
 * image sources, the seeded RNG — and adds the part that is specific to this
 * contract: seeds are the source design's own items and are preserved, the
 * rest is generated around them.
 */

import type { ContentBlock, ImageRef } from '../core/types.js';
import {
  profileTopic,
  TemplateContentEngine,
  type ContentEngine,
  type TopicProfile,
} from '../content/engine.js';
import { hashString, seededRandom } from '../images/png.js';
import type { ImageSource } from '../images/source.js';
import { blocksToGutenberg, escapeHtml } from '../providers/wordpress/gutenberg.js';
import type { MediaCollector } from './media.js';
import {
  META_KEYS,
  NIC_TYPES,
  type NicContent,
  type NicContentRequest,
  type NicItem,
  type NicSeed,
  type NicTaxonomy,
  type NicTerm,
  type NicType,
} from './types.js';
import * as V from './vocab.js';

export interface GenerateNicOptions {
  request: NicContentRequest;
  media: MediaCollector;
  /** Null = no images at all. */
  imageSource: ImageSource | null;
  generator: string;
  engine?: ContentEngine;
  now?: Date;
  onProgress?: (done: number, total: number, title: string) => void;
}

export interface GenerateNicResult {
  content: NicContent;
  counts: Partial<Record<NicType, number>>;
  warnings: string[];
}

/** Default crop ratios (w/h) when a seed gives no image_size. */
const DEFAULT_RATIO: Record<NicType, number> = {
  post: 1.5,
  team: 0.76,
  portfolio: 0.75,
  testimonial: 1,
  service: 1.5,
  product: 1,
};
const GALLERY_EXTRA: Partial<Record<NicType, number>> = { portfolio: 2, product: 2 };

interface Planned {
  seed?: NicSeed;
  title: string;
  key: string;
}

export async function generateNicContent(
  options: GenerateNicOptions
): Promise<GenerateNicResult> {
  const { request, media, imageSource } = options;
  const engine = options.engine ?? new TemplateContentEngine();
  const now = options.now ?? new Date();
  const warnings: string[] = [];
  const topic = request.site.topic;
  const profile = profileTopic(topic);
  const rootSeed = hashString(`${request.theme}|${topic}`);

  if (request.site.language && !/^en(\b|[-_])/i.test(request.site.language)) {
    warnings.push(
      `site.language "${request.site.language}" is not supported by the built-in prose engine; the demo text is English`
    );
  }

  const requested = NIC_TYPES.filter((type) => request.types[type]);
  const terms = buildTerms(requested, request, profile, rootSeed);
  const total = requested.reduce(
    (n, type) =>
      n + Math.max(request.types[type]!.count, request.types[type]!.seeds?.length ?? 0),
    0
  );
  let done = 0;

  const items: NicContent['items'] = {};
  const counts: GenerateNicResult['counts'] = {};

  for (const type of requested) {
    const spec = request.types[type]!;
    const seeds = spec.seeds ?? [];
    if (seeds.length > spec.count) {
      warnings.push(
        `types.${type}: ${seeds.length} seeds exceed count ${spec.count}; all seeds are kept and nothing extra is generated`
      );
    }
    const typeSeed = hashString(`${rootSeed}:${type}`);
    const random = seededRandom(typeSeed);
    const planned = await planItems(
      type,
      spec.count,
      seeds,
      topic,
      profile,
      engine,
      typeSeed,
      random
    );

    const list: NicItem[] = [];
    for (const [index, plan] of planned.entries()) {
      options.onProgress?.(done++, total, plan.title);
      const item = await buildItem({
        type,
        index,
        count: planned.length,
        plan,
        request,
        profile,
        engine,
        media,
        imageSource,
        terms,
        now,
        itemSeed: hashString(`${typeSeed}:${plan.key}`),
        warnings,
      });
      list.push(item);
    }

    // The sku space belongs to the whole product list.
    if (type === 'product') assignSkus(list, request.theme);
    if (list.length > 0) items[type] = list;
    counts[type] = list.length;
  }
  options.onProgress?.(total, total, 'done');

  warnings.push(...media.warnings);

  const usedTerms: NicContent['terms'] = {};
  for (const [taxonomy, list] of Object.entries(terms) as Array<
    [NicTaxonomy, NicTerm[]]
  >) {
    if (list.length > 0) usedTerms[taxonomy] = list;
  }

  return {
    content: {
      format: 'nic-content/1',
      generator: options.generator,
      theme: request.theme,
      ...(Object.keys(usedTerms).length ? { terms: usedTerms } : {}),
      items,
    },
    counts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Planning: seeds first, then generated extras
// ---------------------------------------------------------------------------

async function planItems(
  type: NicType,
  count: number,
  seeds: NicSeed[],
  topic: string,
  profile: TopicProfile,
  engine: ContentEngine,
  typeSeed: number,
  random: () => number
): Promise<Planned[]> {
  const planned: Planned[] = seeds.map((seed) => ({
    seed,
    title: seed.title,
    key: seed.key,
  }));
  const extras = Math.max(0, count - seeds.length);
  if (extras === 0) return planned;

  const takenTitles = new Set(seeds.map((s) => s.title.toLowerCase()));
  const takenKeys = new Set(seeds.map((s) => s.key));

  let titles: string[];
  if (type === 'post') {
    // Over-ask: a generated headline may collide with a seed's title.
    titles = await engine.generateTitles(topic, extras + seeds.length + 2, typeSeed);
  } else {
    titles = vocabTitles(type, extras + seeds.length + 2, profile, random);
  }

  for (const title of titles) {
    if (planned.length - seeds.length >= extras) break;
    const clean = title.trim().slice(0, 200);
    if (!clean || takenTitles.has(clean.toLowerCase())) continue;
    const key = uniqueKey(slugify(clean) || `${type}-${planned.length + 1}`, takenKeys);
    takenTitles.add(clean.toLowerCase());
    planned.push({ title: clean, key });
  }
  // Defensive: numbered fill if the vocabulary ran dry.
  while (planned.length - seeds.length < extras) {
    const n = planned.length + 1;
    const title = `${capitalize(type)} ${n}`;
    planned.push({ title, key: uniqueKey(slugify(title), takenKeys) });
  }
  return planned;
}

function vocabTitles(
  type: NicType,
  n: number,
  profile: TopicProfile,
  random: () => number
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (title: string): void => {
    if (!seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  };
  const shuffled = <T>(arr: readonly T[]): T[] =>
    [...arr]
      .map((v) => [random(), v] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);

  switch (type) {
    case 'team':
    case 'testimonial': {
      const firsts = shuffled(V.FIRST_NAMES);
      const lasts = shuffled(V.LAST_NAMES);
      for (let i = 0; out.length < n && i < n * 4; i++) {
        const first = firsts[i % firsts.length]!;
        const last = lasts[(i * 7 + Math.floor(i / firsts.length)) % lasts.length]!;
        push(type === 'team' ? `${first} ${last}` : `${first} ${last.charAt(0)}.`);
      }
      break;
    }
    case 'portfolio': {
      const adjectives = shuffled(V.PROJECT_ADJECTIVES);
      const nouns = shuffled(V.PROJECT_NOUNS);
      for (let i = 0; out.length < n && i < n * 4; i++) {
        push(
          `${adjectives[i % adjectives.length]!} ${nouns[Math.floor(i / adjectives.length) % nouns.length]!}`
        );
      }
      break;
    }
    case 'service':
      for (const title of shuffled(V.SERVICE_TITLES)) push(title);
      break;
    case 'product': {
      const adjectives = shuffled(V.PRODUCT_ADJECTIVES);
      const nouns = shuffled(V.PRODUCT_NOUNS);
      const subject = capitalize(profile.terms[0] ?? profile.subject);
      for (let i = 0; out.length < n && i < n * 4; i++) {
        push(
          `${adjectives[i % adjectives.length]!} ${subject} ${nouns[Math.floor(i / adjectives.length) % nouns.length]!}`
        );
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

interface BuildArgs {
  type: NicType;
  index: number;
  count: number;
  plan: Planned;
  request: NicContentRequest;
  profile: TopicProfile;
  engine: ContentEngine;
  media: MediaCollector;
  imageSource: ImageSource | null;
  terms: Partial<Record<NicTaxonomy, NicTerm[]>>;
  now: Date;
  itemSeed: number;
  warnings: string[];
}

async function buildItem(a: BuildArgs): Promise<NicItem> {
  const { type, plan, index, profile, engine, itemSeed } = a;
  const seed = plan.seed;
  const random = seededRandom(itemSeed);
  const topic = a.request.site.topic;

  const item: NicItem = { key: plan.key, title: plan.title };

  // --- images first: a post's body needs the body image's path ---------------
  let bodyImage: string | undefined;
  if (a.imageSource) {
    const ratio = ratioFor(type, seed);
    const extra = GALLERY_EXTRA[type] ?? 0;
    // A seed's own body is kept verbatim, so a body image would go unreferenced.
    const wantBody = type === 'post' && nonEmpty(seed?.content) === undefined ? 1 : 0;
    const refs = await safeFetch(
      a,
      {
        query: imageQuery(type, plan.title, profile),
        aspectRatio: ratio,
        minWidth: widthFor(seed),
        role: 'feature',
      },
      1 + extra + wantBody
    );

    const [main, ...rest] = refs;
    if (main) item.image = (await a.media.add(main, `${type}-${plan.key}`)) ?? undefined;
    if (!main) a.media.skipped += 1;

    const galleryRefs = rest.slice(0, extra);
    if (galleryRefs.length > 0) {
      const paths: string[] = [];
      for (const [i, ref] of galleryRefs.entries()) {
        const added = await a.media.add(ref, `${type}-${plan.key}-${i + 2}`);
        if (added && added !== item.image && !paths.includes(added)) paths.push(added);
      }
      if (paths.length > 0) item.gallery = paths;
    }
    if (wantBody && rest[0])
      bodyImage = await a.media.add(rest[0], `${type}-${plan.key}-body`);
  }

  // --- text ------------------------------------------------------------------
  const seedContent = nonEmpty(seed?.content);
  if (seedContent !== undefined) {
    item.content = seedContent;
  } else {
    item.content = await generateContent(a, topic, bodyImage);
  }

  const seedExcerpt = nonEmpty(seed?.excerpt);
  if (seedExcerpt !== undefined) {
    item.excerpt = seedExcerpt;
  } else if (
    type === 'post' ||
    type === 'portfolio' ||
    type === 'service' ||
    type === 'product'
  ) {
    item.excerpt = clampExcerpt(
      await engine.generateExcerpt(plan.title, topic, itemSeed)
    );
  }

  // --- dates, order ----------------------------------------------------------
  if (type === 'post' || type === 'product')
    item.date = pastDate(a.now, index, a.count, random);
  item.menu_order = index;

  // --- meta ------------------------------------------------------------------
  const meta = buildMeta(a, random);
  if (Object.keys(meta).length > 0) item.meta = meta;

  // --- terms -----------------------------------------------------------------
  const itemTerms = assignTerms(type, a.terms, index, random);
  if (itemTerms) item.terms = itemTerms;

  if (type === 'product') item.product = buildProduct(index, random);

  return item;
}

async function safeFetch(
  a: BuildArgs,
  request: Parameters<ImageSource['fetch']>[0],
  count: number
): Promise<ImageRef[]> {
  try {
    return await a.imageSource!.fetch(request, count);
  } catch (err) {
    a.warnings.push(
      `image lookup for "${request.query}" failed (${err instanceof Error ? err.message : String(err)}); the item imports without images`
    );
    return [];
  }
}

function ratioFor(type: NicType, seed: NicSeed | undefined): number {
  const size = seed?.image_size;
  if (size && size[0] > 0 && size[1] > 0) return size[0] / size[1];
  return DEFAULT_RATIO[type];
}

/**
 * 1.5x the hinted width stays sharp on retina without blowing the 500 KB
 * per-file budget, which large generated PNGs hit quickly.
 */
function widthFor(seed: NicSeed | undefined): number {
  const hinted = seed?.image_size?.[0];
  return Math.min(1000, Math.max(600, hinted ? Math.round(hinted * 1.5) : 900));
}

function imageQuery(type: NicType, title: string, profile: TopicProfile): string {
  switch (type) {
    case 'team':
    case 'testimonial':
      return `portrait of ${title}`;
    case 'product':
      return `${title} product photo`;
    case 'post':
      return title;
    default:
      return `${title} ${profile.subject}`;
  }
}

// ---------------------------------------------------------------------------
// Content bodies
// ---------------------------------------------------------------------------

async function generateContent(
  a: BuildArgs,
  topic: string,
  bodyImage: string | undefined
): Promise<string> {
  const { type, plan, engine, itemSeed, profile } = a;
  const textual = (blocks: ContentBlock[]): ContentBlock[] =>
    blocks.filter((b) => ['paragraph', 'heading', 'list', 'quote'].includes(b.type));

  if (type === 'testimonial') {
    const random = seededRandom(itemSeed);
    const quote =
      V.TESTIMONIAL_QUOTES[Math.floor(random() * V.TESTIMONIAL_QUOTES.length)]!;
    return `<p>${escapeHtml(quote.replace('{subject}', profile.subject))}</p>`;
  }

  const words = { post: 450, team: 60, portfolio: 130, service: 90, product: 120 }[type];
  const blocks = textual(
    await engine.generateBody({
      title: plan.title,
      topic,
      targetWords: words,
      seed: itemSeed,
    })
  );

  if (type === 'post') {
    if (bodyImage) {
      // After the first paragraph: the same place the Ghost/WordPress exports put theirs.
      const at = blocks.findIndex((b) => b.type === 'paragraph') + 1;
      const image: ContentBlock = {
        type: 'image',
        image: { kind: 'file', location: bodyImage, alt: plan.title },
        alt: plan.title,
      };
      blocks.splice(Math.max(1, at), 0, image);
    }
    return blocksToGutenberg(blocks, (ref) => ({
      url: ref.location,
      ...(ref.alt ? { alt: ref.alt } : {}),
    }));
  }
  return blocksToHtml(blocks);
}

function blocksToHtml(blocks: ContentBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph') out.push(`<p>${escapeHtml(block.text)}</p>`);
    else if (block.type === 'heading') out.push(`<h3>${escapeHtml(block.text)}</h3>`);
    else if (block.type === 'quote')
      out.push(`<blockquote><p>${escapeHtml(block.text)}</p></blockquote>`);
    else if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`
      );
    }
  }
  return out.length > 0 ? out.join('\n') : '<p></p>';
}

function clampExcerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 300) return clean;
  const cut = clean.slice(0, 299);
  const space = cut.lastIndexOf(' ');
  return `${(space > 200 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Meta, terms, product, dates
// ---------------------------------------------------------------------------

function buildMeta(a: BuildArgs, random: () => number): Record<string, string> {
  const { type, plan } = a;
  const allowed = META_KEYS[type];
  const meta: Record<string, string> = {};

  // Seed meta wins, byte for byte — but only keys the contract knows.
  for (const [key, value] of Object.entries(plan.seed?.meta ?? {})) {
    if (!allowed.includes(key)) {
      a.warnings.push(
        `types.${type} seed "${plan.key}": meta key "${key}" is not part of the contract and was dropped`
      );
      continue;
    }
    if (value !== '') meta[key] = value;
  }

  const fill = (key: string, make: () => string): void => {
    if (allowed.includes(key) && meta[key] === undefined) meta[key] = make();
  };
  const year = a.now.getUTCFullYear();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  switch (type) {
    case 'team':
      fill('nic_role', () => pick(V.ROLES));
      break;
    case 'portfolio':
      fill('nic_client', () => pick(V.COMPANIES));
      fill('nic_year', () => String(year - Math.floor(random() * 4)));
      break;
    case 'testimonial':
      fill('nic_company', () => pick(V.COMPANIES));
      fill('nic_rating', () => (random() < 0.8 ? '5' : '4'));
      break;
    case 'service':
      fill('nic_icon', () => V.SERVICE_ICONS[a.index % V.SERVICE_ICONS.length]!);
      break;
    default:
      break;
  }
  return meta;
}

function buildTerms(
  requested: NicType[],
  request: NicContentRequest,
  profile: TopicProfile,
  rootSeed: number
): Partial<Record<NicTaxonomy, NicTerm[]>> {
  const random = seededRandom(rootSeed ^ 0x9e3779b1);
  const make = (names: readonly string[], n: number, prefix?: string): NicTerm[] => {
    const chosen = [...names]
      .map((v) => [random(), v] as const)
      .sort((x, y) => x[0] - y[0])
      .slice(0, n)
      .map(([, v]) => v);
    const seen = new Set<string>();
    const out: NicTerm[] = [];
    for (const name of chosen) {
      const key = slugify(prefix ? `${prefix} ${name}` : name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, name });
    }
    return out;
  };
  const size = (type: NicType, min: number, max: number): number =>
    Math.min(
      max,
      Math.max(
        min,
        Math.ceil(
          Math.max(
            request.types[type]?.count ?? 0,
            request.types[type]?.seeds?.length ?? 0
          ) / 2
        )
      )
    );

  const terms: Partial<Record<NicTaxonomy, NicTerm[]>> = {};
  if (requested.includes('post')) {
    terms.category = make(CATEGORIES(profile), size('post', 3, 5));
    terms.post_tag = make(V.TAG_NAMES, size('post', 4, 6));
  }
  if (requested.includes('portfolio')) {
    terms.nic_portfolio_category = make(
      V.PORTFOLIO_CATEGORY_NAMES,
      size('portfolio', 2, 4)
    );
  }
  if (requested.includes('product')) {
    terms.product_cat = make(V.PRODUCT_CATEGORY_NAMES, size('product', 2, 4));
    terms.product_tag = make(V.PRODUCT_TAG_NAMES, 3);
  }
  return terms;
}

function CATEGORIES(profile: TopicProfile): readonly string[] {
  // One category named for the publication's own subject, the rest generic.
  const subject = capitalize(profile.terms[0] ?? profile.subject);
  return [`${subject} tips`, ...V.CATEGORY_NAMES];
}

function assignTerms(
  type: NicType,
  terms: Partial<Record<NicTaxonomy, NicTerm[]>>,
  index: number,
  random: () => number
): NicItem['terms'] | undefined {
  const out: NonNullable<NicItem['terms']> = {};
  const one = (taxonomy: NicTaxonomy): string[] => {
    const list = terms[taxonomy] ?? [];
    return list.length ? [list[index % list.length]!.key] : [];
  };
  const some = (taxonomy: NicTaxonomy, max: number): string[] => {
    const list = terms[taxonomy] ?? [];
    if (!list.length) return [];
    const n = 1 + Math.floor(random() * Math.min(max, list.length));
    const start = Math.floor(random() * list.length);
    return [
      ...new Set(
        Array.from({ length: n }, (_, i) => list[(start + i) % list.length]!.key)
      ),
    ];
  };
  if (type === 'post') {
    out.category = one('category');
    out.post_tag = some('post_tag', 2);
  } else if (type === 'portfolio') {
    out.nic_portfolio_category = one('nic_portfolio_category');
  } else if (type === 'product') {
    out.product_cat = one('product_cat');
    if (random() < 0.5) out.product_tag = some('product_tag', 1);
  }
  const cleaned = Object.fromEntries(Object.entries(out).filter(([, v]) => v.length > 0));
  return Object.keys(cleaned).length ? (cleaned as NicItem['terms']) : undefined;
}

function buildProduct(
  index: number,
  random: () => number
): NonNullable<NicItem['product']> {
  const base = V.BASE_PRICES[Math.floor(random() * V.BASE_PRICES.length)]!;
  const onSale = index % 3 === 1;
  return {
    type: 'simple',
    regular_price: base.toFixed(2),
    // 20% off is always strictly below the regular price for any price above zero.
    sale_price: onSale ? (base * 0.8).toFixed(2) : '',
    sku: '', // assigned once the whole list exists, so uniqueness is checkable
    stock_status: index % 7 === 6 ? 'outofstock' : 'instock',
    featured: index < 2,
  };
}

function assignSkus(items: NicItem[], theme: string): void {
  const prefix =
    theme
      .split('-')
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase())
      .join('')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4) || 'NIC';
  const used = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (!item.product) continue;
    const code =
      item.title
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .slice(0, 4) || 'ITM';
    let n = i + 1;
    let sku = `${prefix}-${code}-${String(n).padStart(3, '0')}`;
    while (used.has(sku)) sku = `${prefix}-${code}-${String(++n).padStart(3, '0')}`;
    used.add(sku);
    item.product.sku = sku;
  }
}

/** Newest first; every date is at least two days before `now`. */
function pastDate(now: Date, index: number, count: number, random: () => number): string {
  const spread = Math.floor((index * 90) / Math.max(count, 1));
  const days = 2 + spread + Math.floor(random() * 3);
  const when = new Date(now.getTime() - days * 86_400_000);
  const hour = 8 + Math.floor(random() * 10);
  const minute = [0, 15, 30, 45][Math.floor(random() * 4)]!;
  when.setUTCHours(hour, minute, 0, 0);
  return when.toISOString().slice(0, 19);
}

// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}

function uniqueKey(base: string, taken: Set<string>): string {
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 96)}-${n}`;
  taken.add(key);
  return key;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
