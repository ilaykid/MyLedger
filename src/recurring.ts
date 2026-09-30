import { prisma } from './db.js';
import { cycleOrdinal, median, signatureOf } from './cycle.js';

export function recurringSignature(accountId: string, description: string, amount: number): string {
  return `${accountId}|${amount > 0 ? 'income' : 'expense'}|${signatureOf(description)}`;
}

export function recurringMatches(t: { accountId: string; description: string; amount: number }, r: { accountId: string | null; signature: string; direction: string; displayName: string }): boolean {
  return (!r.accountId || r.accountId === t.accountId)
    && (t.amount > 0 ? 'income' : 'expense') === r.direction
    && (r.signature === recurringSignature(t.accountId, t.description, t.amount)
      || r.signature === signatureOf(t.description)
      || (r.signature.startsWith('manual:') && signatureOf(r.displayName) === signatureOf(t.description)));
}

/**
 * Recurring-charge detection.
 *
 * Knowing which charges are FIXED and predictable is what makes a cash-flow
 * forecast possible: it is the difference between "you have 8,000 left" and
 * "you have 8,000 left but 5,200 of rent is still coming".
 *
 * A merchant signature qualifies as monthly-recurring when all of these hold:
 *   1. seen at least MIN_OCCURRENCES times,
 *   2. in at least MIN_CYCLES distinct cycles,
 *   3. roughly once per cycle (so weekly groceries never qualify),
 *   4. a stable amount (robust MAD-based spread under AMOUNT_TOLERANCE),
 *   5. charged on a clustered day-of-month (within DAY_SPREAD_TOLERANCE days),
 *   6. a regular period - every cycle (monthly) or every other cycle
 *      (bimonthly, which is how Israeli electricity and water actually bill).
 *
 * Rules 3-5 are what keep "שופרסל" - many charges a month, wildly varying
 * amounts, scattered days - out of the fixed-expense list. Rule 6 stops a
 * bimonthly electricity bill from being forecast as a monthly one, which would
 * silently overstate committed expenses by half a bill every cycle.
 */

const MIN_OCCURRENCES = 3;
const MIN_CYCLES = 3;
const MAX_PER_CYCLE = 1.4;
const AMOUNT_TOLERANCE = 0.25; // MAD / |median|
const DAY_SPREAD_TOLERANCE = 6;
/**
 * Income gets a wider day window than expenses, because the two are paid by
 * different kinds of system.
 *
 * A direct debit is charged by a machine on a contractual day and barely moves.
 * A salary is paid by a payroll department "around the Nth" and drifts with
 * weekends, holidays and whatever the employer does that month. Judging both at
 * 6 days is a category error, and it has a concrete cost: a salary
 * landing on the 10th, 12th, 14th and 18th has a circular spread of 8, so it would be
 * rejected - and the dashboard would believe there was no salary coming and
 * show a month with almost no fixed income at all.
 *
 * 12 is still under half a month, so it demands real clustering; income
 * scattered across the month remains variable, which is what it is.
 */
const INCOME_DAY_SPREAD_TOLERANCE = 12;
/** Fraction of cycles in the observed span that must contain an occurrence. */
const MONTHLY_COVERAGE = 0.7;

export interface DetectionStats {
  groupsConsidered: number;
  detected: number;
  removed: number;
}

export async function getSettings() {
  const existing = await prisma.settings.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.settings.create({ data: { id: 1 } });
}

/**
 * Tightest circular window (in days) covering every observed day-of-month.
 * Circular so that the 30th and the 1st count as adjacent, not 29 days apart.
 */
function circularDaySpread(days: number[]): number {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.length <= 1) return 0;
  let largestGap = 31 - unique[unique.length - 1] + unique[0]; // the wrap-around gap
  for (let i = 1; i < unique.length; i++) {
    largestGap = Math.max(largestGap, unique[i] - unique[i - 1]);
  }
  return 31 - largestGap;
}

/** Median absolute deviation - robust to a single unusual month. */
function medianAbsoluteDeviation(values: number[], center: number): number {
  return median(values.map((v) => Math.abs(v - center)));
}

/**
 * Classify the period from the ordinals of the cycles an item appeared in.
 * Returns null when the pattern is too irregular to forecast.
 */
function classifyFrequency(cycleOrdinals: number[]): 'monthly' | 'bimonthly' | null {
  const unique = [...new Set(cycleOrdinals)].sort((a, b) => a - b);
  if (unique.length < MIN_CYCLES) return null;

  const span = unique[unique.length - 1] - unique[0] + 1;
  const coverage = unique.length / span;
  if (coverage >= MONTHLY_COVERAGE) return 'monthly';

  const gaps: number[] = [];
  for (let i = 1; i < unique.length; i++) gaps.push(unique[i] - unique[i - 1]);
  if (gaps.every((g) => g === 2)) return 'bimonthly';

  return null;
}

