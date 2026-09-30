import { prisma } from './db.js';
import { spreadContext } from './spread.js';
import {
  addDays,
  cycleFor,
  cycleOrdinal,
  dateInCycleForDay,
  dayDiff,
  signatureOf,
  startOfDay,
  toISODate,
  type Cycle,
} from './cycle.js';
import { getSettings, recurringMatches } from './recurring.js';
import { coveredCycle } from './forecast-policy.js';
import { upcomingInstallments } from './installments.js';

/**
 * The cash-flow engine.
 *
 * TWO VIEWS OF THE SAME MONEY - keeping them apart is the whole trick:
 *
 * 1. ACCRUAL ("what have I spent") - a card purchase counts on the day it was
 *    made. This is the behavioural number: `available` = what is genuinely left
 *    to spend this cycle. It is the headline of the dashboard.
 *
 * 2. CASH ("what will my bank balance be") - a card purchase counts on the day
 *    the card is settled out of the bank, which in Israel is weeks later. This
 *    drives the balance timeline and the overdraft warning.
 *
 * Conflating the two is the classic Israeli budgeting trap: your balance looks
 * healthy precisely because thousands of shekels of card spending has not been
 * debited yet. `cardFloat` below is that hidden liability, made explicit.
 *
 * Sign convention for OUTPUT: every figure is a positive magnitude
 * (`income.received`, `fixed.paid`, `variable.spent`). Only `balance`,
 * `available` and raw event amounts are signed.
 */

/**
 * The six classes, on two questions: which direction, and is it part of the
 * monthly rhythm?
 *
 *   income_fixed     salary, allowances - money you can plan around
 *   income_variable  freelance, reserve duty, tax refunds - real, but not promised
 *   fixed            rent, insurance, instalments - committed outgoings
 *   variable         groceries, eating out - the part you actually control
 *   excluded         real money, wrong rhythm - see below
 *   savings          money you moved out of reach on purpose - still yours
 *   transfer         not money movement at all (card settlements, own accounts)
 *
 * WHY `savings` IS NOT JUST A TRANSFER
 * A standing order into a savings account is a transfer in the accounting sense
 * and nothing like one in the human sense. Filed as `transfer` it vanishes, and
 * the month that put ₪3,000 aside looks identical to the month that put nothing
 * aside. Filed as an expense it reads as money gone, which is worse - it is the
 * one outgoing that made you richer. Its own class, so it can be subtracted from
 * what is left to spend and still be reported as the win it is.
 *
 * WHY `excluded` EXISTS, IN BOTH DIRECTIONS
 * A six-figure mortgage prepayment is real money leaving a real account, so it
 * is not a `transfer`. But it is not a monthly commitment and not discretionary
 * spending either. Forced into `fixed` the forecast assumes it every month;
 * forced into `variable` the daily burn rate is off by orders of magnitude.
 *
 * The same trap exists on the way in, and it bites harder: a large gift, a loan
 * drawdown, an investment withdrawal. Counted as income
 * they make a month look wonderful and quietly raise the baseline you compare
 * every later month against. Hence one class, direction taken from the sign.
 *
 * Excluded from the verdict, the burn rate and the forecast - but still moving
 * the balance and still shown, because the money genuinely moved.
 */
export type Flow =
  | 'income_fixed'
  | 'income_variable'
  | 'fixed'
  | 'variable'
  | 'transfer'
  | 'excluded'
  | 'savings';

/** Every kind a Category may carry. Same vocabulary as Flow, stored as text. */
export const CATEGORY_KINDS = [
  'income_fixed',
  'income_variable',
  'fixed',
  'variable',
  'transfer',
  'excluded',
  'savings',
] as const;

export function isIncome(flow: Flow): boolean {
  return flow === 'income_fixed' || flow === 'income_variable';
}

export interface CashflowEvent {
  date: string;
  label: string;
  /** signed agorot: positive = money in, negative = money out */
  amount: number;
  /** Display bucket, not a Flow: both income kinds share one marker. */
  kind: 'income' | 'fixed' | 'card_settlement' | 'excluded';
  /** false = forecast */
  actual: boolean;
}

export interface TimelinePoint {
  date: string;
  dayOfMonth: number;
  /** projected or actual end-of-day bank balance, agorot */
  balance: number;
  actual: boolean;
  /** variable spending attributed to that day (accrual, all accounts), positive */
  variableSpend: number;
  events: CashflowEvent[];
}

