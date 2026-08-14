# Contributing to themeseed

The most valuable contribution right now is **a new CMS provider**. WordPress, Joomla, Drupal
and Magento are all planned and none are started.

The architecture exists to make that a self-contained job. If you find yourself editing the
content generator, the image sources, the CLI or the MCP tools in order to support a new
platform, something has gone wrong — please open an issue rather than working around it.

---

## Getting set up

```bash
git clone <repo> && cd themeseed
npm install
cp .env.example .env
npm run verify        # typecheck + lint + unit tests
```

For integration tests you need a **disposable** CMS instance. These tests create and delete
posts; never point them at anything you care about.

```bash
# .env
GHOST_TEST_BLOG_ENDPOINT=http://localhost:2368
GHOST_TEST_BLOG_KEY=<id>:<secret>
GHOST_THEMES_DIR=/path/to/ghost/content/themes   # optional but recommended
```

```bash
npm run test:e2e      # integration tests
npm run test:loop     # the autonomous seed → verify → wipe loop
```

A quick local Ghost:

```bash
npm install -g ghost-cli
mkdir ghost && cd ghost && ghost install local
# Ghost Admin → Settings → Integrations → Add custom integration → copy the Admin API key
```

---

## Adding a provider

### 1. Read the contract

[`src/providers/provider.ts`](src/providers/provider.ts) is the whole interface:

```ts
interface CmsProvider {
  readonly platform: Platform;
  verifyConnection(): Promise<SiteInfo>;
  analyzeTheme(): Promise<ThemeCapabilities>;
  createContent(
    items: SeedContent[],
    options?: CreateContentOptions
  ): Promise<SeedResult[]>;
  listSeeded(): Promise<SeedResult[]>;
  wipeSeeded(): Promise<WipeSummary>;
}
```

The types it moves around live in [`src/core/types.ts`](src/core/types.ts) and are deliberately
free of any CMS's vocabulary.

### 2. Create your directory

```
src/providers/wordpress/
  index.ts      WordPressProvider implements CmsProvider + createWordPressProvider factory
  client.ts     REST/auth plumbing
  types.ts      WordPress-shaped types — nothing outside this directory may import these
  blocks.ts     SeedContent blocks → Gutenberg
  theme.ts      analyzeTheme implementation
```

Use [`src/providers/ghost/`](src/providers/ghost/) as the reference. It is roughly 900 lines
including comments.

### 3. Register it

One line in [`src/providers/registry.ts`](src/providers/registry.ts):

```ts
import { createWordPressProvider } from './wordpress/index.js';
registerProvider('wordpress', createWordPressProvider);
```

Then add `'wordpress'` to `IMPLEMENTED_PLATFORMS` in `src/core/types.ts`.

That is the entire integration. If you needed to touch anything else, say so in the PR.

### 4. Add tests

- **Unit** (`test/unit/`) — your block conversion, with no network. This is where most of the
  value is; conversion bugs are the ones that silently produce broken posts.
- **E2E** (`test/e2e/`) — against a real instance, skipped cleanly when its env vars are absent
  so other contributors are not blocked.

---

## What each method has to get right

### `verifyConnection`

Prove the **credentials work**, not merely that the host answers.

This is a real trap. Ghost serves `GET /ghost/api/admin/site/` without authentication, so
verifying with it returns a happy `200` for a completely invalid key — and `add-site` then saves
a credential that fails much later, mid-run. The Ghost provider therefore also calls an endpoint
that genuinely requires auth. Check whether your platform has the same hazard.

### `analyzeTheme`

Return conservative defaults with low `confidence` rather than throwing. A wrong `false` produces
plainer content; a thrown error blocks the user entirely.

Fill in `evidence[]` with how each conclusion was reached. Users need to be able to check the
analysis, and "confidence 0.4" with no explanation is not actionable.

Two patterns worth stealing from the Ghost provider:

- **Layered strategies.** A precise-but-sometimes-unavailable source (theme files on disk) and an
  always-available inferential one (the rendered site), merged by confidence. See
  `src/providers/ghost/theme/`.
- **The stylesheet is public.** Even when a platform will not serve theme _files_ over its API,
  the compiled CSS is a public asset on every page. Grepping it for the classes a card renders
  with turns a guess into evidence.

Capability detection is not busywork. A gallery block in a theme with no gallery styles renders
as a broken stack of images — worse than the plain post it replaced.

### `createContent`

**Never throw for a single failed item.** Record the failure in that item's `SeedResult.error`
and carry on; one bad image must not lose fourteen good posts.

Upload images **before** creating the post. Creating first and patching images in afterwards
leaves a window where the post renders with dead `src`s.

Validate image bytes before uploading. `probeImage` from `src/images/inspect.ts` will tell you
whether what you fetched is actually an image — stock CDNs return HTML error pages at image URLs
often enough that this matters.

### `listSeeded` / `wipeSeeded`

Everything you create carries `SEED_TAG` (`#themeseed`), mapped onto your platform's hidden
taxonomy. Ghost slugifies it to `hash-themeseed`.

**Deleting content the tool did not create is the one unforgivable bug.** Filter server-side,
then re-check the tag client-side on the actual records before deleting anything. A filter typo
must delete nothing, not everything. There is an e2e test for exactly this — please write the
equivalent.

---

## House style

- TypeScript, strict, ESM, `.js` extensions on relative imports (NodeNext resolution).
- `npm run verify` must pass. `npm run format` before committing.
- **All logging goes to stderr**, via `src/core/logger.ts`. The MCP server speaks JSON-RPC over
  stdout, and one stray `console.log` anywhere in the tree corrupts the stream and drops the
  connection with an unhelpful parse error.
- Errors that reach a user should be `ThemeseedError`/`ProviderError` with a `hint` naming the
  concrete next step.
- Comment the _why_, especially where the code looks odd. Most of the surprising lines here exist
  because a real API behaved unexpectedly, and the comment is the only record of that.

## Secrets

- `.env` is git-ignored and must stay that way.
- Site credentials belong in `~/.themeseed/sites.json` (mode `0600`), never in the repo.
- Never log a key. `maskSecret()` exists for when you need to show which key is in use.
- Before pushing, check history: `git log -p | grep -iE 'adminApiKey|api[_-]?key'`.

## Pull requests

Say what you changed, why, and how you verified it. If you added a provider, include the output
of `npm run test:e2e` against your platform.

Small, focused PRs get reviewed faster. A provider is a big change but a self-contained one,
which is fine.

## Reporting bugs

Include the platform and CMS version, the `themeseed --version`, the command or MCP tool call,
and the output of `themeseed analyze <site> --json` when the issue involves generated content —
that last one is usually enough to diagnose "why did it not add a gallery".
