/**
 * Everything the JSON schema cannot say about a nic-content/1 package:
 * cross references, uniqueness, media limits and credit coverage.
 *
 * The exporter runs this on its own output before writing a byte, and the same
 * function is how the tests prove the committed mcphub fixture is valid — so
 * "what ThemeSeed writes" and "what NIC Core's fixture looks like" are judged
 * by one implementation.
 */

import { probeImage } from '../images/inspect.js';
import { validateContentSchema } from './schema.js';
import {
  MEDIA_LIMITS,
  NIC_TYPES,
  TYPE_TAXONOMIES,
  type MediaFile,
  type NicContent,
  type NicCredits,
  type NicItem,
  type NicTaxonomy,
} from './types.js';

export interface ValidateOptions {
  /** Files that will sit in `content-media/`. Omit to skip media checks. */
  media?: MediaFile[];
  /** Credits that will be written. Omit to skip coverage checks. */
  credits?: NicCredits;
  /** "Now" for the in-the-past date rule. Defaults to the current time. */
  now?: Date;
}

const MEDIA_PREFIX = 'content-media/';

/** Returns problems; an empty array means the package is valid. */
export function validateNicContent(
  content: unknown,
  options: ValidateOptions = {}
): string[] {
  const schemaProblems = validateContentSchema(content);
  // Cross checks assume a schema-valid shape; running them on garbage only
  // produces a second, misleading list.
  if (schemaProblems.length > 0) return schemaProblems.map((p) => `schema ${p}`);

  const doc = content as NicContent;
  const problems: string[] = [];
  const now = options.now ?? new Date();

  // --- terms ----------------------------------------------------------------
  const termKeys = new Map<NicTaxonomy, Set<string>>();
  for (const [taxonomy, list] of Object.entries(doc.terms ?? {}) as Array<
    [NicTaxonomy, Array<{ key: string }>]
  >) {
    const seen = new Set<string>();
    for (const term of list) {
      if (seen.has(term.key))
        problems.push(`terms.${taxonomy}: duplicate key "${term.key}"`);
      seen.add(term.key);
    }
    termKeys.set(taxonomy, seen);
  }

  // --- items ----------------------------------------------------------------
  const referencedMedia = new Set<string>();
  const skus = new Set<string>();

  for (const type of NIC_TYPES) {
    const items = doc.items[type] ?? [];
    const keys = new Set<string>();
    for (const item of items) {
      const at = `items.${type}[${item.key}]`;
      if (keys.has(item.key)) problems.push(`${at}: duplicate key within type "${type}"`);
      keys.add(item.key);

      if (item.date !== undefined && !isPast(item.date, now)) {
        problems.push(`${at}: date ${item.date} is not in the past`);
      }

      for (const [taxonomy, refs] of Object.entries(item.terms ?? {}) as Array<
        [NicTaxonomy, string[]]
      >) {
        if (!TYPE_TAXONOMIES[type].includes(taxonomy)) {
          problems.push(`${at}: taxonomy "${taxonomy}" is not allowed on ${type}`);
        }
        for (const ref of refs) {
          if (!termKeys.get(taxonomy)?.has(ref)) {
            problems.push(`${at}: term "${ref}" is not defined under terms.${taxonomy}`);
          }
        }
      }

      if (item.image) referencedMedia.add(item.image);
      for (const g of item.gallery ?? []) referencedMedia.add(g);
      for (const body of bodyMediaRefs(item)) referencedMedia.add(body);
      problems.push(...contentProblems(at, item));

      if (type === 'product') problems.push(...productProblems(at, item, skus));
    }
  }

  // --- media ----------------------------------------------------------------
  if (options.media) {
    const present = new Map(
      options.media.map((file) => [`${MEDIA_PREFIX}${file.name}`, file])
    );
    let total = 0;
    for (const [ref, file] of present) {
      total += file.bytes.byteLength;
      if (!MEDIA_LIMITS.namePattern.test(file.name)) {
        problems.push(`${ref}: file name must match ${MEDIA_LIMITS.namePattern}`);
      }
      if (file.bytes.byteLength > MEDIA_LIMITS.maxFileBytes) {
        problems.push(
          `${ref}: ${Math.ceil(file.bytes.byteLength / 1024)} KB exceeds the ${MEDIA_LIMITS.maxFileBytes / 1024} KB per-file limit`
        );
      }
      const info = probeImage(file.bytes);
      if (!info || !['png', 'jpeg', 'webp'].includes(info.format)) {
        problems.push(`${ref}: not a readable jpg, png or webp image`);
      } else if (Math.max(info.width, info.height) > MEDIA_LIMITS.maxLongEdge) {
        problems.push(
          `${ref}: ${info.width}x${info.height} exceeds ${MEDIA_LIMITS.maxLongEdge}px on the long edge`
        );
      }
    }
    if (total > MEDIA_LIMITS.maxTotalBytes) {
      problems.push(
        `content-media/: ${(total / 1048576).toFixed(1)} MB exceeds the ${MEDIA_LIMITS.maxTotalBytes / 1048576} MB folder limit`
      );
    }
    for (const ref of referencedMedia) {
      if (!present.has(ref))
        problems.push(`${ref}: referenced but missing from content-media/`);
    }
    for (const ref of present.keys()) {
      if (!referencedMedia.has(ref))
        problems.push(`${ref}: in content-media/ but never referenced`);
    }

    if (options.credits) {
      problems.push(...creditProblems(options.credits, [...present.keys()]));
    }
  }

  return problems;
}

