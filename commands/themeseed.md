---
name: themeseed
description: Fill a CMS with realistic demo content so a theme can be previewed properly. Walks through connecting a site and image providers on first use, then seeds.
---

Help the user seed their CMS with demo content using the themeseed MCP tools.

## First, work out where they are

Call `list_sites`.

**No sites configured yet** — they need two things before anything can be seeded:

1. **A site.** For Ghost they need an Admin API key: Ghost Admin → Settings →
   Integrations → Add custom integration, then copy the **Admin API key** (it
   looks like `<id>:<hex secret>`). The Content API key will not work. Ask them
   to add it themselves rather than pasting a secret into the chat:

   ```
   themeseed add-site
   ```

   If they would rather you did it, use `add_site` — it verifies the credentials
   before saving, so a bad key fails immediately instead of at publish time.

2. **An image provider, optionally.** Without a key, posts publish with no
   images, which previews a theme's typography but not its layout. A free
   Unsplash or Pexels key fixes that:

   ```
   themeseed images
   ```

   Configuring both is worth it: if one hits its hourly quota mid-run, themeseed
   continues on the other instead of losing the rest of the run's images.

**Sites already configured** — go straight to seeding.

## Then seed

Ask what the publication should be about, unless they have already said. If they
have no preference, call `generate_posts` without a `topic` and it will ask, or
pick a random subject if they still do not care.

Judgment calls worth making rather than asking about:

- **Write the titles yourself** and pass them as `titles`. The built-in template
  engine is deterministic and offline by design, which makes its headlines
  repeat their shapes across a run. Your own read like a real publication's.
- **Set `studyTheme: true`** when the point is to preview _this_ theme. It costs
  one extra round trip and means galleries and video embeds are only used where
  the theme can actually style them — an unstyled gallery card renders worse
  than the plain post it replaced.
- **Default to 10–15 posts.** Enough to fill an index page and show pagination.

Report what actually landed: how many posts, how many carried a feature image
and a body image, and whether `skipped.images` came back with a reason. A run
that publishes ten posts with no images is a failure worth naming, not a success.

## Fixing and cleaning up

- One post wrong — missing a hero, or one you want gone? `update_post` edits it
  in place. Do not delete and re-seed for a single post.
- Everything tagged `#themeseed` disappears with `wipe_seeded`. It defaults to a
  dry run; pass `confirm: true` to actually delete. It never touches content
  themeseed did not create, but **always show the user what will be removed
  before confirming**.

$ARGUMENTS
