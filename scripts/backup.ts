/**
 * Encrypted off-machine backup.
 *
 *   npm run backup -- init [destination]   choose where, generate the passphrase
 *   npm run backup                         take a snapshot (what the daily task runs)
 *   npm run backup -- list                 what is in the destination
 *   npm run backup -- verify               prove the newest archive still opens
 *   npm run backup -- restore <file>       unpack into a folder, touching nothing live
 *
 * This is the one gap the local-only design cannot close on its own:
 * myledger.db is the only copy of every categorisation, rule, note and manual
 * override in the system. The scrape can always be run again; that work cannot.
 *
 * Two details carry most of the value:
 *
 * 1. The database is snapshotted with SQLite's VACUUM INTO, not copied. A plain
 *    file copy taken while the API holds a write transaction is a torn file
 *    that restores into corruption - and the daily backup runs right after the
 *    daily scrape, which is exactly when writes are in flight.
 *
 * 2. The archive is passphrase-encrypted, not DPAPI-sealed. See src/backup.ts
 *    for why that inversion is deliberate.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  decryptBundle,
  encryptBundle,
  generatePassphrase,
  packBundle,
  unpackBundle,
  restoreBundle,
  type BundleFile,
} from '../src/backup.js';
import { isProtected, protect, unprotect } from '../src/secrets.js';
import { ask, askHidden, requireTTY, withPrompt } from '../src/prompt.js';
import { prisma } from '../src/db.js';
import { APP_ROOT, dataPath } from '../src/paths.js';

const run = promisify(execFile);

const CONFIG_PATH = dataPath('backup.config.json');
const EXT = '.mlbk';

interface BackupConfig {
  destination: string;
  /** How many archives to keep. Older ones are pruned after a successful run. */
  keep: number;
  /** DPAPI-sealed convenience copy of the passphrase - never the only copy. */
  passphrase: string;
}

function readBackupConfig(): BackupConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<BackupConfig>;
  if (!parsed.destination || !parsed.passphrase) return null;
  return { destination: parsed.destination, keep: parsed.keep ?? 14, passphrase: parsed.passphrase };
}

