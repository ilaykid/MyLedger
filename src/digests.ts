import { prisma } from './db.js';
import { classify, countsAsSpending, cashflowSnapshot, type CashflowEvent, type CashflowSnapshot } from './cashflow.js';
import { generateInsights, summariseMonth, formatILS as ils, formatMonth, type Insight, type InsightKind } from './insights.js';
import { installmentSummary } from './installments.js';
import { analyseSyncHealth, staleProviders } from './sync-health.js';
import { getSettings } from './recurring.js';
import { signatureOf } from './cycle.js';
import * as summaries from './server/summaries.js';
import { escapeHtml as esc } from './html.js';

/**
 * Digest composition.
 *
 * Three shapes because they answer different questions:
 *   daily   - "how did yesterday go against the plan, and what is coming"
 *   weekly  - "what did the week look like against a normal week"
 *   monthly - "was last month positive, and why"
 *
 * Telegram is the only way this ledger reaches a phone - the dashboard is bound
 * to the machine - so every message has to stand on its own. Nothing may say
 * "see the dashboard" in place of saying the thing, and every number comes with
 * the figure it should be read against.
 *
 * The cycle block is the same figures the home screen leads with (remaining to
 * spend, the projected end-of-cycle result, the overdraft forecast), from the
 * same snapshot, so phone and dashboard can never tell different stories.
 *
 * Copy is addressed in the plural or impersonally: the digest can go to more
 * than one person in a household.
 *
 * Every merchant name passes through `name()`, which honours the privacy level.
 * Telegram cloud chats are not end-to-end encrypted, so the difference between
 * "₪450 at בי דראגסטורס" and "₪450, בריאות ופארם" is the difference between
 * publishing a shopping history and publishing a number.
 */

export type DigestKind = 'daily' | 'weekly' | 'monthly';
type Detail = 'full' | 'amounts' | 'minimal';

export interface Digest {
  text: string;
  /**
   * Deliver without sound. A daily message that rings every morning to say
   * "nothing happened" trains its reader to mute the bot, and then the morning
   * a card stops syncing nobody hears it. So routine days arrive silently and
   * only a day with something to act on makes a sound.
   */
  silent: boolean;
}

async function detailLevel(): Promise<Detail> {
  const s = await getSettings();
  const value = s.notificationDetail;
  return value === 'amounts' || value === 'minimal' ? value : 'full';
}

/** Merchant names are the identifying part of a transaction; gate them. */
function redactor(detail: Detail) {
  return (merchant: string | null | undefined, category?: string | null): string => {
    if (detail === 'full') return merchant ?? category ?? 'תנועה';
    return category ?? 'תנועה';
  };
}

// ------------------------------------------------------------- wording

const weekdayFmt = new Intl.DateTimeFormat('he-IL', { weekday: 'short' });
const DAY_MS = 86_400_000;

/** "13/10" - the dashboard's format, so the phone and the screen read alike. */
export const shortDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Local-midnight Date from the snapshot's YYYY-MM-DD strings, free of UTC drift. */
function fromIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "היום" / "מחר" / "מחרתיים" / "יום ה׳ 17.10" - how people actually say when. */
export function dayLabel(date: Date, today: Date): string {
  const diff = Math.round((startOfDay(date).getTime() - startOfDay(today).getTime()) / DAY_MS);
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  if (diff === 2) return 'מחרתיים';
  return `${weekdayFmt.format(date)} ${shortDate(date)}`;
}

/** The same, as an adverb: "מחר" / "ביום ה׳ 17.10". */
export function whenPhrase(date: Date, today: Date): string {
  const label = dayLabel(date, today);
  return label.startsWith('יום ') ? `ב${label}` : label;
}

/** Hebrew counts: "תנועה אחת", not "1 תנועות". */
export function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** "בתנועה אחת" / "ב-3 תנועות" */
export const inTransactions = (n: number) => (n === 1 ? 'בתנועה אחת' : `ב-${n} תנועות`);

/** "26 שעות" / "3 ימים" - "(26ש׳)" is a puzzle, not a sentence. */
export function sinceHours(hours: number): string {
  if (hours < 1) return 'פחות משעה';
  if (hours < 48) return count(hours, 'שעה', 'שעות');
  return count(Math.floor(hours / 24), 'יום', 'ימים');
}

function bar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ------------------------------------------------------------ insights

/**
 * Generic names for each finding. Used at the minimal level, where even a
 * category name says more than "totals and verdicts", and to title new
 * merchants without the word "ספק", which elsewhere in the app means the bank.
 */
