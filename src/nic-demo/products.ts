/**
 * Product style: how generated extra products imitate the request's own seeds.
 *
 * A WooCommerce-backed theme is designed around its products' shape (a
 * "Route" attribute with day steps, a "Duration" like "6 days", a price in
 * whole dollars). Seeds carry that shape; extras read it back and reproduce it
 * instead of inventing a generic catalogue.
 */

import type { NicProductBlock, NicSeed } from './types.js';
import * as V from './vocab.js';

type Random = () => number;
type Attribute = NonNullable<NicProductBlock['attributes']>[number];

export interface Destination {
  place: string;
  country: string;
  stops: readonly string[];
}

interface AttrStyle {
  name: string;
  kind: 'route' | 'unit' | 'list' | 'single';
  samples: string[][];
}

export interface ProductStyle {
  min: number;
  max: number;
  /** Seed prices carry decimals ("49.90") rather than whole numbers ("2890"). */
  decimals: boolean;
  anySale: boolean;
  badges: string[];
  badgeRatio: number;
  rating?: [number, number];
  reviews?: [number, number];
  attrs: AttrStyle[];
}

export function isTravelTopic(topic: string): boolean {
  return /\b(travel|trip|tour|tours|holiday|holidays|vacation|journey|destination|destinations|itinerar\w*|cruise|getaway|resort|voyage|expedition)\b/i.test(
    topic
  );
}

// ---------------------------------------------------------------------------
// Reading the seeds
// ---------------------------------------------------------------------------

export function deriveStyle(seeds: NicSeed[]): ProductStyle | undefined {
  const blocks = seeds.map((s) => s.product).filter((p) => p !== undefined);
  if (blocks.length === 0) return undefined;

  const prices = blocks.map((b) => Number(b.regular_price ?? '')).filter((n) => n > 0);
  const [min, max] = prices.length
    ? [Math.min(...prices), Math.max(...prices)]
    : [V.BASE_PRICES[0] as number, V.BASE_PRICES[V.BASE_PRICES.length - 1] as number];

  const badges = blocks.map((b) => b.badge).filter((b): b is string => !!b);
  const ratings = blocks.filter((b) => b.rating).map((b) => Number(b.rating));
  const reviews = blocks.filter((b) => b.review_count).map((b) => Number(b.review_count));

  // Attribute names present on at least half of the blocks that have any.
  const withAttrs = blocks.filter((b) => (b.attributes?.length ?? 0) > 0);
  const byName = new Map<string, string[][]>();
  for (const block of withAttrs) {
    for (const attr of block.attributes ?? []) {
      const list = byName.get(attr.name) ?? [];
      list.push(attr.values);
      byName.set(attr.name, list);
    }
  }
  const attrs: AttrStyle[] = [];
  for (const [name, samples] of byName) {
    if (samples.length * 2 < withAttrs.length) continue;
    attrs.push({ name, kind: classify(samples), samples });
  }

  return {
    min,
    max,
    decimals: blocks.some((b) => /\./.test(b.regular_price ?? '')),
    anySale: blocks.some((b) => !!b.sale_price),
    badges: [...new Set(badges)],
    badgeRatio: badges.length / blocks.length,
    ...(ratings.length ? { rating: [Math.min(...ratings), Math.max(...ratings)] } : {}),
    ...(reviews.length ? { reviews: [Math.min(...reviews), Math.max(...reviews)] } : {}),
    attrs,
  };
}

const STEP = /^(\D*?)(\d+)(?:\s*\|\s*(.*))?$/;

function classify(samples: string[][]): AttrStyle['kind'] {
  const all = samples.flat();
  if (
    all.every((v) => STEP.test(v)) &&
    all.some((v) => v.includes('|')) &&
    all.length > 1
  )
    return 'route';
  if (
    samples.every((s) => s.length === 1) &&
    all.every((v) => /^\d+(\.\d+)?\s+\S.*$/.test(v))
  )
    return 'unit';
  if (samples.some((s) => s.length > 1)) return 'list';
  return 'single';
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

function roundNice(value: number): number {
  const step = value >= 1000 ? 50 : value >= 200 ? 10 : value >= 50 ? 5 : 1;
  return Math.max(step, Math.round(value / step) * step);
}

function money(style: ProductStyle, value: number): string {
  return style.decimals ? value.toFixed(2) : String(value);
}

const pick = <T>(random: Random, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)]!;