export async function detectRecurring(): Promise<DetectionStats> {
  const settings = await getSettings();
  const anchor = settings.cycleAnchorDay;

  const txns = await prisma.transaction.findMany({
    where: { status: 'completed' },
    select: {
      date: true,
      amount: true,
      description: true,
      accountId: true,
      categoryId: true,
      installmentTotal: true,
      category: { select: { kind: true } },
    },
    orderBy: { date: 'asc' },
  });

  const groups = new Map<string, typeof txns>();
  for (const t of txns) {
    // Credit-card settlements and internal transfers are cash plumbing, not
    // expenses - forecasting them separately would double-count.
    if (t.category?.kind === 'transfer') continue;
    // Non-cash-flow items are defined by not belonging to the monthly rhythm.
    // A few loan prepayments can share a description and would otherwise be
    // "detected" as a six-figure monthly charge.
    if (t.category?.kind === 'excluded' || t.category?.kind === 'oneoff') continue;
    // Instalments look exactly like a monthly commitment and are not: they end
    // on a known date. src/installments.ts forecasts them precisely; leaving
    // them here would both double-count and keep charging after the last payment.
    if (t.installmentTotal != null) continue;
    if (signatureOf(t.description).length < 3) continue;
    const signature = recurringSignature(t.accountId, t.description, t.amount);
    const bucket = groups.get(signature);
    if (bucket) bucket.push(t);
    else groups.set(signature, [t]);
  }

  const detected: Array<{
    signature: string;
    displayName: string;
    direction: string;
    expectedAmount: number;
    expectedDay: number;
    occurrences: number;
    amountSpread: number;
    lastSeen: Date;
    frequency: string;
    accountId: string | null;
    categoryId: string | null;
  }> = [];

  for (const [signature, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;

    const ordinals = list.map((t) => cycleOrdinal(t.date, anchor));
    const distinctCycles = new Set(ordinals).size;
    if (distinctCycles < MIN_CYCLES) continue;
    if (list.length / distinctCycles > MAX_PER_CYCLE) continue;

    const frequency = classifyFrequency(ordinals);
    if (!frequency) continue;

    const amounts = list.map((t) => t.amount);
    const centre = median(amounts);
    if (centre === 0) continue;
    const spread = medianAbsoluteDeviation(amounts, centre);
    if (spread / Math.abs(centre) > AMOUNT_TOLERANCE) continue;

    // Direction is already decided by the sign of the centre; use it to pick the
    // right day window (see INCOME_DAY_SPREAD_TOLERANCE).
    const isIncomeGroup = centre > 0;
    const dayTolerance = isIncomeGroup ? INCOME_DAY_SPREAD_TOLERANCE : DAY_SPREAD_TOLERANCE;

    const days = list.map((t) => t.date.getDate());
    if (circularDaySpread(days) > dayTolerance) continue;

    // When the cluster only holds together circularly (e.g. 30th/1st), the
    // plain median lands in the middle of the empty side - trust the most
    // recent occurrence instead.
    const plainSpread = Math.max(...days) - Math.min(...days);
    const last = list[list.length - 1];
    const expectedDay = plainSpread > dayTolerance ? last.date.getDate() : median(days);

    detected.push({
      signature,
      displayName: last.description,
      direction: centre > 0 ? 'income' : 'expense',
      expectedAmount: centre,
      expectedDay,
      occurrences: list.length,
      amountSpread: spread,
      lastSeen: last.date,
      frequency,
      accountId: last.accountId,
      categoryId: last.categoryId,
    });
  }

  // Upsert detections, deliberately NOT touching `active` so a user's decision
  // to silence an item survives re-detection.
  const manual=await prisma.recurringExpense.findMany({where:{source:{not:'detected'}}});
  for (const d of detected) {
    if(manual.some(r=>recurringMatches({accountId:d.accountId!,description:d.displayName,amount:d.expectedAmount},r)))continue;
    const legacy = await prisma.recurringExpense.findUnique({ where: { signature: signatureOf(d.displayName) } });
    if (legacy && legacy.accountId === d.accountId && legacy.direction === d.direction) {
      await prisma.recurringExpense.update({ where: { id: legacy.id }, data: { signature: d.signature } });
    }
    const existing = await prisma.recurringExpense.findUnique({ where: { signature: d.signature } });
    if (existing && existing.source !== 'detected') continue;
    await prisma.recurringExpense.upsert({
      where: { signature: d.signature },
      create: d,
      update: {
        displayName: d.displayName,
        direction: d.direction,
        expectedAmount: d.expectedAmount,
        expectedDay: d.expectedDay,
        occurrences: d.occurrences,
        amountSpread: d.amountSpread,
        lastSeen: d.lastSeen,
        frequency: d.frequency,
        accountId: d.accountId,
        categoryId: d.categoryId,
      },
    });
  }

  const { count: removed } = await prisma.recurringExpense.updateMany({
    where: { source: 'detected', active: true, signature: { notIn: detected.map((d) => d.signature) } },
    data: { active: false },
  });

  return { groupsConsidered: groups.size, detected: detected.length, removed };
}