const KIND_LABEL: Record<InsightKind, string> = {
  card_fee: 'דמי כרטיס',
  duplicate_charge: 'ייתכן חיוב כפול',
  new_merchant: 'בית עסק חדש',
  unusual_amount: 'חיוב חריג בגובהו',
  category_jump: 'קטגוריה גבוהה מהרגיל',
  category_drop: 'קטגוריה נמוכה מהרגיל',
  installment_ending: 'תשלומים שמסתיימים',
  recurring_increase: 'הוצאה קבועה שהתייקרה',
  monthly_verdict: 'סיכום חודשי',
  quiet_month: 'חודש שקט',
  fixed_expense_late: 'הוצאה קבועה שלא ירדה',
  credit_in_expense_category: 'זיכוי בקטגוריית הוצאה',
};

const titleOf = (i: Insight) => (i.kind === 'new_merchant' ? KIND_LABEL.new_merchant : i.title);

/**
 * What the insight's amount MEANS. A bare "— ₪1,322" after "גבוה מהרגיל" reads
 * as the category total when it is the overshoot.
 */
function amountPhrase(i: Insight): string {
  if (i.amount == null) return '';
  const a = ils(i.amount);
  switch (i.kind) {
    case 'category_jump': return `${a} מעל הרגיל`;
    case 'category_drop': return `${a} פחות מהרגיל`;
    case 'duplicate_charge': return `${a} שאולי חויבו פעמיים`;
    case 'recurring_increase': return `עלייה של ${a} בחודש`;
    case 'installment_ending': return `${a} בחודש מתפנים`;
    case 'fixed_expense_late': return `${a} שעוד לא ירדו`;
    default: return a;
  }
}

/**
 * Insight lines at the chosen privacy level.
 *
 * Below `full`, several new merchants collapse into one line - three identical
 * "בית עסק חדש — ₪387" rows carry no more information than one row with a count.
 * At `minimal` only the kind of finding is named; that is still worth sending,
 * because "ייתכן חיוב כפול" is a reason to open the laptop and "3 insights
 * waiting" is not.
 */
export function insightLines(insights: Insight[], detail: Detail, max: number): string[] {
  if (insights.length === 0) return [];

  if (detail === 'minimal') {
    const byKind = new Map<InsightKind, number>();
    for (const i of insights) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    const parts = [...byKind.entries()].map(([k, n]) => (n > 1 ? `${KIND_LABEL[k]} (${n})` : KIND_LABEL[k]));
    return [`• ${parts.join(' · ')}`];
  }

  const lines: string[] = [];
  let shown = 0;
  const fresh = insights.filter((i) => i.kind === 'new_merchant');
  const groupMerchants = detail === 'amounts' && fresh.length > 1;
  let merchantsDone = false;

  for (const i of insights) {
    if (shown >= max) break;
    if (i.kind === 'new_merchant' && groupMerchants) {
      if (merchantsDone) continue;
      merchantsDone = true;
      const total = fresh.reduce((s, x) => s + (x.amount ?? 0), 0);
      lines.push(`• ${fresh.length} בתי עסק חדשים — ${ils(total)} בסך הכול`);
    } else if (detail === 'full') {
      lines.push(`• <b>${esc(titleOf(i))}</b>\n  ${esc(i.detail)}`);
    } else {
      const phrase = amountPhrase(i);
      lines.push(`• ${esc(titleOf(i))}${phrase ? ` — ${phrase}` : ''}`);
    }
    shown++;
  }
  return lines;
}

// ------------------------------------------------------------ shared blocks

/** The snapshot, or null when it cannot be computed - the digest still goes out. */
async function snapshot(): Promise<CashflowSnapshot | null> {
  try {
    return await cashflowSnapshot(0);
  } catch {
    return null;
  }
}

interface Attention {
  /** Reasons this message deserves a sound. Empty means a routine day. */
  reasons: string[];
}

/**
 * Where the current cycle stands - the same figures as the home screen.
 *
 * "נשאר להוציא ₪5,574" alone reads as all-clear on a day the dashboard leads
 * with a projected shortfall, so the pace and the projected result come with it.
 */
