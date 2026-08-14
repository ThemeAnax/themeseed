/** Errors that carry enough context to print a useful message to a human. */

export class ThemeseedError extends Error {
  readonly code: string;
  /** Concrete next step for the user, when there is one. */
  readonly hint?: string;

  constructor(message: string, options: { code?: string; hint?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ThemeseedError';
    this.code = options.code ?? 'THEMESEED_ERROR';
    if (options.hint) this.hint = options.hint;
  }
}

/** A CMS rejected us, or could not be reached. */
export class ProviderError extends ThemeseedError {
  readonly status?: number;

  constructor(
    message: string,
    options: { code?: string; hint?: string; status?: number; cause?: unknown } = {}
  ) {
    super(message, { code: options.code ?? 'PROVIDER_ERROR', ...options });
    this.name = 'ProviderError';
    if (options.status !== undefined) this.status = options.status;
  }
}

export class ConfigError extends ThemeseedError {
  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { code: 'CONFIG_ERROR', ...options });
    this.name = 'ConfigError';
  }
}

/** Formats any thrown value into a single human-readable line (plus hint). */
export function describeError(err: unknown): string {
  if (err instanceof ThemeseedError) {
    return err.hint ? `${err.message}\n  → ${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