function shuffled<T>(random: Random, list: readonly T[]): T[] {
  return [...list]
    .map((v) => [random(), v] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

function between(random: Random, lo: number, hi: number): number {
  return lo + random() * (hi - lo);
}

export interface StyledContext {
  index: number;
  dest?: Destination;
}

/** Price, sale, badge, rating, reviews and attributes in the seeds' style. */
export function styledFields(
  style: ProductStyle,
  random: Random,
  ctx: StyledContext
): Omit<NicProductBlock, 'sku' | 'stock_status' | 'featured'> {
  const price = roundNice(between(random, style.min * 0.75, style.max * 1.25));
  let sale = '';
  if (style.anySale && ctx.index % 3 === 1) {
    let cut = roundNice(price * 0.85);
    if (cut >= price) cut = Math.max(1, price - 1);
    sale = money(style, cut);
  }

  const out: Omit<NicProductBlock, 'sku' | 'stock_status' | 'featured'> = {
    type: 'simple',
    regular_price: money(style, price),
    sale_price: sale,
  };

  if (style.badges.length > 0 && random() < style.badgeRatio) {
    out.badge = pick(random, style.badges);
  }
  if (style.rating) {
    const [lo, hi] = style.rating;
    out.rating = Math.min(5, Math.max(0, between(random, lo, hi))).toFixed(1);
  }
  if (style.reviews) {
    const [lo, hi] = style.reviews;
    out.review_count = String(
      Math.max(1, Math.round(between(random, lo * 0.7, Math.max(hi, lo + 1) * 1.2)))
    );
  }
  if (style.attrs.length > 0) out.attributes = styledAttributes(style, random, ctx);
  return out;
}

function styledAttributes(
  style: ProductStyle,
  random: Random,
  ctx: StyledContext
): Attribute[] {
  // Duration first, so a route can end on the same day.
  let days: number | undefined;
  const durations = new Map<string, string>();
  for (const attr of style.attrs) {
    if (attr.kind !== 'unit') continue;
    const value = unitValue(attr, random);
    durations.set(attr.name, value);
    const match = /^(\d+)\s+(day|night)/i.exec(value);
    if (match && days === undefined) days = Number(match[1]);
  }

  const labels = [
    ...new Set(style.attrs.flatMap((a) => (a.kind === 'route' ? routeLabels(a) : []))),
  ];
  return style.attrs.map((attr): Attribute => {
    switch (attr.kind) {
      case 'unit':
        return { name: attr.name, values: [durations.get(attr.name)!] };
      case 'route':
        return {
          name: attr.name,
          values: routeValue(attr, random, days, ctx.dest, labels),
        };
      case 'list':
        return { name: attr.name, values: listValue(attr, random) };
      default: {
        if (ctx.dest && /location|destination|country|where/i.test(attr.name)) {
          return { name: attr.name, values: [ctx.dest.country] };
        }
        return { name: attr.name, values: [pick(random, attr.samples.flat())] };
      }
    }
  });
}

function unitValue(attr: AttrStyle, random: Random): string {
  const parsed = attr.samples.map((s) => /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(s[0]!)!);
  const nums = parsed.map((m) => Number(m[1]));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const n = Math.round(between(random, lo, hi));
  return `${n} ${pick(random, parsed)[2]!}`;
}

function listValue(attr: AttrStyle, random: Random): string[] {
  const pool = [...new Set(attr.samples.flat())];
  const sizes = attr.samples.map((s) => s.length);
  const n = Math.min(
    pool.length,
    Math.round(between(random, Math.min(...sizes), Math.max(...sizes)))
  );
  const chosen = new Set(shuffled(random, pool).slice(0, Math.max(1, n)));
  return pool.filter((v) => chosen.has(v));
}

function routeLabels(attr: AttrStyle): string[] {
  return attr.samples.flat().flatMap((v) => {
    const label = STEP.exec(v)?.[3];
    return label ? [label.trim()] : [];
  });
}

function routeValue(
  attr: AttrStyle,
  random: Random,
  days: number | undefined,
  dest: Destination | undefined,
  labelPool: string[]
): string[] {
  const template = pick(random, attr.samples).map((v) => {
    const m = STEP.exec(v)!;
    return { prefix: m[1] ?? '', day: Number(m[2]), label: m[3]?.trim() };
  });
  const first = template[0]!.day;
  const lastTemplate = template[template.length - 1]!.day;
  const last = days && days > first ? days : lastTemplate;
  const span = Math.max(1, lastTemplate - first);

  const stops = dest
    ? [...dest.stops]
    : shuffled(random, labelPool.length ? labelPool : ['Arrival']);
  let nextStop = 0;
  let prev = first - 1;
  return template.map((step, i) => {
    let day =
      i === 0 ? first : Math.round(first + ((step.day - first) * (last - first)) / span);
    day = Math.max(day, prev + 1);
    prev = day;
    const label = step.label === undefined ? undefined : stops[nextStop++ % stops.length];
    return label ? `${step.prefix}${day} | ${label}` : `${step.prefix}${day}`;
  });
}

// ---------------------------------------------------------------------------
// Topic-aware titles
// ---------------------------------------------------------------------------

export interface TitledPlan {
  title: string;
  dest?: Destination;
}

/** Travel package names: "Santorini Sunset Escape". Deterministic for a random. */
export function travelTitles(n: number, random: Random): TitledPlan[] {
  const out: TitledPlan[] = [];
  const places = shuffled(random, V.DESTINATIONS);
  const experiences = shuffled(random, V.TRAVEL_EXPERIENCES);
  for (let i = 0; out.length < n; i++) {
    const dest = places[i % places.length]!;
    const round = Math.floor(i / places.length);
    const exp = experiences[(i + round) % experiences.length]!;
    const flavour =
      round === 0 ? '' : `${V.TRAVEL_FLAVOURS[(i + round) % V.TRAVEL_FLAVOURS.length]!} `;
    out.push({ title: `${flavour}${dest.place} ${exp}`, dest });
  }
  return out;
}
