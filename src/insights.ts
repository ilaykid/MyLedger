import { createHash } from 'node:crypto';
import { prisma } from './db.js';
import { classify, countsAsSpending, monthlyHistory } from './cashflow.js';
import { installmentSummary } from './installments.js';
import { cycleFor, cycleOrdinal, dateInCycleForDay, dayDiff, signatureOf, startOfDay } from './cycle.js';
import { getSettings, recurringMatches } from './recurring.js';

/**
 * Insight generation.
 *
 * Deliberately deterministic rules rather than anything clever: each insight
 * below is something you would want to be *told*, phrased as a fact you can
 * verify against the transaction list. The bar for including one is that it
 * either costs money (a double charge, a subscription that crept up), catches
 * something you did not do (a merchant you have never used), or changes a
 * decision (money freeing up next month).
 *
 * Anything that would just restate the dashboard in a sentence is left out.
 */

export type InsightKind =
  | 'card_fee'
  | 'duplicate_charge'
  | 'new_merchant'
  | 'unusual_amount'
  | 'category_jump'
  | 'category_drop'
  | 'installment_ending'
  | 'recurring_increase'
  | 'monthly_verdict'
  | 'quiet_month'
  | 'fixed_expense_late'
  | 'credit_in_expense_category';

export interface Insight {
  /** Stable identifier used only for local feedback. */
  key: string;
  kind: InsightKind;
  /** 0 = show first. Money-losing findings outrank interesting ones. */
  rank: number;
  title: string;
  detail: string;
  amount?: number;
  /** Merchant names are withheld at the "amounts" privacy level */
  merchant?: string;
  feedback?: 'useful' | null;
}

type DraftInsight = Omit<Insight, 'key' | 'feedback'>;

const ils = (agorot: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(
    agorot / 100,
  );

const heMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
};

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

interface Row {
  id: string;
  date: Date;
  amount: number;
  description: string;
  accountId: string;
  installmentTotal: number | null;
  category: { name: string; kind: string } | null;
  account: { type: string; displayName: string; institution: string; lastFour: string };
}

function formatDate(date: Date): string {
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');
}

async function loadRows(since: Date): Promise<Row[]> {
  return prisma.transaction.findMany({
    where: { date: { gte: since } },
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      accountId: true,
      installmentTotal: true,
      category: { select: { name: true, kind: true } },
      account: { select: { type: true, displayName: true, institution: true, lastFour: true } },
    },
    orderBy: { date: 'asc' },
  }) as Promise<Row[]>;
}

/**
 * A fixed expense that was due and has not arrived.
 *
 * The forecast already knows every recurring commitment and the day it usually
 * lands, and it happily counts one as "still coming" for the whole cycle - so a
 * direct debit that silently stopped looks identical to one that simply has not
 * been charged yet. It matters in both directions: a cancelled standing order is
 * money you are still being told to reserve, and a failed one is a bill about to
 * become a problem.
 *
 * Deliberately shares the staleness rules with the cash-flow forecast, so the
 * two can never disagree about whether an item is still live.
 */
async function lateFixedExpenses(now: Date): Promise<DraftInsight[]> {
  /** Payment dates drift by a day or two; only call it late past this. */
  const GRACE_DAYS = 3;

  const settings = await getSettings();
  const anchor = settings.cycleAnchorDay;
  const cycle = cycleFor(now, anchor, 0);
  const today = startOfDay(now);

  const [recurring, cycleTxns] = await Promise.all([
    prisma.recurringExpense.findMany({
      where: { active: true, direction: 'expense' },
      select: { signature: true, displayName: true, expectedAmount: true, expectedDay: true, frequency: true, lastSeen: true, accountId: true, direction: true, source: true, validFrom: true, validUntil: true },
    }),
    prisma.transaction.findMany({
      where: { date: { gte: cycle.start, lt: cycle.end } },
      select: { description: true, accountId: true, amount: true },
    }),
  ]);

  const seen = new Set(cycleTxns.map((t) => signatureOf(t.description)));
  const out: DraftInsight[] = [];

  for (const r of recurring) {
    if (cycleTxns.some(t => recurringMatches(t, r))) continue;

    const due = dateInCycleForDay(cycle, r.expectedDay);
    if (!due || (r.validFrom && due < r.validFrom) || (r.validUntil && due > r.validUntil)) continue;

    // Not late until the usual day plus a grace window has passed.
    if (dayDiff(today, due) < GRACE_DAYS) continue;

    const cyclesSinceLastSeen = cycleOrdinal(cycle.start, anchor) - cycleOrdinal(r.lastSeen, anchor);

    // Same rules the forecast uses. A bimonthly bill is only due on even
    // cycles, and anything missing longer than its own period has probably
    // ended rather than being late - the forecast has already dropped it, so
    // raising it here would contradict the dashboard.
    if (r.frequency === 'bimonthly' && cyclesSinceLastSeen % 2 !== 0) continue;
    const staleAfter = r.frequency === 'bimonthly' ? 4 : 2;
    if (r.source === 'detected' && cyclesSinceLastSeen >= staleAfter) continue;

    const amount = Math.abs(r.expectedAmount);
    const daysLate = dayDiff(today, due);
    out.push({
      kind: 'fixed_expense_late',
      rank: 1,
      title: 'הוצאה קבועה שלא ירדה',
      detail:
        `${r.displayName} · ${ils(amount)} · בדרך כלל יורדת ב-${r.expectedDay} לחודש, ` +
        `וכבר ${daysLate} ימים שהיא לא נרשמה. אם היא בוטלה — כדאי להסיר אותה מהקבועות ` +
        `כדי לשחרר את הסכום בתחזית. אם לא — היא עוד לפניכם.`,
      amount,
      merchant: r.displayName,
    });
  }

  return out.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 4);
}

