import { prisma } from './db.js';
import { createHash } from 'node:crypto';
import { normalizeCurrency } from './currency.js';
import type { Prisma } from '@prisma/client';
import {
  assignOccurrences,
  normalizeDescription,
  toAgorot,
  toDateISO,
} from './dedup.js';

/** Minimal shape of what israeli-bank-scrapers returns per transaction. */
export interface ScrapedTxn {
  identifier?: string | number;
  date: string;
  processedDate?: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: string; // 'completed' | 'pending'
  installments?: { number: number; total: number };
}

export interface ScrapedAccount {
  accountNumber: string;
  balance?: number;
  txns: ScrapedTxn[];
}

export interface IngestStats {
  inserted: number;
  updated: number;
  pendingMatched: number;
  /** Pending rows the provider stopped reporting - see the sweep below */
  pendingDropped: number;
  skipped: number;
}

const PENDING_MATCH_WINDOW_DAYS = 6;

export async function ingestScrapedAccount(
  institution: string,
  accountType: 'bank' | 'credit_card',
  displayName: string,
  scraped: ScrapedAccount,
  coverageStart?: Date,
): Promise<IngestStats> {
  const lastFour = scraped.accountNumber.replace(/\D/g, '').slice(-4).padStart(4, '0');
  const sourceKey = createHash('sha256')
    .update(`${institution}|${scraped.accountNumber}`)
    .digest('hex');

  return prisma.$transaction(async (db) => {
    let account = await db.account.findUnique({ where: { sourceKey } });
    if (!account) {
      // Upgrade a legacy row on first successful scrape. Only claim it when it
      // is the sole unkeyed candidate; ambiguity must create a distinct account.
      const candidates = await db.account.findMany({ where: { institution, lastFour, sourceKey: null } });
      if (candidates.length === 1) {
        account = await db.account.update({
          where: { id: candidates[0].id },
          data: { sourceKey, dedupIdentity: candidates[0].dedupIdentity ?? lastFour },
        });
      } else {
        const hasLastFourCollision = (await db.account.count({ where: { institution, lastFour } })) > 0;
        account = await db.account.create({
          data: {
            institution,
            lastFour,
            sourceKey,
            dedupIdentity: hasLastFourCollision ? `key:${sourceKey}` : lastFour,
            displayName,
            type: accountType,
          },
        });
      }
    }

    const dedupIdentity = account.dedupIdentity ?? lastFour;
    if (!account.dedupIdentity) {
      account = await db.account.update({ where: { id: account.id }, data: { dedupIdentity } });
    }

    // Prepare + hash after resolving the account's stable identity. Occurrence
    // indexes need the full provider batch.
    const prepared = assignOccurrences(
      institution,
      dedupIdentity,
      scraped.txns.map((t) => ({
        raw: t,
        dateISO: toDateISO(t.date),
        amountAgorot: toAgorot(t.chargedAmount),
        normalizedDescription: normalizeDescription(t.description),
        providerIdentifier: t.identifier != null ? String(t.identifier) : null,
      })),
    );

    const existing = await db.transaction.findMany({
      where: { dedupHash: { in: prepared.map((p) => p.dedupHash) } },
      select: { id: true, dedupHash: true, status: true },
    });
    const existingByHash = new Map(existing.map((entry) => [entry.dedupHash, entry]));
    const stats: IngestStats = {
      inserted: 0,
      updated: 0,
      pendingMatched: 0,
      pendingDropped: 0,
      skipped: 0,
    };

    for (const p of prepared) {
      const t = p.raw;
      const status = t.status === 'pending' ? 'pending' : 'completed';
      const already = existingByHash.get(p.dedupHash);
      if (already) {
        if (already.status === 'pending' && status === 'completed') {
          await db.transaction.update({
            where: { id: already.id },
            data: { status, processedDate: t.processedDate ? new Date(t.processedDate) : undefined },
          });
          stats.updated++;
        } else stats.skipped++;
        continue;
      }

      if (status === 'completed' && (await reconcilePending(db, account.id, p, t))) {
        stats.pendingMatched++;
        continue;
      }

      await db.transaction.create({
        data: {
          accountId: account.id,
          date: new Date(t.date),
          processedDate: t.processedDate ? new Date(t.processedDate) : null,
          descriptionRaw: t.description,
          description: p.normalizedDescription,
          memo: t.memo ?? null,
          amount: p.amountAgorot,
          currency: normalizeCurrency(t.chargedCurrency ?? 'ILS'),
          originalAmount: t.originalCurrency && normalizeCurrency(t.originalCurrency) !== normalizeCurrency(t.chargedCurrency ?? 'ILS')
            ? toAgorot(t.originalAmount) : null,
          originalCurrency: t.originalCurrency && normalizeCurrency(t.originalCurrency) !== normalizeCurrency(t.chargedCurrency ?? 'ILS')
            ? normalizeCurrency(t.originalCurrency) : null,
          status,
          installmentNumber: t.installments?.number ?? null,
          installmentTotal: t.installments?.total ?? null,
          providerIdentifier: p.providerIdentifier,
          dedupHash: p.dedupHash,
        },
      });
      stats.inserted++;
    }

    /**
     * Pending rows the provider has stopped reporting.
     *
     * A pending transaction is the provider's current state, not history. When
     * one settles the provider often RENAMES it - "העברה מחשבון לחשבון" became
     * "העברת שכר דירה" - which changes the dedup hash, so the settled charge
     * lands as a brand new row and the pending one is orphaned. The month then
     * carried the same rent twice: once real, once a ghost that the
     * dashboard reported as still owed.
     *
     * reconcilePending() below handles the easy case, where only the date
     * moved. This handles the rest without having to guess which new row
     * supersedes which old one: if the provider just reported on a date range
     * and did not list a pending row inside it, that row is gone - settled
     * under another name, or cancelled.
     *
     * A note or a spread plan holds the sweep off: those are things the user
     * wrote or decided, and losing them silently is worse than a duplicate. A
     * locked CATEGORY deliberately does not - a ghost rent row can carry
     * exactly that, assigned by hand to the ghost, and preserving it would mean
     * preserving a permanent double-count of the rent because someone once
     * filed the phantom correctly.
     */
    if (prepared.length > 0) {
      const reported = new Set(prepared.map((p) => p.dedupHash));
      const earliest = new Date(
        Math.min(...prepared.map((p) => new Date(p.dateISO).getTime())),
      );
      const stored = await db.transaction.findMany({
        where: {
          accountId: account.id,
          status: 'pending',
          date: { gte: earliest },
          note: null,
          spread: { is: null },
        },
        select: { id: true, dedupHash: true },
      });
      const vanished = stored.filter((row) => !reported.has(row.dedupHash)).map((row) => row.id);
      if (vanished.length > 0) {
        await db.transaction.deleteMany({ where: { id: { in: vanished } } });
        stats.pendingDropped = vanished.length;
      }
    }

    // Freshness is committed last and in the same transaction. A crash above
    // rolls everything back and cannot suppress the next scheduled attempt.
    await db.account.update({
      where: { id: account.id },
      data: {
        displayName,
        type: accountType,
        balance: scraped.balance != null ? toAgorot(scraped.balance) : undefined,
        balanceAt: scraped.balance != null ? new Date() : undefined,
        coverageFrom: coverageStart && (!account.coverageFrom || coverageStart < account.coverageFrom) ? coverageStart : undefined,
        coverageThrough: coverageStart ? new Date() : undefined,
        scrapedAt: new Date(),
      },
    });
    if(scraped.balance!=null)await db.balanceObservation.create({data:{accountId:account.id,amount:toAgorot(scraped.balance),observedAt:new Date()}});
    return stats;
  }, { maxWait: 10_000, timeout: 120_000 });
}

/**
 * A completed transaction with an unseen hash might be a previously-stored
 * pending transaction whose date changed when it settled. Match on: same
 * account, same amount, same normalized description, date within a window.
 * On match, update the stored row in place (including its hash) so future
 * scrapes dedup against the settled version.
 */
async function reconcilePending(
  db: Prisma.TransactionClient,
  accountId: string,
  p: { dedupHash: string; amountAgorot: number; normalizedDescription: string },
  t: ScrapedTxn,
): Promise<boolean> {
  const txnDate = new Date(t.date);
  const windowMs = PENDING_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const candidate = await db.transaction.findFirst({
    where: {
      accountId,
      status: 'pending',
      amount: p.amountAgorot,
      description: p.normalizedDescription,
      date: {
        gte: new Date(txnDate.getTime() - windowMs),
        lte: new Date(txnDate.getTime() + windowMs),
      },
    },
    orderBy: { date: 'asc' },
  });

  if (!candidate) return false;

  await db.transaction.update({
    where: { id: candidate.id },
    data: {
      status: 'completed',
      date: txnDate,
      processedDate: t.processedDate ? new Date(t.processedDate) : null,
      dedupHash: p.dedupHash,
    },
  });
  return true;
}
