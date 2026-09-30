import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The encrypted backup container.
 *
 * WHY NOT DPAPI. Every other secret in this project is sealed with DPAPI, and
 * that is right for them: they only ever have to be readable by this Windows
 * account, on this machine. A backup is the exact opposite requirement. DPAPI
 * keys die with the account - a reinstall, a profile reset, or the dead disk
 * this backup exists for all take the key with them. A backup you cannot open
 * after losing the machine is not a backup, so the archive is sealed with a
 * passphrase you keep somewhere else (a password manager), and nothing about
 * opening it depends on this computer still existing.
 *
 * A DPAPI-sealed *copy* of that passphrase is kept locally, but only so the
 * scheduled run needs no typing. It is a convenience cache, never the only copy
 * - which is why `backup init` refuses to move on until you confirm you saved
 * it.
 *
 * FORMAT (all binary, little of it negotiable):
 *
 *   magic   6   "MLBK1\n"                 version in the bytes, not a field
 *   salt   16   scrypt salt               fresh per archive
 *   iv     12   AES-GCM nonce             fresh per archive
 *   tag    16   AES-GCM auth tag          detects tampering AND wrong passphrase
 *   body    n   AES-256-GCM(gzip(payload))
 *
 * and the payload inside is a length-prefixed bundle:
 *
 *   4 bytes big-endian header length, header JSON, then each file's bytes in
 *   the order the header lists them.
 *
 * Rolled by hand rather than shelling out to 7-Zip because 7-Zip is not on
 * every machine, and rather than an npm package because SECURITY.md is explicit
 * that a dependency with read access to this project is a supply-chain risk.
 * `node:crypto` and `node:zlib` are already in the runtime.
 */

const MAGIC = Buffer.from('MLBK1\n', 'utf-8');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

/**
 * scrypt cost. N=2^15 keeps derivation around a quarter-second on a laptop,
 * which is irrelevant once a day and expensive in bulk for anyone guessing.
 * maxmem must be raised explicitly: 128*N*r is 32MB, exactly Node's default cap.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

export interface BundleFile {
  name: string;
  data: Buffer;
}

export interface BundleHeader {
  createdAt: string;
  files: Array<{ name: string; size: number }>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}

export function packBundle(files: BundleFile[]): Buffer {
  const header: BundleHeader = {
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({ name: f.name, size: f.data.length })),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf-8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([length, headerBytes, ...files.map((f) => f.data)]);
}

export function unpackBundle(bundle: Buffer): { header: BundleHeader; files: BundleFile[] } {
  if (bundle.length < 4) throw new Error('Archive payload is truncated.');
  const headerLength = bundle.readUInt32BE(0);
  if (headerLength <= 0 || 4 + headerLength > bundle.length) {
    throw new Error('Archive header is malformed.');
  }
  const header = JSON.parse(bundle.subarray(4, 4 + headerLength).toString('utf-8')) as BundleHeader;
  // The format contains one database, never arbitrary filesystem entries.
  // Authentication proves knowledge of the passphrase, not that paths are safe.
  if (!header || typeof header.createdAt !== 'string' || !Array.isArray(header.files)
    || header.files.length !== 1 || header.files[0]?.name !== 'myledger.db') {
    throw new Error('Archive must contain only myledger.db.');
  }

  const files: BundleFile[] = [];
  let offset = 4 + headerLength;
  for (const entry of header.files) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_PAYLOAD_BYTES) {
      throw new Error('Archive file size is invalid.');
    }
    const end = offset + entry.size;
    if (end > bundle.length) throw new Error(`Archive is truncated inside "${entry.name}".`);
    files.push({ name: entry.name, data: bundle.subarray(offset, end) });
    offset = end;
  }
  if (offset !== bundle.length) throw new Error('Archive contains unexpected trailing data.');
  return { header, files };
}

/** A restore must never overwrite a live database or follow an existing link. */
export function restoreBundle(bundle: Buffer, target: string): BundleHeader {
  const { header, files } = unpackBundle(bundle);
  mkdirSync(target); // Atomic refusal if the destination already exists.
  for (const file of files) writeFileSync(path.join(target, file.name), file.data, { flag: 'wx', mode: 0o600 });
  return header;
}

export function encryptBundle(bundle: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(bundle, { level: 9 })), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBundle(archive: Buffer, passphrase: string): Buffer {
  const headerSize = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (archive.length < headerSize) throw new Error('Not a MyLedger backup: file is too small.');
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a MyLedger backup: wrong file signature.');
  }

  let cursor = MAGIC.length;
  const salt = archive.subarray(cursor, (cursor += SALT_LEN));
  const iv = archive.subarray(cursor, (cursor += IV_LEN));
  const tag = archive.subarray(cursor, (cursor += TAG_LEN));
  const body = archive.subarray(cursor);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([decipher.update(body), decipher.final()]), { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch {
    // GCM cannot distinguish a wrong key from a corrupted file - both fail the
    // tag check - so the message has to name both.
    throw new Error(
      'Could not open the archive. Either the passphrase is wrong, or the file is damaged.',
    );
  }
}

/**
 * A passphrase meant to be written down once and typed back years later, so it
 * avoids the characters people mistranscribe: no I/L/O/U, no digits that look
 * like letters. 30 characters from a 28-symbol alphabet is ~144 bits.
 */
export function generatePassphrase(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  // Rejection sampling, not modulo: 256 is not a multiple of 30, so `b % 30`
  // would make the first 16 symbols measurably likelier than the rest.
  const limit = 256 - (256 % alphabet.length);
  const chars: string[] = [];
  while (chars.length < 30) {
    for (const b of randomBytes(32)) {
      if (b >= limit || chars.length === 30) continue;
      chars.push(alphabet[b % alphabet.length]);
    }
  }
  return [0, 5, 10, 15, 20, 25].map((i) => chars.slice(i, i + 5).join('')).join('-');
}
