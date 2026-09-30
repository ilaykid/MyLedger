import { createHash } from 'node:crypto';

/**
 * Deduplication strategy
 * ----------------------
 * Every scraped transaction gets a deterministic hash built from fields that
 * are stable across scraper runs:
 *
 *   v1 | institution | accountIdentity | date(yyyy-mm-dd) | amountAgorot | normalizedDescription | providerIdentifier | occurrence
 *
 * - accountIdentity is normally lastFour for backward compatibility. Accounts
 *   that collide on lastFour get a stable hash token derived from the full
 *   provider identifier (the raw identifier itself is never stored).
 * - `occurrence` disambiguates genuinely identical transactions on the same day
 *   (e.g. two identical coffees) when the bank supplies no unique identifier:
 *   within a single scraped batch, identical keys get indexes 0, 1, 2...
 *   Banks return transactions in a stable order, so the indexes are stable too.
 * - `status` is deliberately NOT part of the hash: a pending transaction that
 *   completes with the same date/amount/description produces the same hash and
 *   is updated in place. When the bank shifts the date on completion, the
 *   pending-reconciliation pass in ingest.ts matches it instead.
 */

export interface HashableTxn {
  dateISO: string; // yyyy-mm-dd
  amountAgorot: number;
  normalizedDescription: string;
  providerIdentifier: string | null;
}

export function normalizeDescription(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function toAgorot(amount: number): number {
  return Math.round(amount * 100);
}

export function toDateISO(dateStr: string | Date): string {
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  return d.toISOString().slice(0, 10);
}

function baseKey(institution: string, lastFour: string, t: HashableTxn): string {
  return [
    'v1',
    institution,
    lastFour,
    t.dateISO,
    t.amountAgorot,
    t.normalizedDescription,
    t.providerIdentifier ?? '',
  ].join('|');
}

export function computeDedupHash(
  institution: string,
  lastFour: string,
  t: HashableTxn,
  occurrence: number,
): string {
  return createHash('sha256')
    .update(`${baseKey(institution, lastFour, t)}|${occurrence}`)
    .digest('hex');
}

/**
 * Assign occurrence indexes within one scraped batch: transactions that share
 * the exact same base key get 0, 1, 2... in the order the bank returned them.
 */
export function assignOccurrences<T extends HashableTxn>(
  institution: string,
  lastFour: string,
  txns: T[],
): Array<T & { dedupHash: string }> {
  const counters = new Map<string, number>();
  return txns.map((t) => {
    const key = baseKey(institution, lastFour, t);
    const occurrence = counters.get(key) ?? 0;
    counters.set(key, occurrence + 1);
    return { ...t, dedupHash: computeDedupHash(institution, lastFour, t, occurrence) };
  });
}
