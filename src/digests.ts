import { prisma } from './db.js';
import { countsAsSpending, cashflowSnapshot } from './cashflow.js';
import { generateInsights, summariseMonth, formatILS as ils, formatMonth } from './insights.js';
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
 *   daily   - "did anything happen yesterday I should know about"
 *   weekly  - "how is the month going, and what did the week look like"
 *   monthly - "was last month positive, and why"
 *
 * Every merchant name passes through `name()`, which honours the privacy level.
 * Telegram cloud chats are not end-to-end encrypted, so the difference between
 * "₪450 at בי דראגסטורס" and "₪450, בריאות ופארם" is the difference between
 * publishing a shopping history and publishing a number.
 */

export type DigestKind = 'daily' | 'weekly' | 'monthly';
type Detail = 'full' | 'amounts' | 'minimal';

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

const dayFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
const fmtDay = (d: Date) => dayFmt.format(d);

function bar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ---------------------------------------------------------------- daily

export async function buildDailyDigest(): Promise<string> {
  const detail = await detailLevel();
  const name = redactor(detail);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const txns = await prisma.transaction.findMany({
    where: { date: { gte: start, lt: end } },
    include: { category: { select: { name: true, kind: true, icon: true } }, account: { select: { type: true } } },
    orderBy: { amount: 'asc' },
  });

  const spending = txns.filter((t) => t.amount < 0 && countsAsSpending(t));
  const total = spending.reduce((s, t) => s + Math.abs(t.amount), 0);

  /**
   * A purchase the provider has recorded but not yet priced. Israeli cards do
   * this constantly. It fails `amount < 0`, so without this it disappears - and
   * a day whose only activity was one of these reported as a spend-free day.
   */
  const unpriced = txns.filter((t) => t.amount === 0 && t.status === 'pending' && countsAsSpending(t));

  // Never celebrate a quiet day that is really a missing feed.
  const stale = await staleProviders();

  const lines = [`<b>📒 ${fmtDay(start)}</b>`];

  if (spending.length === 0) {
    if (stale.length > 0) {
      lines.push('אין הוצאות בנתונים שיש לי — אבל הם חסרים.');
    } else if (unpriced.length > 0) {
      lines.push(`אין עדיין סכומים, אבל נרשמו ${unpriced.length} חיובים ממתינים.`);
    } else {
      lines.push('יום בלי הוצאות. 🎉');
    }
  } else if (detail === 'minimal') {
    // No line items at all - the total is the whole message.
    lines.push(`יצאו <b>${ils(total)}</b> ב-${spending.length} תנועות.`);
  } else {
    lines.push(`יצאו <b>${ils(total)}</b> ב-${spending.length} תנועות:`);
    for (const t of spending.slice(0, 8)) {
      const icon = t.category?.icon ?? '•';
      lines.push(`${esc(icon)} ${esc(name(t.description, t.category?.name))} — <b>${ils(Math.abs(t.amount))}</b>`);
    }
    if (spending.length > 8) lines.push(`…ועוד ${spending.length - 8}`);
  }

  if (unpriced.length > 0 && spending.length > 0) {
    lines.push(`⏳ ועוד ${unpriced.length} חיובים ממתינים שהסכום שלהם עוד לא פורסם.`);
  }

  /**
   * The normal, narrated - not only the anomalous.
   *
   * A digest that only ever raises alarms trains its reader to dread opening
   * it. Salary landing is the single event people quietly wait for all month,
   * and "it arrived, same as always" is the most reassuring sentence this
   * message can carry. Comparison against the recurring expectation, because
   * "same as always" is a claim about history, not a feeling.
   */
  const arrivedIncome = txns.filter((t) => t.amount > 0 && t.category?.kind === 'income_fixed');
  for (const t of arrivedIncome) {
    const expected = await prisma.recurringExpense.findFirst({
      where: { active: true, direction: 'income', signature: signatureOf(t.description) },
    });
    let phrase = '';
    if (expected && expected.expectedAmount > 0) {
      const ratio = t.amount / expected.expectedAmount;
      if (ratio >= 0.95 && ratio <= 1.05) phrase = ' — בערך כמו תמיד';
      else if (ratio > 1.05) phrase = ` — יותר מהרגיל (בדרך כלל ${ils(expected.expectedAmount)})`;
      else phrase = ` — פחות מהרגיל (בדרך כלל ${ils(expected.expectedAmount)})`;
    }
    lines.push(`💰 נכנסה ${esc(name(t.description, t.category?.name))}: <b>${ils(t.amount)}</b>${phrase}`);
  }

  /**
   * The coverage caveat, stated before any number is believed. This is the whole
   * fix for a digest that announced a spend-free day while the busiest card had
   * failed to sync minutes earlier.
   */
  if (stale.length > 0) {
    const names = stale.map((p) => `${p.displayName} (${p.hoursSince}ש׳)`).join(', ');
    lines.push(
      '',
      `<b>⚠️ הנתונים חסרים</b>`,
      `לא סונכרנו: ${esc(names)}. המספרים למעלה לא כוללים אותם.`,
    );
  }

  // Only the findings worth interrupting someone for.
  const insights = (await generateInsights(2)).filter((i) => i.rank <= 1);
  if (insights.length && detail !== 'minimal') {
    lines.push('', '<b>⚠️ שווה מבט:</b>');
    for (const i of insights.slice(0, 3)) {
      lines.push(`• ${esc(i.title)}${detail === 'full' ? ` — ${esc(i.detail)}` : i.amount ? ` — ${ils(i.amount)}` : ''}`);
    }
  } else if (insights.length) {
    lines.push('', `⚠️ ${insights.length} דברים שווי מבט — פתח את הדשבורד.`);
  }

  lines.push('', await cycleFooter());
  return lines.join('\n');
}

