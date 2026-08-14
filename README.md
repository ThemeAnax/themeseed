# themeseed

Fill a CMS with realistic demo content so you can judge a theme against real-looking
articles — instead of an empty install, a "Coming soon" placeholder, or a wall of lorem ipsum.

themeseed reads the **active theme** first, works out what it can actually display, and then
generates content that fits: hero images at the theme's own aspect ratio, galleries only where
the theme has gallery styles, real embedded videos only where it has embed styles, and articles
long enough to fill the layout the designer built.

It ships as both an **MCP server** (drive it from Claude Code, Cursor, Windsurf, Claude Desktop,
VS Code, Zed…) and a **CLI**.

```bash
themeseed add-site --slug blog --url http://localhost:2368
themeseed analyze blog          # what can this theme display?
themeseed seed blog -t "SaaS productivity blog" -c 15
themeseed wipe blog             # remove exactly what it created
```

---

## Contents

- [Why](#why)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [MCP tools](#mcp-tools)
- [How theme analysis works](#how-theme-analysis-works)
- [Image sources](#image-sources)
- [Content generation](#content-generation)
- [Supported platforms](#supported-platforms)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Open questions](#open-questions)

---

## Why

Evaluating a theme against an empty site tells you almost nothing. The hero looks fine because
there is no hero. The archive grid looks tidy because there are three posts. The typography
looks great for 200 words and falls apart at 1,500.

Filling the site by hand is an hour of work you throw away. Filling it with lorem ipsum tells
you about the typography and nothing about the layout, because lorem ipsum has no headings, no
images, no galleries, no pull quotes and no embeds.

themeseed produces content shaped like the real thing — and shaped like _this theme's_ real
thing, because it reads the theme before it writes anything.

## Install

themeseed is published to IndiaNIC's private registry. Point the `@indianic` scope at it once:

```bash
npm config set @indianic:registry https://npm.indianic.in/
npm login --registry https://npm.indianic.in/ --scope @indianic
```

Then install globally:

```bash
npm install -g @indianic/themeseed
```

Or run it without installing:

```bash
npx @indianic/themeseed init
```

Node 20 or newer is required.

> **Registry note.** The public-npm / public-GitHub story is still undecided — see
> [Open questions](#open-questions). Today this package exists only on `npm.indianic.in`.

## Quick start

```bash
themeseed init
```

`init` does three things:

1. Detects MCP-capable tools installed on your machine.
2. Asks which of them to register the themeseed MCP server with, and writes each one's config
   in its own native format (merging, never replacing).
3. Offers to add your first site.

Adding a site verifies the credentials before saving them, so a bad key fails immediately rather
than half way through a seed run.

```
$ themeseed analyze blog

bohomian v1.0.0
Bohomian — a quiet, Scandinavian Ghost theme.

  feature image   yes (ratio ≈ 1.33)
  gallery card    yes
  video embed     yes
  bookmark card   yes
  wide images     yes
  shows tags      yes
  shows author    yes (with avatar)
  reading time    yes
  target length   ~1400 words (910–2030)
  posts per page  12

  confidence 0.95 via local-theme-files, rendered-site
```

Then fill it:

```
$ themeseed seed blog -t "SaaS productivity blog" -c 15

✔ Created 15 of 15 post(s) on "blog"

  theme            bohomian
  feature images   15
  inline images    5
  galleries        5
  video embeds     5
```

Every post is tagged `#themeseed` (an internal, non-public tag on Ghost), which is how
`themeseed wipe` removes exactly this content and nothing else.

## CLI reference

themeseed uses [commander](https://github.com/tj/commander.js) for argument parsing and
[@clack/prompts](https://github.com/bombshell-dev/clack) for interactive input. Prompts degrade
to plain line output when stdout is not a TTY, so piping and CI logs stay readable.

### Setup

| Command                             | What it does                                                         |
| ----------------------------------- | -------------------------------------------------------------------- |
| `themeseed init`                    | First-run setup: detect editors, register the MCP server, add a site |
| `themeseed install [-t <id>…] [-a]` | Register the MCP server with an editor, without the full init flow   |
| `themeseed uninstall [-t <id>…]`    | Remove the MCP server from editor configuration                      |
| `themeseed mcp-config`              | Print the JSON snippet for manual configuration                      |
| `themeseed upgrade [--check]`       | Check the registry for a newer version and install it                |
| `themeseed --version` / `-v`        | Print the installed version                                          |
| `themeseed --help` / `-h`           | Show help (also `themeseed help <command>`)                          |

### Sites

| Command                        | What it does                                       |
| ------------------------------ | -------------------------------------------------- |
| `themeseed add-site`           | Register a CMS. Verifies credentials before saving |
| `themeseed remove-site [slug]` | Forget a site. Deletes no content                  |
| `themeseed list-sites`         | List configured sites (never prints credentials)   |
| `themeseed use <slug>`         | Set the default site used when no slug is given    |

`add-site` accepts `--slug`, `--platform`, `--url`, `--key` and `--themes-dir` for scripting.
Prefer the interactive prompt for the key: a credential passed as a flag lands in your shell
history and in `ps` output.

### Content

| Command                             | What it does                                            |
| ----------------------------------- | ------------------------------------------------------- |
| `themeseed analyze [site] [--json]` | Report what the active theme can display, with evidence |
| `themeseed seed [site]`             | Generate and publish content that suits the theme       |
| `themeseed list [site] [--json]`    | List content themeseed created                          |
| `themeseed wipe [site] [-y]`        | Delete everything themeseed created                     |

`seed` options:

| Flag                          | Default    | Meaning                                      |
| ----------------------------- | ---------- | -------------------------------------------- |
| `-t, --topic <topic>`         | prompted   | What the publication is about                |
| `-c, --count <n>`             | `12`       | How many posts to create                     |
| `-i, --image-source <source>` | `stock`    | `local`, `stock` or `ai`                     |
| `--draft`                     | off        | Create drafts instead of published posts     |
| `--author <name>`             | —          | Author to attribute posts to                 |
| `--no-video`                  | off        | Skip YouTube lookups (faster, fully offline) |
| `--seed <n>`                  | topic hash | Seed the generator for reproducible output   |
| `-y, --yes`                   | off        | Skip the confirmation prompt                 |

## MCP tools

Run `themeseed install` to register the server, or add it by hand:

```json
{
  "mcpServers": {
    "themeseed": {
      "command": "npx",
      "args": ["-y", "--package", "@indianic/themeseed", "themeseed-mcp"],
      "env": { "npm_config_registry": "https://npm.indianic.in/" }
    }
  }
}
```

VS Code nests servers under `servers` rather than `mcpServers`; Zed calls them
`context_servers`. `themeseed install` handles each format for you.

| Tool             | Parameters                                                                                   | What it does                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `analyze_theme`  | `site?`                                                                                      | Reports theme capabilities, with evidence and a confidence score |
| `generate_posts` | `site?`, `topic`, `count`, `imageSource`, `status`, `titles?`, `authorName?`, `includeVideo` | Analyzes, generates, sources images, publishes                   |
| `list_seeded`    | `site?`                                                                                      | Lists everything themeseed created                               |
| `wipe_seeded`    | `site?`, `confirm`                                                                           | Deletes it. Defaults to a dry run — `confirm: true` to proceed   |
| `add_site`       | `slug`, `platform`, `url`, `credentials`, `themesDir?`                                       | Registers a site, verifying credentials first                    |
| `list_sites`     | —                                                                                            | Lists sites. Never returns credentials                           |
| `remove_site`    | `slug`                                                                                       | Forgets a site                                                   |

**Tip:** pass your own headlines to `generate_posts` via `titles`. The built-in engine writes
serviceable copy, but a model that knows the client's voice writes better copy — this lets it
supply the words while themeseed handles structure, images, capability-gating and publishing.

## How theme analysis works

This is the part that makes the output fit rather than merely exist.

Ghost's Admin API **will not serve theme files**: `GET /ghost/api/admin/themes/` returns
`403 NoPermissionError` for API-token auth on every Ghost version, because it requires a staff
session. So themeseed uses two strategies and merges them.

**1. Local theme files** (confidence 0.9) — when Ghost runs on this machine and you point
`--themes-dir` at `content/themes`. Reads the active theme's `.hbs` templates, `package.json`
and compiled CSS. This is as close to ground truth as it gets: `card_assets: true` proves every
Koenig card is styled; `{{#if feature_image}}` proves the hero is rendered; a table-of-contents
partial proves the theme expects long articles.

**2. The rendered site** (confidence 0.6) — always available, including Ghost(Pro) and any
remote install. The trick: a theme's own stylesheet is a public asset. Fetching it and looking
for `kg-gallery-container`, `kg-embed-card`, `kg-width-wide` answers the card questions with
real evidence rather than assumption. The rendered post page supplies the rest — hero, tags,
author avatar, reading time.

The higher-confidence strategy wins any contested field; the lower one fills what nobody else
measured. Anything still unmeasured falls back to conservative defaults **and lowers the reported
confidence**, so a low number means "we guessed", not "the theme is limited".

Which theme is active comes from `GET /ghost/api/admin/settings/` (`active_theme`), which
API tokens _may_ read.

Every conclusion is recorded in `evidence[]`:

```
- [local-theme-files] package.json config.card_assets enables Ghost card styles for all cards
- [local-theme-files] feature image aspect-ratio ≈ 1.33 (most common of the ratios attached to
  feature images; 3 occurrence(s), via class)
- [rendered-site] card selectors in served CSS — gallery:true embed:true bookmark:true wide:true
```

### Why capability-gating matters

A gallery card in a theme with no gallery styles renders as a broken-looking stack of images.
That is _worse_ than the plain post it replaced, because it makes a good theme look buggy.
themeseed only emits a block when the theme was measured to support it.

## Image sources

One interface, three interchangeable implementations, selected with `--image-source`.

### `local`

Scans a directory (`THEMESEED_LOCAL_IMAGE_DIR`) and picks files whose aspect ratio is closest to
what the theme wants. Fully offline and reproducible. Descriptive filenames become alt text;
camera filenames like `IMG_4821` are rejected in favour of the query, because bad alt text is
worse than generic alt text.

### `stock`

| Adapter    | Key                   | Query-relevant?                  |
| ---------- | --------------------- | -------------------------------- |
| `unsplash` | `UNSPLASH_ACCESS_KEY` | yes                              |
| `pexels`   | `PEXELS_API_KEY`      | yes                              |
| `picsum`   | none                  | **no** — real photos, but random |

Picks whichever key is present, else falls back to Lorem Picsum so the zero-config path still
works. Picsum returns genuine photographs at the right dimensions, which is enough to judge a
theme's _layout_, and useless for judging whether images match the copy — so every image it
returns carries a `credit` saying exactly that. Set `THEMESEED_STOCK_PROVIDER` to force one.

### `ai`

| Adapter      | Key              | Default model            | Actually AI? |
| ------------ | ---------------- | ------------------------ | ------------ |
| `openai`     | `OPENAI_API_KEY` | `gpt-image-1`            | yes          |
| `grok`       | `XAI_API_KEY`    | `grok-imagine-image`     | yes          |
| `gemini`     | `GOOGLE_API_KEY` | `gemini-2.5-flash-image` | yes          |
| `fal`        | `FAL_KEY`        | `fal-ai/flux/schnell`    | yes          |
| `procedural` | none             | —                        | **no**       |

Whichever key is present is used; `THEMESEED_AI_IMAGE_ADAPTER` forces one and
`THEMESEED_AI_IMAGE_MODEL` overrides the model. Each backend asks for output shape
differently — `aspect_ratio`, `imageConfig.aspectRatio`, named size presets — so themeseed
snaps the theme's measured ratio onto whatever that backend supports and the generator only
ever asks for a number.

Two things worth knowing before picking one:

- **Gemini image models require billing enabled on the project.** Without it every call
  returns `429 RESOURCE_EXHAUSTED` immediately, which reads like a rate limit that will clear
  on its own. It will not.
- **fal keys are `<id>:<secret>`**, sent as `Authorization: Key …` rather than `Bearer`.

`procedural` renders deterministic abstract artwork locally — gradients and soft geometry, no
network, no key. It exists so `--image-source ai` still produces valid, correctly-sized images
out of the box and so the integration tests are hermetic. It is not AI, and every image it
produces says so in its credit line.

Check what actually works on your machine, one image per configured adapter:

```bash
npx tsx scripts/probe-ai-adapters.ts --ratio 1.5
```

Adding a backend (Replicate, Stability, a local diffusion server) means implementing
`AiImageAdapter` and adding one line to `selectAiAdapter` — see `src/images/ai-source.ts`.

### Validation

Every image is parsed before upload. Stock APIs and CDNs return HTML error pages with image URLs
often enough that uploading unverified bytes reliably produces posts full of broken images, so
bytes that are not a decodable PNG/JPEG/GIF/WebP/AVIF are dropped with a warning.

## Content generation

The default engine is deterministic, offline and free. It composes each paragraph from a claim, an
elaboration and usually an example or caveat, drawn from rotating decks so a 1,400-word article
does not visibly repeat. Titles cycle through five article shapes — guide, listicle, opinion,
case study, explainer — so a batch of fifteen looks like a real publication's archive rather than
fifteen variations of one headline.

It is not trying to write good essays. It is trying to produce headings, paragraph rhythm,
article length, pull quotes, lists and images that stress a layout the way real content will.

Two ways to get better prose without touching the code:

- Pass `titles` (MCP) or use your own copy — the host model writes, themeseed structures.
- Implement `ContentEngine` (`src/content/engine.ts`) and pass it to `generateSeedContent`.

**Videos are always real.** themeseed searches YouTube, then confirms each candidate through the
public oEmbed endpoint — which only answers for videos that exist and permit embedding — and takes
the title, author and thumbnail from that response. A fabricated video ID renders as "Video
unavailable", which looks like a broken theme, so ids are never invented.

## Supported platforms

| Platform  | Status                                                          |
| --------- | --------------------------------------------------------------- |
| **Ghost** | ✅ Supported — Admin API, Lexical, image upload, theme analysis |
| WordPress | 📋 Planned — contributions welcome                              |
| Joomla    | 📋 Planned — contributions welcome                              |
| Drupal    | 📋 Planned — contributions welcome                              |
| Magento   | 📋 Planned — contributions welcome                              |

Adding one is a self-contained job: implement `CmsProvider`, register it, add tests. Nothing in
the content generator, image sources, CLI or MCP tools needs to change. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

Sites live in `~/.themeseed/sites.json`, written `0600`, never inside a repository:

```json
{
  "version": 1,
  "defaultSite": "blog",
  "sites": {
    "blog": {
      "platform": "ghost",
      "url": "http://localhost:2368",
      "credentials": { "adminApiKey": "<id>:<secret>" },
      "options": { "themesDir": "/path/to/ghost/content/themes" }
    }
  }
}
```

Get a Ghost Admin API key from **Ghost Admin → Settings → Integrations → Add custom
integration**. It is the key with a colon in it — the Content API key will not work.

Environment variables (all optional) are documented in [`.env.example`](.env.example).
`THEMESEED_LOG_LEVEL=debug` turns on verbose diagnostics; all logging goes to stderr, because
stdout belongs to the MCP protocol.

## Architecture

```
src/
  core/types.ts            platform-neutral domain model — the contract everything shares
  core/seed.ts             analyze → generate → publish, used by both CLI and MCP
  providers/provider.ts    the CmsProvider interface
  providers/registry.ts    platform name → implementation (one line per platform)
  providers/ghost/         the only place Ghost's vocabulary exists
  content/generator.ts     topic + capabilities → neutral blocks
  content/engine.ts        prose, behind a swappable interface
  images/                  local | stock | ai, behind one ImageSource interface
  mcp/                     MCP server and tools
  cli/                     commander + clack
```

Two rules hold the whole thing together:

1. **Nothing outside `src/providers/<platform>/` may import that platform's types.** Shared code
   talks only to `CmsProvider`.
2. **The generator emits neutral blocks, never a CMS storage format.** Conversion to Ghost's
   Lexical happens only in `src/providers/ghost/lexical.ts`. This is what makes WordPress support
   a provider-only change rather than a rewrite.

## Development

```bash
npm install
cp .env.example .env      # point GHOST_TEST_BLOG_* at a disposable Ghost
npm run verify            # typecheck + lint + unit tests
npm run test:e2e          # integration tests against the real instance
npm run test:loop         # the autonomous seed/verify/wipe loop
```

`npm run test:loop` seeds 15 posts, verifies them by reading back through Ghost's own Admin API
(deliberately not through themeseed's `listSeeded`, so a bug affecting both cannot hide), and
repeats until three consecutive clean runs, then wipes and confirms zero. Each iteration is
appended to `test-loop.log`.

Handy probes, none of which are part of the test suite:

```bash
npx tsx scripts/probe-theme.ts --themes-dir /path/to/content/themes
npx tsx scripts/probe-images.ts
npx tsx scripts/probe-video.ts "deep work"
npm run build && npx tsx scripts/probe-mcp.ts
```

## Open questions

Three decisions are deliberately **not** settled in code. See
[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) for the full trade-offs.

1. **License** — currently MIT, provisionally. Confirm MIT vs Apache-2.0.
2. **Distribution** — private to `npm.indianic.in`, or also public npm/GitHub under a public org.
3. **Stock image provider** — standardise on Unsplash, Pexels, both, or keep all three.

## License

MIT — see [LICENSE](LICENSE). Provisional pending the decision above.