export function cycleBlock(cf: CashflowSnapshot, detail: Detail, attention: Attention, today = new Date()): string[] {
  if (cf.income.total <= 0) {
    return ['<i>אין הכנסות רשומות במחזור, אז אין חישוב של כמה נשאר. חיבור חשבון הבנק ישלים את התמונה.</i>'];
  }

  const { cycle } = cf;
  const lines = [
    `<b>🧭 מחזור ${shortDate(fromIso(cycle.start))}–${shortDate(fromIso(cycle.lastDay))}</b> · ${
      cycle.daysRemaining === 1 ? 'נשאר יום אחד' : `נשארו ${cycle.daysRemaining} ימים`
    }`,
  ];

  if (cf.available > 0) {
    lines.push(`נשאר להוציא <b>${ils(cf.available)}</b> · ${ils(cf.dailyAllowance)} ליום`);
  } else {
    lines.push(`🔴 ההוצאות כבר עברו את מה שתוכנן למחזור ב-<b>${ils(Math.abs(cf.available))}</b>`);
  }

  // Pace against the same day of the previous cycle. Too early in the cycle a
  // single grocery run is "40% more", so it waits a few days.
  const pace = cf.pace;
  if (pace && cycle.daysElapsed >= 3 && pace.previousSpendAtSameDay >= 100_00) {
    const ratio = pace.delta / pace.previousSpendAtSameDay;
    const pct = Math.round(Math.abs(ratio) * 100);
    if (ratio >= 0.15) {
      lines.push(`⚠️ הוצאות משתנות במחזור: ${ils(pace.currentSpend)} עד עכשיו — ${pct}% יותר מבאותו שלב במחזור הקודם`);
    } else if (ratio <= -0.15) {
      lines.push(`👍 הוצאות משתנות במחזור: ${ils(pace.currentSpend)} עד עכשיו — ${pct}% פחות מבאותו שלב במחזור הקודם`);
    }
  }

  if (cf.projectedNet < 0) {
    lines.push(`📉 בקצב הזה המחזור צפוי להיגמר בגירעון של כ-${ils(Math.abs(cf.projectedNet))}`);
  } else {
    lines.push(`📈 בקצב הזה צפוי עודף של כ-${ils(cf.projectedNet)} בסוף המחזור`);
  }

  if (cf.overdraftDate) {
    const low = cf.lowestPoint ? ` — היתרה עלולה לרדת עד ${ils(cf.lowestPoint.balance)}` : '';
    lines.push(`🔴 <b>צפוי מינוס בעו״ש ${whenPhrase(fromIso(cf.overdraftDate), today)}</b>${low}`);
    attention.reasons.push('overdraft');
  }

  if (cf.cardFloat.total > 0) {
    let line = `💳 ${ils(cf.cardFloat.total)} באשראי עוד לא ירדו מהעו״ש`;
    const next = [...cf.cardFloat.byAccount]
      .filter((a) => a.chargeDate && a.amount > 0)
      .sort((a, b) => a.chargeDate!.localeCompare(b.chargeDate!))[0];
    if (next && detail !== 'minimal') {
      line += ` · הקרוב: ${esc(next.displayName)}, ${ils(next.amount)} ${whenPhrase(fromIso(next.chargeDate!), today)}`;
    }
    lines.push(line);
  }

  return lines;
}

/** Budget categories at 80% or more of their calendar-month budget. */
async function budgetLines(detail: Detail): Promise<string[]> {
  const budgets = await summaries.budgets(summaries.currentMonthKey());
  return budgets
    .filter((b) => b.spent / b.budget >= 0.8)
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
    .slice(0, 3)
    .map((b) => {
      const pct = Math.round((b.spent / b.budget) * 100);
      const amounts = detail === 'minimal' ? '' : ` (${ils(b.spent)} מתוך ${ils(b.budget)})`;
      return `${pct >= 100 ? '⚠️' : esc(b.icon)} ${esc(b.name)}: ${pct}% מהתקציב החודשי${amounts}`;
    });
}

/**
 * Anything that makes the numbers in this message incomplete. A quiet day that
 * is really a missing feed must never read as a quiet day.
 */
async function dataGapLines(attention: Attention): Promise<string[]> {
  const [stale, health] = await Promise.all([staleProviders(), analyseSyncHealth()]);
  const lines: string[] = [];
  for (const p of stale.slice(0, 4)) {
    lines.push(
      `• ${esc(p.displayName)} — לא התעדכן כבר ${sinceHours(p.hoursSince)}${p.lastAttemptFailed ? ' (העדכון האחרון נכשל)' : ''}`,
    );
  }
  const staleNames = new Set(stale.map((p) => p.displayName));
  for (const issue of health.issues.filter((i) => i.severity === 'error').slice(0, 3)) {
    // The stale list already names these providers; do not say it twice.
    if ([...staleNames].some((n) => issue.title.includes(n))) continue;
    lines.push(`• ${esc(issue.title)}`);
  }
  if (lines.length === 0) return [];
  attention.reasons.push('data-gap');
  return ['<b>⚠️ חסרים נתונים</b>', ...lines, 'הסכומים בהודעה לא כוללים את מה שחסר.'];
}

