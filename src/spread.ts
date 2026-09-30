import { prisma } from './db.js';

/**
 * Spreading a lump sum across months - the income twin of credit-card
 * instalments.
 *
 * THE PROBLEM
 * An annual bonus, or a benefit paid in advance for months of leave, arrives in
 * one payment and covers half a year. Counted whole in June, June looks
 * extraordinary and July through November look like a collapse. Neither reading is true, and both are actively
 * misleading: the whole point of this system is answering "is this month
 * sustainable", and one lump sum destroys that answer for six months.
 *
 * THE RULE
 * A spread changes the ACCRUAL view only - what the month "earned" or "cost".
 * The cash never moves differently: the bank balance really did jump by the whole
 * sum on one day, and the balance timeline is rebuilt from actual bank rows, so it
 * is deliberately untouched. Mixing those two views is the single easiest way to
 * produce a forecast that is confidently wrong.
 *
 * HOW IT WORKS
 * The plan expands into N virtual transactions, one per month, on the same
 * day-of-month as the original. Because they carry real dates, every existing
 * cycle-window and month-bucket calculation works on them unchanged - no
 * special-casing of cycle anchors, no separate code path.
 */

/** Below this a spread is meaningless; above it, almost certainly a typo. */
export const MIN_MONTHS = 2;
export const MAX_MONTHS = 60;

export interface SpreadSlice {
  /** yyyy-MM-DD of the month this slice is recognised in */
  date: Date;
  /** signed agorot, same sign as the source transaction */
  amount: number;
  /** 1-based, for display: "3 מתוך 6" */
  index: number;
  total: number;
}

/**
 * Add months to a date, clamping the day so that spreading from the 31st does
 * not silently skip February. Without the clamp, `new Date(2026, 1, 31)` rolls
 * into March and two slices land in the same month.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear();
  const month = date.getMonth() + months;
  const target = new Date(year, month, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

/**
 * Expand a plan into its monthly slices.
 *
 * The slices sum to exactly the original amount: integer division leaves a
 * remainder of a few agorot, and it goes on the LAST slice. Dropping it would
 * make the spread quietly disagree with the bank by a few agorot per plan, and
 * "the numbers almost add up" is worse than an obvious error.
 */
export function slicesFor(plan: {
  months: number;
  offsetMonths: number;
  transaction: { date: Date; amount: number };
}): SpreadSlice[] {
  const months = Math.max(MIN_MONTHS, Math.min(MAX_MONTHS, plan.months));
  const total = plan.transaction.amount;
  const per = Math.trunc(total / months);
  const remainder = total - per * months;

  const slices: SpreadSlice[] = [];
  for (let i = 0; i < months; i++) {
    slices.push({
      date: addMonthsClamped(plan.transaction.date, plan.offsetMonths + i),
      amount: i === months - 1 ? per + remainder : per,
      index: i + 1,
      total: months,
    });
  }
  return slices;
}

export interface SpreadPlanView {
  id: string;
  transactionId: string;
  description: string;
  /** The original single amount, signed agorot */
  amount: number;
  months: number;
  offsetMonths: number;
  note: string | null;
  perMonth: number;
  firstMonth: string;
  lastMonth: string;
  slices: Array<{ month: string; amount: number }>;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export async function listSpreadPlans(): Promise<SpreadPlanView[]> {
  const plans = await prisma.spreadPlan.findMany({
    include: { transaction: { select: { id: true, date: true, amount: true, description: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return plans.map((plan) => {
    const slices = slicesFor(plan);
    return {
      id: plan.id,
      transactionId: plan.transactionId,
      description: plan.transaction.description,
      amount: plan.transaction.amount,
      months: plan.months,
      offsetMonths: plan.offsetMonths,
      note: plan.note,
      perMonth: slices[0].amount,
      firstMonth: monthKey(slices[0].date),
      lastMonth: monthKey(slices[slices.length - 1].date),
      slices: slices.map((s) => ({ month: monthKey(s.date), amount: s.amount })),
    };
  });
}

/**
 * A virtual transaction standing in for one month of a spread. Shaped so it can
 * be dropped straight into the same sums as a real row - the classification is
 * inherited from the source, so a spread income stays income and a spread
 * insurance premium stays a fixed cost.
 */
export interface SpreadRow {
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
  /** Marks the row as recognition rather than a real movement */
  spreadOf: string;
}

export interface SpreadContext {
  /**
   * Every transaction that has a plan. Callers must skip these on their own
   * date - including ones whose slices all fall outside the window, or the
   * lump sum gets counted twice.
   */
  spreadIds: Set<string>;
  /** Virtual rows for slices landing inside the requested window. */
  rows: SpreadRow[];
}

/**
 * Everything a month/cycle calculation needs to honour spread plans, for the
 * half-open window [from, to).
 */
export async function spreadContext(from: Date, to: Date): Promise<SpreadContext> {
  const plans = await prisma.spreadPlan.findMany({
    include: {
      transaction: {
        select: {
          id: true,
          date: true,
          amount: true,
          description: true,
          accountId: true,
          categoryId: true,
          category: { select: { kind: true } },
          account: { select: { type: true, displayName: true } },
        },
      },
    },
  });

  const spreadIds = new Set(plans.map((p) => p.transactionId));
  const rows: SpreadRow[] = [];

  for (const plan of plans) {
    const t = plan.transaction;
    for (const slice of slicesFor(plan)) {
      if (slice.date < from || slice.date >= to) continue;
      rows.push({
        date: slice.date,
        processedDate: slice.date,
        amount: slice.amount,
        description: `${t.description} (${slice.index}/${slice.total})`,
        status: 'completed',
        accountId: t.accountId,
        categoryId: t.categoryId,
        installmentTotal: null,
        category: t.category,
        account: t.account,
        spreadOf: t.id,
      });
    }
  }

  return { spreadIds, rows };
}

export class SpreadError extends Error {}

export async function createSpreadPlan(input: {
  transactionId: string;
  months: number;
  offsetMonths?: number;
  note?: string | null;
}): Promise<SpreadPlanView> {
  const txn = await prisma.transaction.findUnique({
    where: { id: input.transactionId },
    select: { id: true, amount: true, installmentTotal: true },
  });
  if (!txn) throw new SpreadError('התנועה לא נמצאה');

  if (!Number.isInteger(input.months) || input.months < MIN_MONTHS || input.months > MAX_MONTHS) {
    throw new SpreadError(`מספר החודשים חייב להיות בין ${MIN_MONTHS} ל-${MAX_MONTHS}`);
  }
  // An instalment is already spread, by the card company, with its own schedule
  // in src/installments.ts. Spreading it again double-counts it.
  if (txn.installmentTotal != null) {
    throw new SpreadError('התנועה הזאת היא כבר תשלום בפריסה של חברת האשראי');
  }

  await prisma.spreadPlan.upsert({
    where: { transactionId: txn.id },
    update: {
      months: input.months,
      offsetMonths: input.offsetMonths ?? 0,
      note: input.note ?? null,
    },
    create: {
      transactionId: txn.id,
      months: input.months,
      offsetMonths: input.offsetMonths ?? 0,
      note: input.note ?? null,
    },
  });

  const all = await listSpreadPlans();
  const created = all.find((p) => p.transactionId === txn.id);
  if (!created) throw new SpreadError('הפריסה נוצרה אבל לא נמצאה');
  return created;
}

export async function deleteSpreadPlan(transactionId: string): Promise<boolean> {
  const { count } = await prisma.spreadPlan.deleteMany({ where: { transactionId } });
  return count > 0;
}
