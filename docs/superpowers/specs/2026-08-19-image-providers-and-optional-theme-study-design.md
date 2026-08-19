# Image providers, generated config files, and optional theme study

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning
**Target version:** 0.2.0

## Problem

Three defects surfaced after `@indianic/themeseed@0.1.1` shipped to `npm.indianic.in`.

**Image provider keys never reach the MCP server.** Both entry points call
`dotenv.config()` with no path, so dotenv reads `.env` from the current working
directory. An editor launching `themeseed-mcp` sets that directory to whatever
project it happens to have open, so `UNSPLASH_ACCESS_KEY`, `OPENAI_API_KEY` and
their siblings resolve to nothing. Stock lookups silently degrade to keyless
Lorem Picsum, which ignores the query and returns unrelated photographs.

**Nothing ever asks for those keys.** `themeseed init` registers the MCP server
with editors and adds a site. It never mentions image sources, and no other
command configures them. The only documentation is `.env.example` in the
repository, which the header marks as configuration for the project's own e2e
suite. A user who installs from the registry never sees that file.

**Theme analysis runs on every seed.** `seedSite()` calls
`provider.analyzeTheme()` unconditionally, then warns when confidence falls
below 0.35. Reading a theme costs a round trip and is worth paying for only
when the user asks for content matched to the theme's design.

## Goals

1. Generate `~/.themeseed/.env` and a documented site-config template on first
   run, with every field present and commented out.
2. Prompt for stock and AI image providers during `themeseed init`, and offer
   the same flow on demand afterwards.
3. Load those keys in both the CLI and the MCP server regardless of working
   directory.
4. Make images optional. A run with no provider configured publishes text-only
   posts instead of failing or falling back to irrelevant stock photography.
5. Make theme study opt-in. Skip it unless the caller asks, and never prompt.

## Non-goals

- Per-project key overrides. Keys live in one global file.
- Content-engine setup in the wizard. The generated `.env` documents
  `THEMESEED_CONTENT_ENGINE` and `ANTHROPIC_API_KEY`, but the first-run prompts
  cover image providers only.
- Writing secrets through MCP tools. Keys are entered at a terminal prompt, not
  handed to a model.
- New CMS providers. Ghost remains the only implementation.

## Decisions

| Question | Decision | Rejected alternative |
| --- | --- | --- |
| Where does `.env` live? | `~/.themeseed/.env` only | Project `./.env`, or global plus project override. One file, one place to look. |
| How does a config template carry comments? | A separate `sites.example.json` | JSONC in the live `sites.json`. Every save rewrites that file and would strip the user's comments, and `JSON.parse` elsewhere would break. |
| Does theme analysis run by default? | No. Opt in per call | Always-on but silent, which still pays the cost this work exists to remove. |
| What happens with no image provider? | Resolve to a new `none` source | Keep defaulting to stock and fall through to Lorem Picsum placeholders. |

## Design

### Config directory layout

All user-facing configuration moves under the directory `configDir()` already
returns, so `THEMESEED_CONFIG_DIR` keeps working:

```
~/.themeseed/
  sites.json           live config, strict JSON, mode 0600   (unchanged)
  .env                 image and AI provider keys, mode 0600 (new)
  sites.example.json   documented template, mode 0644        (new)
```

`.env` holds secrets, so `ensureEnvFile()` writes the template only when the
file is absent and never overwrites it. `sites.example.json` holds no secrets
and documents the current schema, so `init` regenerates it every run.

### `src/config/env.ts` (new)

| Export | Behaviour |
| --- | --- |
| `envPath()` | `path.join(configDir(), '.env')` |
| `loadUserEnv()` | `dotenv.config({ path: envPath(), quiet: true })`. Variables already exported in the process win, because dotenv does not override. |
| `ensureEnvFile()` | Creates the directory at mode 0700 and the file at 0600 with the full commented template, only when missing. Returns whether it created anything. |
| `readEnvValues()` | Parses the file and returns the keys that carry a value, ignoring commented lines. |
| `setEnvValues(updates)` | Comment-preserving upsert. For each key, replaces the first line matching `^#?\s*KEY=`; appends under the matching section header when no such line exists. Writes to a temp file and renames, mirroring `saveSites()`, so an interrupted write cannot truncate the file. |

