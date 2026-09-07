# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run verify        # typecheck + lint + unit tests — must pass before any commit
npm test              # unit tests only (vitest, `unit` project)
npm run test:watch
npm run build         # tsc -p tsconfig.build.json, then chmod the bin shims
npm run format        # prettier --write . (run before committing)
```

Single test file / single test:

```bash
npx vitest run --project unit test/unit/lexical.test.ts
npx vitest run --project unit -t 'uses "alt" rather than "altText"'
```

Integration, both needing a **disposable** Ghost instance (they create and delete posts):

```bash
npm run test:e2e      # test/e2e/ghost.e2e.test.ts
npm run test:loop     # seed → verify → wipe, until 3 consecutive clean runs; appends to test-loop.log
```

E2E is gated on `GHOST_TEST_BLOG_ENDPOINT` and `GHOST_TEST_BLOG_KEY` in the repo's `.env` (`cp .env.example .env`). Without them the suite **skips cleanly** rather than failing — preserve that property in any new e2e test. The Ghost key is the Admin API key in `<id>:<hex secret>` form (Ghost Admin → Settings → Integrations → Add custom integration); the Content API key will not work. `GHOST_THEMES_DIR` is optional but makes theme analysis far more accurate.

`scripts/probe-*.ts` are manual diagnostics, deliberately not part of the test suite — reach for them when something behaves surprisingly and you want evidence:

```bash
npx tsx scripts/probe-theme.ts --themes-dir /path/to/content/themes
npx tsx scripts/probe-ai-adapters.ts --ratio 1.5   # costs money: one generated image per configured adapter
npx tsx scripts/probe-images.ts
npx tsx scripts/probe-video.ts "deep work"
npm run build && npx tsx scripts/probe-mcp.ts      # needs a build first
```

`scripts/seed-architecture.ts` is a worked `ContentEngine` example, not a probe.

## Architecture

The whole design exists to keep CMS-specific knowledge inside one directory. Three layers:

**Neutral domain model** (`src/core/types.ts`) — `ContentBlock`, `ImageRef`, `SeedContent`, `ThemeCapabilities`. Deliberately free of any CMS's vocabulary. A field here starting to look Ghost-shaped is the signal it belongs in the provider instead.

**Orchestrator** (`src/core/seed.ts`) — `seedSite()` is the single high-level operation: analyze (optional) → generate → publish. **Both the CLI and the MCP server call it**, so the two surfaces cannot drift in behaviour, only in presentation.

**Two thin surfaces** over that core — `src/cli/` (commander + @clack/prompts, binary `themeseed`) and `src/mcp/` (binary `themeseed-mcp`, 7 tools: `list_sites`, `add_site`, `remove_site`, `analyze_theme`, `generate_posts`, `list_seeded`, `wipe_seeded`). Neither wraps the other. Features have consistently shipped to both; treat parity as the default expectation.

### The provider contract

`CmsProvider` in `src/providers/provider.ts` is the point of the architecture. Adding WordPress means adding `src/providers/wordpress/` plus one `registerProvider(...)` line in `src/providers/registry.ts` and a name in `IMPLEMENTED_PLATFORMS`. **If a new platform requires touching the generator, image sources, CLI or MCP tools, something is wrong** — raise it rather than working around it. `src/providers/ghost/` is the reference implementation.

Rules for implementers:

1. Nothing outside `src/providers/<platform>/` may import that platform's types.
2. Translate _from_ the neutral model. Never push CMS block/field vocabulary back up into shared code. Ghost's Lexical conversion lives only in `src/providers/ghost/lexical.ts`; a WordPress provider would have `gutenberg.ts` in exactly that shape and the generator would not change by a line.
3. Tag everything with `SEED_TAG` (`#themeseed`).
4. `createContent` must **never throw for a single failed item** — record it in that item's `SeedResult.error` and carry on, so one bad image does not lose fourteen good posts.
5. `analyzeTheme` degrades rather than throws: conservative defaults with low `confidence` beat a hard failure, and `evidence[]` records how each conclusion was reached.
6. `verifyConnection` must prove the _credentials_ work, not merely that the host answers.

### Deleting content is the one unforgivable bug

`wipeSeeded` must filter server-side **and** re-check `SEED_TAG` client-side on the actual records before deleting. A filter typo must delete nothing, not everything. Ghost slugifies the internal tag `#themeseed` to `hash-themeseed` and filters on slug, not name — `SEED_TAG_SLUG` in `src/providers/ghost/index.ts` exists because getting this wrong silently matches nothing, or matches everything. There is an e2e test for this; a new provider needs the equivalent.

### Capability gating is an invariant, not polish

`ThemeCapabilities` drives which blocks the generator emits. A gallery block in a theme with no gallery styles renders as a broken stack of images — worse than the plain post it replaced. Theme analysis is **opt-in** (`studyTheme` / `--study-theme`) because it costs a round trip; without it `genericCapabilities()` in `src/core/theme-defaults.ts` supplies the conservative half of every choice (feature image, tags, author; no galleries, embeds, bookmark cards or wide images) with `confidence: 0` and `analyzedVia: ['defaults']` marking it as assumed rather than measured.

