/**
 * Pre-publish privacy check.  npm run git:safe-check
 *
 * Answers one question before anything leaves the machine: does a file that
 * would be pushed contain a secret, or a piece of YOUR financial life?
 *
 *  1. Runtime files that hold secrets (.env, accounts.config.json, the
 *     database, browser profiles) exist but are not ignored.
 *  2. Secret shapes: private keys, Telegram bot tokens.
 *  3. Your own data, cross-checked against the local ledger when one exists:
 *     account names, card last-four digits and your notes are errors; merchant
 *     names and one-word notes are warnings, because national chains
 *     ("שופרסל") legitimately appear in the rule preset.
 *  4. private/denylist.txt, one term per line (names, addresses, employers -
 *     anything the database cannot know is yours). The folder is ignored, so
 *     the list itself never leaves the machine.
 *
 * Read-only, local, and exits non-zero on any error, so it can gate a push.
 * The pre-push hook runs it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import 'dotenv/config';

const run = promisify(execFile);
const root = process.cwd();
// Also reject forced-added runtime files and scan lockfiles; gitignore alone
// does not protect data already in the index.
await run(process.execPath, ['scripts/publish-guard.mjs', '--worktree'], { cwd: root });

const errors: string[] = [];
const warnings: string[] = [];

// ---------------------------------------------------------------- 1. ignored
const sensitive = [
  '.env',
  'accounts.config.json',
  'backup.config.json',
  '.browser-profiles',
  '.claude',
  'private',
  path.join('prisma', 'myledger.db'),
];
for (const target of sensitive) {
  if (!existsSync(path.join(root, target))) continue;
  try {
    await run('git', ['check-ignore', '-q', '--', target], { cwd: root });
  } catch {
    errors.push(`${target} exists but is not ignored`);
  }
}

// What would be published: tracked files plus untracked ones git would pick up.
const { stdout } = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const files = stdout
  .split('\0')
  .filter((f) => f && !/(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?|db)$/i.test(f));

const texts = new Map<string, string>();
for (const file of files) {
  try {
    texts.set(file, readFileSync(path.join(root, file), 'utf8'));
  } catch {
    /* deleted in the working tree */
  }
}

// ----------------------------------------------------------- 2. secret shapes
const tokenPattern = /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;
for (const [file, text] of texts) {
  if (tokenPattern.test(text)) errors.push(`${file}: private-key or Telegram-token pattern`);
}

// ------------------------------------------------------ 3. your own ledger
type Kind = 'account' | 'last-four' | 'note' | 'merchant' | 'denylist';
const terms = new Map<string, Kind>();
const add = (term: string | null | undefined, kind: Kind, min = 4) => {
  const t = term?.trim();
  if (t && t.length >= min && !terms.has(t)) terms.set(t, kind);
};

const dbUrl = process.env.DATABASE_URL ?? '';
const dbFile = dbUrl.startsWith('file:') ? path.resolve(root, 'prisma', dbUrl.slice(5)) : '';
if (dbFile && existsSync(dbFile)) {
  const { prisma } = await import('../src/db.js');
  try {
    for (const a of await prisma.account.findMany({ select: { displayName: true, lastFour: true } })) {
      add(a.displayName, 'account');
      if (/^\d{4}$/.test(a.lastFour)) terms.set(a.lastFour, 'last-four');
    }
    for (const n of await prisma.note.findMany({ select: { note: true } })) add(n.note, 'note', 6);
    for (const t of await prisma.transaction.findMany({ where: { note: { not: null } }, select: { note: true } })) {
      add(t.note, 'note', 6);
    }
    const descriptions = await prisma.transaction.findMany({ distinct: ['description'], select: { description: true } });
    for (const { description } of descriptions) {
      // The longest digit-free run is the merchant; branch numbers and dates
      // around it make the full string too specific to ever match.
      const name = description.split(/\d+/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0];
      add(name, 'merchant', 5);
    }
  } finally {
    await prisma.$disconnect();
  }
} else {
  warnings.push('no local ledger found (DATABASE_URL) - skipped the cross-check against your own data');
}

const denylist = path.join(root, 'private', 'denylist.txt');
if (existsSync(denylist)) {
  for (const line of readFileSync(denylist, 'utf8').split(/\r?\n/)) {
    if (line.trim() && !line.startsWith('#')) terms.set(line.trim(), 'denylist');
  }
}

// Demo and test data use these on purpose.
const DEMO_LAST_FOUR = new Set(['1111', '1234', '2222', '4471', '5216', '8830']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [term, kind] of terms) {
  if (kind === 'last-four' && DEMO_LAST_FOUR.has(term)) continue;
  // Digits must stand alone - "1234" inside "12345" is not a card.
  const pattern = kind === 'last-four' ? new RegExp(`(^|\\D)${term}(\\D|$)`) : new RegExp(escape(term), 'i');
  for (const [file, text] of texts) {
    if (!pattern.test(text)) continue;
    const message = `${file}: contains your ${kind} (value withheld; check locally)`;
    // A one- or two-word note ("רמי לוי") is usually just a chain's name.
    const generic = kind === 'merchant' || (kind === 'note' && term.length < 12);
    (generic ? warnings : errors).push(message);
  }
}

// ------------------------------------------------------------------ report
for (const w of warnings) console.warn(`! ${w}`);
for (const e of errors) console.error(`✗ ${e}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s). Nothing was sent anywhere - this check is local.`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} publishable files checked`);
  console.log('✓ Sensitive runtime files are ignored');
  console.log('✓ No secret patterns, account names, card digits or notes from your ledger');
  if (warnings.length) console.log(`  (${warnings.length} warning(s) above - short names; national chains are expected)`);
}
