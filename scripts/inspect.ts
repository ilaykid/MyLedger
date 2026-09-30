/**
 * Data-quality report for freshly scraped real accounts.  npm run inspect
 *
 * The demo data was built to be well-behaved; real provider data rarely is.
 * This prints the things that actually break downstream: missing charge dates
 * (kills the credit-card float), uncategorised spend, thin history (recurring
 * detection needs cycles), and whether a bank account exists at all (without one
 * there is no balance and the cash-flow forecast cannot mean anything).
 *
 * Prints merchant names and amounts - it is a local report on your own data.
 */
import { prisma } from '../src/db.js';
import { cycleOrdinal, toISODate } from '../src/cycle.js';
import { getSettings } from '../src/recurring.js';

const ils = (agorot: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(
    agorot / 100,
  );

async function main() {
  const settings = await getSettings();
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: 'asc' } });
  const txns = await prisma.transaction.findMany({
    include: { category: { select: { name: true, kind: true } }, account: { select: { type: true, displayName: true } } },
    orderBy: { date: 'asc' },
  });

  if (txns.length === 0) {
    console.log('No transactions in the database.');
    return;
  }

  console.log('=== ACCOUNTS ===');
  for (const a of accounts) {
    const n = txns.filter((t) => t.accountId === a.id).length;
    console.log(
      `  ${a.type === 'bank' ? '🏦' : '💳'} ${a.displayName}  (${a.institution} ****${a.lastFour})  ` +
        `${n} txns  balance=${a.balance != null ? ils(a.balance) : '—'}  billingDay=${a.billingDay ?? '—'}`,
    );
  }
  const hasBank = accounts.some((a) => a.type === 'bank');
  if (!hasBank) {
    console.log('\n  ! No bank account connected. Balance, income and the cash-flow forecast');
    console.log('    cannot be computed from cards alone - the dashboard will look wrong until');
    console.log('    a bank account is added. Transactions and categories work fine meanwhile.');
  }

  console.log('\n=== COVERAGE ===');
  const first = txns[0].date;
  const last = txns[txns.length - 1].date;
  const cycles = new Set(txns.map((t) => cycleOrdinal(t.date, settings.cycleAnchorDay)));
  console.log(`  ${txns.length} transactions, ${toISODate(first)} → ${toISODate(last)}`);
  console.log(`  spans ${cycles.size} cash-flow cycles (recurring detection needs 3+)`);
  console.log(`  pending: ${txns.filter((t) => t.status === 'pending').length}`);
  console.log(`  with installments: ${txns.filter((t) => t.installmentTotal).length}`);
  console.log(`  foreign currency: ${txns.filter((t) => t.originalCurrency).length}`);

  const cardTxns = txns.filter((t) => t.account.type === 'credit_card');
  const noCharge = cardTxns.filter((t) => !t.processedDate);
  console.log(`\n  card transactions: ${cardTxns.length}, missing charge date: ${noCharge.length}`);
  if (noCharge.length > 0) {
    console.log('  ! Without processedDate these cannot be counted in the credit-card float.');
  } else if (cardTxns.length > 0) {
    const future = cardTxns.filter((t) => t.processedDate && t.processedDate > new Date());
    const floatTotal = future.reduce((s, t) => s + -t.amount, 0);
    console.log(`  not yet debited (the float): ${future.length} txns, ${ils(floatTotal)}`);
    const dates = [...new Set(future.map((t) => toISODate(t.processedDate!)))].sort();
    if (dates.length) console.log(`  upcoming charge dates: ${dates.join(', ')}`);
  }

  console.log('\n=== CATEGORISATION ===');
  const uncategorised = txns.filter((t) => !t.categoryId);
  const pct = Math.round(((txns.length - uncategorised.length) / txns.length) * 100);
  console.log(`  ${txns.length - uncategorised.length}/${txns.length} categorised (${pct}%)`);
  if (uncategorised.length) {
    const byDesc = new Map<string, { n: number; total: number }>();
    for (const t of uncategorised) {
      const e = byDesc.get(t.description) ?? { n: 0, total: 0 };
      e.n++;
      e.total += t.amount;
      byDesc.set(t.description, e);
    }
    console.log(`\n  Top uncategorised merchants — each is a rule worth adding:`);
    for (const [desc, e] of [...byDesc].sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total)).slice(0, 20)) {
      console.log(`    ${String(e.n).padStart(3)}x ${ils(e.total).padStart(12)}  ${desc}`);
    }
  }

  console.log('\n=== SPEND BY CATEGORY (all time) ===');
  const byCat = new Map<string, number>();
  for (const t of txns) {
    if (t.amount >= 0 || t.category?.kind === 'transfer') continue;
    const k = t.category?.name ?? '(ללא קטגוריה)';
    byCat.set(k, (byCat.get(k) ?? 0) + -t.amount);
  }
  for (const [name, total] of [...byCat].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ils(total).padStart(12)}  ${name}`);
  }

  console.log('\n=== RECURRING DETECTED ===');
  const rec = await prisma.recurringExpense.findMany({ orderBy: { expectedDay: 'asc' } });
  if (rec.length === 0) {
    console.log('  none yet (needs at least 3 cycles of history per merchant)');
  }
  for (const r of rec) {
    console.log(
      `  day ${String(r.expectedDay).padStart(2)} | ${r.frequency.padEnd(10)} | ${ils(r.expectedAmount).padStart(11)} | x${r.occurrences} | ${r.displayName}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