function writeBackupConfig(config: BackupConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A crash-consistent copy of the database, produced by SQLite itself.
 * VACUUM INTO runs inside a read transaction, so the output is a complete
 * database as of one instant even while another process is writing.
 */
async function snapshotDatabase(): Promise<Buffer> {
  // Plaintext copy of the ledger: keep it beside the live database, under the
  // same protection, not in a shared temp folder a crash would leave it in.
  const target = dataPath(`.backup-${process.pid}-${Date.now()}.db`);
  try {
    // The path is ours, not user input, but a stray quote would still break the
    // statement - SQLite escapes a literal quote by doubling it.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return readFileSync(target);
  } finally {
    try {
      rmSync(target, { force: true });
    } catch {
      /* a stray temp file is not worth failing the backup over */
    }
  }
}

/**
 * The database, and deliberately nothing else.
 *
 * accounts.config.json would have been convenient to keep - it records which
 * providers, display names and intervals were set up. But its credentials would
 * then exist in one more place, and "one more place" is a real cost even when
 * the values there are DPAPI-sealed and unreadable off this machine. What it
 * buys back is small: re-entering provider details is a few minutes with
 * `npm run accounts -- add`, and the passwords have to be re-entered on a new
 * machine regardless, because DPAPI keys do not travel.
 *
 * So: the archive holds financial history and none of the keys to anything.
 * Losing an archive to a stranger costs privacy, never account access.
 *
 * (The Telegram token lives inside the database and IS carried along - but it
 * is DPAPI-sealed there too, and it is an outbound-only channel. See
 * SECURITY.md section 6.)
 */
function collectFiles(dbSnapshot: Buffer): BundleFile[] {
  return [{ name: 'myledger.db', data: dbSnapshot }];
}

function archiveName(): string {
  return `myledger-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${EXT}`;
}

function listArchives(destination: string): string[] {
  if (!existsSync(destination)) return [];
  // ISO-8601 names sort chronologically as plain strings.
  return readdirSync(destination)
    .filter((f) => f.startsWith('myledger-') && f.endsWith(EXT))
    .sort();
}

/** Same volume as the project = one dead disk takes both copies. */
function sameVolume(a: string, b: string): boolean {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
}

async function init(): Promise<void> {
  if (!requireTTY()) {
    process.exitCode = 1;
    return;
  }

  const existing = readBackupConfig();
  const fromArgs = process.argv.slice(3).find((a) => !a.startsWith('-'));

  await withPrompt(async (rl) => {
    const typed =
      fromArgs ??
      (await ask(
        rl,
        `Backup destination folder${existing ? ` [${existing.destination}]` : ''}\n` +
          '  (an external drive, a network share, or a cloud-synced folder - the archive is\n' +
          '   encrypted, so syncing it to OneDrive/Drive is fine)\n> ',
      ));
    // Blank means "keep what is already configured", which only works if there is one.
    const destination = typed || existing?.destination;

    if (!destination) {
      console.error('No destination given.');
      process.exitCode = 1;
      return;
    }

    const resolved = path.resolve(destination);
    if (resolved.startsWith(APP_ROOT + path.sep)) {
      console.error('That folder is inside the project. A backup there dies with the project.');
      process.exitCode = 1;
      return;
    }
    mkdirSync(resolved, { recursive: true });

    if (sameVolume(resolved, APP_ROOT)) {
      console.log(
        `\n⚠  ${resolved} is on the same drive as the project. That covers an accidental\n` +
          '   delete or a bad migration, but not the disk failing. Prefer another drive.',
      );
    }

    if (existing) {
      console.log('\nA passphrase already exists. Keeping it means old archives stay readable.');
      const replace = await ask(rl, 'Generate a NEW passphrase? Old archives become unopenable. (yes/no) [no]: ');
      if (replace.toLowerCase() !== 'yes') {
        writeBackupConfig({ ...existing, destination: resolved });
        console.log(`\n✓ Destination set to ${resolved}. Passphrase unchanged.`);
        return;
      }
    }

    const passphrase = generatePassphrase();
    console.log('\n' + '='.repeat(64));
    console.log('  YOUR BACKUP PASSPHRASE - shown once, and only once');
    console.log('='.repeat(64));
    console.log(`\n      ${passphrase}\n`);
    console.log('='.repeat(64));
    console.log(
      'Put it in your password manager NOW. A copy is cached on this machine so the\n' +
        'daily task can run unattended, but that copy is sealed to this Windows account -\n' +
        'it dies with the disk you are backing up. Without your own copy, these archives\n' +
        'cannot be opened by anyone, including you.\n',
    );

    const confirm = await ask(rl, 'Type "saved" once it is stored somewhere else: ');
    if (confirm.toLowerCase() !== 'saved') {
      console.error('\nAborted - nothing was written. Run init again when you are ready.');
      process.exitCode = 1;
      return;
    }

    writeBackupConfig({ destination: resolved, keep: existing?.keep ?? 14, passphrase: await protect(passphrase) });
    console.log(`\n✓ Configured. Destination: ${resolved}`);
    console.log('  Take the first one now with:  npm run backup');
    console.log('  It also runs automatically after each daily sync.');
  });
}

async function create(): Promise<void> {
  const config = readBackupConfig();
  if (!config) {
    console.error('Backups are not configured yet. Run:  npm run backup -- init');
    process.exitCode = 1;
    return;
  }

  const passphrase = await unprotect(config.passphrase);
  mkdirSync(config.destination, { recursive: true });

  const snapshot = await snapshotDatabase();
  const files = collectFiles(snapshot);
  const archive = encryptBundle(packBundle(files), passphrase);

  const target = path.join(config.destination, archiveName());
  writeFileSync(target, archive);

  // Read it back before pruning anything: an archive that cannot be decrypted
  // is worse than no archive, because it is silently trusted.
  const check = unpackBundle(decryptBundle(readFileSync(target), passphrase));
  if (!check.files.some((f) => f.name === 'myledger.db' && f.data.length === snapshot.length)) {
    rmSync(target, { force: true });
    throw new Error('The archive did not verify after writing - nothing was kept.');
  }

  console.log(`✓ ${path.basename(target)}  (${fmtSize(archive.length)} from ${fmtSize(snapshot.length)}, verified)`);
  for (const f of files) console.log(`    ${f.name}  ${fmtSize(f.data.length)}`);

  const archives = listArchives(config.destination);
  const excess = archives.slice(0, Math.max(0, archives.length - config.keep));
  for (const old of excess) rmSync(path.join(config.destination, old), { force: true });
  if (excess.length) console.log(`  pruned ${excess.length} older archive(s), keeping ${config.keep}`);

  console.log(`  → ${config.destination}`);
}

function list(): void {
  const config = readBackupConfig();
  if (!config) {
    console.error('Backups are not configured yet. Run:  npm run backup -- init');
    process.exitCode = 1;
    return;
  }
  const archives = listArchives(config.destination);
  console.log(`Destination: ${config.destination}`);
  console.log(`Keeping:     ${config.keep} archives\n`);
  if (archives.length === 0) {
    console.log('No archives yet. Take one with:  npm run backup');
    return;
  }
  for (const name of archives) {
    const s = statSync(path.join(config.destination, name));
    console.log(`  ${name}  ${fmtSize(s.size).padStart(8)}  ${s.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  console.log(`\n${archives.length} archive(s). Newest first opened with:  npm run backup -- verify`);
}

/** Read the passphrase: cached copy if we have one, otherwise ask. */
async function resolvePassphrase(config: BackupConfig | null): Promise<string | null> {
  if (config && isProtected(config.passphrase)) {
    try {
      return await unprotect(config.passphrase);
    } catch {
      console.log('The cached passphrase could not be decrypted - falling back to asking.');
    }
  }
  if (!requireTTY()) return null;
  return withPrompt((rl) => askHidden(rl, 'Backup passphrase: '));
}

async function verify(): Promise<void> {
  const config = readBackupConfig();
  const explicit = process.argv.slice(3).find((a) => !a.startsWith('-'));
  const target =
    explicit ??
    (() => {
      if (!config) return undefined;
      const archives = listArchives(config.destination);
      const newest = archives.at(-1);
      return newest ? path.join(config.destination, newest) : undefined;
    })();

  if (!target) {
    console.error('Nothing to verify. Configure with "npm run backup -- init" or pass a file path.');
    process.exitCode = 1;
    return;
  }

  const passphrase = await resolvePassphrase(config);
  if (passphrase == null) {
    process.exitCode = 1;
    return;
  }

  const { header, files } = unpackBundle(decryptBundle(readFileSync(target), passphrase));
  const db = files.find((f) => f.name === 'myledger.db');

  // Decrypting proves the passphrase; this proves the payload is a database and
  // not, say, a zero-length file that encrypted perfectly happily.
  if (!db || db.data.subarray(0, 16).toString('utf-8') !== 'SQLite format 3\0') {
    throw new Error(`${path.basename(target)} opened, but the database inside is not valid.`);
  }

  console.log(`✓ ${path.basename(target)} opens and contains a valid database.`);
  console.log(`  Taken: ${header.createdAt}`);
  for (const f of header.files) console.log(`    ${f.name}  ${fmtSize(f.size)}`);
}

async function restore(): Promise<void> {
  const config = readBackupConfig();
  const given = process.argv.slice(3).filter((a) => !a.startsWith('-'));
  let source = given[0];

  if (!source && config) {
    const newest = listArchives(config.destination).at(-1);
    if (newest) source = path.join(config.destination, newest);
  }
  if (!source || !existsSync(source)) {
    console.error('Usage: npm run backup -- restore <archive.mlbk> [target folder]');
    process.exitCode = 1;
    return;
  }

  const passphrase = await resolvePassphrase(config);
  if (passphrase == null) {
    process.exitCode = 1;
    return;
  }

  const bundle = decryptBundle(readFileSync(source), passphrase);

  // Never restore over the live files. Unpacking somewhere neutral turns "did I
  // just destroy three months of categorisation" into a copy the user makes on
  // purpose, after looking at what came out.
  const target = path.resolve(given[1] ?? `restored-${path.basename(source, EXT)}`);
  const header = restoreBundle(bundle, target);

  console.log(`✓ Restored ${header.files.length} file(s) from ${header.createdAt}`);
  console.log(`  → ${target}\n`);
  console.log('Nothing live was touched. To adopt this snapshot:');
  console.log('  1. Stop the API and any scrape.');
  console.log(`  2. Copy myledger.db over prisma\\myledger.db`);
  console.log('  3. npx prisma migrate deploy   (in case the schema moved on since)');
  console.log(
    '\nThe archive holds no credentials by design, so on a NEW machine set the providers\n' +
      'up again with "npm run accounts -- add". Everything that took real work -\n' +
      'categories, rules, notes, manual overrides - is in the database you just restored.',
  );
}

async function main() {
  const command = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'create';
  switch (command) {
    case 'init':
      await init();
      break;
    case 'list':
      list();
      break;
    case 'verify':
      await verify();
      break;
    case 'restore':
      await restore();
      break;
    case 'create':
      await create();
      break;
    default:
      console.error(`Unknown command "${command}". Use: init | list | verify | restore | (blank to back up)`);
      process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
