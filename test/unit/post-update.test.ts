import { describe, expect, it } from 'vitest';

import { SEED_TAG, type UpdateContent } from '../../src/core/types.js';
import type { GhostClient } from '../../src/providers/ghost/client.js';
import { insertImageCard, type HostedImage } from '../../src/providers/ghost/lexical.js';
import { updatePosts } from '../../src/providers/ghost/posts.js';
import type { GhostPost, GhostTag } from '../../src/providers/ghost/types.js';

const SEED_TAG_SLUG = 'hash-themeseed';

const HOSTED: HostedImage = {
  url: 'https://blog.test/content/images/shot.jpg',
  width: 1600,
  height: 1067,
};

function lexicalDoc(...types: string[]): string {
  return JSON.stringify({
    root: { children: types.map((type) => ({ type, version: 1 })) },
  });
}

function childTypes(lexical: string): string[] {
  const doc = JSON.parse(lexical) as { root: { children: Array<{ type: string }> } };
  return doc.root.children.map((child) => child.type);
}

describe('insertImageCard', () => {
  it('places the image after the first paragraph, as the generator does', () => {
    const updated = insertImageCard(
      lexicalDoc('heading', 'paragraph', 'paragraph'),
      HOSTED
    );
    expect(childTypes(updated)).toEqual(['heading', 'paragraph', 'image', 'paragraph']);
  });

  it('appends when the body has no paragraph at all', () => {
    const updated = insertImageCard(lexicalDoc('heading'), HOSTED);
    expect(childTypes(updated)).toEqual(['heading', 'image']);
  });

  it('carries the hosted dimensions and the given alt text', () => {
    const updated = insertImageCard(lexicalDoc('paragraph'), HOSTED, {
      alt: 'a squat rack',
    });
    const card = (
      JSON.parse(updated) as { root: { children: Array<Record<string, unknown>> } }
    ).root.children[1]!;
    expect(card).toMatchObject({
      type: 'image',
      src: HOSTED.url,
      width: 1600,
      height: 1067,
      alt: 'a squat rack',
    });
  });

  it('leaves the prose untouched', () => {
    const before = lexicalDoc('paragraph', 'paragraph');
    const after = insertImageCard(before, HOSTED);
    expect(childTypes(after).filter((t) => t === 'paragraph')).toHaveLength(2);
  });
});

interface StubOptions {
  tags?: GhostTag[];
  lexical?: string;
}

/** A GhostClient that records the payload it was asked to write. */
function stubClient(options: StubOptions = {}) {
  const post: GhostPost = {
    id: 'abc123',
    title: 'An existing post',
    slug: 'an-existing-post',
    status: 'published',
    updated_at: '2026-09-07T10:00:00.000Z',
    feature_image: 'https://blog.test/content/images/old.jpg',
    lexical: options.lexical ?? lexicalDoc('paragraph', 'paragraph'),
    tags: options.tags ?? [{ id: 't1', slug: SEED_TAG_SLUG, name: SEED_TAG }],
  };

  const writes: Array<Record<string, unknown>> = [];

  const client = {
    async getPost() {
      return post;
    },
    async updatePost(_id: string, payload: Record<string, unknown>) {
      writes.push(payload);
      return { ...post, ...payload } as GhostPost;
    },
  } as unknown as GhostClient;

  return { client, writes };
}

describe('updatePosts', () => {
  it('clears the hero when the feature image is explicitly null', async () => {
    const { client, writes } = stubClient();

    const [result] = await updatePosts(client, [{ id: 'abc123', featureImage: null }], {
      seedTagSlug: SEED_TAG_SLUG,
    });

    expect(result?.error).toBeUndefined();
    expect(writes[0]).toMatchObject({ feature_image: null });
  });

  // Absent must mean "leave alone", or a caller fixing a title would silently
  // blank every field it did not mention.
  it('touches only the fields it was given', async () => {
    const { client, writes } = stubClient();

    await updatePosts(client, [{ id: 'abc123', title: 'A better title' }], {
      seedTagSlug: SEED_TAG_SLUG,
    });

    expect(Object.keys(writes[0]!)).toEqual(['title']);
  });

  it('sends the updated_at it read, so a concurrent edit collides', async () => {
    const { client } = stubClient();
    let sent: string | undefined;
    const spy = {
      ...client,
      async updatePost(_id: string, _payload: unknown, updatedAt: string) {
        sent = updatedAt;
        return { id: 'abc123', title: 't', slug: 's', status: 'published' } as GhostPost;
      },
      async getPost() {
        return client.getPost('abc123');
      },
    } as unknown as GhostClient;

    await updatePosts(spy, [{ id: 'abc123', title: 'x' }], {
      seedTagSlug: SEED_TAG_SLUG,
    });

    expect(sent).toBe('2026-09-07T10:00:00.000Z');
  });

  // Overwriting somebody's real article is a smaller disaster than deleting it
  // only by degree, so an id pointing at unseeded content is refused by default.
  it('refuses a post that does not carry the seed tag', async () => {
    const { client, writes } = stubClient({
      tags: [{ id: 't2', slug: 'essays', name: 'Essays' }],
    });

    const [result] = await updatePosts(client, [{ id: 'abc123', title: 'x' }], {
      seedTagSlug: SEED_TAG_SLUG,
    });

    expect(result?.error).toMatch(/does not carry #themeseed/);
    expect(writes).toHaveLength(0);
  });

  it('edits unseeded content when explicitly allowed', async () => {
    const { client, writes } = stubClient({
      tags: [{ id: 't2', slug: 'essays', name: 'Essays' }],
    });

    const [result] = await updatePosts(client, [{ id: 'abc123', title: 'x' }], {
      seedTagSlug: SEED_TAG_SLUG,
      allowUnseeded: true,
    });

    expect(result?.error).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('records a failure per item rather than throwing the run away', async () => {
    const { client } = stubClient({
      tags: [{ id: 't2', slug: 'essays', name: 'Essays' }],
    });

    const items: UpdateContent[] = [
      { id: 'abc123', title: 'one' },
      { id: 'abc123', title: 'two' },
    ];
    const results = await updatePosts(client, items, { seedTagSlug: SEED_TAG_SLUG });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error)).toBe(true);
  });
});
