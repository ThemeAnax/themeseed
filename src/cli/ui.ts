/** Small shared console helpers, so command output looks like one program. */

import * as p from '@clack/prompts';
import pc from 'picocolors';

export function success(message: string): void {
  console.log(`${pc.green('✔')} ${message}`);
}

export function fail(message: string): void {
  console.log(`${pc.red('✖')} ${message}`);
}

export function warn(message: string): void {
  console.log(`${pc.yellow('!')} ${message}`);
}

export function note(message: string): void {
  console.log(`${pc.dim('·')} ${message}`);
}

export function heading(message: string): void {
  console.log(`\n${pc.bold(message)}`);
}

/** Exits cleanly when a user presses Ctrl-C at a prompt. */
export function cancelled(): never {
  p.cancel('Cancelled.');
  process.exit(130);
}

export function yesNo(value: boolean): string {
  return value ? pc.green('yes') : pc.dim('no');
}

export interface Spinner {
  start(message?: string): void;
  message(text: string): void;
  stop(message?: string): void;
}

/**
 * A spinner that animates on a terminal and prints plain lines when it is not.
 *
 * clack's spinner redraws unconditionally, which turns piped output and CI
 * logs into thousands of escape sequences — the seed command emitted several
 * hundred lines of cursor codes for a five-post run.
 */
export function spinner(): Spinner {
  if (process.stdout.isTTY) return p.spinner();

  let last = '';
  return {
    start(message = '') {
      last = message;
      if (message) console.log(`${pc.dim('·')} ${message}`);
    },
    message(text: string) {
      // Only report meaningful changes, not every animation tick.
      if (text && text !== last) {
        last = text;
        console.log(`${pc.dim('·')} ${text}`);
      }
    },
    stop(message = '') {
      if (message) console.log(`${pc.green('✔')} ${message}`);
    },
  };
}