/**
 * Money that came IN while sitting in a category meant for money going OUT.
 *
 * Almost always a loan drawdown, an investment withdrawal or a transfer that the
 * rules matched on the merchant name without looking at the sign. It is not a
 * cosmetic error: these are large, and until the fix above they were subtracted
 * from the very commitments they were filed alongside - one large credit in a
 * fixed category reported a month with no fixed expenses at all.
 *
 * The right home is nearly always `excluded` or `transfer`, but which one is a
 * statement about your money, so this asks rather than guesses.
 */
async function creditsInExpenseCategories(now: Date): Promise<DraftInsight[]> {
  const since = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  /** Small credits in an expense category are ordinary refunds. */
  const MIN_AMOUNT = 100_00;

  const rows = await prisma.transaction.findMany({
    where: {
      date: { gte: since },
      amount: { gt: MIN_AMOUNT },
      category: { kind: { in: ['fixed', 'variable'] } },
    },
    select: {
      amount: true,
      date: true,
      description: true,
      category: { select: { name: true } },
    },
    orderBy: { amount: 'desc' },
    take: 3,
  });

  return rows.map((r) => ({
    kind: 'credit_in_expense_category' as InsightKind,
    rank: 0,
    title: 'כסף שנכנס יושב בקטגוריית הוצאה',
    detail:
      `${r.description} · ${ils(r.amount)} · ${formatDate(r.date)} · מסווג כ"${r.category?.name}". ` +
      `סכום שנכנס בקטגוריה של הוצאות מעוות את הסיכומים — בדרך כלל זו משיכה מהשקעות, ` +
      `הלוואה שהתקבלה או העברה. השיוך הנכון הוא "לא תזרימי" או "העברה", תלוי מה זה.`,
    amount: r.amount,
    merchant: r.description,
  }));
}

/**
 * @param windowDays how far back "recent" reaches for the event-style insights
 * @param asOf exclusive end of a PAST period to look back on (the monthly
 *   digest's "what stood out in September"). Without it the findings are about
 *   today. With it, nothing after `asOf` is seen, and the present-tense checks -
 *   a bill late right now, a miscategorised credit to fix, an instalment plan
 *   ending soon - are skipped, because they describe today and would leak the
 *   current month into a summary of a finished one.
 */