// --------------------------------------------------------------- weekly

export async function buildWeeklyDigest(): Promise<string> {
  const detail = await detailLevel();
  const name = redactor(detail);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);

  const txns = await prisma.transaction.findMany({
    where: { date: { gte: start } },
    include: { category: { select: { name: true, kind: true, icon: true } }, account: { select: { type: true } } },
  });

  const spending = txns.filter((t) => t.amount < 0 && countsAsSpending(t));
  const total = spending.reduce((s, t) => s + Math.abs(t.amount), 0);

  const byCategory = new Map<string, { total: number; icon: string }>();
  for (const t of spending) {
    const key = t.category?.name ?? 'ללא קטגוריה';
    const e = byCategory.get(key) ?? { total: 0, icon: t.category?.icon ?? '•' };
    e.total += Math.abs(t.amount);
    byCategory.set(key, e);
  }
  const ranked = [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total);
  const peak = ranked[0]?.[1].total ?? 1;

  const lines = [`<b>📊 השבוע האחרון</b>`, `יצאו <b>${ils(total)}</b> ב-${spending.length} תנועות.`];

  if (detail !== 'minimal') {
    lines.push('');
    for (const [category, v] of ranked.slice(0, 6)) {
      lines.push(`${esc(v.icon)} <code>${bar(v.total / peak)}</code> ${ils(v.total)} · ${esc(category)}`);
    }
  }

  const insights = (await generateInsights(7)).filter((i) => i.rank <= 3);
  if (insights.length && detail !== 'minimal') {
    lines.push('', '<b>💡 תובנות:</b>');
    for (const i of insights.slice(0, 4)) {
      lines.push(`• <b>${esc(i.title)}</b>${detail === 'full' ? `\n  ${esc(i.detail)}` : i.amount ? ` — ${ils(i.amount)}` : ''}`);
    }
  } else if (insights.length) {
    lines.push('', `💡 ${insights.length} תובנות ממתינות בדשבורד.`);
  }

  void name;
  lines.push('', await cycleFooter());
  return lines.join('\n');
}

// -------------------------------------------------------------- monthly

