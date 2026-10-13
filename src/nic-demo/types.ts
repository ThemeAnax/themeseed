/**
 * Shapes of the nic-demo contract (docs/superpowers/specs/2026-10-13-demo-content-contract.md).
 *
 * Hand-written rather than generated from the schemas: the schemas are the
 * authority and are enforced at runtime by `schema.ts`; these types exist so
 * the generator is checked by the compiler.
 */

export const NIC_TYPES = [
  'post',
  'team',
  'portfolio',
  'testimonial',
  'service',
  'product',
] as const;
export type NicType = (typeof NIC_TYPES)[number];

export type NicTarget = 'themeforest' | 'wordpress.org' | 'client' | 'private';
export type NicImageSource = 'auto' | 'local' | 'ai' | 'stock' | 'none';

export interface NicSeed {
  key: string;
  title: string;
  content?: string;
  excerpt?: string;
  meta?: Record<string, string>;
  image_size?: [number, number];
}

export interface NicContentRequest {
  format: 'nic-content-request/1';
  theme: string;
  target: NicTarget;
  site: { name: string; topic: string; language?: string; tone?: string };
  images?: { source?: NicImageSource };
  types: Partial<Record<NicType, { count: number; seeds?: NicSeed[] }>>;
}

export interface NicTerm {
  key: string;
  name: string;
  description?: string;
}

export type NicTaxonomy =
  'category' | 'post_tag' | 'nic_portfolio_category' | 'product_cat' | 'product_tag';

export interface NicProductBlock {
  type: 'simple';
  regular_price: string;
  sale_price: string;
  sku: string;
  stock_status: 'instock' | 'outofstock';
  featured: boolean;
}

export interface NicItem {
  key: string;
  title: string;
  content?: string;
  excerpt?: string;
  date?: string;
  image?: string;
  gallery?: string[];
  terms?: Partial<Record<NicTaxonomy, string[]>>;
  meta?: Record<string, string>;
  menu_order?: number;
  product?: NicProductBlock;
}

export interface NicContent {
  format: 'nic-content/1';
  generator: string;
  theme: string;
  terms?: Partial<Record<NicTaxonomy, NicTerm[]>>;
  items: Partial<Record<NicType, NicItem[]>>;
}

export interface NicCreditEntry {
  path: string;
  license: string;
  source: string;
  author: string;
}

export interface NicCredits {
  assets: NicCreditEntry[];
}

/** Allowed meta keys and taxonomies per type — spec §6. */
export const META_KEYS: Record<NicType, readonly string[]> = {
  post: [],
  team: ['nic_role', 'nic_linkedin', 'nic_twitter', 'nic_website'],
  portfolio: ['nic_client', 'nic_year', 'nic_project_url'],
  testimonial: ['nic_company', 'nic_rating'],
  service: ['nic_icon'],
  product: [],
};

export const TYPE_TAXONOMIES: Record<NicType, readonly NicTaxonomy[]> = {
  post: ['category', 'post_tag'],
  team: [],
  portfolio: ['nic_portfolio_category'],
  testimonial: [],
  service: [],
  product: ['product_cat', 'product_tag'],
};

/** Media limits — spec §5. */
export const MEDIA_LIMITS = {
  maxLongEdge: 2000,
  maxFileBytes: 500 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  namePattern: /^[a-z0-9][a-z0-9-]*\.(jpg|png|webp)$/,
} as const;

/** One image file ready to be written into `content-media/`. */
export interface MediaFile {
  /** File name only, e.g. `post-long-haul.png`. */
  name: string;
  bytes: Uint8Array;
}