export interface CashflowSnapshot {
  cycle: {
    offset: number;
    start: string;
    end: string;
    lastDay: string;
    anchorDay: number;
    daysTotal: number;
    daysElapsed: number;
    daysRemaining: number;
    /** 0..1 - how far through the cycle we are in time */
    timeProgress: number;
    isCurrent: boolean;
  };
  bankBalance: number;
  bankSnapshots: Array<{ name: string; balance: number | null; asOf: string | null }>;
  forecastCoverage: { usableCycles: number; excludedCycles: number; detail: string };
  categoryTotals: Array<{ categoryId: string | null; amount: number }>;
  income: {
    received: number;
    expected: number;
    total: number;
    /** Of `received`: the part from salary and allowances - plannable */
    fixedReceived: number;
    /** Of `received`: freelance, reserve duty, refunds - real but not promised */
    variableReceived: number;
  };
  fixed: { paid: number; upcoming: number; total: number };
  /**
   * Money deliberately moved out of reach this cycle, and what share of income
   * it represents - the "how much came in against how much I put away" pair.
   */
  savings: { deposited: number; rateOfIncome: number };
  variable: {
    spent: number;
    projectedRest: number;
    projectedTotal: number;
    dailyBurn: number;
    /** Transparent basis for the forecast: median daily rate of complete cycles. */
    forecastBasis: Array<{ start: string; end: string; total: number; daily: number }>;
  };
  cardFloat: {
    total: number;
    withinCycle: number;
    byAccount: Array<{ accountId: string; displayName: string; amount: number; chargeDate: string | null }>;
  };
  /** THE headline: planned income - committed fixed - variable spent so far */
  available: number;
  /**
   * How the cycle is expected to END: all income (received + expected) minus all
   * fixed (paid + due) minus all variable (spent + forecast for the rest).
   *
   * WHY THIS IS NOT `available`
   * `available` answers "how much may I still spend" and therefore does NOT
   * subtract the spending it expects you to do. This answers "will the month
   * come out ahead", so it does. The two differ by exactly
   * `variable.projectedRest` and are both needed.
   *
   * WHY IT LIVES HERE
   * It is the only honest headline for a month still in progress. Month-to-date
   * net is structurally negative until payday - salary arrives in one beat while
   * expenses flow daily - so a screen leading with it announces a crisis on
   * schedule every month. Two screens now lead with this figure, and computing
   * it twice would guarantee they eventually disagree about whether the month is
   * fine, at which point neither is worth reading.
   *
   * Savings are excluded from both sides, matching the monthly net: money set
   * aside is not spending.
   */
  projectedNet: number;
  dailyAllowance: number;
  /**
   * 0..1 - how much of the *discretionary* pot has been used. Compared against
   * cycle.timeProgress this is an apples-to-apples "am I spending too fast".
   * Fixed commitments are excluded from both sides on purpose: they are lumpy
   * and front-loaded, so including them would make every cycle look like
   * overspending in its first week.
   */
  spendProgress: number;
  status: 'ok' | 'tight' | 'over';
  projectedEndBalance: number;
  lowestPoint: { date: string; balance: number } | null;
  overdraftDate: string | null;
  pace: {
    currentSpend: number;
    previousSpendAtSameDay: number;
    delta: number;
    series: Array<{ day: number; current: number | null; previous: number | null }>;
  } | null;
  timeline: TimelinePoint[];
  upcoming: CashflowEvent[];
  /** Variable spending this cycle, by category, biggest first. */
  variableByCategory: Array<{
    categoryId: string | null;
    name: string;
    color: string;
    icon: string;
    amount: number;
    budget: number | null;
    /**
     * What this category typically costs in a full cycle, from its own history.
     * null when the cycle is complete, or the category has no prior cycles.
     */
    forecast: number | null;
  }>;
}

interface TxnRow {
  /** Absent on the virtual rows a spread plan expands into. */
  id?: string;
  date: Date;
  processedDate: Date | null;
  amount: number;
  description: string;
  status: string;
  accountId: string;
  categoryId: string | null;
  installmentTotal: number | null;
  category: { kind: string } | null;
  account: { type: string; displayName: string };
}

/**
 * Resolve a transaction to a cash-flow class. Explicit category classification
 * wins; uncategorized transactions are inferred - and a credit on a CARD is
 * treated as a refund (reducing variable spend) rather than as income, which is
 * what it almost always is.
 */
export function classify(t: {
  amount: number;
  category: { kind: string } | null;
  account: { type: string };
  installmentTotal?: number | null;
}): Flow {
  const kind = normaliseKind(t.category?.kind);
  // Explicit classification always wins - these are statements about what the
  // money IS, which no amount of inference should second-guess.
  if (kind === 'transfer' || kind === 'excluded' || kind === 'savings' || (kind && isIncome(kind))) return kind;

  // An instalment payment is a commitment, not a choice. The purchase was
  // discretionary; this month's payment is not - you cannot decide to skip it.
  // Counting it as variable would inflate "how much is left to spend" by the
  // whole instalment load, so it belongs with the fixed obligations regardless
  // of which category the original merchant falls into.
  if (t.installmentTotal != null && t.amount < 0) return 'fixed';

  if (kind === 'fixed' || kind === 'variable') return kind;
  // An uncategorised bank credit is income, but nothing tells us whether it
  // recurs - so it lands in the class that promises less.
  if (t.amount > 0 && t.account.type === 'bank') return 'income_variable';
  return 'variable';
}

/**
 * Accept the pre-split vocabulary so a database written by an older build still
 * reads correctly between deploying the code and running the migration.
 */
function normaliseKind(kind: string | undefined): Flow | null {
  if (!kind) return null;
  if (kind === 'income') return 'income_fixed';
  if (kind === 'oneoff') return 'excluded';
  return (CATEGORY_KINDS as readonly string[]).includes(kind) ? (kind as Flow) : null;
}

/**
 * Is this transaction part of "what I spend", the number every digest, insight
 * and anomaly check reasons about?
 *
 * Transfers are not spending (the money is still yours) and neither are
 * excluded items (real, but not part of any pattern). Left in, a single
 * loan prepayment becomes the largest expense of the year, the biggest
 * category, an "unusual amount" alert and a "category jump" alert - all at
 * once, all noise.
 */
