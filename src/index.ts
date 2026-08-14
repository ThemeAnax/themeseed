/**
 * Public library surface.
 *
 * Consumers embedding themeseed (rather than using the CLI or MCP server) get
 * the neutral domain model, the provider contract and the orchestrator. Nothing
 * Ghost-specific is exported here on purpose — see `./providers` for the
 * registry, and CONTRIBUTING.md for how to add a platform.
 */

export * from './core/types.js';
export { ConfigError, ProviderError, ThemeseedError, describeError } from './core/errors.js';
export { logger, setLogLevel, maskSecret } from './core/logger.js';
export type { LogLevel } from './core/logger.js';
export { seedSite } from './core/seed.js';
export type { SeedPhase, SeedReport, SeedRequest } from './core/seed.js';
export { readVersion } from './core/version.js';

export { generateSeedContent, slugify } from './content/generator.js';
export type { GenerateOptions, GenerateSummary } from './content/generator.js';
export { TemplateContentEngine, profileTopic } from './content/engine.js';
export type { ContentEngine, OutlineRequest, TopicProfile } from './content/engine.js';
export { YouTubeVideoFinder } from './content/video.js';

export * from './images/index.js';

export {
  createProvider,
  hasProvider,
  implementedPlatforms,
  registerProvider,
} from './providers/registry.js';
export type {
  CmsProvider,
  CreateContentOptions,
  ProviderFactory,
  SiteConfig,
  SiteCredentials,
  SiteInfo,
} from './providers/provider.js';

export {
  addSite,
  configDir,
  getSite,
  listSitesSafe,
  loadSites,
  removeSite,
  resolveSite,
  saveSites,
  sitesPath,
} from './config/sites.js';
export type { SitesFile } from './config/sites.js';

export { createThemeseedServer, SERVER_NAME } from './mcp/server.js';
