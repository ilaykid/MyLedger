import { prisma } from './db.js';
import { cashflowSnapshot, classify, isIncome, type Flow } from './cashflow.js';
import { spreadContext } from './spread.js';
import { monthRange } from './month.js';

/**
 * "What did this month earn and spend, by topic?" - the by-category view.
 *
 * Deliberately built on the same `classify()` and `spreadContext()` as the
 * dashboard rather than its own SQL. Two screens that answer the same question
 * with two different code paths WILL drift, and the moment the category page and
 * the headline disagree by ₪40 the whole system stops being believable. Every
 * figure here is the dashboard's figures, grouped differently.
 *
 * Consequences of that choice, all intentional:
 *  - pending transactions count (the money is committed), as on the dashboard
 *  - card purchases count on the purchase date, not the debit date (accrual)
 *  - transfers are absent entirely
 *  - a spread lump sum contributes only this month's slice, and the line says so
 */

/**
 * One actual transaction inside a category.
 *
 * These used to be merged by description with an "×6" beside them, which read
 * as a riddle: opening a category is exactly the moment you want the individual
 * charges, and being handed a count instead means going somewhere else to see
 * what you already asked for. The rows are the rows.
 */
export interface BreakdownItem {
  date: string;
  description: string;
  amount: number;
  /** True when this line is a slice of a spread plan rather than a real charge */
  fromSpread: boolean;
}

export interface BreakdownLine {
  categoryId: string | null;
  name: string;
  color: string;
  icon: string;
  kind: Flow;
  /** positive magnitude, agorot */
  amount: number;
  /** 0..1 of its own side's total - precomputed so the UI cannot get it wrong */
  share: number;
  count: number;
  /**
   * Part of `amount` that is recognition of a spread lump sum rather than money
   * that moved this month. Surfaced because "why is there income here I
   * don't remember receiving" is the first question a spread provokes.
   */
  fromSpread: number;
  /** Monthly budget in agorot, when one is set */
  budget: number | null;
  /** The biggest transactions inside this category, largest first */
  topItems: BreakdownItem[];
  /** All contributions for the inline monthly category review. */
  items: BreakdownItem[];
  /** How many more there are beyond `topItems` - the drill-through has the rest */
  moreItems: number;
}

export interface BreakdownSide {
  total: number;
  /** Of `total`: the predictable part (income_fixed / fixed) */
  fixed: number;
  /** Of `total`: the part that varies (income_variable / variable) */
  variable: number;
  lines: BreakdownLine[];
}

export interface Breakdown {
  month: string;
  income: BreakdownSide;
  expense: BreakdownSide;
  /**
   * Money put aside, kept out of `expense` entirely.
   *
   * Filed among the expenses it read as a scolding - the biggest red bar of the
   * month for the one thing that went right. It is still yours; the only thing
   * that changed is where it sits. `rateOfIncome` is what makes it a score
   * rather than another number.
   */
  savings: { total: number; rateOfIncome: number; lines: BreakdownLine[] };
  /** Real money that is deliberately outside the cash-flow verdict */
  excluded: { in: number; out: number; lines: BreakdownLine[] };
  /** income.total - expense.total, from money that has actually moved */
  net: number;
  /**
   * Where the month is heading - present only while it is still running.
   *
   * WHY THIS EXISTS
   * `net` is a true number and a terrible headline. Income arrives in one or
   * two beats and expenses flow continuously, so a month-to-date net is
   * structurally negative for its whole first half: deep in the red on day 11
   * while most of the month's salary was still due and the dashboard was
   * calling the same cycle healthy. A figure that says "שלילי" in red every month until
   * payday is not a warning, it is noise that trains you to ignore warnings.
   *
   * WHERE THE NUMBERS COME FROM
   * `cashflowSnapshot()`, not a second forecast built here. Two screens
   * answering the same question through two code paths WILL drift, and the
   * moment the by-topic page and the dashboard disagree about whether the
   * month is fine, neither is believable. Consequence: this is only attached
   * when the requested month IS the current cycle. A cycle anchored to payday
   * rather than the 1st does not line up with a calendar month, and inventing
   * a projection for a window the engine never computed would be exactly the
   * drift this avoids.
   */
  projection: {
    /** Received + still expected from recurring income */
    income: number;
    incomeExpected: number;
    /** Paid + still due */
    expense: number;
    fixedUpcoming: number;
    /** Forecast from the median daily rate of complete cycles */
    variableProjectedRest: number;
    /** income - expense, on the same definition as `net` (savings excluded) */
    net: number;
    daysElapsed: number;
    daysTotal: number;
  } | null;
  budget: {
    /** How many categories have a budget set */
    tracked: number;
    totalBudget: number;
    /** Spent inside budgeted categories only - comparable to totalBudget */
    totalSpent: number;
    /** How many budgeted categories are over */
    over: number;
    /** Expense total sitting in categories with no budget at all */
    unbudgeted: number;
  };
}

