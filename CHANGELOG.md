# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-09-08

### Added

- **themeseed installs as a Claude Code plugin**, with no npm account and no
  registry configuration:

  ```
  /plugin marketplace add ThemeAnax/themeseed
  /plugin install themeseed@themeseed
  ```

  The plugin is served from the public GitHub repository and carries a prebuilt,
  dependency-inlined copy of the MCP server at `plugin/themeseed-mcp.mjs`. Claude
  Code runs a plugin by cloning the repo and executing what it finds — it does
  not run `npm install` — and the npm package sits on a private registry most
  people cannot read, so shipping the server ready-to-run is what makes the
  plugin installable by anyone at all. It carries no credentials: the Ghost
  Admin API key and any image-provider keys remain the user's own.

- **A `/themeseed` command**, which checks whether a site and image providers are
  configured, walks a first-time user through connecting them, and then seeds.

### Changed

- `readVersion` also looks one directory up from the module that calls it, so the
  bundled plugin — a single file sitting in `plugin/` beside the repository's
  `package.json` — reports its real version instead of `0.0.0-unknown`.
- `prepack` rebuilds the plugin bundle, so a published release cannot carry a
  stale one. A unit test fails if the plugin manifests drift from the package
  version.

## [0.4.0] — 2026-09-07

### Added

- **`update_post` (MCP) and `themeseed update` (CLI) edit a post that already
  exists.** Attach a feature image to a post that has none, remove one, splice a
  body image into the prose without rewriting it, or change title, excerpt and
  status. Until now the only repair for one bad post was deleting it and seeding
  again, which is absurd when the failure hit the last three posts of
  twenty-five. Only the fields you name are touched, and the edit carries the
  `updated_at` it read so a concurrent change in Ghost Admin collides rather
  than being silently overwritten.
- **Stock image providers now chain.** With both an Unsplash and a Pexels key
  configured, a provider that fails — a quota, an outage, an empty result — hands
  off to the next instead of ending the run's images. Naming a provider
  explicitly puts it first without disabling the spare. Picsum stays a
  standalone last resort: it cannot search, so chaining it behind a keyed
  provider would quietly swap searched photography for random photography.

### Changed

- **`generate_posts` now reports why images are missing.** A failed image lookup
  only ever reached stderr, which an MCP host does not display, so a run whose
  provider had hit its hourly quota still reported `created: 25, failed: 0` with
  nothing in any of them. The reason now appears in `skipped.images` on both
  surfaces.

### Security

- `update_post` refuses to edit a post that does not carry `#themeseed` unless
  `allowUnseeded` is passed. The tag is re-checked on the record the CMS
  returns, never on the caller's claim, so a mistyped or misremembered id cannot
  overwrite a real article.

## [0.3.0] — 2026-09-07

### Added

- **`topic` is now optional on `generate_posts`.** When it is omitted the user is
  asked directly, via MCP elicitation, rather than the calling model inventing a
  subject nobody chose. An empty answer — or a host that does not implement
  elicitation — falls back to a random subject from a deck of ordinary
  publication topics. `themeseed seed` accepts a blank prompt the same way.

### Changed

- **Every post now gets a body image**, not just two in three. Galleries and
  video embeds still rotate across a run, and each is still used only where the
  theme can style it. The old rotation handed every third post a video _instead
  of_ an image, so a three-post run — the smallest useful preview, and the one
  most likely to be judged on — published a post with no image at all.

### Fixed

- **Provider keys added while the MCP server is running are now picked up.**
  `~/.themeseed/.env` was read once at startup, but the server outlives the shell
  that launched it: a key written by `themeseed images` mid-session stayed
  invisible until the editor restarted. `auto` then resolved to `none` and posts
  published with no images while a working Unsplash key sat in the file. The file
  is re-read per seed run, and a key commented out since the last read is
  withdrawn. Variables exported in the user's own shell still win.
- **Theme analysis no longer concludes a theme hides feature images because the
  post it sampled had none.** Ghost emits `og:image` on every post, falling back
  to the publication cover when a post has no feature image of its own; reading
  that as "this post has a hero the theme refuses to render" marked the theme as
  hero-less. The failure was self-reinforcing — one seed run without feature
  images poisoned the next analysis, which then suppressed feature images on
  every later run. Analysis now prefers a sample post that actually has a feature
  image, and otherwise declines to answer rather than guessing.

## [0.2.1] — 2026-09-07

### Fixed

- **The generated MCP config now names the node interpreter explicitly**, as
  `{"command": "<node>", "args": ["<…>/themeseed-mcp"]}` rather than executing
  the binary directly. The installed bin is a symlink to a `.js` file whose
  `#!/usr/bin/env node` shebang resolves `node` against PATH, and an editor may
  spawn the server with a PATH carrying no nvm/fnm/volta shim. The spawn then
  died with `env: node: No such file or directory` before the server existed,
  which surfaced only as an MCP entry stuck at "connecting" — with nothing
  listening, reconnecting could never succeed, and the underlying error was
  never shown. The CLI worked throughout, because a shell has node on PATH.
  An already-written config keeps its old shape until the service is
  reinstalled: `themeseed uninstall --tool <id>` then `themeseed install`.

## [0.2.0] — 2026-08-19

### Added

- `themeseed images` configures stock, AI and local image providers at any time,
  with `--list`, `--set`, `--remove` and an interactive wizard.
- `themeseed init` now asks which image providers to set up, and writes
  `~/.themeseed/.env` and `~/.themeseed/sites.example.json`. Both list every
  setting, commented out, so they can be filled in by hand. `--skip-images`
  skips the prompt.
