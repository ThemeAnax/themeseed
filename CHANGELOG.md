# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ThemeAnax/themeseed/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ThemeAnax/themeseed/releases/tag/v0.1.1
[0.1.0]: https://github.com/ThemeAnax/themeseed/releases/tag/v0.1.0