`src/cli/index.ts` and `src/mcp/index.ts` call `loadUserEnv()` in place of the
current bare `dotenv.config()`.

Dropping the working-directory load does not affect the e2e suite:
`test/e2e/ghost.e2e.test.ts` imports `dotenv/config` itself, so it still reads
the repository's own `.env` for `GHOST_TEST_BLOG_ENDPOINT` and
`GHOST_TEST_BLOG_KEY`.

### `src/config/templates.ts` (new)

`ensureSitesExample()` writes `~/.themeseed/sites.example.json`. The file is
strict JSON and uses `"//"` keys for documentation, so a user can copy it to
`sites.json`, delete the `"//"` entries, and fill in values. It documents
`version`, `defaultSite`, and every field of a site entry: `platform`, `url`,
`credentials`, and `options.themesDir`.

### `src/images/providers.ts` (new)

One table describes every provider — id, label, environment variable, signup
URL, and category. The `.env` template, the init wizard, `themeseed images
--list`, and automatic resolution all read from it, so the four cannot drift
apart.

```
stock:  unsplash    UNSPLASH_ACCESS_KEY
        pexels      PEXELS_API_KEY
ai:     openai      OPENAI_API_KEY
        grok        XAI_API_KEY
        gemini      GOOGLE_API_KEY
        fal         FAL_KEY
        procedural  (no key)
local:  directory   THEMESEED_LOCAL_IMAGE_DIR
```

`configuredProviders()` reads `process.env` through this table and reports
which providers are usable.

### `themeseed init`

The flow gains a step and a preamble:

1. Write `~/.themeseed/.env` and `sites.example.json`. Silent, always.
2. Register the MCP server with detected editors. Unchanged.
3. Configure image providers. New.
4. Add a site. Unchanged.

Step 3 opens with a multiselect over Stock photos, AI generation, and a local
folder. Each selection then asks which provider and takes the key through a
masked prompt, and the answer lands in `.env` through `setEnvValues()`.
Declining is a first-class answer, and the step says what declining means:
posts publish without images until a key arrives.

New flag `--skip-images` skips step 3. The existing `-y, --yes` skips the
prompts and writes the templates only.

### `themeseed images` (new command)

The same configuration, available at any time:

| Invocation | Behaviour |
| --- | --- |
| `themeseed images` | Interactive, identical to init step 3 |
| `themeseed images --list` | Prints each provider, whether a key is set, the masked key, and which provider `auto` would choose |
| `themeseed images --set <provider> --key <value>` | Non-interactive write. `<value>` is an API key for every provider except `local`, where it is a directory path written to `THEMESEED_LOCAL_IMAGE_DIR`. |
| `themeseed images --remove <provider>` | Comments the line out again, discarding the value |

### Optional images

`ImageSourceKind` gains `'none'`. A new `NoneImageSource` in
`src/images/none-source.ts` reports itself available and returns an empty array
from `fetch()`.

`'auto'` is a request value, not a resolved kind, so `ImageRef.source` never
records a value that was not the source. A new type expresses the difference:

```ts
// src/core/types.ts
export type ImageSourceKind = 'local' | 'stock' | 'ai' | 'none';
export type RequestedImageSource = ImageSourceKind | 'auto';
```

`SeedRequest.imageSource` widens from `ImageSourceKind` to
`RequestedImageSource`. `ImageRef.source` keeps the narrower
`ImageSourceKind`.

`resolveImageSourceKind(requested)` in `src/images/index.ts` maps `'auto'` to
`'ai'` when an AI key is set, otherwise `'stock'` when a stock key is set,
otherwise `'none'`. Every other value passes through unchanged.

The default changes from `'stock'` to `'auto'` in three places. The CLI flag
becomes `-i, --image-source <auto|local|stock|ai|none>`, defaulting to `auto`.
The MCP `imageSource` enum grows from `['local', 'stock', 'ai']` to
`['auto', 'local', 'stock', 'ai', 'none']`, defaulting to `auto`. An explicit
`'stock'` or `'ai'` still runs through `createUsableImageSource()` and still
fails loudly on a missing key, so a deliberate choice never degrades quietly.
Only `'auto'` degrades, and it degrades to `'none'`.

No change to the generator is required. `manyImages()` in
`src/content/generator.ts` already catches every failure and returns an empty
array, and `featureImage` is already optional on `SeedContent`, so an empty
result yields a post without pictures.

