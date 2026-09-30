/**
 * Double-counting audit.  Run: npm run audit
 *
 * When you scrape both a bank and its credit cards, the same money appears
 * twice: once as ~30 individual purchases on the card, and once as a single
 * lump settlement debit in the bank. The system avoids counting it twice by
 * classifying settlement transactions as kind="transfer" and excluding them
 * from every total.
 *
 * That protection rests on the settlement being correctly categorised - which
 * depends on a category rule matching the bank's wording. Every bank words it
 * differently ("חיוב כרטיס אשראי", "כ.אשראי", "מסב", "לאומי קארד"...), so a
 * rule that works for one bank silently leaks for another, and the leak looks
 * like real spending.
 *
 * This audit therefore detects settlements STRUCTURALLY rather than by text: a
 * bank debit whose amount matches the sum of a card's purchases for that charge
 * date is a settlement, whatever it is called. Anything that matches but is not
 * marked as a transfer is flagged as an active double-count.
 *
 * Exit code 1 if it finds a problem, so it can be wired into a cron/CI check.
 */
import { prisma } from '../src/db.js';
import { classify, countsAsSpending } from '../src/cashflow.js';
import { toISODate } from '../src/cycle.js';
import { analyseSyncHealth } from '../src/sync-health.js';

const ils = (agorot: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(
    agorot / 100,
  );

/** A settlement never differs from the purchases it covers by more than rounding. */
const MATCH_TOLERANCE_AGOROT = 200;

interface Finding {
  severity: 'error' | 'warning';
  message: string;
}

async function main() {
  const findings: Finding[] = [];

  const txns = await prisma.transaction.findMany({
    select: {
      id: true,
      date: true,
      processedDate: true,
      amount: true,
      description: true,
      status: true,
      accountId: true,
      categoryId: true,
      category: { select: { kind: true, name: true } },
      account: { select: { type: true, displayName: true, billingDay: true } },
    },
    orderBy: { date: 'asc' },
  });

  if (txns.length === 0) {
    console.log('No transactions yet - nothing to audit.');
    return;
  }

  // Historical rows stay in the ledger, but a cancelled card from long ago is
  // not a current coverage problem. Audit the same rolling window we scrape.
  const relevanceCutoff = new Date();
  relevanceCutoff.setHours(0, 0, 0, 0);
  relevanceCutoff.setMonth(relevanceCutoff.getMonth() - 3);
  const recentTxns = txns.filter((t) => t.date >= relevanceCutoff);
  const cards = recentTxns.filter((t) => t.account.type === 'credit_card');
  const bank = recentTxns.filter((t) => t.account.type === 'bank');

  console.log(
    `Auditing ${recentTxns.length} recent transactions (${bank.length} bank, ${cards.length} card). ` +
      `${txns.length - recentTxns.length} older rows are retained and intentionally ignored for warnings.\n`,
  );

  // ---------------------------------------------------------------- 1. coverage
  console.log('1. Data sources');
  const accounts = await prisma.account.findMany();
  const bankAccounts = accounts.filter((a) => a.type === 'bank');
  const cardAccounts = accounts.filter((a) => a.type === 'credit_card');
  console.log(`   banks: ${bankAccounts.map((a) => a.displayName).join(', ') || '(none)'}`);
  console.log(`   cards: ${cardAccounts.map((a) => a.displayName).join(', ') || '(none)'}`);

  const cardsMissingProcessedDate = cards.filter((t) => !t.processedDate).length;
  if (cardsMissingProcessedDate > 0) {
    findings.push({
      severity: 'warning',
      message: `${cardsMissingProcessedDate} card transactions have no charge date (processedDate). The credit-card float cannot include them, so the balance forecast will be optimistic. Set billingDay on the card account, or check what the scraper returns.`,
    });
  }

  // -------------------------------------------- 2. structural settlement match
  console.log('\n2. Card settlements vs the purchases they cover');

  /** charge date -> total per card account */
  const expectedByCardAndDate = new Map<string, number>();
  for (const t of cards) {
    if (!t.processedDate) continue;
    const key = `${t.accountId}|${toISODate(t.processedDate)}`;
    expectedByCardAndDate.set(key, (expectedByCardAndDate.get(key) ?? 0) + t.amount);
  }

  const bankDebits = bank.filter((t) => t.amount < 0);
  /** bank debits that structurally look like a settlement */
  const structuralSettlements: Array<{ txn: (typeof bank)[number]; expected: number; cardName: string }> = [];
  const todayISO = toISODate(new Date());
  /** A charge date in the future has not been debited yet - that is the float, not a gap. */
  const unsettledFuture: string[] = [];
  const unmatchedPast: Array<{ dateISO: string; expected: number; cardName: string }> = [];

  for (const [key, expected] of expectedByCardAndDate) {
    const [accountId, dateISO] = key.split('|');
    const cardName = accounts.find((a) => a.id === accountId)?.displayName ?? accountId;
    const hit = bankDebits.find(
      (b) => toISODate(b.date) === dateISO && Math.abs(b.amount - expected) <= MATCH_TOLERANCE_AGOROT,
    );
    if (hit) structuralSettlements.push({ txn: hit, expected, cardName });
    else if (dateISO > todayISO) unsettledFuture.push(`${cardName} ${dateISO}`);
    else unmatchedPast.push({ dateISO, expected, cardName });
  }

  console.log(
    `   ${structuralSettlements.length} settled charge dates matched by amount` +
      (unsettledFuture.length ? `, ${unsettledFuture.length} still in the float (${unsettledFuture.join(', ')})` : ''),
  );

  if (unmatchedPast.length > 0) {
    // Either the bank scrape is missing days, or the card scrape is incomplete.
    for (const u of unmatchedPast.slice(0, 6)) {
      console.log(`   ? ${u.dateISO} expected a ${ils(u.expected)} debit for ${u.cardName} — no matching bank debit found`);
    }
    findings.push({
      severity: 'warning',
      message: `${unmatchedPast.length} past card charge date(s) have no matching bank debit. Usually means the bank history does not go back as far as the card history - harmless - but check the bank scrape is not missing transactions.`,
    });
  }

  // The ones that matter: a real settlement still being counted as spending.
  const leaking = structuralSettlements.filter(({ txn }) => classify(txn) !== 'transfer');
  if (leaking.length > 0) {
    findings.push({
      severity: 'error',
      message:
        `${leaking.length} bank debit(s) are credit-card settlements but are NOT classified as "transfer", so the same money is counted twice ` +
        `(once as card purchases, once here). Fix: add a category rule matching their wording and point it at a category whose kind is "transfer".`,
    });
    for (const { txn, cardName } of leaking.slice(0, 10)) {
      console.log(
        `   ✗ ${toISODate(txn.date)} ${ils(txn.amount)} "${txn.description}" ` +
          `matches ${cardName} — currently counted as ${classify(txn)}`,
      );
    }
  } else if (structuralSettlements.length > 0) {
    console.log('   ✓ all matched settlements are excluded from totals');
  }

  // ---------------------------------------- 3. transfers that are not settlements
  console.log('\n3. Transactions excluded from totals');
  const excluded = recentTxns.filter((t) => classify(t) === 'transfer');
  const excludedTotal = excluded.reduce((s, t) => s + Math.abs(t.amount), 0);
  console.log(`   ${excluded.length} transactions, ${ils(excludedTotal)} excluded as transfers`);

  const settlementIds = new Set(structuralSettlements.map((s) => s.txn.id));
  const unexplained = excluded.filter((t) => !settlementIds.has(t.id) && t.account.type === 'bank');
  if (unexplained.length > 0) {
    // Not necessarily wrong (own-account transfers belong here) but worth a look:
    // anything wrongly marked transfer disappears from your spending entirely.
    console.log(`   ${unexplained.length} excluded bank transactions are not matched card settlements:`);
    const byDesc = new Map<string, { n: number; total: number }>();
    for (const t of unexplained) {
      const e = byDesc.get(t.description) ?? { n: 0, total: 0 };
      e.n++;
      e.total += t.amount;
      byDesc.set(t.description, e);
    }
    for (const [desc, e] of [...byDesc].sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total)).slice(0, 8)) {
      console.log(`     ${String(e.n).padStart(3)}x ${ils(e.total).padStart(12)}  ${desc}`);
    }
    findings.push({
      severity: 'warning',
      message: `${unexplained.length} bank transactions are excluded from all totals without matching a card settlement. Verify each is genuinely an internal transfer - anything mis-marked here vanishes from your spending.`,
    });
  }

  // ------------------------------------------------------ 4. uncategorised spend
  console.log('\n4. Uncategorised transactions');
  const uncategorised = recentTxns.filter((t) => !t.categoryId && t.amount < 0);
  const uncatTotal = uncategorised.reduce((s, t) => s + -t.amount, 0);
  console.log(`   ${uncategorised.length} expenses, ${ils(uncatTotal)} — counted as variable spending`);
  if (uncategorised.length > 0) {
    findings.push({
      severity: 'warning',
      message: `${uncategorised.length} uncategorised expenses (${ils(uncatTotal)}) default to "variable". If any is actually a fixed commitment or a transfer, the forecast is off.`,
    });
  }

  // ---------------------------------------------------------- 5. the bottom line
  console.log('\n5. The bottom line');
  const completed = recentTxns.filter((t) => t.status === 'completed');
  const counted = completed
    .filter(countsAsSpending)
    .reduce((s, t) => s + -t.amount, 0);
  const naive = completed.filter((t) => t.amount < 0).reduce((s, t) => s + -t.amount, 0);
  console.log(`   naive total of every outgoing transaction: ${ils(naive)}`);
  console.log(`   what the system counts as spending:        ${ils(Math.max(0, counted))}`);
  console.log(`   not counted (transfers/excluded/refunds):   ${ils(naive - Math.max(0, counted))}`);

  // ------------------------------------------------------------ 6. sync health
  console.log('\n6. Coverage — is anything charging you that is not connected?');
  const { issues } = await analyseSyncHealth();
  if (issues.length === 0) {
    console.log('   ✓ every card company seen in the bank statement is connected');
  }
  for (const issue of issues) {
    console.log(`   ${issue.severity === 'error' ? '✗' : '!'} ${issue.title}`);
    console.log(`     ${issue.detail}`);
    findings.push({
      severity: issue.severity === 'error' ? 'error' : 'warning',
      message: issue.title,
    });
  }

  // ------------------------------------------------------------------- verdict
  console.log('\n' + '-'.repeat(70));
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  if (findings.length === 0) {
    console.log('✓ No double-counting detected.');
  } else {
    for (const f of errors) console.log(`✗ ERROR:   ${f.message}`);
    for (const f of warnings) console.log(`! WARNING: ${f.message}`);
  }

  if (errors.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
