import { ANOMALY_THRESHOLD, merchantPattern } from './categorize.js';
import { prisma } from './db.js';
import { generateInsights, type Insight } from './insights.js';
import { staleProviders } from './sync-health.js';

/**
 * The five-minute daily pass.
 *
 * The backlog problem this exists to solve is real and measured: 92% of one
 * month's money sat in "no category", and the reason is not that categorising is
 * hard - it is that nothing ever asks. A transactions table is a place you go
 * when you already intend to do maintenance, which is roughly never.
 *
 * So the work is turned into a short, finite queue: a handful of cards, biggest
 * first, each with the decision already reduced to a tap. Finite matters more
 * than complete - a queue that visibly ends gets finished, and one that shows
 * 467 items gets closed. Whatever is left is still there tomorrow.
 *
 * Cards are ordered by what it costs to be wrong: data that is missing entirely,
 * then money that is unexplained, then things merely worth knowing.
 */

export type ReviewCardKind = 'sync' | 'confirm' | 'categorise' | 'late_fixed' | 'insight' | 'done';

export interface ReviewCard {
  kind: ReviewCardKind;
  /** Stable within a day, so dismissals can be remembered client-side */
  id: string;
  title: string;
  body: string;
  /** Signed agorot when the card is about a specific sum */
  amount?: number;
  /** Present on `categorise` - everything the tap needs */
  transaction?: {
    id: string;
    description: string;
    amount: number;
    date: string;
    accountName: string;
    /**
     * Still provisional at the provider: the description and even the amount
     * may change when it settles - the rent ghost renamed itself entirely.
     * The card says so, because classifying a name that is about to change
     * wastes the decision.
     */
    pending: boolean;
    /** Set when a category is already assigned - lets the card be confirmed as-is */
    currentCategoryId: string | null;
    /** The user's own note on this transaction */
    note: string | null;
    /** Set when the lump sum is already recognised across months */
    spread: { months: number; note: string | null } | null;
    /**
     * The merchant name behind this description, and how many other
     * uncategorised transactions carry it - i.e. what answering "and every
     * charge from this one" is actually worth. Null when the description has
     * no usable name in it.
     */
    merchant: { pattern: string; others: number } | null;
    /** Categories worth offering, already filtered to the right direction */
    suggestions: Array<{ id: string; name: string; icon: string | null }>;
  };
}

export interface DailyReview {
  date: string;
  cards: ReviewCard[];
  /** How much uncategorised money is still waiting after this batch */
  remaining: { count: number; amount: number };
}

/** Enough to be worth doing, few enough to actually finish. */
const MAX_CATEGORISE = 6;
const MAX_INSIGHTS = 3;
/** The full sweep is a sitting, not a glance - but still bounded. */
const MAX_SWEEP = 25;

/**
 * 'daily'    the short pass: only money with no category at all, plus advice.
 * 'expenses' the same work in a longer sitting: every expense with no category,
 *            biggest first, without the advice cards.
 *
 * It deliberately does NOT ask you to re-confirm what the rules already
 * classified. Re-approving correct work is pure friction, and a wrong rule does
 * not need a queue to be found - it announces itself through the insights (a
 * credit in an expense category, a commitment that stopped arriving) and through
 * the category totals looking wrong. Trust the rules; review the unknowns.
 */
export type ReviewScope = 'daily' | 'expenses';