function creditProblems(credits: NicCredits, mediaRefs: string[]): string[] {
  const problems: string[] = [];
  const covered = new Map<string, number>();
  for (const asset of credits.assets) {
    covered.set(asset.path, (covered.get(asset.path) ?? 0) + 1);
    if (!asset.license || !asset.source || !asset.author) {
      problems.push(`credits: ${asset.path} needs license, source and author`);
    }
  }
  for (const ref of mediaRefs) {
    const expected = `demo/${ref}`;
    const count = covered.get(expected) ?? 0;
    if (count === 0) problems.push(`credits: no entry for ${expected}`);
    if (count > 1)
      problems.push(`credits: ${expected} has ${count} entries, expected one`);
  }
  const known = new Set(mediaRefs.map((ref) => `demo/${ref}`));
  for (const path of covered.keys()) {
    if (!known.has(path))
      problems.push(`credits: ${path} does not match any file in content-media/`);
  }
  return problems;
}

function productProblems(at: string, item: NicItem, skus: Set<string>): string[] {
  const problems: string[] = [];
  const product = item.product;
  if (!product) return [`${at}: missing product block`];
  const regular = Number(product.regular_price);
  if (!(regular > 0)) problems.push(`${at}: regular_price must be greater than zero`);
  if (product.sale_price !== undefined && product.sale_price !== '') {
    if (!(Number(product.sale_price) < regular)) {
      problems.push(`${at}: sale_price must be lower than regular_price`);
    }
  }
  if (product.rating !== undefined && Number(product.rating) > 5) {
    problems.push(`${at}: rating must be between 0 and 5`);
  }
  const attrSlugs = new Set<string>();
  for (const attr of product.attributes ?? []) {
    const slug = attr.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    if (attrSlugs.has(slug)) problems.push(`${at}: duplicate attribute "${attr.name}"`);
    attrSlugs.add(slug);
  }
  if (skus.has(product.sku)) problems.push(`${at}: duplicate sku "${product.sku}"`);
  skus.add(product.sku);
  return problems;
}

/** `wp_kses_post` strips scripts, and a remote <img> is invalid in nic-content/1. */
function contentProblems(at: string, item: NicItem): string[] {
  const html = item.content ?? '';
  const problems: string[] = [];
  if (/<script\b/i.test(html)) problems.push(`${at}: content must not contain <script>`);
  for (const match of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = match[1]!;
    if (!src.startsWith(MEDIA_PREFIX)) {
      problems.push(`${at}: body image "${src}" must be a content-media/ path`);
    }
  }
  return problems;
}

function bodyMediaRefs(item: NicItem): string[] {
  const refs: string[] = [];
  for (const match of (item.content ?? '').matchAll(
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  )) {
    if (match[1]!.startsWith(MEDIA_PREFIX)) refs.push(match[1]!);
  }
  return refs;
}

function isPast(date: string, now: Date): boolean {
  // The contract date is local site time with no zone; compare it as if UTC.
  // A day of slack either way cannot flip a date generated days in the past.
  const parsed = Date.parse(`${date}Z`);
  return Number.isFinite(parsed) && parsed < now.getTime();
}
