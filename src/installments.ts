import { prisma } from './db.js';
import { addDays, signatureOf, toISODate } from './cycle.js';

/**
 * Instalment plans - the part of your fixed load that has an end date.
 *
 * Israeli cards split a purchase into N monthly payments, and the provider tells
 * us exactly where we are: `installmentNumber` of `installmentTotal`. That is
 * enough to know precisely how many payments remain and when the plan ends -
 * information no generic "recurring charge" detector can have.
 *
 * Two things depend on getting this right:
 *
 *  1. **Not forecasting a finished plan.** The recurring detector sees three
 *     identical monthly charges and concludes "monthly commitment", then keeps
 *     charging you for it after the last payment: a plan paid 3 of 3 in one
 *     month is still forecast for the next.
 *
 *  2. **Knowing when money frees up.** "₪1,650 of your fixed load is temporary;
 *     ₪1,250 of it ends in September" is a genuinely useful thing to know and it
 *     is sitting in the data unused.
 */

export interface InstallmentPlan {
  /** Stable key derived from the plan's identity, not a database id. */
  id: string;
  accountId: string;
  accountName: string;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  /** Per-payment amount, positive agorot */
  perPayment: number;
  /** Total number of payments in the plan */
  totalPayments: number;
  /** Highest payment number observed */
  paidPayments: number;
  remainingPayments: number;
  totalAmount: number;
  remainingAmount: number;
  firstSeen: string;
  lastSeen: string;
  /** Day of month the payment lands on */
  dayOfMonth: number;
  /** null once the plan is finished */
  nextDue: string | null;
  /** Date of the final payment; null once finished */
  endsOn: string | null;
  status: 'active' | 'finished' | 'stale';
}

export interface UpcomingInstallment {
  planId: string;
  description: string;
  accountId: string;
  accountType: string;
  amount: number; // signed (negative)
  date: Date;
  paymentNumber: number;
  totalPayments: number;
}

/**
 * A plan whose latest payment is older than this probably was cancelled, or its
 * history is incomplete - forecasting it would invent charges.
 */
const STALE_AFTER_DAYS = 70;

/**
 * A stable identity for one instalment PURCHASE, usable as a note key.
 *
 * It must survive new payments arriving, so it cannot depend on how many we have
 * seen. Instead it is anchored to the month the purchase was made, inferred by
 * walking back from any payment: payment 4 dated May belongs to a purchase made
 * in February. Two separate purchases at the same shop with the same payment
 * count therefore differ as long as they were not bought in the same month.
 */
export function planKeyFor(t: {
  accountId: string;
  description: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  date: Date;
}): string | null {
  if (t.installmentTotal == null || t.installmentNumber == null) return null;
  const purchase = addMonths(t.date, -(t.installmentNumber - 1));
  const month = `${purchase.getFullYear()}-${String(purchase.getMonth() + 1).padStart(2, '0')}`;
  return `${t.accountId}|${signatureOf(t.description)}|${t.installmentTotal}|${month}`;
}

/** Add whole months, clamping to the target month's length (31 Jan + 1 = 28 Feb). */
function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), daysInTarget), 12);
}