export async function buildDailyReview(scope: ReviewScope = 'daily'): Promise<DailyReview> {
  const today = new Date();
  const day = today.toISOString().slice(0, 10);

  const txnSelect = {
    id: true,
    description: true,
    amount: true,
    date: true,
    status: true,
    account: { select: { displayName: true } },
    categoryId: true,
    note: true,
    spread: { select: { months: true, note: true } },
    category: { select: { name: true, icon: true } },
  } as const;

  const [stale, uncategorised, autoExcluded, allCategories, insights, dismissed] = await Promise.all([
    staleProviders(),
    // Both directions: a six-figure credit needs classifying at least as urgently
    // as a ₪40 expense, and the income side is where the damage is worst.
    prisma.transaction.findMany({
      where:
        scope === 'expenses'
          ? { amount: { lt: 0 }, categoryId: null }
          : { categoryId: null },
      orderBy: { date: 'desc' },
      select: txnSelect,
    }),
    /**
     * Rows the anomaly sweep filed as excluded on its own (see
     * excludeAnomalies). Unlocked is what marks them as machine-made: any human
     * decision - confirming here, or picking a category anywhere - locks the
     * row and it stops matching. So a card survives exactly until it is
     * answered, and a rule-assigned excluded row of ordinary size never asks.
     */
    prisma.transaction.findMany({
      where: {
        categoryLocked: false,
        category: { kind: 'excluded' },
        classificationSource: 'legacy',
        account: { type: 'bank' },
        OR: [{ amount: { gte: ANOMALY_THRESHOLD } }, { amount: { lte: -ANOMALY_THRESHOLD } }],
      },
      orderBy: { date: 'desc' },
      take: 5,
      select: txnSelect,
    }),
    prisma.category.findMany({
      orderBy: { transactions: { _count: 'desc' } },
      select: { id: true, name: true, icon: true, kind: true },
    }),
    generateInsights(7),
    prisma.insightFeedback.findMany({
      where: { verdict: 'dismissed' },
      select: { insightKey: true },
    }),
  ]);

  const seenBefore = new Set(dismissed.map((d) => d.insightKey));
  const cards: ReviewCard[] = [];

  // ---- 1. Missing data beats every other card ----
  // Any decision made below is made on incomplete numbers until this is fixed.
  if (scope === 'daily' && stale.length > 0 && !seenBefore.has(`sync-${day}`)) {
    const names = stale.map((p) => p.displayName).join(', ');
    cards.push({
      kind: 'sync',
      id: `sync-${day}`,
      title: 'חסרים נתונים',
      body:
        `${names} לא סונכרן${stale.length > 1 ? 'ו' : ''}. כל מספר שתראה היום מחושב בלעדיו — ` +
        `שווה להריץ משיכה מעמוד החיבורים לפני שממשיכים.`,
    });
  }

  /**
   * Offering "מסעדות" for a large incoming bank transfer is noise, so suggestion
   * lists are filtered by direction - but `transfer` and `excluded` are always
   * appended, because for exactly the rows that dominate this queue they ARE
   * the answer.
   */
  const systemKinds = ['transfer', 'excluded', 'savings'];

  // ---- 1.5 Machine decisions awaiting a veto ----
  // Confirmation, not classification: the answer is already applied and the
  // numbers are already right. One tap agrees; picking a category overrules.
  if (scope === 'daily') {
    for (const t of autoExcluded) {
      const incoming = t.amount > 0;
      cards.push({
        kind: 'confirm',
        id: `conf-${t.id}`,
        title: 'סיווג מהותי מחכה לאישור',
        body:
          `${t.description} — התנועה הוחרגה בעבר. בדקו אם זו העברה, הוצאה אמיתית או הכנסה; גודל הסכום לבדו אינו מספיק להכרעה.`,
        amount: t.amount,
        transaction: txnPayload(t, incoming, allCategories, systemKinds, null),
      });
    }
  }

  // ---- 2. Unexplained money, biggest first ----
  const byMagnitude = [...uncategorised].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const batch = byMagnitude.slice(0, scope === 'expenses' ? MAX_SWEEP : MAX_CATEGORISE);

  /**
   * How much each card is worth answering once rather than repeatedly.
   *
   * A queue that asks the same question about the same merchant twelve times is
   * a queue nobody finishes, so every card carries the count of what a rule
   * would sweep up with it. Counted live rather than from the fetched batch,
   * because the whole point is the rows further down the queue than you can see.
   */
  const merchants = new Map<string, { pattern: string; others: number }>();
  await Promise.all(
    batch.map(async (t) => {
      const pattern = merchantPattern(t.description);
      if (!pattern) return;
      const others = await prisma.transaction.count({
        where: {
          categoryId: null,
          categoryLocked: false,
          description: { contains: pattern },
          id: { not: t.id },
        },
      });
      merchants.set(t.id, { pattern, others });
    }),
  );

  for (const t of batch) {
    const incoming = t.amount > 0;
    cards.push({
      kind: 'categorise',
      id: `cat-${t.id}`,
      title: t.category
        ? `מסווג כרגע: ${t.category.icon ?? ''} ${t.category.name}`.trim()
        : incoming
          ? 'כסף שנכנס וטרם סווג'
          : 'הוצאה שטרם סווגה',
      body: t.description,
      amount: t.amount,
      transaction: txnPayload(t, incoming, allCategories, systemKinds, merchants.get(t.id) ?? null),
    });
  }

  // ---- 3. Things worth knowing ----
  const late = insights.filter((i) => i.kind === 'fixed_expense_late');
  const rest = insights.filter((i) => i.kind !== 'fixed_expense_late');

  const undismissed = (i: Insight) => scope === 'daily' && !seenBefore.has(`ins-${i.key}`);
  for (const i of late.filter(undismissed).slice(0, 2)) cards.push(insightCard(i, 'late_fixed'));
  for (const i of rest.filter(undismissed).slice(0, MAX_INSIGHTS)) cards.push(insightCard(i, 'insight'));

  const remainingRows = byMagnitude.slice(batch.length);
  const remaining = {
    count: remainingRows.length,
    amount: remainingRows.reduce((s, t) => s + Math.abs(t.amount), 0),
  };

  // A queue that ends says so. Without this the last swipe lands on nothing and
  // the whole thing reads as broken rather than finished.
  cards.push({
    kind: 'done',
    id: `done-${day}`,
    title: scope === 'expenses' ? 'סיימת את המנה' : 'זהו להיום',
    body:
      scope === 'expenses'
        ? remaining.count
          ? `נשארו ${remaining.count} הוצאות לעבור עליהן. רענון יביא את המנה הבאה.`
          : 'עברת על כל ההוצאות. אין מה לאשר יותר.'
        : remaining.count
          ? `נשארו עוד ${remaining.count} תנועות לא מסווגות. הן יחכו למחר — עדיף מעט כל יום מאשר הכל פעם אחת.`
          : 'הכל מסווג ואין מה לתקן. נתראה מחר.',
  });

  return { date: day, cards, remaining };
}

