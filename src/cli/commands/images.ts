/**
 * `themeseed images` — configure where pictures come from.
 *
 * The same wizard runs during `themeseed init` and on demand afterwards, so
 * there is one flow to maintain and one place a key can be entered. Keys are
 * taken through a masked prompt rather than an argument by default: a key
 * typed as `--key sk-...` lands in shell history and in `ps` output.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { ensureEnvFile, envPath, readEnvValues, setEnvValues } from '../../config/env.js';
import { ConfigError } from '../../core/errors.js';
import {
  IMAGE_PROVIDERS,
  findProvider,
  hasAiKey,
  hasStockKey,
  isConfigured,
  providersByCategory,
  type ImageProviderInfo,
} from '../../images/providers.js';
import { assertInteractive, cancelled, note, success } from '../ui.js';

export interface ImagesFlags {
  list?: boolean;
  set?: string;
  key?: string;
  remove?: string;
}

export async function imagesCommand(flags: ImagesFlags = {}): Promise<void> {
  if (flags.list) return listProviders();
  if (flags.remove) return removeProvider(flags.remove);
  if (flags.set) return setProvider(flags.set, flags.key);

  assertInteractive(
    'A terminal',
    'Use `themeseed images --set <provider> --key <value>` to configure without prompts.'
  );
  p.intro(pc.bgCyan(pc.black(' themeseed — image sources ')));
  await runImageWizard();
  p.outro(`Saved to ${pc.cyan(envPath())}`);
}

/**
 * The shared wizard. `init` calls this between editor setup and site setup,
 * inside its own intro/outro, which is why it prints neither.
 */
export async function runImageWizard(): Promise<void> {
  await ensureEnvFile();
  const current = await readEnvValues();

  p.note(
    'themeseed can illustrate posts three ways. Every one of them is optional:\n' +
      'with none configured, posts publish as text, which is a fair preview of a\n' +
      'theme too. You can add these later with `themeseed images`.',
    'Image sources'
  );

  const categories = await p.multiselect({
    message: 'Which image sources do you want to set up?',
    options: [
      {
        value: 'stock',
        label: 'Stock photos',
        hint: `Unsplash or Pexels${hasStockKey(current) ? ' — configured' : ''}`,
      },
      {
        value: 'ai',
        label: 'AI generated',
        hint: `OpenAI, Grok, Gemini or fal${hasAiKey(current) ? ' — configured' : ''}`,
      },
      {
        value: 'local',
        label: 'A folder on this machine',
        hint: 'Images you already have',
      },
    ],
    initialValues: [],
    required: false,
  });
  if (p.isCancel(categories)) cancelled();

  const chosen = categories as Array<'stock' | 'ai' | 'local'>;
  if (chosen.length === 0) {
    note('Skipped. Posts will publish without images until you add a provider.');
    note(`Add one any time with ${pc.cyan('themeseed images')}.`);
    return;
  }

  for (const category of chosen) {
    const candidates = providersByCategory(category).filter(
      (provider) => provider.envKey !== null
    );

    let provider: ImageProviderInfo | undefined = candidates[0];
    if (candidates.length > 1) {
      const picked = await p.select({
        message: `Which ${category === 'ai' ? 'AI' : category} provider?`,
        options: candidates.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
          hint: isConfigured(candidate, current)
            ? 'already configured — will replace'
            : candidate.note,
        })),
      });
      if (p.isCancel(picked)) cancelled();
      provider = findProvider(picked as string);
    }
    if (!provider?.envKey) continue;

    if (provider.signupUrl) note(`Get a key at ${pc.cyan(provider.signupUrl)}`);

    const isPath = provider.category === 'local';
    const value = isPath
      ? await p.text({
          message: 'Path to the folder',
          placeholder: '/Users/you/Pictures/seed',
          validate: (input) => (input ? undefined : 'Required.'),
        })
      : await p.password({
          message: `${provider.label} key`,
          validate: (input) => (input ? undefined : 'Required.'),
        });
    if (p.isCancel(value)) cancelled();

    await setEnvValues({ [provider.envKey]: (value as string).trim() });
    success(`${provider.label} saved.`);
  }
}

async function listProviders(): Promise<void> {
  const current = await readEnvValues();
  console.log(`\n${pc.bold('Image providers')} ${pc.dim(envPath())}\n`);

  for (const category of ['stock', 'ai', 'local'] as const) {
    console.log(pc.dim(`  ${category}`));
    for (const provider of providersByCategory(category)) {
      const state = !provider.envKey
        ? pc.dim('no key needed')
        : isConfigured(provider, current)
          ? pc.green(mask(current[provider.envKey] ?? ''))
          : pc.dim('not set');
      console.log(`    ${provider.label.padEnd(24)} ${state}`);
    }
  }

  const auto = hasAiKey(current) ? 'ai' : hasStockKey(current) ? 'stock' : 'none';
  console.log(`\n  ${pc.bold('auto')} currently resolves to ${pc.cyan(auto)}`);
  if (auto === 'none') {
    console.log(pc.dim('  Posts will publish without images. Run `themeseed images`.'));
  }
  console.log('');
}

async function setProvider(id: string, value?: string): Promise<void> {
  const provider = requireProvider(id);
  if (!provider.envKey) {
    throw new ConfigError(`${provider.label} needs no key`, {
      hint: 'It is always available. There is nothing to configure.',
    });
  }
  if (!value) {
    throw new ConfigError(`--key is required with --set ${id}`, {
      hint:
        provider.category === 'local'
          ? 'Pass the directory path, e.g. --set local --key /Users/you/Pictures'
          : `Pass the API key, e.g. --set ${id} --key <key>. Run \`themeseed images\` to be prompted instead, which keeps it out of shell history.`,
    });
  }
  await setEnvValues({ [provider.envKey]: value.trim() });
  success(`${provider.label} saved to ${envPath()}`);
}

async function removeProvider(id: string): Promise<void> {
  const provider = requireProvider(id);
  if (!provider.envKey) {
    throw new ConfigError(`${provider.label} has no key to remove`, {
      hint: 'It needs no configuration.',
    });
  }
  await setEnvValues({ [provider.envKey]: null });
  success(`${provider.label} removed from ${envPath()}`);
}

function requireProvider(id: string): ImageProviderInfo {
  const provider = findProvider(id);
  if (!provider) {
    throw new ConfigError(`Unknown image provider "${id}"`, {
      hint: `Known providers: ${IMAGE_PROVIDERS.map((entry) => entry.id).join(', ')}`,
    });
  }
  return provider;
}

/** Shows enough of a key to recognise it, and not enough to use it. */
function mask(value: string): string {
  if (value.length <= 8) return `set (${value.length} chars)`;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