export async function generateInsights(windowDays = 7, asOf?: Date): Promise<Insight[]> {
  const realNow = new Date();
  const retrospective = asOf != null;
  const now = asOf ? new Date(asOf.getTime() - 1) : realNow;
  const history = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - windowDays);

  const rows = (await loadRows(history)).filter((r) => !asOf || r.date < asOf);
  const spending = rows.filter((r) => r.amount < 0 && countsAsSpending(r));
  const recent = spending.filter((r) => r.date >= windowStart);

  const insights: DraftInsight[] = [];

  // ------------------------------------------------------- 0. avoidable fees
  // These descriptions vary between issuers, but the phrases below are narrow
  // enough not to confuse an ordinary purchase with a card membership fee.
  const cardFeePattern = /(?:דמי\s*(?:כרטיס|חבר)|עמלת\s*(?:כרטיס|כרטיסי\s*אשראי)|דמי\s*ניהול\s*כרטיס)/i;
  const offsetPattern = /(?:דמי\s*כרטיס|הנפקה|הנחה)/i;
  const uncompensatedFees = recent.filter((row) => {
    if (!cardFeePattern.test(row.description)) return false;
    // Issuers sometimes post the fee and its waiver as two opposite rows. A
    // fully offset fee costs nothing and is not worth interrupting the user.
    return !rows.some((credit) =>
      credit.accountId === row.accountId &&
      credit.amount === Math.abs(row.amount) &&
      credit.amount > 0 &&
      offsetPattern.test(credit.description) &&
      Math.abs(credit.date.getTime() - row.date.getTime()) <= 35 * 86_400_000,
    );
  });
  for (const r of uncompensatedFees.slice(0, 4)) {
    insights.push({
      kind: 'card_fee',
      rank: 1,
      title: 'זוהו דמי כרטיס',
      detail: `${r.account.displayName} · ${r.description} · ${ils(Math.abs(r.amount))} · ${formatDate(r.date)}. לעיתים אפשר לבטל או לקבל פטור מהעמלה הזו בשיחה קצרה עם חברת האשראי.`,
      amount: Math.abs(r.amount),
      merchant: r.description,
    });
  }

  // ---------------------------------------------------- 1. duplicate charges
  // Same merchant, same amount, same card, within a few days. Occasionally a
  // legitimate repeat purchase - but it is the one finding worth checking by
  // hand every time, so it leads.
  const seen = new Map<string, Row[]>();
  for (const r of spending) {
    const key = `${r.accountId}|${signatureOf(r.description)}|${r.amount}`;
    const list = seen.get(key) ?? [];
    list.push(r);
    seen.set(key, list);
  }
  for (const rawList of seen.values()) {
    // Instalments are supposed to repeat; they are not duplicate candidates.
    const list = rawList.filter((row) => row.installmentTotal == null);
    if (list.length < 2) continue;

    const clusters: Row[][] = [];
    let cluster: Row[] = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const gapDays = (list[i].date.getTime() - list[i - 1].date.getTime()) / 86_400_000;
      if (gapDays <= 3) cluster.push(list[i]);
      else {
        if (cluster.length > 1) clusters.push(cluster);
        cluster = [list[i]];
      }
    }
    if (cluster.length > 1) clusters.push(cluster);

    for (const group of clusters) {
      const first = group[0];
      const last = group[group.length - 1];
      if (last.date < windowStart) continue;
      const gapDays = Math.round((last.date.getTime() - first.date.getTime()) / 86_400_000);
      const occurrenceText = group.length === 2
        ? `פעמיים תוך ${gapDays} ימים`
        : `ב-${group.length} חיובים בתוך ${gapDays} ימים`;
      insights.push({
        kind: 'duplicate_charge',
        rank: 0,
        title: 'ייתכן חיוב כפול',
        detail: `${last.description} — ${ils(Math.abs(last.amount))} ${occurrenceText} (${formatDate(first.date)} עד ${formatDate(last.date)}). שווה לבדוק.`,
        amount: Math.abs(last.amount) * (group.length - 1),
        merchant: last.description,
      });
    }
  }

  // ------------------------------------------------------- 2. new merchants
  // A merchant with no history at all. Mostly just new places you tried; the
  // reason it is here is the occasional one you did not.
  const historicalSignatures = new Set(
    spending.filter((r) => r.date < windowStart).map((r) => signatureOf(r.description)),
  );
  const newOnes = new Map<string, { total: number; count: number; name: string; first: Date; last: Date }>();
  for (const r of recent) {
    const sig = signatureOf(r.description);
    if (historicalSignatures.has(sig)) continue;
    const e = newOnes.get(sig) ?? { total: 0, count: 0, name: r.description, first: r.date, last: r.date };
    e.total += Math.abs(r.amount);
    e.count++;
    if (r.date < e.first) e.first = r.date;
    if (r.date > e.last) e.last = r.date;
    newOnes.set(sig, e);
  }
  for (const e of [...newOnes.values()].sort((a, b) => b.total - a.total).slice(0, 3)) {
    const when = e.first.getTime() === e.last.getTime()
      ? `בתאריך ${formatDate(e.first)}`
      : `בין ${formatDate(e.first)} ל-${formatDate(e.last)}`;
    insights.push({
      kind: 'new_merchant',
      rank: 2,
      title: 'ספק חדש',
      detail: `${e.name} — ${ils(e.total)}${e.count > 1 ? ` ב-${e.count} חיובים` : ''}, ${when}. לא הופיע בהיסטוריה עד עכשיו.`,
      amount: e.total,
      merchant: e.name,
    });
  }

  // ----------------------------------------------------- 3. unusual amounts
  // Much larger than what this merchant normally costs you.
  const byMerchant = new Map<string, Row[]>();
  for (const r of spending) {
    const sig = signatureOf(r.description);
    const list = byMerchant.get(sig) ?? [];
    list.push(r);
    byMerchant.set(sig, list);
  }
  for (const r of recent) {
    const list = byMerchant.get(signatureOf(r.description)) ?? [];
    const past = list.filter((x) => x.date < windowStart).map((x) => Math.abs(x.amount));
    if (past.length < 4) continue; // not enough history to call anything unusual
    const typical = median(past);
    const amount = Math.abs(r.amount);
    if (typical <= 0 || amount < typical * 2.5 || amount - typical < 20_000) continue;
    insights.push({
      kind: 'unusual_amount',
      rank: 1,
      title: 'חיוב חריג בגובהו',
      detail: `${r.description} — ${ils(amount)}, לעומת ${ils(typical)} שאתה משלם שם בדרך כלל.`,
      amount,
      merchant: r.description,
    });
  }

  // ------------------------------------------- 4. category vs its own average
  // Compares the month so far against the same span in previous months, so an
  // early-month reading is not automatically "down".
  const thisMonth = monthKey(now);
  const dayOfMonth = now.getDate();
  const perCategoryThis = new Map<string, number>();
  /** Per category, per earlier month: the total over the same slice of days. */
  const perCategoryPrev = new Map<string, Map<string, number>>();

  for (const r of spending) {
    const name = r.category?.name;
    if (!name || r.category?.kind !== 'variable') continue;
    if (r.date.getDate() > dayOfMonth) continue; // same slice of every month
    const key = monthKey(r.date);
    if (key === thisMonth) {
      perCategoryThis.set(name, (perCategoryThis.get(name) ?? 0) + Math.abs(r.amount));
    } else {
      const months = perCategoryPrev.get(name) ?? new Map<string, number>();
      months.set(key, (months.get(key) ?? 0) + Math.abs(r.amount));
      perCategoryPrev.set(name, months);
    }
  }

  const movers: Array<{ name: string; now: number; typical: number; delta: number }> = [];
  for (const [name, current] of perCategoryThis) {
    // Month totals, not single purchases: the median grocery RUN is not what a
    // month of groceries costs, and comparing against it fired on every month.
    const past = [...(perCategoryPrev.get(name)?.values() ?? [])];
    if (past.length < 3) continue;
    const typical = median(past);
    if (typical < 10_000) continue; // ignore categories too small to matter
    movers.push({ name, now: current, typical, delta: current - typical });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const riser = movers.find((m) => m.delta > m.typical * 0.4);
  if (riser) {
    insights.push({
      kind: 'category_jump',
      rank: 3,
      title: `${riser.name} גבוה מהרגיל`,
      detail: retrospective
        ? `${ils(riser.now)} בכל החודש, לעומת ${ils(riser.typical)} בחודש רגיל.`
        : `${ils(riser.now)} עד עכשיו החודש, לעומת ${ils(riser.typical)} שהוצאת באותו יום בחודשים קודמים.`,
      amount: riser.delta,
    });
  }
  const faller = movers.find((m) => m.delta < -m.typical * 0.4);
  if (faller) {
    insights.push({
      kind: 'category_drop',
      rank: 5,
      title: `${faller.name} נמוך מהרגיל`,
      detail: retrospective
        ? `${ils(faller.now)} בכל החודש, לעומת ${ils(faller.typical)} בחודש רגיל.`
        : `${ils(faller.now)} עד עכשיו החודש, לעומת ${ils(faller.typical)} בדרך כלל. חסכת ${ils(Math.abs(faller.delta))}.`,
      amount: Math.abs(faller.delta),
    });
  }

  // -------------------------------------------------- 5. instalments ending
  const plans = retrospective ? null : await installmentSummary();
  if (plans?.nextToFinish) {
    const monthsAway =
      (new Date(plans.nextToFinish.endsOn).getFullYear() - now.getFullYear()) * 12 +
      (new Date(plans.nextToFinish.endsOn).getMonth() - now.getMonth());
    if (monthsAway <= 2) {
      insights.push({
        kind: 'installment_ending',
        rank: 4,
        title: 'תשלומים שמסתיימים',
        detail: `${plans.nextToFinish.description} נגמר ב-${plans.nextToFinish.endsOn} — ומשחרר ${ils(plans.nextToFinish.perPayment)} בחודש.`,
        amount: plans.nextToFinish.perPayment,
        merchant: plans.nextToFinish.description,
      });
    }
  }

  // ------------------------------------------- 6. recurring charge crept up
  const recurring = await prisma.recurringExpense.findMany({ where: { active: true } });
  for (const r of recurring) {
    const list = (byMerchant.get(r.signature) ?? []).filter((x) => x.amount < 0);
    if (list.length < 4) continue;
    const latest = Math.abs(list[list.length - 1].amount);
    const before = median(list.slice(0, -1).map((x) => Math.abs(x.amount)));
    if (before <= 0 || latest <= before * 1.15 || latest - before < 2_000) continue;
    insights.push({
      kind: 'recurring_increase',
      rank: 1,
      title: 'הוצאה קבועה שהתייקרה',
      detail: `${r.displayName} עלה מ-${ils(before)} ל-${ils(latest)} בחודש.`,
      amount: latest - before,
      merchant: r.displayName,
    });
  }

  if (!retrospective) {
    insights.push(...(await lateFixedExpenses(now)));
    insights.push(...(await creditsInExpenseCategories(now)));
  }

  insights.sort((a, b) => a.rank - b.rank || (b.amount ?? 0) - (a.amount ?? 0));

  const keyed = insights.map((insight) => ({
    ...insight,
    key: createHash('sha256')
      .update([insight.kind, insight.title, insight.detail, insight.merchant ?? '', insight.amount ?? ''].join('|'))
      .digest('hex')
      .slice(0, 24),
  }));
  const feedback = await prisma.insightFeedback.findMany({
    where: { insightKey: { in: keyed.map((i) => i.key) } },
    select: { insightKey: true, verdict: true, snoozedUntil: true },
  });
  const verdicts = new Map(feedback.filter(f => f.verdict !== 'useful' && !(f.verdict === 'snoozed' && (!f.snoozedUntil || f.snoozedUntil <= realNow))).map((f) => [f.insightKey, f.verdict]));

  // A dismissed observation should not return in the dashboard or Telegram.
  // Both answers resolve the notification. "Useful" is positive product
  // feedback, not a request to pin the card forever.
  return keyed
    .filter((i) => verdicts.get(i.key) == null)
    .map((i) => ({ ...i, feedback: null }));
}

