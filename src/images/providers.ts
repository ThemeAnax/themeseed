/**
 * The one description of every image provider themeseed can be configured with.
 *
 * Four things read this table: the generated `~/.themeseed/.env` template, the
 * `themeseed init` wizard, `themeseed images --list`, and the `auto` image
 * source resolver. Keeping them on one list is the point — a provider added in
 * four places is a provider that ends up documented in three.
 */

export type ProviderCategory = 'stock' | 'ai' | 'local';

export interface ImageProviderInfo {
  id: string;
  label: string;
  category: ProviderCategory;
  /**
   * Environment variable holding the credential. Null for providers that need
   * none, which cannot be "configured" and are skipped by configuredProviders.
   */
  envKey: string | null;
  /** Where a key comes from. Empty when none is needed. */
  signupUrl: string;
  /** One line, shown in the .env template and as a wizard hint. */
  note: string;
}

export const IMAGE_PROVIDERS: readonly ImageProviderInfo[] = [
  {
    id: 'unsplash',
    label: 'Unsplash',
    category: 'stock',
    envKey: 'UNSPLASH_ACCESS_KEY',
    signupUrl: 'https://unsplash.com/developers',
    note: 'Free developer tier. Best match quality of the two stock APIs.',
  },
  {
    id: 'pexels',
    label: 'Pexels',
    category: 'stock',
    envKey: 'PEXELS_API_KEY',
    signupUrl: 'https://www.pexels.com/api/',
    note: 'Free, generous rate limit, no attribution requirement.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'ai',
    envKey: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    note: 'OpenAI Images API. Paid per image.',
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    category: 'ai',
    envKey: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai/',
    note: 'grok-imagine-image. Paid per image.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    category: 'ai',
    envKey: 'GOOGLE_API_KEY',
    signupUrl: 'https://aistudio.google.com/apikey',
    note: 'Needs billing enabled on the project, or every call returns 429.',
  },
  {
    id: 'fal',
    label: 'fal.ai',
    category: 'ai',
    envKey: 'FAL_KEY',
    signupUrl: 'https://fal.ai/dashboard/keys',
    note: 'Hosted open models. The key is "<id>:<secret>".',
  },
  {
    id: 'procedural',
    label: 'Procedural placeholders',
    category: 'ai',
    envKey: null,
    signupUrl: '',
    note: 'Locally generated placeholder art. Needs no key, and is not AI.',
  },
  {
    id: 'local',
    label: 'Local folder',
    category: 'local',
    envKey: 'THEMESEED_LOCAL_IMAGE_DIR',
    signupUrl: '',
    note: 'A directory of images on this machine.',
  },
] as const;

export type ProviderEnv = Record<string, string | undefined>;

export function findProvider(id: string): ImageProviderInfo | undefined {
  return IMAGE_PROVIDERS.find((provider) => provider.id === id);
}

export function providersByCategory(category: ProviderCategory): ImageProviderInfo[] {
  return IMAGE_PROVIDERS.filter((provider) => provider.category === category);
}

/**
 * True when this provider's credential is present and not blank. A variable
 * uncommented but left empty is the common half-configured state, and treating
 * it as configured sends every request out unauthorised.
 */
export function isConfigured(
  provider: ImageProviderInfo,
  env: ProviderEnv = process.env
): boolean {
  if (!provider.envKey) return false;
  return (env[provider.envKey] ?? '').trim().length > 0;
}

export function configuredProviders(env: ProviderEnv = process.env): ImageProviderInfo[] {
  return IMAGE_PROVIDERS.filter((provider) => isConfigured(provider, env));
}

export function hasStockKey(env: ProviderEnv = process.env): boolean {
  return providersByCategory('stock').some((provider) => isConfigured(provider, env));
}

export function hasAiKey(env: ProviderEnv = process.env): boolean {
  return providersByCategory('ai').some((provider) => isConfigured(provider, env));
}
