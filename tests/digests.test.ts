import test from 'node:test';
import assert from 'node:assert/strict';
import {
  count,
  crossedBudgetLines,
  cycleBlock,
  dayLabel,
  digestForToday,
  inTransactions,
  insightLines,
  sinceHours,
  soonLine,
  standingLines,
  upcomingLines,
  whenPhrase,
  yesterdayLine,
} from '../src/digests.js';
import type { CashflowEvent, CashflowSnapshot } from '../src/cashflow.js';
import type { Insight } from '../src/insights.js';

const today = new Date(2026, 9, 14); // Wednesday

test('Hebrew counts agree with their number', () => {
  assert.equal(inTransactions(1), 'בתנועה אחת');
  assert.equal(inTransactions(3), 'ב-3 תנועות');
  assert.equal(count(1, 'חיוב אחד', 'חיובים'), 'חיוב אחד');
  assert.equal(count(2, 'חיוב אחד', 'חיובים'), '2 חיובים');
  assert.equal(sinceHours(1), 'שעה');
  assert.equal(sinceHours(26), '26 שעות');
  assert.equal(sinceHours(80), '3 ימים');
});

test('days are named the way people say them', () => {
  assert.equal(dayLabel(today, today), 'היום');
  assert.equal(dayLabel(new Date(2026, 9, 15), today), 'מחר');
  assert.equal(dayLabel(new Date(2026, 9, 16), today), 'מחרתיים');
  assert.equal(dayLabel(new Date(2026, 10, 2), today), 'יום ב׳ 02/11');
  assert.equal(whenPhrase(new Date(2026, 10, 2), today), 'ביום ב׳ 02/11');
  assert.equal(whenPhrase(new Date(2026, 9, 15), today), 'מחר');
});

test('the digest kind follows the calendar', () => {
  assert.equal(digestForToday(new Date(2026, 10, 1)), 'monthly');
  assert.equal(digestForToday(new Date(2026, 9, 18)), 'weekly'); // Sunday
  assert.equal(digestForToday(today), 'daily');
});

function insight(partial: Partial<Insight>): Insight {
  return { key: 'k', kind: 'new_merchant', rank: 2, title: 'ספק חדש', detail: 'שופרסל אונליין — ₪387', ...partial };
}

test('insight lines never leak merchant names below the full level', () => {
  const insights = [
    insight({ amount: 38_700, merchant: 'שופרסל אונליין' }),
    insight({ amount: 15_700, merchant: 'סופר-פארם', detail: 'סופר-פארם — ₪157' }),
    insight({ kind: 'category_jump', rank: 3, title: 'סופר גבוה מהרגיל', amount: 132_200, detail: '' }),
  ];

  const amounts = insightLines(insights, 'amounts', 4).join('\n');
  assert.doesNotMatch(amounts, /שופרסל|סופר-פארם/);
  assert.match(amounts, /2 בתי עסק חדשים/, 'several new merchants collapse into one line');
  assert.match(amounts, /מעל הרגיל/, 'the overshoot is labelled as an overshoot');

  const minimal = insightLines(insights, 'minimal', 4);
  assert.equal(minimal.length, 1);
  assert.doesNotMatch(minimal[0], /סופר|₪/);
  assert.match(minimal[0], /בית עסק חדש \(2\)/);

  const full = insightLines(insights, 'full', 4).join('\n');
  assert.match(full, /שופרסל אונליין/);
  assert.doesNotMatch(full, /ספק חדש/, 'merchants are not called "ספק", which means the bank elsewhere');
});

const events: CashflowEvent[] = [
  { date: '2026-10-14', label: 'ביטוח ישיר', amount: -38_400, kind: 'fixed', actual: false },
  { date: '2026-10-15', label: 'חברת החשמל', amount: -59_650, kind: 'fixed', actual: false },
  { date: '2026-10-16', label: 'משכורת', amount: 726_000, kind: 'income', actual: false },
  { date: '2026-10-30', label: 'רחוק', amount: -1_000, kind: 'fixed', actual: false },
];

test('upcoming lines cover the next days only and respect privacy', () => {
  const full = upcomingLines(events, 'full', today).join('\n');
  assert.match(full, /היום · ביטוח ישיר/);
  assert.match(full, /מחר · חברת החשמל/);
  assert.match(full, /נכנסים/);
  assert.doesNotMatch(full, /רחוק/);

  const amounts = upcomingLines(events, 'amounts', today).join('\n');
  assert.doesNotMatch(amounts, /ביטוח ישיר|חברת החשמל/);
  assert.match(amounts, /הוצאה קבועה/);

  const minimal = upcomingLines(events, 'minimal', today);
  assert.equal(minimal.length, 1);
  assert.match(minimal[0], /2 חיובים/);
  assert.match(minimal[0], /הכנסה אחת/);
});

function snapshot(overrides: Partial<CashflowSnapshot>): CashflowSnapshot {
  return {
    cycle: {
      offset: 0, start: '2026-10-09', end: '2026-11-09', lastDay: '2026-11-08', anchorDay: 9,
      daysTotal: 31, daysElapsed: 6, daysRemaining: 25, timeProgress: 0.2, isCurrent: true,
    },
    income: { received: 0, expected: 0, total: 726_000, fixedReceived: 0, variableReceived: 0 },
    available: 557_420,
    dailyAllowance: 22_296,
    projectedNet: -73_205,
    overdraftDate: null,
    lowestPoint: null,
    pace: { currentSpend: 151_350, previousSpendAtSameDay: 110_600, delta: 40_750, series: [] },
    cardFloat: { total: 333_360, withinCycle: 0, byAccount: [
      { accountId: 'a', displayName: 'Max ויזה', amount: 241_050, chargeDate: '2026-11-02' },
    ] },
    ...overrides,
  } as CashflowSnapshot;
}

