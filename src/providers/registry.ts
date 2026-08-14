/**
 * Platform name → provider implementation.
 *
 * This is the single place a new CMS gets wired in. Adding WordPress is:
 *   import { createWordPressProvider } from './wordpress/index.js';
 *   registerProvider('wordpress', createWordPressProvider);
 * and nothing else in shared code changes.
 */

import { ThemeseedError } from '../core/errors.js';
import { IMPLEMENTED_PLATFORMS, type Platform } from '../core/types.js';
import { createGhostProvider } from './ghost/index.js';
import type { CmsProvider, ProviderFactory, SiteConfig } from './provider.js';

const registry = new Map<Platform, ProviderFactory>();

export function registerProvider(platform: Platform, factory: ProviderFactory): void {
  registry.set(platform, factory);
}

export function hasProvider(platform: Platform): boolean {
  return registry.has(platform);
}

export function implementedPlatforms(): Platform[] {
  return [...registry.keys()];
}

export function createProvider(site: SiteConfig): CmsProvider {
  const factory = registry.get(site.platform);
  if (!factory) {
    throw new ThemeseedError(`No provider implemented for platform "${site.platform}"`, {
      code: 'PROVIDER_NOT_IMPLEMENTED',
      hint:
        `Currently implemented: ${IMPLEMENTED_PLATFORMS.join(', ')}. ` +
        'Contributions for the others are welcome — see CONTRIBUTING.md.',
    });
  }
  return factory(site);
}

registerProvider('ghost', createGhostProvider);
