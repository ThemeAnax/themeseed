/**
 * Every log line goes to stderr, without exception.
 *
 * The MCP server speaks JSON-RPC over stdout. A single stray `console.log`
 * anywhere in the dependency tree corrupts the stream and the host drops the
 * connection with an unhelpful parse error. Routing all diagnostics to stderr
 * makes that class of bug impossible, and stderr is what MCP hosts surface in
 * their logs anyway.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function resolveLevel(): LogLevel {
  const raw = process.env.THEMESEED_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_RANK) return raw as LogLevel;
  return 'info';
}

let current: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, 'silent'>, prefix: string, args: unknown[]): void {
  if (LEVEL_RANK[current] < LEVEL_RANK[level]) return;
  const parts = args.map((a) =>
    typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : inspect(a)
  );
  process.stderr.write(`${prefix} ${parts.join(' ')}\n`);
}

function inspect(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  error: (...args: unknown[]) => emit('error', '[themeseed:error]', args),
  warn: (...args: unknown[]) => emit('warn', '[themeseed:warn]', args),
  info: (...args: unknown[]) => emit('info', '[themeseed]', args),
  debug: (...args: unknown[]) => emit('debug', '[themeseed:debug]', args),
};

/**
 * Masks a secret for display: keeps enough to identify which key is in use,
 * never enough to use it. Ghost Admin keys are `<id>:<secret>` — the id half
 * is not sensitive on its own, but we still truncate it.
 */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '<unset>';
  const [head] = secret.split(':');
  const id = head ?? '';
  if (id.length <= 6) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 6)}…:<redacted ${secret.length} chars>`;
}
