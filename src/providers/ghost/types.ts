/**
 * Ghost-shaped types. Nothing outside `src/providers/ghost/` may import these —
 * that boundary is what keeps the rest of the codebase portable.
 */

export interface GhostSite {
  title: string;
  description?: string;
  logo?: string | null;
  icon?: string | null;
  cover_image?: string | null;
  accent_color?: string | null;
  locale?: string;
  url: string;
  version: string;
}

export interface GhostTag {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  visibility?: 'public' | 'internal';
}

export interface GhostAuthor {
  id: string;
  name: string;
  slug: string;
  profile_image?: string | null;
}

export interface GhostPost {
  id: string;
  uuid?: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'scheduled' | 'sent';
  url?: string;
  feature_image?: string | null;
  feature_image_alt?: string | null;
  feature_image_caption?: string | null;
  custom_excerpt?: string | null;
  excerpt?: string | null;
  lexical?: string | null;
  html?: string | null;
  tags?: GhostTag[];
  authors?: GhostAuthor[];
  published_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GhostUploadedImage {
  url: string;
  ref?: string | null;
}

// ---------------------------------------------------------------------------
// Lexical
// ---------------------------------------------------------------------------

/**
 * Ghost stores post bodies as a Lexical editor state (a JSON string). Only the
 * subset of node shapes themeseed emits is modelled here; Ghost tolerates the
 * rest of the schema being absent as long as the required keys are present.
 */
export interface LexicalTextNode {
  type: 'extended-text';
  detail: number;
  format: number;
  mode: 'normal';
  style: '';
  text: string;
  version: 1;
}

export interface LexicalLinkNode {
  type: 'link';
  version: 1;
  url: string;
  rel: null;
  target: null;
  title: null;
  children: LexicalTextNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
}

export interface LexicalParagraphNode {
  type: 'paragraph';
  version: 1;
  children: Array<LexicalTextNode | LexicalLinkNode>;
  direction: 'ltr';
  format: '';
  indent: 0;
}

export interface LexicalHeadingNode {
  type: 'extended-heading';
  version: 1;
  tag: 'h2' | 'h3' | 'h4';
  children: LexicalTextNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
}

export interface LexicalListItemNode {
  type: 'listitem';
  version: 1;
  value: number;
  checked?: boolean;
  children: LexicalTextNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
}

export interface LexicalListNode {
  type: 'list';
  version: 1;
  listType: 'bullet' | 'number';
  tag: 'ul' | 'ol';
  start: 1;
  children: LexicalListItemNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
}

export interface LexicalQuoteNode {
  type: 'quote';
  version: 1;
  children: LexicalTextNode[];
  direction: 'ltr';
  format: '';
  indent: 0;
}

/** Ghost's editor cards all arrive as a single decorator node with a payload. */
export interface LexicalCardNode {
  type: string;
  version: 1;
  [key: string]: unknown;
}

export type LexicalNode =
  | LexicalParagraphNode
  | LexicalHeadingNode
  | LexicalListNode
  | LexicalQuoteNode
  | LexicalCardNode;

export interface LexicalRoot {
  root: {
    type: 'root';
    version: 1;
    children: LexicalNode[];
    direction: 'ltr';
    format: '';
    indent: 0;
  };
}