export async function listInstallmentPlans(): Promise<InstallmentPlan[]> {
  const txns = await prisma.transaction.findMany({
    where: { installmentTotal: { not: null }, installmentNumber: { not: null } },
    select: {
      date: true,
      amount: true,
      description: true,
      installmentNumber: true,
      installmentTotal: true,
      accountId: true,
      categoryId: true,
      category: { select: { name: true } },
      account: { select: { displayName: true } },
    },
    orderBy: { date: 'asc' },
  });

  /**
   * Split each merchant's instalment history into plans by watching the payment
   * SEQUENCE, not the amount.
   *
   * Amount is the obvious key and the wrong one: Israeli plans routinely round
   * the first payment differently (₪1,599 / 12 = 133.25 → one payment of 133.75
   * and eleven of 133.00). Keying on it tears one plan into "paid 1 of 12, 11
   * unpaid" plus "paid 12 of 12" - a phantom half-finished plan that then looks
   * like an abandoned debt, and a real history produces dozens of them.
   *
   * A restart in the numbering (`number <= previous`) is the real signal that a
   * second plan began at the same shop.
   */
  const byMerchant = new Map<string, typeof txns>();
  for (const t of txns) {
    const key = `${t.accountId}|${t.description}|${t.installmentTotal}`;
    const list = byMerchant.get(key) ?? [];
    list.push(t);
    byMerchant.set(key, list);
  }

  const groups = new Map<string, typeof txns>();
  for (const [merchantKey, list] of byMerchant) {
    let run: typeof txns = [];
    let runIndex = 0;
    let previousNumber = 0;

    const flush = () => {
      if (run.length) groups.set(`${merchantKey}#${runIndex++}`, run);
      run = [];
    };

    for (const t of list) {
      const number = t.installmentNumber ?? 0;
      if (run.length && number <= previousNumber) flush();
      run.push(t);
      previousNumber = number;
    }
    flush();
  }

  const now = new Date();
  const staleCutoff = addDays(now, -STALE_AFTER_DAYS);
  const plans: InstallmentPlan[] = [];

  for (const [key, list] of groups) {
    const last = list[list.length - 1];
    const first = list[0];
    const totalPayments = last.installmentTotal!;
    // Highest number seen - history often starts mid-plan, so counting rows is wrong.
    const paidPayments = Math.max(...list.map((t) => t.installmentNumber ?? 0));
    const remainingPayments = Math.max(0, totalPayments - paidPayments);
    // The most recent payment is the best predictor of the next one - the odd
    // amount is usually the first payment, not the last.
    const perPayment = Math.abs(last.amount);

    let status: InstallmentPlan['status'] = 'active';
    if (remainingPayments === 0) status = 'finished';
    else if (last.date < staleCutoff) status = 'stale';

    const nextDue = status === 'active' ? addMonths(last.date, 1) : null;
    const endsOn = status === 'active' ? addMonths(last.date, remainingPayments) : null;

    plans.push({
      id: Buffer.from(key).toString('base64url').slice(0, 24),
      accountId: last.accountId,
      accountName: last.account.displayName,
      description: last.description,
      categoryId: last.categoryId,
      categoryName: last.category?.name ?? null,
      perPayment,
      totalPayments,
      paidPayments,
      remainingPayments,
      totalAmount: perPayment * totalPayments,
      remainingAmount: perPayment * remainingPayments,
      firstSeen: toISODate(first.date),
      lastSeen: toISODate(last.date),
      dayOfMonth: last.date.getDate(),
      nextDue: nextDue ? toISODate(nextDue) : null,
      endsOn: endsOn ? toISODate(endsOn) : null,
      status,
    });
  }

  // Soonest-ending active plans first; finished ones last.
  const rank = { active: 0, stale: 1, finished: 2 } as const;
  return plans.sort((a, b) => rank[a.status] - rank[b.status] || (a.endsOn ?? '9999').localeCompare(b.endsOn ?? '9999'));
}

/** Every remaining payment of every active plan that falls inside a window. */
export async function upcomingInstallments(from: Date, to: Date): Promise<UpcomingInstallment[]> {
  const plans = await listInstallmentPlans();
  const accounts = await prisma.account.findMany({ select: { id: true, type: true } });
  const typeById = new Map(accounts.map((a) => [a.id, a.type]));

  const out: UpcomingInstallment[] = [];

  for (const plan of plans) {
    if (plan.status !== 'active') continue;
    const lastPaid = new Date(`${plan.lastSeen}T12:00:00`);

    for (let i = 1; i <= plan.remainingPayments; i++) {
      const date = addMonths(lastPaid, i);
      if (date < from || date >= to) continue;
      out.push({
        planId: plan.id,
        description: plan.description,
        accountId: plan.accountId,
        accountType: typeById.get(plan.accountId) ?? 'credit_card',
        amount: -plan.perPayment,
        date,
        paymentNumber: plan.paidPayments + i,
        totalPayments: plan.totalPayments,
      });
    }
  }

  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export interface InstallmentSummary {
  activePlans: number;
  /** Monthly cost of all active plans - the temporary slice of the fixed load */
  monthlyLoad: number;
  /** Everything still owed across active plans */
  totalRemaining: number;
  /** month (yyyy-MM) -> amount that stops being charged after it */
  freeingUp: Array<{ month: string; amount: number; plans: string[] }>;
  /** The next plan to finish, if any */
  nextToFinish: { description: string; endsOn: string; perPayment: number } | null;
}

export async function installmentSummary(): Promise<InstallmentSummary> {
  const plans = await listInstallmentPlans();
  const active = plans.filter((p) => p.status === 'active');

  const freeing = new Map<string, { amount: number; plans: string[] }>();
  for (const plan of active) {
    if (!plan.endsOn) continue;
    const month = plan.endsOn.slice(0, 7);
    const entry = freeing.get(month) ?? { amount: 0, plans: [] };
    entry.amount += plan.perPayment;
    entry.plans.push(plan.description);
    freeing.set(month, entry);
  }

  const soonest = active
    .filter((p) => p.endsOn)
    .sort((a, b) => (a.endsOn ?? '').localeCompare(b.endsOn ?? ''))[0];

  return {
    activePlans: active.length,
    monthlyLoad: active.reduce((s, p) => s + p.perPayment, 0),
    totalRemaining: active.reduce((s, p) => s + p.remainingAmount, 0),
    freeingUp: [...freeing.entries()]
      .map(([month, v]) => ({ month, amount: v.amount, plans: v.plans }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    nextToFinish: soonest
      ? { description: soonest.description, endsOn: soonest.endsOn!, perPayment: soonest.perPayment }
      : null,
  };
}