/** Bills, card charges and income due in the next few days. */
export function upcomingLines(events: CashflowEvent[], detail: Detail, today = new Date(), days = 3): string[] {
  const from = startOfDay(today).getTime();
  const until = from + (days + 1) * DAY_MS;
  const soon = events
    .filter((e) => e.kind !== 'excluded')
    .filter((e) => {
      const t = fromIso(e.date).getTime();
      return t >= from && t < until;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (soon.length === 0) return [];

  if (detail === 'minimal') {
    const out = soon.filter((e) => e.amount < 0);
    const income = soon.filter((e) => e.amount > 0);
    const parts: string[] = [];
    if (out.length) parts.push(`${count(out.length, 'חיוב אחד', 'חיובים')} · ${ils(out.reduce((s, e) => s + Math.abs(e.amount), 0))}`);
    if (income.length) parts.push(`${count(income.length, 'הכנסה אחת', 'הכנסות')} · ${ils(income.reduce((s, e) => s + e.amount, 0))}`);
    return [`📅 ב-${days} הימים הקרובים: ${parts.join(' · ')}`];
  }

  const generic: Record<CashflowEvent['kind'], string> = {
    income: 'הכנסה',
    fixed: 'הוצאה קבועה',
    card_settlement: 'חיוב כרטיס אשראי',
    excluded: 'תנועה',
  };
  const lines = ['<b>📅 בימים הקרובים</b>'];
  for (const e of soon.slice(0, 5)) {
    const label = detail === 'full' ? e.label : generic[e.kind];
    const amount = e.amount > 0 ? `${ils(e.amount)} נכנסים` : ils(Math.abs(e.amount));
    lines.push(`• ${dayLabel(fromIso(e.date), today)} · ${esc(label)} · ${amount}`);
  }
  if (soon.length > 5) lines.push(`…ועוד ${soon.length - 5}`);
  return lines;
}

/** Join blocks with a blank line between non-empty ones. */
function sections(...blocks: string[][]): string {
  return blocks
    .filter((b) => b.length > 0)
    .map((b) => b.join('\n'))
    .join('\n\n');
}

// ---------------------------------------------------------------- daily

/**
 * The daily message is read in three seconds on a phone, so it says only what
 * changed and what needs doing. On a routine day that is two or three lines:
 * yesterday against the daily budget, what is left in the cycle, and - only
 * when it is off - the pace. Everything else appears only on the day it
 * matters (a charge due today or tomorrow, a budget crossed yesterday, a
 * missing feed, a suspicious charge, an overdraft forecast); the full picture
 * moves to the weekly summary. A long morning message therefore means
 * something by its length alone.
 */

/** "ג׳ 13.10" */
const shortDay = (d: Date) => `${weekdayFmt.format(d).replace(/^יום\s+/, '')} ${shortDate(d)}`;

export interface Yesterday {
  date: Date;
  /** Spending that counts (fixed + variable), agorot */
  total: number;
  /** Of `total`: the discretionary part the daily budget is about */
  variable: number;
  /** Purchases recorded but not yet priced */
  unpriced: number;
  /** Some feeds are missing, so "nothing" may be "not known yet" */
  incomplete: boolean;
}

/** Line one: yesterday, and the one comparison that makes the number mean something. */
export function yesterdayLine(y: Yesterday, dailyAllowance: number | null): string {
  const head = `📒 אתמול (${shortDay(y.date)}):`;
  const pending = y.unpriced > 0
    ? ` · ⏳ ${y.unpriced === 1 ? 'חיוב אחד ממתין לסכום' : `${y.unpriced} חיובים ממתינים לסכום`}`
    : '';

  if (y.total === 0) {
    if (y.incomplete) return `${head} לא נרשמו הוצאות — אבל חסרים נתונים${pending}`;
    if (y.unpriced > 0) return `${head} עדיין אין סכומים${pending}`;
    return `${head} יום בלי הוצאות 🎉`;
  }

  const fixed = y.total - y.variable;
  let line = `${head} <b>${ils(y.total)}</b>`;
  if (fixed > 0) line += y.variable > 0 ? `, מתוכם ${ils(fixed)} הוצאות קבועות` : ' בהוצאות קבועות';

  // The daily budget is for variable spending; rent leaving yesterday is not
  // "over budget", it was always going to leave.
  if (y.variable > 0 && dailyAllowance != null && dailyAllowance > 0) {
    const subject = fixed > 0 ? 'המשתנות ' : '';
    line += y.variable <= dailyAllowance
      ? ` · ${subject}בתוך התקציב היומי ✅`
      : ` · ${subject}מעל התקציב היומי (${ils(dailyAllowance)}) ⚠️`;
  }
  return line + pending;
}

/**
 * Lines two and three: where the cycle stands - the same figures the home
 * screen leads with. The pace line is printed only when the pace is off or the
 * cycle is heading for a shortfall; "on track" is what its absence means.
 */
export function standingLines(cf: CashflowSnapshot, attention: Attention, today = new Date()): string[] {
  if (cf.income.total <= 0) return [];
  const lines: string[] = [];
  const until = shortDate(fromIso(cf.cycle.lastDay));

  if (cf.available > 0) {
    lines.push(`נשאר להוציא <b>${ils(cf.available)}</b> עד ${until} (${ils(cf.dailyAllowance)} ליום)`);
  } else {
    lines.push(`🔴 ההוצאות כבר עברו את מה שתוכנן למחזור ב-<b>${ils(Math.abs(cf.available))}</b>`);
  }

  // Too early in the cycle a single grocery run is "40% more", so it waits.
  const pace = cf.pace;
  const ratio = pace && cf.cycle.daysElapsed >= 3 && pace.previousSpendAtSameDay >= 100_00
    ? pace.delta / pace.previousSpendAtSameDay
    : 0;
  const fast = ratio >= 0.15;
  const pct = Math.round(ratio * 100);
  if (fast && cf.projectedNet < 0) {
    lines.push(`⚠️ קצב גבוה ב-${pct}% מהמחזור הקודם — צפוי גירעון של כ-${ils(Math.abs(cf.projectedNet))}`);
  } else if (fast) {
    lines.push(`⚠️ קצב גבוה ב-${pct}% מהמחזור הקודם (עדיין צפוי עודף של כ-${ils(cf.projectedNet)})`);
  } else if (cf.projectedNet < 0) {
    lines.push(`📉 בקצב הרגיל המחזור צפוי להיגמר בגירעון של כ-${ils(Math.abs(cf.projectedNet))}`);
  }

  if (cf.overdraftDate) {
    const low = cf.lowestPoint ? ` (עד ${ils(cf.lowestPoint.balance)})` : '';
    lines.push(`🔴 <b>צפוי מינוס בעו״ש ${whenPhrase(fromIso(cf.overdraftDate), today)}</b>${low}`);
    attention.reasons.push('overdraft');
  }
  return lines;
}

/**
 * Money moving today or tomorrow that is worth a heads-up, on one line.
 * Small debits are left out; a card settlement and income always count.
 */
export function soonLine(events: CashflowEvent[], detail: Detail, today = new Date()): string | null {
  const MIN = 200_00;
  const from = startOfDay(today).getTime();
  const soon = events
    .filter((e) => e.kind !== 'excluded')
    .filter((e) => {
      const t = fromIso(e.date).getTime();
      return t >= from && t < from + 2 * DAY_MS;
    })
    .filter((e) => e.kind === 'card_settlement' || e.amount > 0 || Math.abs(e.amount) >= MIN)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (soon.length === 0) return null;

  if (detail === 'minimal') {
    const out = soon.filter((e) => e.amount < 0);
    const income = soon.filter((e) => e.amount > 0);
    const parts: string[] = [];
    if (out.length) parts.push(`${count(out.length, 'חיוב אחד', 'חיובים')} · ${ils(out.reduce((s, e) => s + Math.abs(e.amount), 0))}`);
    if (income.length) parts.push(income.length === 1 ? 'הכנסה אחת נכנסת' : `${income.length} הכנסות נכנסות`);
    return `📅 היום ומחר: ${parts.join(' · ')}`;
  }

  const generic: Record<CashflowEvent['kind'], string> = {
    income: 'הכנסה', fixed: 'הוצאה קבועה', card_settlement: 'חיוב כרטיס אשראי', excluded: 'תנועה',
  };
  const items = soon.slice(0, 3).map((e) => {
    const label = detail === 'full' ? e.label : generic[e.kind];
    const amount = e.amount > 0 ? `${ils(e.amount)} נכנסים` : ils(Math.abs(e.amount));
    return `${dayLabel(fromIso(e.date), today)}: ${esc(label)} ${amount}`;
  });
  return `📅 ${items.join(' · ')}${soon.length > 3 ? ` · ועוד ${soon.length - 3}` : ''}`;
}

/** Budgets that went over on THE day they went over - not every morning after. */
export function crossedBudgetLines(
  budgets: Array<{ name: string; spent: number; budget: number }>,
  spentYesterday: Map<string, number>,
  detail: Detail,
): string[] {
  return budgets
    .filter((b) => b.spent >= b.budget && b.spent - (spentYesterday.get(b.name) ?? 0) < b.budget)
    .slice(0, 2)
    .map((b) =>
      `⚠️ ${esc(b.name)} עבר את התקציב החודשי` +
      (detail === 'minimal' ? '' : `: ${ils(b.spent)} מתוך ${ils(b.budget)}`),
    );
}

/** One line per finding worth interrupting someone for; the merchant only at `full`. */
export function attentionInsightLines(insights: Insight[], detail: Detail): string[] {
  if (detail === 'minimal') {
    return insightLines(insights, 'minimal', 2).map((l) => l.replace(/^• /, '🔎 שווה לבדוק: '));
  }
  return insights.slice(0, 2).map((i) => {
    const who = detail === 'full' && i.merchant ? `: ${esc(i.merchant)}` : '';
    const phrase = amountPhrase(i);
    return `🔎 ${esc(titleOf(i))}${who}${phrase ? ` — ${phrase}` : ''}`;
  });
}

/** The data-gap block, on one line. */
async function gapLine(attention: Attention): Promise<string | null> {
  const [stale, health] = await Promise.all([staleProviders(), analyseSyncHealth()]);
  const parts = stale.slice(0, 3).map((p) =>
    `${esc(p.displayName)} (${p.lastAttemptFailed ? 'העדכון נכשל, ' : ''}לא התעדכן ${sinceHours(p.hoursSince)})`,
  );
  const staleNames = stale.map((p) => p.displayName);
  for (const issue of health.issues.filter((i) => i.severity === 'error').slice(0, 2)) {
    // The stale list already names these providers; do not say it twice.
    if (staleNames.some((n) => issue.title.includes(n))) continue;
    parts.push(esc(issue.title));
  }
  if (parts.length === 0) return null;
  attention.reasons.push('data-gap');
  return `🔴 חסרים נתונים: ${parts.join(' · ')} — הסכומים חלקיים`;
}

export async function composeDailyDigest(now = new Date()): Promise<Digest> {
  const detail = await detailLevel();
  const name = redactor(detail);
  const attention: Attention = { reasons: [] };
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [txns, cf, gap] = await Promise.all([
    prisma.transaction.findMany({
      where: { date: { gte: start, lt: end } },
      include: { category: { select: { name: true, kind: true, icon: true } }, account: { select: { type: true } } },
    }),
    snapshot(),
    gapLine(attention),
  ]);

  const spending = txns.filter((t) => t.amount < 0 && countsAsSpending(t));
  const yesterday: Yesterday = {
    date: start,
    total: spending.reduce((s, t) => s + Math.abs(t.amount), 0),
    variable: spending.filter((t) => classify(t) === 'variable').reduce((s, t) => s + Math.abs(t.amount), 0),
    /**
     * A purchase the provider has recorded but not yet priced. Israeli cards do
     * this constantly. It fails `amount < 0`, so without this it disappears - and
     * a day whose only activity was one of these reported as a spend-free day.
     */
    unpriced: txns.filter((t) => t.amount === 0 && t.status === 'pending' && countsAsSpending(t)).length,
    // Never celebrate a quiet day that is really a missing feed.
    incomplete: gap != null,
  };

  const lines = [yesterdayLine(yesterday, cf && cf.income.total > 0 ? cf.dailyAllowance : null)];
  if (gap) lines.push(gap);

  /**
   * The normal, narrated - not only the anomalous. Salary landing is the single
   * event people quietly wait for all month, and "it arrived, same as always"
   * is the most reassuring sentence this message can carry. Compared against
   * the recurring expectation, because "same as always" is a claim about
   * history, not a feeling.
   */
  for (const t of txns.filter((t) => t.amount > 0 && t.category?.kind === 'income_fixed')) {
    const expected = await prisma.recurringExpense.findFirst({
      where: { active: true, direction: 'income', signature: signatureOf(t.description) },
    });
    let phrase = '';
    if (expected && expected.expectedAmount > 0) {
      const ratio = t.amount / expected.expectedAmount;
      if (ratio >= 0.95 && ratio <= 1.05) phrase = ' — כמו תמיד';
      else phrase = ` — ${ratio > 1 ? 'יותר' : 'פחות'} מהרגיל (בדרך כלל ${ils(expected.expectedAmount)})`;
    }
    lines.push(`💰 נכנס: ${esc(name(t.description, t.category?.name))} <b>${ils(t.amount)}</b>${phrase}`);
  }

  if (cf) lines.push(...standingLines(cf, attention, now));

  const soon = cf ? soonLine(cf.upcoming, detail, now) : null;
  if (soon) lines.push(soon);

  const spentYesterday = new Map<string, number>();
  for (const t of spending) {
    const key = t.category?.name;
    if (key) spentYesterday.set(key, (spentYesterday.get(key) ?? 0) + Math.abs(t.amount));
  }
  const crossed = crossedBudgetLines(await summaries.budgets(summaries.currentMonthKey()), spentYesterday, detail);
  if (crossed.length) {
    lines.push(...crossed);
    attention.reasons.push('budget');
  }

  // Only the findings worth interrupting someone for.
  const insights = (await generateInsights(2)).filter((i) => i.rank <= 1);
  if (insights.length) {
    lines.push(...attentionInsightLines(insights, detail));
    attention.reasons.push('insight');
  }

  return { text: lines.join('\n'), silent: attention.reasons.length === 0 };
}

// --------------------------------------------------------------- weekly

/** Median-free and honest: the average variable week over the weeks we have data for. */
async function typicalVariableWeek(before: Date): Promise<number | null> {
  const WEEKS = 8;
  const earliest = await prisma.transaction.findFirst({ orderBy: { date: 'asc' }, select: { date: true } });
  if (!earliest) return null;
  const weeks = Math.min(WEEKS, Math.floor((before.getTime() - startOfDay(earliest.date).getTime()) / (7 * DAY_MS)));
  if (weeks < 2) return null;

  const since = new Date(before.getFullYear(), before.getMonth(), before.getDate() - weeks * 7);
  const rows = await prisma.transaction.findMany({
    where: { date: { gte: since, lt: before }, amount: { lt: 0 } },
    include: { category: { select: { kind: true } }, account: { select: { type: true } } },
  });
  const total = rows.filter((t) => classify(t) === 'variable').reduce((s, t) => s + Math.abs(t.amount), 0);
  return Math.round(total / weeks);
}

export async function composeWeeklyDigest(now = new Date()): Promise<Digest> {
  const detail = await detailLevel();
  const attention: Attention = { reasons: [] };
  // The seven full days before today - not a partial today tacked on.
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const last = new Date(end.getTime() - DAY_MS);

  const [txns, typical, cf] = await Promise.all([
    prisma.transaction.findMany({
      where: { date: { gte: start, lt: end } },
      include: { category: { select: { name: true, kind: true, icon: true } }, account: { select: { type: true } } },
    }),
    typicalVariableWeek(start),
    snapshot(),
  ]);

  const spending = txns.filter((t) => t.amount < 0 && countsAsSpending(t));
  const variableRows = spending.filter((t) => classify(t) === 'variable');
  const fixedRows = spending.filter((t) => classify(t) === 'fixed');
  const variable = variableRows.reduce((s, t) => s + Math.abs(t.amount), 0);
  const fixed = fixedRows.reduce((s, t) => s + Math.abs(t.amount), 0);

  const head = [`<b>📊 סיכום שבועי · ${shortDate(start)}–${shortDate(last)}</b>`];

  // Variable first: it is the part a week of choices actually moved. Rent in
  // the same total made a normal week read as a ₪12,000 week.
  let variableLine = `הוצאות משתנות: <b>${ils(variable)}</b>`;
  if (typical != null && typical > 0) {
    const ratio = (variable - typical) / typical;
    const pct = Math.round(Math.abs(ratio) * 100);
    variableLine +=
      Math.abs(ratio) < 0.1
        ? ` — דומה לשבוע רגיל (${ils(typical)})`
        : ` — ${pct}% ${ratio > 0 ? 'יותר' : 'פחות'} משבוע רגיל (${ils(typical)})`;
  }
  head.push(variableLine);
  if (fixed > 0) head.push(`הוצאות קבועות: ${ils(fixed)} (${count(fixedRows.length, 'תשלום אחד', 'תשלומים')})`);

  const bars: string[] = [];
  if (detail !== 'minimal' && variableRows.length > 0) {
    const byCategory = new Map<string, { total: number; icon: string }>();
    for (const t of variableRows) {
      const key = t.category?.name ?? 'ללא קטגוריה';
      const e = byCategory.get(key) ?? { total: 0, icon: t.category?.icon ?? '•' };
      e.total += Math.abs(t.amount);
      byCategory.set(key, e);
    }
    const ranked = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);
    bars.push('<b>לאן הלכו ההוצאות המשתנות</b>');
    for (const [category, v] of ranked.slice(0, 6)) {
      bars.push(`${esc(v.icon)} <code>${bar(v.total / (variable || 1))}</code> ${ils(v.total)} · ${esc(category)}`);
    }
  }

  const insights = (await generateInsights(7)).filter((i) => i.rank <= 3);
  const insightBlock = insights.length ? ['<b>💡 מה בלט השבוע</b>', ...insightLines(insights, detail, 4)] : [];

  const gaps = await dataGapLines(attention);
  const cycle = cf ? cycleBlock(cf, detail, attention, now) : [];
  // The daily message only names what is due today or tomorrow; the week
  // ahead in full lives here.
  const upcoming = cf ? upcomingLines(cf.upcoming, detail, now, 7) : [];
  const budgets = await budgetLines(detail);

  return { text: sections(head, gaps, bars, insightBlock, cycle, upcoming, budgets), silent: false };
}

// -------------------------------------------------------------- monthly

/** Present-tense findings; they describe today, not the month being summarised. */
const PRESENT_TENSE: InsightKind[] = ['fixed_expense_late', 'credit_in_expense_category', 'installment_ending'];

export async function composeMonthlyDigest(now = new Date()): Promise<Digest> {
  const detail = await detailLevel();
  const attention: Attention = { reasons: [] };
  // The month that just ended.
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;

  const summary = await summariseMonth(key);
  if (!summary) return { text: `<b>📅 ${formatMonth(key)}</b>\nאין נתונים לחודש הזה.`, silent: false };

  const head: string[] = [`<b>📅 סיכום ${formatMonth(key)}</b>`];

  if (!summary.hasIncome) {
    // Declaring a month "negative" when income simply is not tracked would be
    // alarming and wrong.
    head.push(`יצאו <b>${ils(summary.expense)}</b>.`);
    head.push('<i>אין הכנסות רשומות לחודש, אז אין חישוב של עודף או גירעון. חיבור חשבון הבנק ישלים את התמונה.</i>');
  } else {
    head.push(
      summary.positive
        ? `✅ <b>עודף של ${ils(summary.net)}</b>`
        : `🔴 <b>גירעון של ${ils(Math.abs(summary.net))}</b>`,
    );
    head.push(`נכנסו ${ils(summary.income)} · יצאו ${ils(summary.expense)}`);

    // "↓ ₪241 מול הממוצע" did not say whether that was good.
    const versus = (label: string, delta: number) =>
      `${delta >= 0 ? '↑' : '↓'} ${delta >= 0 ? 'טוב יותר' : 'חלש יותר'} ב-${ils(Math.abs(delta))} ${label}`;
    if (summary.versusPrevious != null) head.push(versus('מהחודש הקודם', summary.versusPrevious));
    if (summary.versusAverage != null) head.push(versus('מהממוצע של החודשים הקודמים', summary.versusAverage));
  }

  const where: string[] = [];
  if (summary.topCategories.length && detail !== 'minimal') {
    where.push('<b>לאן הלך הכסף</b>');
    for (const c of summary.topCategories) {
      where.push(`<code>${bar(c.share)}</code> ${ils(c.amount)} · ${esc(c.name)}`);
    }
  }

  // Findings about THAT month only - nothing dated after it.
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const insights = (await generateInsights(daysInMonth - 1, monthEnd)).filter((i) => !PRESENT_TENSE.includes(i.kind));
  const insightBlock = insights.length ? ['<b>💡 מה בלט בחודש</b>', ...insightLines(insights, detail, 5)] : [];

  const freeing: string[] = [];
  const plans = await installmentSummary();
  if (plans.freeingUp.length && detail !== 'minimal') {
    freeing.push('<b>🔓 תשלומים שמסתיימים</b>');
    for (const f of plans.freeingUp.slice(0, 3)) {
      freeing.push(`• מ${formatMonth(f.month)}: ${ils(f.amount)} פחות בתשלומים בכל חודש`);
    }
  }

  const cf = await snapshot();
  const cycle = cf ? cycleBlock(cf, detail, attention, now) : [];
  const gaps = await dataGapLines(attention);

  return { text: sections(head, where, insightBlock, freeing, gaps, cycle), silent: false };
}

// --------------------------------------------------------------- shared

export async function composeDigest(kind: DigestKind, now = new Date()): Promise<Digest> {
  if (kind === 'monthly') return composeMonthlyDigest(now);
  if (kind === 'weekly') return composeWeeklyDigest(now);
  return composeDailyDigest(now);
}

/** Text only - for previews and callers that do not care how it is delivered. */
export async function buildDigest(kind: DigestKind): Promise<string> {
  return (await composeDigest(kind)).text;
}

/**
 * Which digest today calls for: the monthly one on the 1st, the weekly one on
 * Sundays (the Israeli week opens then), otherwise the daily one.
 */
export function digestForToday(date = new Date()): DigestKind {
  if (date.getDate() === 1) return 'monthly';
  if (date.getDay() === 0) return 'weekly';
  return 'daily';
}
