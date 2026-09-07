/**
 * The MCP server surface.
 *
 * Tools return human-readable text plus a `structuredContent` payload, because
 * hosts differ in which they use and a model reading "created 15 posts, 1
 * failed" acts more sensibly than one parsing raw JSON.
 *
 * Everything here delegates to `seedSite` and the provider registry — no Ghost
 * knowledge lives at this layer, so a WordPress site works the moment its
 * provider is registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadUserEnv } from '../config/env.js';
import { addSite, listSitesSafe, removeSite, resolveSite } from '../config/sites.js';
import { randomTopic } from '../content/topics.js';
import { describeError, ThemeseedError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { seedSite } from '../core/seed.js';
import { updatePost } from '../core/update.js';
import { IMPLEMENTED_PLATFORMS, PLATFORMS, type Platform } from '../core/types.js';
import { createProvider } from '../providers/registry.js';

export const SERVER_NAME = 'themeseed';

export function createThemeseedServer(version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      instructions:
        'themeseed fills a CMS with realistic demo content so a theme can be previewed with ' +
        'real-looking articles, images, galleries and video embeds. Call generate_posts directly; ' +
        'it needs no setup call first. Pass `topic` when the user named a subject; omit it and ' +
        'the user is asked, so do not invent one. Call analyze_theme only when the user asks ' +
        'about the theme, and set generate_posts.studyTheme when they want content shaped to the ' +
        "theme's design. Every post gets a feature image and a body image when an image provider " +
        'is configured; with no key set, posts publish without them. Everything it creates is ' +
        'tagged #themeseed and can be removed with wipe_seeded. To fix a post that already ' +
        'exists — a missing hero, an unwanted one — use update_post rather than wiping and ' +
        'seeding again. Ghost is supported today.',
    }
  );

  registerSiteTools(server);
  registerContentTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// site management
// ---------------------------------------------------------------------------

function registerSiteTools(server: McpServer): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List configured sites',
      description:
        'Lists sites configured in ~/.themeseed/sites.json. Credentials are never returned.',
      inputSchema: {},
    },
    async () => {
      const sites = await listSitesSafe();
      if (sites.length === 0) {
        return text(
          'No sites configured yet. Add one with add_site, or run `themeseed init`.',
          {
            sites: [],
          }
        );
      }
      const lines = sites.map(
        (site) =>
          `${site.isDefault ? '*' : ' '} ${site.slug} — ${site.platform} at ${site.url}`
      );
      return text(`Configured sites (* = default):\n${lines.join('\n')}`, { sites });
    }
  );

  server.registerTool(
    'add_site',
    {
      title: 'Add a site',
      description:
        'Registers a CMS and verifies the credentials before saving. For Ghost, credentials must ' +
        'contain adminApiKey in "<id>:<secret>" form (Ghost Admin → Settings → Integrations).',
      inputSchema: {
        slug: z
          .string()
          .describe('Short identifier used to refer to this site, e.g. "client-blog".'),
        platform: z
          .enum(PLATFORMS as unknown as [Platform, ...Platform[]])
          .describe(
            `CMS platform. Implemented today: ${IMPLEMENTED_PLATFORMS.join(', ')}.`
          ),
        url: z
          .string()
          .url()
          .describe('Base URL of the site, e.g. https://blog.example.com'),
        credentials: z
          .record(z.string(), z.string())
          .describe('Platform credentials. Ghost: { "adminApiKey": "<id>:<secret>" }'),
        themesDir: z
          .string()
          .optional()
          .describe(
            'Optional path to the CMS themes directory on this machine. For Ghost this makes ' +
              'theme analysis source-accurate, since its Admin API will not serve theme files.'
          ),
      },
    },
    async ({ slug, platform, url, credentials, themesDir }) => {
      const site = {
        platform,
        url,
        credentials,
        ...(themesDir ? { options: { themesDir } } : {}),
      };

      // Verify before persisting: saving credentials that do not work only
      // moves the failure to a more confusing place.
      const provider = createProvider(site);
      const info = await provider.verifyConnection();

      await addSite(slug, site);
      return text(
        `Added "${slug}" → ${info.title} (${platform}${info.version ? ` ${info.version}` : ''}) at ${info.url}`,
        { slug, platform, url: info.url, title: info.title, version: info.version }
      );
    }
  );

  server.registerTool(
    'remove_site',
    {
      title: 'Remove a site',
      description:
        'Forgets a site from local configuration. Does not touch any content on the site itself.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const removed = await removeSite(slug);
      return text(
        removed
          ? `Removed "${slug}" from local configuration.`
          : `No site configured with slug "${slug}".`,
        { slug, removed }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

function registerContentTools(server: McpServer): void {
  server.registerTool(
    'analyze_theme',
    {
      title: 'Analyze the active theme',
      description:
        "Inspects a site's active theme and reports what it can display: feature images and their " +
        'aspect ratio, gallery and video card support, expected article length, whether tags and ' +
        'authors are shown. Returns evidence for each conclusion and a confidence score.',
      inputSchema: {
        site: z
          .string()
          .optional()
          .describe('Site slug. Defaults to the configured default site.'),
      },
    },
    async ({ site: slug }) => {
      const { slug: resolved, site } = await resolveSite(slug);
      const provider = createProvider(site);
      const capabilities = await provider.analyzeTheme();

      const summary = [
        `Theme "${capabilities.themeName}"${capabilities.themeVersion ? ` v${capabilities.themeVersion}` : ''} on ${resolved}`,
        `  feature image:   ${yesNo(capabilities.supportsFeatureImage)}${
          capabilities.featureImageAspectRatio
            ? ` (aspect ratio ≈ ${capabilities.featureImageAspectRatio})`
            : ''
        }`,
        `  gallery card:    ${yesNo(capabilities.supportsGallery)}`,
        `  video embed:     ${yesNo(capabilities.supportsVideoEmbed)}`,
        `  bookmark card:   ${yesNo(capabilities.supportsBookmarkCard)}`,
        `  wide images:     ${yesNo(capabilities.supportsWideImages)}`,
        `  shows tags:      ${yesNo(capabilities.displaysTags)}`,
        `  shows author:    ${yesNo(capabilities.displaysAuthor)}${capabilities.displaysAuthorImage ? ' (with avatar)' : ''}`,
        `  reading time:    ${yesNo(capabilities.displaysReadingTime)}`,
        `  target length:   ~${capabilities.expectedWordCount.target} words`,
        `  confidence:      ${capabilities.confidence} (via ${capabilities.analyzedVia.join(', ') || 'nothing measurable'})`,
      ].join('\n');

      return text(summary, capabilities);
    }
  );

  server.registerTool(
    'generate_posts',
    {
      title: 'Generate and publish demo posts',
      description:
        'Generates posts, sources images, and publishes them. Set studyTheme to read the ' +
        'active theme first and include only cards it can display; otherwise generic ' +
        'defaults are used and no theme is read. Every post gets a feature image and a ' +
        'body image; galleries and video embeds rotate across the run, and each is used ' +
        'only where the theme can style it. Images resolve from whichever provider keys ' +
        'are configured. Every post is tagged #themeseed so wipe_seeded can remove exactly ' +
        'this content later. Supply `titles` to use your own headlines instead of ' +
        'generated ones.',
      inputSchema: {
        site: z
          .string()
          .optional()
          .describe('Site slug. Defaults to the configured default site.'),
        topic: z
          .string()
          .optional()
          .describe(
            'Subject of the publication, e.g. "SaaS productivity blog". Optional: ' +
              'when omitted the user is asked directly, and a random demo subject is ' +
              'used if they have no preference. Pass it whenever the user named one.'
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(12)
          .describe('How many posts to create.'),
        imageSource: z
          .enum(['auto', 'local', 'stock', 'ai', 'none'])
          .default('auto')
          .describe(
            'auto = AI if an AI key is configured, else stock if a stock key is, else no images. ' +
              'local = a folder on disk (THEMESEED_LOCAL_IMAGE_DIR); stock = Unsplash/Pexels, ' +
              'falling back to keyless Lorem Picsum; ai = a generated image; none = text only. ' +
              'Keys live in ~/.themeseed/.env; the user sets them with `themeseed images`.'
          ),
        status: z
          .enum(['draft', 'published'])
          .default('published')
          .describe('Drafts are invisible to visitors but still previewable in the CMS.'),
        titles: z
          .array(z.string())
          .optional()
          .describe(
            'Your own post titles. Better copy than the built-in template engine produces.'
          ),
        authorName: z.string().optional(),
        includeVideo: z
          .boolean()
          .default(true)
          .describe(
            'Look up real YouTube videos to embed. Set false to skip the network calls.'
          ),
        studyTheme: z
          .boolean()
          .default(false)
          .describe(
            "Read the site's active theme first and shape content to what it can display. " +
              'Set this when the user asks for content that matches their theme or design; ' +
              'leave it false otherwise, because the analysis costs an extra round trip.'
          ),
      },
    },
    async (args) => {
      // Re-read ~/.themeseed/.env. This server outlives the shell that started
      // it, so a key added by `themeseed images` mid-session was invisible
      // until the editor restarted — and the only symptom was images quietly
      // going missing.
      loadUserEnv();

      const { slug, site } = await resolveSite(args.site);
      const topic = args.topic?.trim() || (await askForTopic(server));
      const report = await seedSite({
        site,
        topic,
        count: args.count,
        imageSource: args.imageSource,
        status: args.status,
        includeVideo: args.includeVideo,
        studyTheme: args.studyTheme,
        ...(args.titles?.length ? { titles: args.titles } : {}),
        ...(args.authorName ? { authorName: args.authorName } : {}),
      });

      const lines = [
        `Created ${report.created} of ${args.count} posts about "${topic}" on "${slug}"${
          args.studyTheme ? ` (theme: ${report.capabilities.themeName})` : ''
        }.`,
        `  feature images:  ${report.generation.withFeatureImage}`,
        `  inline images:   ${report.generation.withInlineImage}`,
        `  galleries:       ${report.generation.withGallery}${report.generation.skipped.gallery ? ` (skipped — ${report.generation.skipped.gallery})` : ''}`,
        `  video embeds:    ${report.generation.withVideo}${report.generation.skipped.video ? ` (skipped — ${report.generation.skipped.video})` : ''}`,
      ];
      if (report.generation.skipped.images) {
        lines.push(`  image problem:   ${report.generation.skipped.images}`);
      }
      if (report.failed > 0) {
        lines.push(`  failed:          ${report.failed}`);
        for (const result of report.results.filter((r) => r.error)) {
          lines.push(`    - ${result.title}: ${result.error}`);
        }
      }
      lines.push('', 'Remove all of it later with wipe_seeded.');

      return text(lines.join('\n'), {
        site: slug,
        topic,
        theme: report.capabilities.themeName,
        created: report.created,
        failed: report.failed,
        generation: report.generation,
        posts: report.results.map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          status: r.status,
        })),
      });
    }
  );

  server.registerTool(
    'update_post',
    {
      title: 'Update an existing post',
      description:
        'Edits one post that already exists, changing only what you name. Use it to ' +
        'attach a feature image to a post that has none, remove a feature image, add a ' +
        'body image, or change the title, excerpt or status — without deleting and ' +
        're-seeding. Get ids from list_seeded. By default it refuses to touch a post ' +
        'that is not tagged #themeseed, so it cannot overwrite a real article.',
      inputSchema: {
        site: z
          .string()
          .optional()
          .describe('Site slug. Defaults to the configured default site.'),
        id: z.string().describe('Post id, as reported by list_seeded.'),
        title: z.string().optional().describe('New title. Omit to leave it alone.'),
        excerpt: z.string().optional().describe('New excerpt. Omit to leave it alone.'),
        status: z
          .enum(['draft', 'published'])
          .optional()
          .describe('Publish or unpublish. Omit to leave it alone.'),
        featureImage: z
          .enum(['keep', 'remove', 'replace'])
          .default('keep')
          .describe(
            'keep = leave the hero as it is; remove = delete it; replace = source a new ' +
              'one from the configured image provider.'
          ),
        addBodyImage: z
          .boolean()
          .default(false)
          .describe(
            'Splice one image into the body after the first paragraph, leaving the ' +
              'existing prose untouched.'
          ),
        imageQuery: z
          .string()
          .optional()
          .describe('What to search for. Defaults to the post title.'),
        imageSource: z
          .enum(['auto', 'local', 'stock', 'ai', 'none'])
          .default('auto')
          .describe(
            'Where a replacement image comes from. Same meaning as in generate_posts.'
          ),
        allowUnseeded: z
          .boolean()
          .default(false)
          .describe(
            'Permit editing a post themeseed did not create. Leave false unless the user ' +
              'has explicitly asked to edit their own content.'
          ),
      },
    },
    async (args) => {
      loadUserEnv();

      const { slug, site } = await resolveSite(args.site);
      const report = await updatePost({
        site,
        id: args.id,
        featureImage: args.featureImage,
        addBodyImage: args.addBodyImage,
        imageSource: args.imageSource,
        allowUnseeded: args.allowUnseeded,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.excerpt !== undefined ? { excerpt: args.excerpt } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.imageQuery !== undefined ? { imageQuery: args.imageQuery } : {}),
      });

      const { result } = report;
      if (result.error) {
        return text(`Could not update ${args.id} on "${slug}": ${result.error}`, {
          site: slug,
          id: args.id,
          updated: false,
          error: result.error,
        });
      }

      const lines = [`Updated "${result.title}" on "${slug}".`];
      if (args.featureImage === 'remove') lines.push('  feature image:  removed');
      else if (args.featureImage === 'replace')
        lines.push(
          `  feature image:  ${report.featureImageAttached ? 'replaced' : 'NOT replaced'}`
        );
      if (args.addBodyImage)
        lines.push(
          `  body image:     ${report.bodyImageAttached ? 'added' : 'NOT added'}`
        );
      if (report.imageError) lines.push(`  image problem:  ${report.imageError}`);
      if (result.url) lines.push('', result.url);

      return text(lines.join('\n'), {
        site: slug,
        id: result.id,
        title: result.title,
        url: result.url,
        status: result.status,
        updated: true,
        featureImageAttached: report.featureImageAttached,
        bodyImageAttached: report.bodyImageAttached,
        ...(report.imageError ? { imageError: report.imageError } : {}),
      });
    }
  );

  server.registerTool(
    'list_seeded',
    {
      title: 'List seeded content',
      description:
        'Lists posts themeseed created on a site (everything tagged #themeseed).',
      inputSchema: { site: z.string().optional() },
    },
    async ({ site: slug }) => {
      const { slug: resolved, site } = await resolveSite(slug);
      const provider = createProvider(site);
      const results = await provider.listSeeded();

      if (results.length === 0) {
        return text(`No themeseed content found on "${resolved}".`, {
          site: resolved,
          posts: [],
        });
      }
      const lines = results.map(
        (r) => `  ${r.status.padEnd(9)} ${r.title}${r.url ? ` — ${r.url}` : ''}`
      );
      return text(
        `${results.length} seeded post(s) on "${resolved}":\n${lines.join('\n')}`,
        {
          site: resolved,
          count: results.length,
          posts: results,
        }
      );
    }
  );

  server.registerTool(
    'wipe_seeded',
    {
      title: 'Remove seeded content',
      description:
        'Deletes every post themeseed created on a site, identified by the #themeseed tag. ' +
        'Content the tool did not create is never touched. This cannot be undone.',
      inputSchema: {
        site: z.string().optional(),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            'Must be true to actually delete. False returns what would be removed.'
          ),
      },
    },
    async ({ site: slug, confirm }) => {
      const { slug: resolved, site } = await resolveSite(slug);
      const provider = createProvider(site);

      if (!confirm) {
        const pending = await provider.listSeeded();
        return text(
          `Dry run: ${pending.length} post(s) on "${resolved}" would be deleted. ` +
            'Call again with confirm: true to proceed.',
          { site: resolved, wouldRemove: pending.length, confirmed: false }
        );
      }

      const summary = await provider.wipeSeeded();
      const remaining = await provider.listSeeded();
      const lines = [`Removed ${summary.removed} seeded post(s) from "${resolved}".`];
      if (summary.failed?.length) {
        lines.push(`${summary.failed.length} could not be removed:`);
        for (const failure of summary.failed)
          lines.push(`  - ${failure.id}: ${failure.error}`);
      }
      lines.push(`${remaining.length} seeded post(s) remain.`);

      return text(lines.join('\n'), {
        site: resolved,
        removed: summary.removed,
        failed: summary.failed ?? [],
        remaining: remaining.length,
      });
    }
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Asks the user what to seed about, when the caller did not say.
 *
 * The CLI has always prompted for this; the MCP tool used to make `topic`
 * required, which pushed the model into inventing a subject the user never
 * chose. Elicitation puts the same question to the same person.
 *
 * Not every host implements elicitation, and a tool that hard-fails on an
 * optional nicety is worse than one that picks a sensible demo subject — so
 * anything short of an explicit cancel falls through to a random topic.
 */
async function askForTopic(server: McpServer): Promise<string> {
  try {
    const result = await server.server.elicitInput({
      message:
        'What should the demo posts be about? Leave it blank for a random subject — ' +
        'any realistic copy previews a theme equally well.',
      requestedSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            title: 'Topic',
            description:
              'Subject of the publication, e.g. "SaaS productivity blog". Blank picks one at random.',
          },
        },
      },
    });

    if (result.action === 'cancel') {
      throw new ThemeseedError('No topic was chosen, so nothing was seeded', {
        code: 'TOPIC_REQUIRED',
        hint: 'Call generate_posts again with an explicit `topic`.',
      });
    }

    const value = result.content?.['topic'];
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch (err) {
    if (err instanceof ThemeseedError) throw err;
    logger.debug('host would not elicit a topic; falling back to a random one:', err);
  }
  return randomTopic();
}

function text(message: string, structured?: unknown) {
  return {
    content: [{ type: 'text' as const, text: message }],
    ...(structured !== undefined
      ? { structuredContent: structured as Record<string, unknown> }
      : {}),
  };
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

export { describeError };