### Optional theme study

`src/core/theme-defaults.ts` (new) exports `genericCapabilities(platform)`,
returning a neutral `ThemeCapabilities`:

| Field | Value | Reason |
| --- | --- | --- |
| `supportsFeatureImage` | `true` | Nearly every theme renders one |
| `featureImageAspectRatio` | `1.5` | The common 3:2 hero |
| `supportsCodeBlocks` | `true` | Renders acceptably even when unstyled |
| `supportsGallery`, `supportsVideoEmbed`, `supportsBookmarkCard`, `supportsWideImages` | `false` | A card the theme cannot style looks worse than its absence |
| `displaysTags`, `displaysAuthor`, `displaysExcerpt` | `true` | Standard blog furniture |
| `displaysAuthorImage`, `displaysReadingTime` | `false` | Theme-specific |
| `expectedWordCount` | `{ min: 500, target: 850, max: 1200 }` | Reads well in any layout |
| `themeName` | `'unknown'` | Nothing was measured |
| `confidence` | `0` | Nothing was measured |
| `evidence` | `['no theme analysis requested — generic defaults']` | Explains the zero |
| `analyzedVia` | `['defaults']` | Distinguishes this from a failed analysis |

`SeedRequest` gains `studyTheme?: boolean`, defaulting to false, and
`seedSite()` becomes:

```ts
const capabilities =
  request.capabilities ??
  (request.studyTheme
    ? await provider.analyzeTheme()
    : genericCapabilities(request.site.platform));
```

The low-confidence warning fires only when `studyTheme` was true. An
unrequested analysis cannot warn about itself.

Surfaces:

- CLI gains `themeseed seed --study-theme`. `themeseed analyze` is unchanged,
  because running it is itself the explicit instruction.
- MCP `generate_posts` gains `studyTheme`, default false, described so the host
  model sets it when the user asks for content matched to the theme and leaves
  it alone otherwise.
- The server `instructions` string tells hosts to "call analyze_theme first".
  That sentence drives the always-analyze behaviour and becomes "call
  analyze_theme only when the user asks about the theme".

## Files

**New:** `src/config/env.ts`, `src/config/templates.ts`,
`src/images/providers.ts`, `src/images/none-source.ts`,
`src/core/theme-defaults.ts`, `src/cli/commands/images.ts`,
`test/unit/env.test.ts`, `test/unit/image-resolve.test.ts`,
`test/unit/theme-defaults.test.ts`

**Modified:** `src/core/types.ts`, `src/core/seed.ts`, `src/images/index.ts`,
`src/mcp/index.ts`, `src/mcp/server.ts`, `src/cli/index.ts`,
`src/cli/commands/init.ts`, `src/cli/commands/content.ts`, `README.md`,
`CHANGELOG.md`, `package.json`

## Testing

Unit tests, run through the existing `unit` vitest project. Every test that
touches the config directory points `THEMESEED_CONFIG_DIR` at a temporary
directory.

- `setEnvValues()` uncomments an existing commented key in place, rather than
  appending a duplicate.
- `setEnvValues()` preserves surrounding comments and section headers.
- `ensureEnvFile()` leaves an existing file untouched.
- `loadUserEnv()` does not override a variable already exported in the process.
- `resolveImageSourceKind('auto')` returns `ai`, `stock`, and `none` across the
  three key combinations, and passes explicit kinds through unchanged.
- `NoneImageSource` reports availability and returns an empty array.
- `seedSite()` with `studyTheme` unset never calls `analyzeTheme()` and uses
  `genericCapabilities()`; with `studyTheme: true` it calls `analyzeTheme()`.
  The test needs no module mocking: `registerProvider()` is exported from
  `src/providers/registry.ts`, so it registers a counting fake under an
  unimplemented platform such as `wordpress` and seeds against that.
- `sites.example.json` parses under `JSON.parse`.

## Release

Version 0.2.0. The minor bump reflects two changed defaults: `imageSource`
resolves automatically instead of always choosing stock, and theme analysis no
longer runs unless requested.

`README.md` gains a section on image providers and the `~/.themeseed/` layout,
and documents `--study-theme`. `CHANGELOG.md` records both default changes
under Unreleased.
