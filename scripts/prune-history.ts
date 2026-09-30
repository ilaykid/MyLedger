/**
 * Keep a rolling number of months of transaction history.
 * Dry-run by default; pass the bare word `apply` to perform the deletion.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { DATA_ROOT } from '../src/paths.js';
import { detectRecurring } from '../src/recurring.js';
import { planKeyFor } from '../src/installments.js';

const monthsArg = process.argv.find((value) => /^\d+$/.test(value));
const months = monthsArg ? Number(monthsArg) : 3;
if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error('months must be between 1 and 120');
const apply = process.argv.includes('apply');
const makeSnapshot = !process.argv.includes('no-snapshot');

const cutoff = new Date();
cutoff.setHours(0, 0, 0, 0);
cutoff.setMonth(cutoff.getMonth() - months);

// Cards are retained by billing cycles, not by purchase date. For three cycles
// in August keep charge dates June/July/August, plus unprocessed purchases from
// the first day of May so the June cycle cannot be cut in half.
const billingCutoff = new Date(new Date().getFullYear(), new Date().getMonth() - (months - 1), 1);
const cardPurchaseCutoff = new Date(new Date().getFullYear(), new Date().getMonth() - months, 1);

const oldWhere: Prisma.TransactionWhereInput = {
  OR: [
    { account: { type: 'bank' }, date: { lt: cutoff } },
    { account: { type: 'credit_card' }, processedDate: { not: null, lt: billingCutoff } },
    { account: { type: 'credit_card' }, processedDate: null, date: { lt: cardPurchaseCutoff } },
  ],
};
const retainedWhere: Prisma.TransactionWhereInput = {
  OR: [
    { account: { type: 'bank' }, date: { gte: cutoff } },
    { account: { type: 'credit_card' }, processedDate: { gte: billingCutoff } },
    { account: { type: 'credit_card' }, processedDate: null, date: { gte: cardPurchaseCutoff } },
  ],
};

const oldTransactions = await prisma.transaction.count({ where: oldWhere });
const totalTransactions = await prisma.transaction.count();
const emptyAccounts = await prisma.account.findMany({
  where: { transactions: { none: retainedWhere } },
  select: { id: true, displayName: true },
});

console.log(`Bank cutoff: ${cutoff.toLocaleDateString('he-IL')} (rolling ${months} months)`);
console.log(`Card cutoff: billing dates from ${billingCutoff.toLocaleDateString('he-IL')} (${months} billing cycles)`);
console.log(`${oldTransactions}/${totalTransactions} transactions will be removed; ${totalTransactions - oldTransactions} remain.`);
console.log(`${emptyAccounts.length} account rows will become empty and be removed.`);

if (!apply) {
  console.log('Dry run only. Add the bare word "apply" to execute.');
  await prisma.$disconnect();
  process.exit(0);
}

// A recoverable, ACL-protected checkpoint. It intentionally sits beside the
// live DB so it inherits the runtime's user-only permissions. Delete it after
// a week once the trimmed dashboard has been reviewed.
let snapshot: string | null = null;
if (makeSnapshot) {
  const safetyDir = path.join(DATA_ROOT, 'safety-snapshots');
  mkdirSync(safetyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  snapshot = path.join(safetyDir, `myledger-before-${months}m-prune-${stamp}.db`);
  if (existsSync(snapshot)) throw new Error(`Safety snapshot already exists: ${snapshot}`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
}

const result = await prisma.$transaction(async (db) => {
  const deletedTransactions = await db.transaction.deleteMany({ where: oldWhere });
  const deletedRuns = await db.syncRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  const deletedAccounts = await db.account.deleteMany({ where: { transactions: { none: {} } } });

  // Plan notes are tied to a particular historical purchase. Merchant notes
  // and rules are preferences for future transactions, so those stay.
  const installmentRows = await db.transaction.findMany({
    where: { installmentTotal: { not: null } },
    select: {
      accountId: true,
      description: true,
      installmentNumber: true,
      installmentTotal: true,
      date: true,
      amount: true,
    },
  });
  const activePlanKeys = installmentRows.map(planKeyFor).filter((key): key is string => key != null);
  const deletedPlanNotes = await db.note.deleteMany({
    where: { scope: 'plan', ...(activePlanKeys.length ? { key: { notIn: activePlanKeys } } : {}) },
  });
  return {
    transactions: deletedTransactions.count,
    runs: deletedRuns.count,
    accounts: deletedAccounts.count,
    planNotes: deletedPlanNotes.count,
  };
}, { maxWait: 10_000, timeout: 120_000 });

const recurring = await detectRecurring();
const remainingOld = await prisma.transaction.count({ where: oldWhere });
if (remainingOld !== 0) throw new Error(`${remainingOld} old transactions remain after prune`);

console.log(`Deleted: ${JSON.stringify(result)}`);
console.log(`Recurring rebuilt: ${recurring.detected} active patterns, ${recurring.removed} stale removed.`);
if (snapshot) console.log(`Safety snapshot: ${snapshot}`);
await prisma.$disconnect();
