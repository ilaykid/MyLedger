import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from './db.js';
import { decryptBundle, encryptBundle, generatePassphrase, packBundle, unpackBundle } from './backup.js';
import { protect, unprotect } from './secrets.js';
import { APP_ROOT, DATA_ROOT, dataPath } from './paths.js';

const configPath = dataPath('backup.config.json');
const extension = '.mlbk';
interface Config { destination: string; keep: number; passphrase: string }
interface Pending { destination: string; keep: number; passphrase: string; expires: number }
const pending = new Map<string, Pending>();

function readConfig(): Config | null {
  if (!existsSync(configPath)) return null;
  const value = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<Config>;
  return value.destination && value.passphrase
    ? { destination: value.destination, keep: value.keep ?? 14, passphrase: value.passphrase }
    : null;
}

function archives(destination: string): string[] {
  return existsSync(destination)
    // Only our own archives: retention deletes from this list, and a shared
    // folder may hold someone else's files.
    ? readdirSync(destination).filter((name) => name.startsWith('myledger-') && name.endsWith(extension)).sort()
    : [];
}

export function backupStatus() {
  const config = readConfig();
  const files = config ? archives(config.destination) : [];
  return {
    configured: !!config,
    destination: config?.destination ?? null,
    keep: config?.keep ?? 14,
    count: files.length,
    newest: files.at(-1) ?? null,
    suggestedDestination: process.env.OneDrive ? path.join(process.env.OneDrive, 'MyLedger Backups') : null,
  };
}

function validateDestination(input: string): string {
  const destination = path.resolve(input.trim());
  if (!path.isAbsolute(destination)) throw new Error('Backup destination must be an absolute path');
  for (const protectedRoot of [APP_ROOT, DATA_ROOT]) {
    if (destination === protectedRoot || destination.startsWith(protectedRoot + path.sep)) {
      throw new Error('Backup destination must be outside the MyLedger runtime');
    }
  }
  return destination;
}

export function prepareBackup(destinationInput: string, keep = 14) {
  const destination = validateDestination(destinationInput);
  mkdirSync(destination, { recursive: true });
  const setupId = randomUUID();
  const passphrase = generatePassphrase();
  pending.set(setupId, { destination, keep, passphrase, expires: Date.now() + 10 * 60_000 });
  return { setupId, passphrase, destination, sameDrive: path.parse(destination).root === path.parse(DATA_ROOT).root };
}

export async function confirmBackup(setupId: string) {
  const setup = pending.get(setupId);
  pending.delete(setupId);
  if (!setup || setup.expires < Date.now()) throw new Error('Backup setup expired; start again');
  writeFileSync(configPath, JSON.stringify({
    destination: setup.destination,
    keep: setup.keep,
    passphrase: await protect(setup.passphrase),
  }, null, 2) + '\n', 'utf8');
  return createBackup();
}

export async function createBackup() {
  const config = readConfig();
  if (!config) throw new Error('Backups are not configured');
  mkdirSync(config.destination, { recursive: true });
  // The snapshot is the plaintext database. It lives next to the live one, under
  // the same protection, rather than in a shared temp folder where a crash
  // between VACUUM and cleanup would leave a readable copy behind.
  const snapshot = dataPath(`.backup-${process.pid}-${Date.now()}.db`);
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const db = readFileSync(snapshot);
    const passphrase = await unprotect(config.passphrase);
    const encrypted = encryptBundle(packBundle([{ name: 'myledger.db', data: db }]), passphrase);
    const name = `myledger-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${extension}`;
    const target = path.join(config.destination, name);
    writeFileSync(target, encrypted);
    const verified = unpackBundle(decryptBundle(readFileSync(target), passphrase));
    if (!verified.files.some((file) => file.name === 'myledger.db' && file.data.length === db.length)) {
      rmSync(target, { force: true });
      throw new Error('Backup verification failed');
    }
    const files = archives(config.destination);
    for (const old of files.slice(0, Math.max(0, files.length - config.keep))) rmSync(path.join(config.destination, old), { force: true });
    return { ok: true as const, name, bytes: encrypted.length, ...backupStatus() };
  } finally {
    rmSync(snapshot, { force: true });
  }
}