interface TxnRow {
  id: string;
  description: string;
  amount: number;
  date: Date;
  status: string;
  account: { displayName: string };
  categoryId: string | null;
  note: string | null;
  spread: { months: number; note: string | null } | null;
}

interface CategoryRow {
  id: string;
  name: string;
  icon: string | null;
  kind: string;
}

/**
 * Everything a card needs to be answerable, shared by the categorise and
 * confirm flows so the two can never drift apart in what a tap can do.
 *
 * Suggestions are every category of the right direction, most-used first, with
 * the "not really spending" ones pinned last. The first version showed only the
 * top five, which meant the right answer was frequently absent and the card
 * could not be answered honestly - you either picked something close or
 * skipped. Being able to answer correctly matters more than the card being tidy.
 */
function txnPayload(
  t: TxnRow,
  incoming: boolean,
  allCategories: CategoryRow[],
  systemKinds: string[],
  merchant: { pattern: string; others: number } | null,
): NonNullable<ReviewCard['transaction']> {
  const kinds = incoming
    ? ['income_fixed', 'income_variable', ...systemKinds]
    : ['fixed', 'variable', ...systemKinds];
  return {
    id: t.id,
    description: t.description,
    amount: t.amount,
    date: t.date.toISOString().slice(0, 10),
    accountName: t.account.displayName,
    pending: t.status === 'pending',
    currentCategoryId: t.categoryId,
    note: t.note,
    spread: t.spread ? { months: t.spread.months, note: t.spread.note } : null,
    merchant,
    suggestions: [
      ...allCategories.filter((c) => kinds.includes(c.kind) && !systemKinds.includes(c.kind)),
      ...allCategories.filter((c) => systemKinds.includes(c.kind)),
    ].map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
  };
}

function insightCard(insight: Insight, kind: ReviewCardKind): ReviewCard {
  return {
    kind,
    id: `ins-${insight.key}`,
    title: insight.title,
    body: insight.detail,
    amount: insight.amount,
  };
}