export async function buildMonthlyDigest(): Promise<string> {
  const detail = await detailLevel();
  const now = new Date();
  // The month that just ended.
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;

  const summary = await summariseMonth(key);
  if (!summary) return `<b>📅 ${formatMonth(key)}</b>\nאין נתונים לחודש הזה.`;

  const lines: string[] = [`<b>📅 סיכום ${formatMonth(key)}</b>`, ''];

  if (!summary.hasIncome) {
    // Declaring a month "negative" when income simply is not tracked would be
    // alarming and wrong.
    lines.push(`הוצאת <b>${ils(summary.expense)}</b>.`);
    lines.push('<i>אין הכנסות רשומות — חברו חשבון בנק לתזרים אמיתי.</i>');
  } else {
    lines.push(
      summary.positive
        ? `✅ <b>תזרים חיובי: +${ils(summary.net)}</b>`
        : `🔴 <b>תזרים שלילי: ${ils(summary.net)}</b>`,
    );
    lines.push(`נכנס ${ils(summary.income)} · יצא ${ils(summary.expense)}`);

    if (summary.versusPrevious != null) {
      const better = summary.versusPrevious >= 0;
      lines.push(
        `${better ? '↑' : '↓'} ${ils(Math.abs(summary.versusPrevious))} ${better ? 'טוב יותר' : 'פחות טוב'} מהחודש הקודם`,
      );
    }
    if (summary.versusAverage != null) {
      const better = summary.versusAverage >= 0;
      lines.push(`${better ? '↑' : '↓'} ${ils(Math.abs(summary.versusAverage))} מול הממוצע שלך`);
    }
  }

  if (summary.topCategories.length && detail !== 'minimal') {
    lines.push('', '<b>לאן הלך הכסף:</b>');
    for (const c of summary.topCategories) {
      lines.push(`<code>${bar(c.share)}</code> ${ils(c.amount)} · ${esc(c.name)}`);
    }
  }

  const insights = await generateInsights(30);
  if (insights.length && detail !== 'minimal') {
    lines.push('', '<b>💡 מה בלט:</b>');
    for (const i of insights.slice(0, 5)) {
      lines.push(`• <b>${esc(i.title)}</b>${detail === 'full' ? `\n  ${esc(i.detail)}` : i.amount ? ` — ${ils(i.amount)}` : ''}`);
    }
  } else if (insights.length) {
    lines.push('', `💡 ${insights.length} תובנות ממתינות בדשבורד.`);
  }

  const plans = await installmentSummary();
  if (plans.freeingUp.length && detail !== 'minimal') {
    lines.push('', '<b>🔓 כסף שמשתחרר:</b>');
    for (const f of plans.freeingUp.slice(0, 3)) {
      lines.push(`• ${formatMonth(f.month)}: +${ils(f.amount)} בחודש`);
    }
  }

  lines.push('', await cycleFooter());
  return lines.join('\n');
}

// --------------------------------------------------------------- shared

/** Current standing, plus anything that makes the numbers above incomplete. */
async function cycleFooter(): Promise<string> {
  const parts: string[] = [];

  try {
    const cf = await cashflowSnapshot(0);
    if (cf.income.total > 0) {
      parts.push(
        `נשאר להוציא <b>${ils(cf.available)}</b> · ${cf.cycle.daysRemaining} ימים (${ils(cf.dailyAllowance)}/יום)`,
      );
    }
    if (cf.cardFloat.total > 0) parts.push(`צף אשראי: ${ils(cf.cardFloat.total)}`);
  } catch {
    /* the digest is still worth sending without it */
  }

  const budgets = await summaries.budgets(summaries.currentMonthKey());
  const over = budgets.filter((b) => b.spent / b.budget >= 0.8);
  if (over.length) {
    parts.push(
      '⚠️ תקציב: ' +
        over
          .slice(0, 3)
          .map((b) => `${esc(b.name)} ${Math.round((b.spent / b.budget) * 100)}%`)
          .join(' · '),
    );
  }

  const { issues } = await analyseSyncHealth();
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length) parts.push(`🔴 ${esc(blocking[0].title)}`);

  return parts.join('\n');
}

export async function buildDigest(kind: DigestKind): Promise<string> {
  if (kind === 'monthly') return buildMonthlyDigest();
  if (kind === 'weekly') return buildWeeklyDigest();
  return buildDailyDigest();
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