test('the cycle block tells the same story as the home screen', () => {
  const attention = { reasons: [] as string[] };
  const text = cycleBlock(snapshot({}), 'amounts', attention, today).join('\n');
  assert.match(text, /09\/10–08\/11/);
  assert.match(text, /נשאר להוציא/);
  assert.match(text, /37% יותר/, 'a fast pace is called out');
  assert.match(text, /גירעון של כ-/, 'a projected shortfall is never hidden behind "remaining to spend"');
  assert.match(text, /עוד לא ירדו מהעו״ש · הקרוב: Max ויזה/);
  assert.doesNotMatch(text, /צף/, 'no "float" jargon');
  assert.deepEqual(attention.reasons, [], 'standing states do not ring every morning');
});

test('an overdraft forecast makes the message ring', () => {
  const attention = { reasons: [] as string[] };
  const text = cycleBlock(
    snapshot({ overdraftDate: '2026-10-15', lowestPoint: { date: '2026-10-20', balance: -120_000 } }),
    'minimal',
    attention,
    today,
  ).join('\n');
  assert.match(text, /צפוי מינוס בעו״ש מחר/);
  assert.deepEqual(attention.reasons, ['overdraft']);
  assert.doesNotMatch(text, /Max ויזה/, 'minimal names no accounts');
});

test('one day left is said in the singular', () => {
  const s = snapshot({});
  const text = cycleBlock({ ...s, cycle: { ...s.cycle, daysRemaining: 1 } }, 'full', { reasons: [] }, today).join('\n');
  assert.match(text, /נשאר יום אחד/);
});

// ------------------------------------------------------- the lean daily message

const yesterday = new Date(2026, 9, 13);

test('a routine day is short: yesterday against the daily budget, in one line', () => {
  const line = yesterdayLine({ date: yesterday, total: 9_500, variable: 9_500, unpriced: 0, incomplete: false }, 22_300);
  assert.match(line, /^📒 אתמול \(ג׳ 13\/10\):/);
  assert.match(line, /בתוך התקציב היומי ✅$/);

  const over = yesterdayLine({ date: yesterday, total: 50_000, variable: 50_000, unpriced: 0, incomplete: false }, 22_300);
  assert.match(over, /מעל התקציב היומי \(.*223.*\) ⚠️/);
});

test('rent leaving yesterday is not "over the daily budget"', () => {
  const line = yesterdayLine({ date: yesterday, total: 640_000, variable: 10_000, unpriced: 0, incomplete: false }, 22_300);
  assert.match(line, /מתוכם .* הוצאות קבועות/);
  assert.match(line, /המשתנות בתוך התקציב היומי/);
});

test('a quiet day with a missing feed is not celebrated', () => {
  assert.match(yesterdayLine({ date: yesterday, total: 0, variable: 0, unpriced: 0, incomplete: false }, 1), /יום בלי הוצאות/);
  const missing = yesterdayLine({ date: yesterday, total: 0, variable: 0, unpriced: 0, incomplete: true }, 1);
  assert.match(missing, /חסרים נתונים/);
  assert.doesNotMatch(missing, /🎉/);
  assert.match(yesterdayLine({ date: yesterday, total: 0, variable: 0, unpriced: 1, incomplete: false }, 1), /חיוב אחד ממתין/);
});

test('the pace line appears only when something is off', () => {
  const calm = snapshot({ projectedNet: 50_000, pace: { currentSpend: 100_000, previousSpendAtSameDay: 100_000, delta: 0, series: [] } });
  const calmLines = standingLines(calm, { reasons: [] }, today);
  assert.equal(calmLines.length, 1, 'on track: just what is left');
  assert.match(calmLines[0], /נשאר להוציא .* עד 08\/11/);

  const fast = standingLines(snapshot({}), { reasons: [] }, today).join('\n');
  assert.match(fast, /קצב גבוה ב-37% מהמחזור הקודם — צפוי גירעון/);
});

test('only today and tomorrow, and only charges worth a heads-up', () => {
  const small: CashflowEvent = { date: '2026-10-14', label: 'נטפליקס', amount: -5_000, kind: 'fixed', actual: false };
  const line = soonLine([...events, small], 'full', today)!;
  assert.match(line, /^📅 היום: ביטוח ישיר .* · מחר: חברת החשמל/);
  assert.doesNotMatch(line, /נטפליקס|משכורת/);
  assert.equal(soonLine([small], 'full', today), null);
  assert.doesNotMatch(soonLine(events, 'amounts', today)!, /ביטוח ישיר/);
});

test('a budget is reported on the day it is crossed, not every day after', () => {
  const budgets = [{ name: 'פארם', spent: 35_600, budget: 30_000 }];
  assert.equal(crossedBudgetLines(budgets, new Map([['פארם', 10_000]]), 'amounts').length, 1);
  assert.equal(crossedBudgetLines(budgets, new Map(), 'amounts').length, 0, 'already over before yesterday');
  assert.doesNotMatch(crossedBudgetLines(budgets, new Map([['פארם', 10_000]]), 'minimal')[0], /₪/);
});