Ghost theme analysis merges two strategies (`src/providers/ghost/theme/`): local `.hbs` sources off disk (confidence 0.9, needs `themesDir`) and the rendered site plus its public stylesheet (0.6). Higher confidence wins contested fields. The stylesheet trick matters — `kg-*` card selectors answer the gallery/embed/bookmark/wide-image questions with real evidence. There is no remote alternative: `GET /ghost/api/admin/themes/` returns 403 for API-token auth on every Ghost version (staff session only), so the active theme name comes from `GET /ghost/api/admin/settings/` (`active_theme`).

### Swappable pieces

- **`ContentEngine`** (`src/content/engine.ts`) — default `TemplateContentEngine` is deterministic and offline by design: composes paragraphs from rotating decks of claims/elaborations/examples/caveats, so a 1400-word article does not visibly repeat. Better prose needs no code change — pass `titles` into the generator (an MCP host's model writes them) or implement `ContentEngine`.
- **`ImageSource`** (`src/images/source.ts`) — `local` | `stock` | `ai` | `none`. `auto` resolves to ai → stock → none based on which keys are present, and **never fails**; an explicit kind **fails loudly** when unusable, because that was the caller's decision. Add an AI backend by implementing `AiImageAdapter` and adding a line to `selectAiAdapter` in `src/images/ai-source.ts`, plus an entry in the `IMAGE_PROVIDERS` table.
- **`IMAGE_PROVIDERS`** (`src/images/providers.ts`) — one table feeding four consumers: the generated `.env` template, the `init` wizard, `images --list`, and `auto` resolution. Adding a provider in four places is a provider documented in three.

## Configuration

Lives in `~/.themeseed/` (override with `THEMESEED_CONFIG_DIR` — this is also how unit tests isolate; see `test/unit/config-and-cli.test.ts`).

- `sites.json` — sites and credentials, mode `0600`, written atomically (temp + rename).
- `.env` — provider keys. Written by `init` / `themeseed images`, **never overwritten**; every setting ships present but commented out, which is why `setEnvValues` upserts in place rather than appending.

**Both surfaces read `~/.themeseed/.env` by absolute path and deliberately do not read `.env` from cwd.** An editor launches the MCP server in whatever directory it has open, so a relative lookup found an unrelated file or none, and stock lookups degraded silently to keyless Lorem Picsum. The repo's own `.env.example` configures the e2e suite only, not normal use.

Env vars: `THEMESEED_CONFIG_DIR`, `THEMESEED_LOG_LEVEL`, `THEMESEED_STOCK_PROVIDER`, `THEMESEED_AI_IMAGE_ADAPTER`, `THEMESEED_AI_IMAGE_MODEL`, `THEMESEED_CONTENT_ENGINE`, `THEMESEED_LOCAL_IMAGE_DIR`; keys `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY`, `FAL_KEY`, `ANTHROPIC_API_KEY`.

## House style

- TypeScript, strict, ESM. **`.js` extensions on relative imports** (NodeNext). `noUncheckedIndexedAccess` is on.
- **All logging goes to stderr via `src/core/logger.ts`.** The MCP server speaks JSON-RPC over stdout — one stray `console.log` anywhere in the tree corrupts the stream.
- User-facing failures are `ThemeseedError` / `ProviderError` / `ConfigError` with a `hint` naming the concrete next step.
- Comment the _why_. Most of the surprising lines here exist because a real API behaved unexpectedly, and the comment is the only record of that.
- Commits follow Conventional Commits (`feat(images):`, `fix(config):`, `docs:`).
- Never log a key — use `maskSecret()`. `.env` is git-ignored and must stay so.

## Publishing

`@indianic/themeseed`, published to the private registry `https://npm.indianic.in/` (`publishConfig.access: restricted`). Source is public at `github.com/ThemeAnax/themeseed`; the npm package is not. Consumers need `npm config set @indianic:registry https://npm.indianic.in/`, and generated MCP configs carry `"env": {"npm_config_registry": "https://npm.indianic.in/"}`. SemVer; CHANGELOG follows Keep a Changelog. Node 20+.

## Platform gotchas worth carrying forward

- Ghost serves `GET /ghost/api/admin/site/` **without** auth, so verifying with it alone accepts an invalid key. Check whether a new platform has the same hazard.
- Ghost's image card silently renders `alt=""` when given `altText`; the honoured property is `alt`.
- Video ids are **never fabricated** — every candidate is confirmed through YouTube's public oEmbed endpoint, which only answers for videos that exist and are embeddable. A dead embed reads as a broken theme, which is worse than no video.
- Gemini image models return `429 RESOURCE_EXHAUSTED` immediately unless billing is enabled. It reads like a transient rate limit; it is not.
- fal keys are `<id>:<secret>` sent as `Authorization: Key …`, not `Bearer`.