- `imageSource: "none"` publishes posts without images, and `"auto"` picks a
  source from whichever provider keys are configured.
- `studyTheme` on `generate_posts`, and `themeseed seed --study-theme`, read the
  active theme and shape content to it.

### Changed

- **Provider keys now load from `~/.themeseed/.env`** instead of the current
  working directory. The MCP server is launched by an editor in whatever
  directory it has open, so the old lookup found an unrelated `.env` or none at
  all, and stock lookups degraded silently to keyless Lorem Picsum.
- **`imageSource` defaults to `auto`, not `stock`.** With no key configured,
  posts publish without images rather than with unrelated placeholder
  photography. Passing `stock` or `ai` explicitly still fails loudly when the
  key is missing.
- **Theme analysis no longer runs on every seed.** It costs a round trip and
  now happens only when `studyTheme` is set, or when `analyze_theme` /
  `themeseed analyze` is called directly.

## [0.1.1] — 2026-08-14

### Added

- Three more AI image adapters alongside `openai` and `procedural`: `grok`
  (`XAI_API_KEY`, `grok-imagine-image`), `gemini` (`GOOGLE_API_KEY`) and `fal` (`FAL_KEY`).
  Whichever key is present is used; `THEMESEED_AI_IMAGE_ADAPTER` forces one and
  `THEMESEED_AI_IMAGE_MODEL` overrides the model.
- `nearestAspectLabel` snaps a theme's measured aspect ratio onto whatever labels each
  backend accepts, so the generator only ever asks for a number.
- `scripts/probe-ai-adapters.ts` — reports which adapters actually work on this machine.
- `scripts/seed-architecture.ts` — a worked `ContentEngine` example.

### Changed

- Repository is public at `github.com/ThemeAnax/themeseed`; package metadata updated.

### Notes

- Google image models return `429 RESOURCE_EXHAUSTED` immediately unless billing is enabled
  on the project — the adapter's hint says so, because it otherwise reads as a transient
  rate limit.
- fal keys are `<id>:<secret>` and are sent as `Authorization: Key …`, not `Bearer`.

## [0.1.0] — 2026-08-14

First release. Ghost support, complete CLI, MCP server.

### Added

**Core**

- `CmsProvider` interface and a provider registry, so a new platform is one directory and one
  registration line.
- Platform-neutral content model: posts as structured blocks (paragraph, heading, image, gallery,
  video, quote, list, code, divider). No CMS storage format appears outside its own provider.
- Multi-site, multi-platform configuration at `~/.themeseed/sites.json`, written `0600`.

**Ghost provider**

- Admin API client with per-request JWT signing from an `<id>:<secret>` Admin API key.
- Theme analysis via two merged strategies — the theme's `.hbs` sources on disk when reachable,
  and the publicly-served theme stylesheet otherwise. Every conclusion carries evidence and the
  result carries a confidence score.
- Block → Lexical conversion covering image, gallery, embed, quote, list, codeblock and divider
  cards, verified by round-tripping through a live Ghost 6 instance.
- Image upload, post creation with backdated publish times, and `#themeseed`-tagged cleanup that
  re-checks the tag client-side before deleting anything.

**Content**

- Deterministic offline generation: five article shapes, compositional paragraphs, article length
  matched to what the theme's layout expects.
- Galleries and video embeds only where the theme was measured to support them.
- Real YouTube videos, each confirmed through the public oEmbed endpoint. Video ids are never
  fabricated.

**Images**

- Three sources behind one interface: `local` (a folder), `stock` (Unsplash, Pexels, or keyless
  Lorem Picsum), `ai` (OpenAI `gpt-image-1`, or a labelled procedural placeholder).
- Dependency-free header parsing for PNG, JPEG, GIF, WebP and AVIF, used both for gallery
  dimensions and to reject non-image bytes before upload.

**MCP server** (`themeseed-mcp`)

- Tools: `analyze_theme`, `generate_posts`, `list_seeded`, `wipe_seeded`, `add_site`,
  `list_sites`, `remove_site`.
- `generate_posts` accepts caller-supplied `titles`, so a host model can write the copy while
  themeseed handles structure, images and publishing.
- `wipe_seeded` defaults to a dry run.

**CLI** (`themeseed`)

- `init` detects MCP-capable tools (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Cline,
  Zed), confirms which to configure, and writes each one's native config format — merging rather
  than replacing, and refusing to touch a config file it could not parse.
- `install`, `uninstall`, `mcp-config`, `upgrade`, `add-site`, `remove-site`, `list-sites`, `use`,
  `analyze`, `seed`, `list`, `wipe`, plus `--help` and `--version`.
- Prompts degrade to plain line output when stdout is not a TTY.

### Notes

- Ghost's `GET /ghost/api/admin/themes/` rejects API-token auth on every Ghost version, which is
  why theme analysis reads the rendered stylesheet rather than downloading the theme package.
- Ghost serves `GET /ghost/api/admin/site/` **without** authentication, so `verifyConnection`
  additionally calls an authenticated endpoint. Verifying with `/site/` alone would accept an
  invalid key.
- Ghost's image card silently renders `alt=""` when given `altText`; the property it honours is
  `alt`.

[Unreleased]: https://github.com/ThemeAnax/themeseed/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/ThemeAnax/themeseed/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ThemeAnax/themeseed/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ThemeAnax/themeseed/releases/tag/v0.1.1
[0.1.0]: https://github.com/ThemeAnax/themeseed/releases/tag/v0.1.0
