import { describe, expect, it } from 'vitest';

import type { CmsProvider } from '../../src/providers/provider.js';
import { GhostProvider } from '../../src/providers/ghost/index.js';
import type { SeedConfigForTest } from './helpers/ghost-fetch.js';
import { recordingFetch } from './helpers/ghost-fetch.js';

function provider(fetchImpl: typeof fetch): CmsProvider {
  const site: SeedConfigForTest = {
    platform: 'ghost',
    url: 'https://blog.test',
    credentials: { adminApiKey: '6400000000000000000000aa:' + 'ab'.repeat(32) },
  };
  return new GhostProvider(site, { fetchImpl });
}

describe('GhostProvider — pages', () => {
  it('creates a page as a post of type "page", which is how Ghost models it', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await provider(fetchImpl).createPages!([
      { title: 'About', slug: 'about', blocks: [], status: 'published' },
    ]);
    const call = calls.find((c) => c.url.includes('/pages/'));
    expect(call).toBeDefined();
    expect(call!.body?.pages?.[0]).toMatchObject({ title: 'About', slug: 'about' });
  });

  it('sends a supplied body as html rather than inventing lexical for it', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await provider(fetchImpl).createPages!([
      {
        title: 'Style guide',
        slug: 'style-guide',
        blocks: [],
        status: 'published',
        suppliedBody: '<figure class="kg-card"></figure>',
      },
    ]);
    const page = calls.find((c) => c.url.includes('/pages/'))!.body!.pages![0]!;
    expect(page['html']).toContain('kg-card');
    expect(page['lexical']).toBeUndefined();
  });

  it('records a failure per item instead of losing the whole batch', async () => {
    const { fetchImpl } = recordingFetch({ failOn: 'second' });
    const results = await provider(fetchImpl).createPages!([
      { title: 'A', slug: 'a', blocks: [], status: 'published' },
      { title: 'B', slug: 'b', blocks: [], status: 'published' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.error).toBeUndefined();
    expect(results[1]!.error).toBeTruthy();
  });
});

describe('GhostProvider — tags and authors', () => {
  it('creates a tag with its description', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await provider(fetchImpl).createTags!([
      { name: 'Design', slug: 'design', description: 'On craft.' },
    ]);
    const tag = calls.find((c) => c.url.includes('/tags/'))!.body!.tags![0]!;
    expect(tag).toMatchObject({ name: 'Design', slug: 'design', description: 'On craft.' });
  });

  it('does not offer author creation, because Ghost\'s API cannot do it', () => {
    // /users/ is Browse and Read only on the Admin API — a user is invited by
    // email and must accept. There is no honest implementation, so the
    // optional method is simply absent rather than silently doing nothing.
    //
    // The file export is not bound by this: Ghost's *importer* creates users
    // from the JSON, so authors arrive with their bios intact that way.
    const { fetchImpl } = recordingFetch();
    expect(provider(fetchImpl).createAuthors).toBeUndefined();
  });
});