/** Enough to recognise the month at a glance; the rest is one click away. */
const TOP_ITEMS = 12;

interface Bucket {
  amount: number;
  count: number;
  fromSpread: number;
  byFlow: Map<Flow, number>;
  items: BreakdownItem[];
}

function normalisePair(first: number, second: number): [number, number] {
  // Refunds reduce their own side. If they exceed that side, carry the excess
  // across so the split still adds up exactly to the headline total.
  if (first < 0) return [0, Math.max(0, second + first)];
  if (second < 0) return [Math.max(0, first + second), 0];
  return [first, second];
}

/**
 * The forward view for a month still in progress, borrowed from the cash-flow
 * engine rather than recomputed.
 *
 * Returns null for any month that is finished (its `net` is already the final
 * answer) and for any month the current cycle does not cover - see the comment
 * on `Breakdown.projection`.
 */
async function projectionFor(month: string): Promise<Breakdown['projection']> {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month !== currentMonth) return null;

  const snap = await cashflowSnapshot();
  // A cycle anchored to payday spans two calendar months; projecting one from
  // the other would be a guess dressed as a number.
  if (!snap.cycle.isCurrent || snap.cycle.start.slice(0, 7) !== month) return null;
  // Nothing left to project on the last day - `net` is the answer by then.
  if (snap.cycle.daysRemaining <= 0) return null;

  return {
    income: snap.income.total,
    incomeExpected: snap.income.expected,
    expense: snap.fixed.total + snap.variable.projectedTotal,
    fixedUpcoming: snap.fixed.upcoming,
    variableProjectedRest: snap.variable.projectedRest,
    // The engine's own figure, not arithmetic repeated here - see projectedNet.
    net: snap.projectedNet,
    daysElapsed: snap.cycle.daysElapsed,
    daysTotal: snap.cycle.daysTotal,
  };
}

