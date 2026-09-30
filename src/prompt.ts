import { createInterface, type Interface } from 'node:readline';

/**
 * Shared terminal prompting.
 *
 * Masked input is the kind of thing that must exist exactly once: it works by
 * monkey-patching a private readline method, and a second copy that drifts out
 * of sync is a password echoed in clear. Both `npm run accounts` and
 * `npm run backup` read secrets, so they read them through here.
 */

export function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

/**
 * Prompt without echoing. readline writes every keystroke through
 * `_writeToOutput`, so we swap it for one that emits asterisks while muted.
 */
export function askHidden(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const target = rl as Interface & { _writeToOutput?: (s: string) => void; output?: NodeJS.WriteStream };
    const original = target._writeToOutput;
    let muted = false;

    target._writeToOutput = (str: string) => {
      if (!muted) {
        target.output?.write(str);
        return;
      }
      // Keep control sequences (backspace, newline) intact; mask the rest.
      target.output?.write(str.includes('\n') ? '\n' : '*');
    };

    rl.question(question, (answer) => {
      muted = false;
      target._writeToOutput = original;
      target.output?.write('\n');
      resolve(answer.trim());
    });
    muted = true;
  });
}

/**
 * Masking depends on readline driving a real terminal. Piped or redirected
 * input would echo the secret in clear - refuse rather than risk it.
 */
export function requireTTY(): boolean {
  if (process.stdin.isTTY) return true;
  console.error(
    'This command needs an interactive terminal (secret input is masked).\n' +
      'Run it directly in a terminal window, not through a pipe or a task runner.',
  );
  return false;
}

/** Run `fn` with a readline interface, closing it whatever happens. */
export async function withPrompt<T>(fn: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}