export function countsAsSpending(t: Parameters<typeof classify>[0]): boolean {
  const flow = classify(t);
  return flow === 'fixed' || flow === 'variable';
}

function sumVariable(txns: TxnRow[]): number {
  let total = 0;
  for (const t of txns) {
    if (classify(t) !== 'variable') continue;
    total -= t.amount; // expenses are negative -> positive magnitude; refunds subtract
  }
  return Math.max(0, total);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export async function cashflowSnapshot(offset = 0): Promise<CashflowSnapshot> {
  const settings = await getSettings();
  const anchor = settings.cycleAnchorDay;
  const now = new Date();
  const today = startOfDay(now);

  const cycle = cycleFor(now, anchor, offset);
  const prevCycle = cycleFor(now, anchor, offset - 1);
  const lookbackStart = cycleFor(now, anchor, offset - settings.forecastLookbackCycles).start;

  const isCurrent = today >= cycle.start && today < cycle.end;
  const lastDay = addDays(cycle.end, -1);
  /** The "as of" day inside this cycle: today for the live cycle, else its last day. */
  const asOf = isCurrent ? today : today < cycle.start ? cycle.start : lastDay;
  const daysElapsed = dayDiff(asOf, cycle.start) + 1;
  const daysRemaining = Math.max(0, cycle.totalDays - daysElapsed);

  const accounts = await prisma.account.findMany();
  const bankBalance = accounts
    .filter((a) => a.type === 'bank' && a.lifecycle !== 'closed')
    .reduce((s, a) => s + (a.balance ?? 0), 0);

  // One query covers cycle sums, pace and the historical burn rate.
  const [rawWindowTxns, spread] = await Promise.all([
    prisma.transaction.findMany({
      where: { date: { gte: lookbackStart, lt: cycle.end } },
      select: {
        id: true,
        date: true,
        processedDate: true,
        amount: true,
        description: true,
        status: true,
        accountId: true,
        categoryId: true,
        installmentTotal: true,
        category: { select: { kind: true } },
        account: { select: { type: true, displayName: true } },
      },
      orderBy: { date: 'asc' },
    }) as Promise<TxnRow[]>,
    spreadContext(lookbackStart, cycle.end),
  ]);

  // A spread lump sum is recognised across months instead of on its own date.
  // Both halves matter: drop the original, add the slices. Doing only the second
  // would count the money twice.
  const windowTxns = [
    ...rawWindowTxns.filter((t) => !t.id || !spread.spreadIds.has(t.id)),
    ...(spread.rows as unknown as TxnRow[]),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const cycleTxns = windowTxns.filter((t) => t.date >= cycle.start);
  const priorTxns = windowTxns.filter((t) => t.date < cycle.start);

  // ---- Accrual sums for this cycle ----
  let incomeReceived = 0;
  let incomeFixedReceived = 0;
  let incomeVariableReceived = 0;
  let fixedPaid = 0;
  /** Deliberately set aside this cycle - an outflow, but not a loss. */
  let savedThisCycle = 0;
  for (const t of cycleTxns) {
    const flow = classify(t);
    if (isIncome(flow)) {
      incomeReceived += t.amount;
      if (flow === 'income_fixed') incomeFixedReceived += t.amount;
      else incomeVariableReceived += t.amount;
    }
    // Outflows only.
    //
    // Summing this signed let a single credit sitting in an expense category
    // erase every real commitment: one large investment withdrawal filed under a
    // fixed category drove the total negative, which clamped to zero, and the
    // dashboard reported no fixed expenses paid at all in a month full of them.
    // A miscategorised row should cost you that row, never the
    // whole figure. Genuine refunds against a fixed bill are rare enough that
    // ignoring them is the cheaper error - and `creditInExpenseCategory` in
    // src/insights.ts now surfaces the miscategorisation itself.
    else if (flow === 'fixed' && t.amount < 0) fixedPaid -= t.amount;
    // Outflows only here too: a withdrawal FROM savings is not negative saving,
    // it is money coming back, and netting the two would report a month that
    // raided its savings as a month that saved nothing.
    else if (flow === 'savings' && t.amount < 0) savedThisCycle -= t.amount;
  }
  incomeReceived = Math.max(0, incomeReceived);
  fixedPaid = Math.max(0, fixedPaid);
  const variableSpent = sumVariable(cycleTxns);

  // ---- Historical variable burn rate (from complete prior cycles) ----
  // Use the median cycle rather than pooling every transaction into one average.
  // A one-off transfer or an as-yet uncategorised extraordinary month can then
  // be visible without pretending it is the household's new daily habit.
  const historicalCycles = Array.from({ length: settings.forecastLookbackCycles }, (_, index) =>
    cycleFor(now, anchor, offset - settings.forecastLookbackCycles + index),
  );
  const allBasis = historicalCycles
    .map((priorCycle) => {
      const rows = windowTxns.filter((t) => t.date >= priorCycle.start && t.date < priorCycle.end);
      const total = sumVariable(rows);
      return {
        rows,
        covered: coveredCycle(accounts, priorCycle.start, priorCycle.end),
        start: toISODate(priorCycle.start),
        end: toISODate(addDays(priorCycle.end, -1)),
        total,
        daily: Math.round(total / Math.max(1, priorCycle.totalDays)),
        bankDaily: Math.round(
          sumVariable(rows.filter((t) => t.account.type === 'bank')) / Math.max(1, priorCycle.totalDays),
        ),
      };
    })
    // Do not treat a genuinely missing month as a zero-spend month.
    .filter((entry) => entry.rows.length > 0);
  const forecastBasis = allBasis.filter(entry => entry.covered);

  const dailyBurn = forecastBasis.length > 0
    ? median(forecastBasis.map((entry) => entry.daily))
    : daysElapsed > 0
      ? Math.round(variableSpent / daysElapsed)
      : 0;
  // Only the slice of variable spending that leaves the bank directly (cash
  // withdrawals, direct debits) moves the balance inside this cycle - card
  // purchases made now settle next cycle.
  const dailyBankBurn = forecastBasis.length > 0
    ? median(forecastBasis.map((entry) => entry.bankDaily))
    : Math.round(sumVariable(cycleTxns.filter(t=>t.account.type==='bank'))/Math.max(1,daysElapsed));

  // ---- Recurring: what is still coming ----
  const seenSignatures = new Set(cycleTxns.map((t) => signatureOf(t.description)));
  const recurring = await prisma.recurringExpense.findMany({
    where: { active: true },
    include: { account: { select: { type: true, lifecycle:true } } },
  });

  const upcoming: CashflowEvent[] = [];
  let fixedUpcoming = 0;
  let incomeExpected = 0;
  /** Future events that actually move the BANK balance (cash view). */
  const bankEvents: CashflowEvent[] = [];

  for (const r of recurring) {
    if(r.account?.lifecycle==='closed')continue;
    if (cycleTxns.some(t => recurringMatches(t, r))) continue;
    const due = dateInCycleForDay(cycle, r.expectedDay);
    if (!due || !isCurrent) continue;
    if (r.validFrom && due < startOfDay(r.validFrom)) continue;
    if (r.validUntil && due > startOfDay(r.validUntil)) continue;

    const cyclesSinceLastSeen = cycleOrdinal(cycle.start, anchor) - cycleOrdinal(r.lastSeen, anchor);

    // A bimonthly bill (electricity, water) is only due when an even number of
    // cycles has passed since it was last charged.
    if (r.frequency === 'bimonthly' && cyclesSinceLastSeen % 2 !== 0) continue;

    // An item that has gone missing for longer than its period has probably
    // ended - a cancelled subscription or a finished instalment plan. Without
    // this, the forecast keeps charging you for a phone you finished paying off.
    const staleAfter = r.frequency === 'bimonthly' ? 4 : 2;
    if (r.source === 'detected' && cyclesSinceLastSeen >= staleAfter) continue;

    const event: CashflowEvent = {
      // An item already past its expected day but not yet charged is treated as
      // imminent rather than skipped.
      date: toISODate(due < today ? addDays(today, 1) : due),
      label: r.displayName,
      amount: r.expectedAmount,
      kind: r.direction === 'income' ? 'income' : 'fixed',
      actual: false,
    };

    if (r.direction === 'income') {
      incomeExpected += r.expectedAmount;
    } else {
      // Accrual: every fixed commitment counts, whatever it is charged to.
      fixedUpcoming += -r.expectedAmount;
    }
    upcoming.push(event);

    // Cash: only bank-charged items hit the balance within this cycle.
    const chargedToBank = !r.account || r.account.type === 'bank';
    if (chargedToBank) bankEvents.push(event);
  }
  fixedUpcoming = Math.max(0, fixedUpcoming);

  // ---- Credit-card float: spent already, not yet debited ----
  const unsettledCardTxns = await prisma.transaction.findMany({
    where: {
      account: { type: 'credit_card' },
      processedDate: { gt: now },
    },
    select: {
      amount: true,
      processedDate: true,
      accountId: true,
      account: { select: { displayName: true } },
      category: { select: { kind: true } },
    },
  });

  let cardFloatTotal = 0;
  let cardFloatWithinCycle = 0;
  const floatByAccount = new Map<string, { displayName: string; amount: number; chargeDate: Date | null }>();
  /** charge date (ISO) -> total debit */
  const settlementByDate = new Map<string, number>();

  for (const t of unsettledCardTxns) {
    if (t.category?.kind === 'transfer' || !t.processedDate) continue;
    cardFloatTotal += -t.amount;
    const entry = floatByAccount.get(t.accountId) ?? {
      displayName: t.account.displayName,
      amount: 0,
      chargeDate: t.processedDate,
    };
    entry.amount += -t.amount;
    if (!entry.chargeDate || t.processedDate < entry.chargeDate) entry.chargeDate = t.processedDate;
    floatByAccount.set(t.accountId, entry);

    if (t.processedDate < cycle.end) {
      cardFloatWithinCycle += -t.amount;
      const key = toISODate(t.processedDate);
      settlementByDate.set(key, (settlementByDate.get(key) ?? 0) + t.amount);
    }
  }

  for (const [date, amount] of settlementByDate) {
    const event: CashflowEvent = { date, label: 'חיוב כרטיס אשראי', amount, kind: 'card_settlement', actual: false };
    bankEvents.push(event);
    upcoming.push(event);
  }

  // ---- Remaining instalment payments ----
  // These come from the instalment engine rather than the recurring detector,
  // because only it knows the plan ends - and exactly when.
  if (isCurrent) {
    const dueSoon = await upcomingInstallments(addDays(today, 1), cycle.end);
    for (const payment of dueSoon) {
      fixedUpcoming += -payment.amount;
      const event: CashflowEvent = {
        date: toISODate(payment.date),
        label: `${payment.description} (תשלום ${payment.paymentNumber}/${payment.totalPayments})`,
        amount: payment.amount,
        kind: 'fixed',
        actual: false,
      };
      upcoming.push(event);
      // Card instalments settle with the card, not straight out of the bank.
      if (payment.accountType === 'bank') bankEvents.push(event);
    }
  }

  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  // ---- The headline number ----
  const plannedIncome = incomeReceived + incomeExpected;
  const committedFixed = fixedPaid + fixedUpcoming;
  /**
   * Savings come out of what is left to spend, because they genuinely are not
   * available to spend - the money is somewhere else on purpose. It is the one
   * subtraction here that is good news, which is why the dashboard reports it
   * separately instead of burying it in "spent".
   */
  const available = plannedIncome - committedFixed - variableSpent - savedThisCycle;
  // "Safe per day" must remain safe down to the agora. Rounding to nearest can
  // overshoot by a few agorot and render the absurd result "-₪0, overdraft".
  const dailyAllowance = daysRemaining > 0 ? Math.floor(available / daysRemaining) : available;
  /** Everything that was ever free to spend on variable things this cycle. */
  const spendablePot = variableSpent + Math.max(0, available);
  /**
   * Where the cycle lands. Unlike `available` this DOES subtract the variable
   * spending still expected, because the question is "will it come out ahead"
   * rather than "what may I still spend". Savings are left out on both sides,
   * matching the monthly net.
   */
  const variableProjectedTotal = variableSpent + dailyBurn * daysRemaining;
  const projectedNet = plannedIncome - committedFixed - variableProjectedTotal;

  let status: CashflowSnapshot['status'] = 'ok';
  if (available < 0) status = 'over';
  else if (daysRemaining > 0 && dailyBurn > 0 && dailyAllowance < dailyBurn * 0.75) status = 'tight';

  // ---- Balance timeline ----
  const timeline = await buildTimeline({
    cycle,
    today,
    isCurrent,
    bankBalance,
    bankAnchors:accounts.filter(a=>a.type==='bank'&&a.lifecycle!=='closed').map(a=>({id:a.id,at:a.balanceAt??a.scrapedAt??today})),
    cycleTxns,
    bankEvents,
    dailyBankBurn,
  });

  const futurePoints = timeline.filter((p) => !p.actual);
  const projectedEndBalance = timeline.length ? timeline[timeline.length - 1].balance : bankBalance;
  const lowestPoint = futurePoints.length
    ? futurePoints.reduce((min, p) => (p.balance < min.balance ? p : min))
    : null;
  const overdraftDate = futurePoints.find((p) => p.balance < 0)?.date ?? null;

  // ---- Pace vs the previous cycle at the same point ----
  const pace = await buildPace({ cycle, prevCycle, cycleTxns, daysElapsed, isCurrent });

  // ---- Variable spending by category, within this cycle ----
  const categories = await prisma.category.findMany();
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const variableTotals = new Map<string | null, number>();
  for (const t of cycleTxns) {
    if (classify(t) !== 'variable') continue;
    const key = t.categoryId;
    variableTotals.set(key, (variableTotals.get(key) ?? 0) + -t.amount);
  }
  /**
   * What each category usually costs in a full cycle.
   *
   * A manual budget only exists where someone sat down and typed one, which in
   * practice is a handful of categories - so most of the page has nothing to
   * compare against. The median of the same category's completed cycles needs no
   * input at all and answers the more useful question anyway: not "what did I
   * allow myself" but "what does this normally end up being".
   *
   * Median rather than mean so one unusual month does not set the expectation,
   * and floored at what has already been spent - a forecast below the actual is
   * not a forecast, it is a contradiction.
   */
  const historyByCategory = new Map<string | null, Map<number, number>>();
  for (const t of priorTxns) {
    if (classify(t) !== 'variable' || !forecastBasis.some(b=>t.date>=new Date(b.start+'T00:00:00') && t.date<addDays(new Date(b.end+'T00:00:00'),1))) continue;
    const perCycle = historyByCategory.get(t.categoryId) ?? new Map<number, number>();
    const ord = cycleOrdinal(t.date, anchor);
    perCycle.set(ord, (perCycle.get(ord) ?? 0) + -t.amount);
    historyByCategory.set(t.categoryId, perCycle);
  }

  function forecastFor(categoryId: string | null, spent: number): number | null {
    // A finished cycle has no forecast - what happened IS the number.
    if (!isCurrent) return null;
    const perCycle = historyByCategory.get(categoryId);
    if (!perCycle || perCycle.size === 0) return null;
    const totals = forecastBasis.map(b=>perCycle.get(cycleOrdinal(new Date(b.start+'T00:00:00'),anchor))??0).sort((a,b)=>a-b);
    const mid = Math.floor(totals.length / 2);
    const typical =
      totals.length % 2 ? totals[mid] : Math.round((totals[mid - 1] + totals[mid]) / 2);
    return Math.max(typical, spent);
  }

  const variableByCategory = [...variableTotals.entries()]
    .map(([categoryId, amount]) => {
      const c = categoryId ? categoryById.get(categoryId) : null;
      return {
        categoryId,
        name: c?.name ?? 'ללא קטגוריה',
        color: c?.color ?? '#8a8a94',
        icon: c?.icon ?? '❔',
        amount,
        budget: c?.monthlyBudget ?? null,
        forecast: forecastFor(categoryId, amount),
      };
    })
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  return {
    cycle: {
      offset,
      start: toISODate(cycle.start),
      end: toISODate(cycle.end),
      lastDay: toISODate(lastDay),
      anchorDay: anchor,
      daysTotal: cycle.totalDays,
      daysElapsed,
      daysRemaining,
      timeProgress: Math.min(1, daysElapsed / cycle.totalDays),
      isCurrent,
    },
    bankBalance,
    bankSnapshots: accounts.filter(a => a.type === 'bank' && a.lifecycle !== 'closed').map(a => ({ name: a.displayName, balance: a.balance, asOf: (a.balanceAt ?? a.scrapedAt)?.toISOString() ?? null })),
    forecastCoverage: { usableCycles: forecastBasis.length, excludedCycles: allBasis.length - forecastBasis.length, detail: forecastBasis.length ? 'קצב ההוצאה מבוסס על מחזורים עם חלון משיכה מתועד לכל החשבונות הפעילים. אין בכך אישור עצמאי של דוחות המקור.' : 'טרם תועד מחזור מלא מכל המקורות. ההערכה מבוססת על הקצב במחזור הנוכחי והיא זמנית.' },
    categoryTotals: [...new Set(cycleTxns.map(t => t.categoryId))].map(categoryId => ({ categoryId, amount: cycleTxns.filter(t => t.categoryId === categoryId).reduce((sum,t) => sum+t.amount,0) })),
    income: {
      received: incomeReceived,
      expected: incomeExpected,
      total: plannedIncome,
      fixedReceived: Math.max(0, incomeFixedReceived),
      variableReceived: Math.max(0, incomeVariableReceived),
    },
    fixed: { paid: fixedPaid, upcoming: fixedUpcoming, total: committedFixed },
    savings: {
      deposited: savedThisCycle,
      rateOfIncome: plannedIncome > 0 ? savedThisCycle / plannedIncome : 0,
    },
    variable: {
      spent: variableSpent,
      projectedRest: dailyBurn * daysRemaining,
      projectedTotal: variableProjectedTotal,
      dailyBurn,
      forecastBasis: forecastBasis.map(({ start, end, total, daily }) => ({ start, end, total, daily })),
    },
    cardFloat: {
      total: cardFloatTotal,
      withinCycle: cardFloatWithinCycle,
      byAccount: [...floatByAccount.entries()].map(([accountId, v]) => ({
        accountId,
        displayName: v.displayName,
        amount: v.amount,
        chargeDate: v.chargeDate ? toISODate(v.chargeDate) : null,
      })),
    },
    available,
    projectedNet,
    dailyAllowance,
    spendProgress: spendablePot > 0 ? Math.min(1, variableSpent / spendablePot) : 0,
    status,
    projectedEndBalance,
    lowestPoint: lowestPoint ? { date: lowestPoint.date, balance: lowestPoint.balance } : null,
    overdraftDate,
    pace,
    timeline,
    upcoming,
    variableByCategory,
  };
}

export interface MonthlyNet {
  /** yyyy-MM */
  month: string;
  /** incomeFixed + incomeVariable */
  income: number;
  /** Salary and allowances - the part you can plan the next month around */
  incomeFixed: number;
  /** Freelance, reserve duty, refunds - arrived, but promises nothing */
  incomeVariable: number;
  /** positive magnitude, routine spending only */
  expense: number;
  /**
   * Money in and out that is real but outside the monthly rhythm, positive
   * magnitudes. Deliberately kept out of `net` - see Flow.excluded for why
   * mixing them in breaks both the verdict and the forecast.
   */
  excludedIn: number;
  excludedOut: number;
  /**
   * Deposited into savings, positive magnitude, and NOT part of `expense`.
   *
   * It used to fall through into `expense` along with everything else that was
   * not income or excluded, which meant the dashboard and the by-topic screen
   * disagreed about the same month by exactly its savings. Both had the same
   * rows; one counted the saving as a cost. Money set aside is not spending -
   * see Flow.savings - and two screens disagreeing by a month's savings about
   * whether the month was bad is exactly how a ledger stops being believed.
   */
  savings: number;
  /** income - expense; negative means the month cost more than it earned */
  net: number;
  /** false while the month is still running - its net is not final yet */
  complete: boolean;
}

/**
 * Net per CALENDAR month - the plain "did this month cost more than it earned"
 * question, independent of the cash-flow cycle.
 *
 * Deliberately shares `classify()` with the cycle view so the two can never
 * disagree about what counts: transfers excluded, card purchases counted on the
 * day they were made (accrual), pending included because the money is committed,
 * and lump sums recognised across the months their spread plan covers.
 */
export async function monthlyHistory(months: number): Promise<MonthlyNet[]> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const spread = await spreadContext(start, end);

  const rawTxns = (await prisma.transaction.findMany({
    where: { date: { gte: start, lt: end } },
    select: {
      id: true,
      date: true,
      processedDate: true,
      amount: true,
      description: true,
      status: true,
      accountId: true,
      categoryId: true,
      installmentTotal: true,
      category: { select: { kind: true } },
      account: { select: { type: true, displayName: true } },
    },
  })) as TxnRow[];

  // Same two-step as the cycle view: drop the lump sums, add their slices.
  const txns = [
    ...rawTxns.filter((t) => !t.id || !spread.spreadIds.has(t.id)),
    ...(spread.rows as unknown as TxnRow[]),
  ];

  interface Bucket {
    incomeFixed: number;
    incomeVariable: number;
    expense: number;
    excludedIn: number;
    excludedOut: number;
    savings: number;
  }
  const empty = (): Bucket => ({
    incomeFixed: 0,
    incomeVariable: 0,
    expense: 0,
    excludedIn: 0,
    excludedOut: 0,
    savings: 0,
  });

  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    buckets.set(monthKey(d), empty());
  }

  for (const t of txns) {
    const flow = classify(t);
    if (flow === 'transfer') continue;
    const bucket = buckets.get(monthKey(t.date));
    if (!bucket) continue;

    if (flow === 'income_fixed') bucket.incomeFixed += t.amount;
    else if (flow === 'income_variable') bucket.incomeVariable += t.amount;
    // Kept in their own columns rather than dropped: hiding them would make the
    // chart disagree with the bank balance, which is worse than a tall bar.
    else if (flow === 'excluded') {
      if (t.amount > 0) bucket.excludedIn += t.amount;
      else bucket.excludedOut += -t.amount;
    }
    // Its own column, never `expense`. Withdrawals net off deposits, so a month
    // that drew more than it put in reports zero rather than negative saving.
    else if (flow === 'savings') bucket.savings += -t.amount;
    else bucket.expense += -t.amount;
  }

  const currentKey = monthKey(now);
  return [...buckets.entries()].map(([month, v]) => {
    // A clawback/refund inside one income class reduces the month's income. If
    // it exceeds that class, carry the excess across so the split still sums to
    // the headline instead of silently dropping the negative amount.
    let incomeFixed = v.incomeFixed;
    let incomeVariable = v.incomeVariable;
    if (incomeFixed < 0) [incomeFixed, incomeVariable] = [0, Math.max(0, incomeVariable + incomeFixed)];
    else if (incomeVariable < 0) [incomeFixed, incomeVariable] = [Math.max(0, incomeFixed + incomeVariable), 0];
    const income = incomeFixed + incomeVariable;
    const expense = Math.max(0, v.expense);
    return {
      month,
      income,
      incomeFixed,
      incomeVariable,
      expense,
      excludedIn: Math.max(0, v.excludedIn),
      excludedOut: Math.max(0, v.excludedOut),
      savings: Math.max(0, v.savings),
      // The verdict deliberately ignores excluded items - that is the whole
      // point of the class. Both income kinds count: variable income is less
      // plannable, but it did arrive.
      net: income - expense,
      complete: month < currentKey,
    };
  });
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function buildTimeline(args: {
  cycle: Cycle;
  today: Date;
  isCurrent: boolean;
  bankBalance: number;
  bankAnchors: Array<{id:string;at:Date}>;
  cycleTxns: TxnRow[];
  bankEvents: CashflowEvent[];
  dailyBankBurn: number;
}): Promise<TimelinePoint[]> {
  const { cycle, today, isCurrent, bankBalance, bankAnchors, cycleTxns, bankEvents, dailyBankBurn } = args;

  // Daily variable spend (accrual, all accounts) for tooltips.
  const variableByDay = new Map<string, number>();
  for (const t of cycleTxns) {
    if (classify(t) !== 'variable') continue;
    const key = toISODate(t.date);
    variableByDay.set(key, (variableByDay.get(key) ?? 0) + -t.amount);
  }

  // Notable ACTUAL events (income / fixed / settlements) for markers & tooltips.
  const actualEventsByDay = new Map<string, CashflowEvent[]>();
  for (const t of cycleTxns) {
    const flow = classify(t);
    const isSettlement = flow === 'transfer' && t.account.type === 'bank' && t.amount < 0;
    // Excluded items are kept out of the forecast but are exactly the events you
    // most want a marker for - an unexplained cliff in the balance line is the
    // fastest way to lose trust in the chart.
    const notable = isIncome(flow) || flow === 'fixed' || flow === 'excluded';
    if (!notable && !isSettlement) continue;
    const key = toISODate(t.date);
    const list = actualEventsByDay.get(key) ?? [];
    list.push({
      date: key,
      label: t.description,
      amount: t.amount,
      kind: isSettlement
        ? 'card_settlement'
        : isIncome(flow)
          ? 'income'
          : (flow as 'fixed' | 'excluded'),
      actual: true,
    });
    actualEventsByDay.set(key, list);
  }

  // Bank cash movements needed to walk the balance backwards from "now".
  const reconstructionStart = bankAnchors.reduce((start,a)=>a.at<start?startOfDay(a.at):start,cycle.start<today?cycle.start:today);
  const bankMovements = await prisma.transaction.findMany({
    where: {
      account: { type: 'bank', lifecycle:{not:'closed'} },
      status: 'completed',
      date: { gte: reconstructionStart, lt: addDays(today,1) },
    },
    select: { date: true, amount: true, accountId:true },
  });
  // Align known movements to each bank’s own observation date. This remains
  // a reconstruction: uncollected transactions cannot be inferred.
  const alignedBalance=bankBalance+bankMovements.filter(m=>{const a=bankAnchors.find(a=>a.id===m.accountId);return a&&startOfDay(m.date)>startOfDay(a.at)}).reduce((sum,m)=>sum+m.amount,0);
  const movementByDay = new Map<string, number>();
  for (const m of bankMovements) {
    const key = toISODate(m.date);
    movementByDay.set(key, (movementByDay.get(key) ?? 0) + m.amount);
  }

  const lastDay = addDays(cycle.end, -1);
  const points: TimelinePoint[] = [];

  const pointFor = (d: Date, balance: number, actual: boolean, extraEvents: CashflowEvent[] = []): TimelinePoint => {
    const key = toISODate(d);
    return {
      date: key,
      dayOfMonth: d.getDate(),
      balance,
      actual,
      // The balance line only subtracts direct-bank variable spending. Card
      // purchases settle through their explicit card-settlement event, so
      // showing the all-account burn here described a different calculation
      // than the line itself used.
      variableSpend: actual ? Math.max(0, variableByDay.get(key) ?? 0) : dailyBankBurn,
      events: actual ? (actualEventsByDay.get(key) ?? []) : extraEvents,
    };
  };

  // --- Past: reconstruct end-of-day balances backwards from the live balance ---
  const pastEnd = isCurrent ? today : today > lastDay ? lastDay : null;
  if (pastEnd) {
    let balance = alignedBalance;
    // When viewing a past cycle, unwind the days between it and today first.
    for (let d = today; d > pastEnd; d = addDays(d, -1)) {
      balance -= movementByDay.get(toISODate(d)) ?? 0;
    }
    const past: TimelinePoint[] = [];
    for (let d = pastEnd; d >= cycle.start; d = addDays(d, -1)) {
      past.unshift(pointFor(d, balance, true));
      balance -= movementByDay.get(toISODate(d)) ?? 0;
    }
    points.push(...past);
  }

  // --- Future: project forward from the live balance ---
  if (isCurrent) {
    const eventsByDay = new Map<string, CashflowEvent[]>();
    for (const e of bankEvents) {
      const list = eventsByDay.get(e.date) ?? [];
      list.push(e);
      eventsByDay.set(e.date, list);
    }
    let balance = alignedBalance;
    for (let d = addDays(today, 1); d <= lastDay; d = addDays(d, 1)) {
      const key = toISODate(d);
      const dayEvents = eventsByDay.get(key) ?? [];
      balance += dayEvents.reduce((s, e) => s + e.amount, 0);
      balance -= dailyBankBurn;
      points.push(pointFor(d, balance, false, dayEvents));
    }
  }

  return points;
}

async function buildPace(args: {
  cycle: Cycle;
  prevCycle: Cycle;
  cycleTxns: TxnRow[];
  daysElapsed: number;
  isCurrent: boolean;
}): Promise<CashflowSnapshot['pace']> {
  const { cycle, prevCycle, cycleTxns, daysElapsed } = args;

  const rawPrevTxns = (await prisma.transaction.findMany({
    where: { date: { gte: prevCycle.start, lt: prevCycle.end } },
    select: {
      id: true,
      date: true,
      processedDate: true,
      amount: true,
      description: true,
      status: true,
      accountId: true,
      categoryId: true,
      installmentTotal: true,
      category: { select: { kind: true } },
      account: { select: { type: true, displayName: true } },
    },
    orderBy: { date: 'asc' },
  })) as TxnRow[];

  const previousSpread = await spreadContext(prevCycle.start, prevCycle.end);
  const prevTxns = [...rawPrevTxns.filter(t => !t.id || !previousSpread.spreadIds.has(t.id)), ...(previousSpread.rows as unknown as TxnRow[])];
  if (prevTxns.length === 0) return null;

  /** Cumulative variable spend by 1-based day index within a cycle. */
  const cumulative = (txns: TxnRow[], start: Date, days: number): number[] => {
    const perDay = new Array<number>(days).fill(0);
    for (const t of txns) {
      if (classify(t) !== 'variable') continue;
      const idx = dayDiff(t.date, start);
      if (idx < 0 || idx >= days) continue;
      perDay[idx] += -t.amount;
    }
    const out: number[] = [];
    let running = 0;
    for (const v of perDay) {
      running += Math.max(0, v);
      out.push(running);
    }
    return out;
  };

  const currentCum = cumulative(cycleTxns, cycle.start, cycle.totalDays);
  const previousCum = cumulative(prevTxns, prevCycle.start, prevCycle.totalDays);

  const currentSpend = currentCum[Math.min(daysElapsed, currentCum.length) - 1] ?? 0;
  const previousSpendAtSameDay = previousCum[Math.min(daysElapsed, previousCum.length) - 1] ?? 0;

  const maxDays = Math.max(cycle.totalDays, prevCycle.totalDays);
  const series = Array.from({ length: maxDays }, (_, i) => ({
    day: i + 1,
    current: i < daysElapsed && i < currentCum.length ? currentCum[i] : null,
    previous: i < previousCum.length ? previousCum[i] : null,
  }));

  return {
    currentSpend,
    previousSpendAtSameDay,
    delta: currentSpend - previousSpendAtSameDay,
    series,
  };
}