export interface MonthSummary {
  month: string;
  income: number;
  expense: number;
  net: number;
  positive: boolean;
  hasIncome: boolean;
  versusPrevious: number | null;
  versusAverage: number | null;
  topCategories: Array<{ name: string; amount: number; share: number }>;
}

/** Everything the monthly digest needs about one completed month. */
export async function summariseMonth(key: string): Promise<MonthSummary | null> {
  const history = await monthlyHistory(13);
  const row = history.find((m) => m.month === key);
  if (!row) return null;

  const index = history.findIndex((m) => m.month === key);
  const previous = index > 0 ? history[index - 1] : null;
  const earlier = history.slice(0, index).filter((m) => m.income > 0 || m.expense > 0);
  const averageNet = earlier.length
    ? Math.round(earlier.reduce((s, m) => s + m.net, 0) / earlier.length)
    : null;

  const [y, m] = key.split('-').map(Number);
  const rows = await prisma.transaction.findMany({
    where: { date: { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) } },
    select: {
      amount: true,
      description: true,
      accountId: true,
      installmentTotal: true,
      category: { select: { name: true, kind: true } },
      account: { select: { type: true } },
    },
  });

  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.amount >= 0) continue;
    if (!countsAsSpending(r as never)) continue;
    const name = r.category?.name ?? 'ללא קטגוריה';
    byCategory.set(name, (byCategory.get(name) ?? 0) + Math.abs(r.amount));
  }
  const totalSpend = [...byCategory.values()].reduce((s, v) => s + v, 0) || 1;

  return {
    month: key,
    income: row.income,
    expense: row.expense,
    net: row.net,
    positive: row.net >= 0,
    hasIncome: row.income > 0,
    versusPrevious: previous ? row.net - previous.net : null,
    versusAverage: averageNet != null ? row.net - averageNet : null,
    topCategories: [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, amount]) => ({ name, amount, share: amount / totalSpend })),
  };
}

export { ils as formatILS, heMonth as formatMonth };