export async function monthlyBreakdown(month: string): Promise<Breakdown> {
  const { start, end } = monthRange(month);

  const [rawTxns, spread, categories] = await Promise.all([
    prisma.transaction.findMany({
      where: { date: { gte: start, lt: end } },
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        categoryId: true,
        installmentTotal: true,
        category: { select: { kind: true } },
        account: { select: { type: true } },
      },
    }),
    spreadContext(start, end),
    prisma.category.findMany({
      select: { id: true, name: true, color: true, icon: true, monthlyBudget: true },
    }),
  ]);

  // Same two-step as everywhere else: drop the lump sums, add their slices.
  const rows = [
    ...rawTxns.filter((t) => !spread.spreadIds.has(t.id)).map((t) => ({ ...t, spreadOf: null as string | null })),
    ...spread.rows.map((r) => ({
      id: null as string | null,
      date: r.date,
      amount: r.amount,
      description: r.description,
      categoryId: r.categoryId,
      installmentTotal: r.installmentTotal,
      category: r.category,
      account: r.account,
      spreadOf: r.spreadOf,
    })),
  ];

  const incomeBuckets = new Map<string | null, Bucket>();
  const expenseBuckets = new Map<string | null, Bucket>();
  const excludedBuckets = new Map<string | null, Bucket>();
  const savingsBuckets = new Map<string | null, Bucket>();

  let excludedIn = 0;
  let excludedOut = 0;
  const totals = new Map<Flow, number>();

  for (const t of rows) {
    const flow = classify(t);
    if (flow === 'transfer') continue;

    const target =
      flow === 'excluded'
        ? excludedBuckets
        : flow === 'savings'
          ? savingsBuckets
          : isIncome(flow)
            ? incomeBuckets
            : expenseBuckets;

    // Magnitudes throughout: a refund inside a category reduces that category's
    // total, which is what "how much did food cost me" actually means.
    const signed = isIncome(flow) || (flow === 'excluded' && t.amount > 0) ? t.amount : -t.amount;

    const bucket =
      target.get(t.categoryId) ??
      ({ amount: 0, count: 0, fromSpread: 0, byFlow: new Map(), items: [] } as Bucket);
    bucket.amount += signed;
    bucket.byFlow.set(flow, (bucket.byFlow.get(flow) ?? 0) + signed);
    totals.set(flow, (totals.get(flow) ?? 0) + signed);
    bucket.count++;
    if (t.spreadOf) bucket.fromSpread += signed;

    bucket.items.push({
      date: t.date.toISOString().slice(0, 10),
      description: t.description,
      amount: signed,
      fromSpread: t.spreadOf != null,
    });

    target.set(t.categoryId, bucket);

    if (flow === 'excluded') {
      if (t.amount > 0) excludedIn += t.amount;
      else excludedOut += -t.amount;
    }
  }

  const catById = new Map(categories.map((c) => [c.id, c]));

  function toLines(buckets: Map<string | null, Bucket>): BreakdownLine[] {
    const total = [...buckets.values()].reduce((s, b) => s + Math.abs(b.amount), 0) || 1;
    return [...buckets.entries()]
      // Keep refund-only categories visible. Dropping them made this screen
      // disagree with the monthly headline even though both used the same rows.
      .filter(([, b]) => b.amount !== 0)
      .map(([categoryId, b]) => {
        const cat = categoryId ? catById.get(categoryId) : null;
        const kind = [...b.byFlow.entries()].sort(
          (a, b2) => Math.abs(b2[1]) - Math.abs(a[1]),
        )[0]?.[0] ?? 'variable';
        return {
          categoryId,
          name: cat?.name ?? 'ללא קטגוריה',
          color: cat?.color ?? 'var(--text-muted)',
          icon: cat?.icon ?? '❔',
          kind,
          amount: b.amount,
          share: Math.abs(b.amount) / total,
          count: b.count,
          fromSpread: b.fromSpread,
          budget: cat?.monthlyBudget ?? null,
          topItems: [...b.items]
            .sort((a, b2) => Math.abs(b2.amount) - Math.abs(a.amount))
            .slice(0, TOP_ITEMS),
          items: [...b.items].sort((a, b) => b.date.localeCompare(a.date)),
          moreItems: Math.max(0, b.items.length - TOP_ITEMS),
        };
      })
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }

  const incomeLines = toLines(incomeBuckets);
  const expenseLines = toLines(expenseBuckets);
  const excludedLines = toLines(excludedBuckets);
  const savingsLines = toLines(savingsBuckets);

  const [incomeFixed, incomeVariable] = normalisePair(
    totals.get('income_fixed') ?? 0,
    totals.get('income_variable') ?? 0,
  );
  const [fixedExpense, variableExpense] = normalisePair(
    totals.get('fixed') ?? 0,
    totals.get('variable') ?? 0,
  );
  const incomeTotal = incomeFixed + incomeVariable;
  const expenseTotal = fixedExpense + variableExpense;
  // Withdrawals from savings net off deposits, so a month that drew more than it
  // put in reports zero rather than a negative "saving".
  const savingsTotal = Math.max(0, totals.get('savings') ?? 0);

  const budgeted = expenseLines.filter((l) => l.budget != null && l.budget > 0);

  return {
    projection: await projectionFor(month),
    month,
    income: {
      total: incomeTotal,
      fixed: incomeFixed,
      variable: incomeVariable,
      lines: incomeLines,
    },
    expense: {
      total: expenseTotal,
      fixed: fixedExpense,
      variable: variableExpense,
      lines: expenseLines,
    },
    excluded: { in: excludedIn, out: excludedOut, lines: excludedLines },
    savings: {
      total: savingsTotal,
      // Against income, not against spending: "I kept 12% of what I earned" is
      // the sentence people actually judge a month by.
      rateOfIncome: incomeTotal > 0 ? savingsTotal / incomeTotal : 0,
      lines: savingsLines,
    },
    net: incomeTotal - expenseTotal,
    budget: {
      tracked: budgeted.length,
      totalBudget: budgeted.reduce((s, l) => s + (l.budget ?? 0), 0),
      totalSpent: Math.max(0, budgeted.reduce((s, l) => s + l.amount, 0)),
      over: budgeted.filter((l) => l.amount > (l.budget ?? 0)).length,
      unbudgeted: Math.max(0, expenseTotal - budgeted.reduce((s, l) => s + l.amount, 0)),
    },
  };
}
