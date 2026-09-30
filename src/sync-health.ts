import { dataState } from './forecast-policy.js';
import { qualityItems } from './finance-quality.js';
import { prisma } from './db.js';
import { toISODate } from './cycle.js';

/**
 * Sync-gap detection: "the bank says you are paying MAX, but MAX is not connected."
 *
 * A cash-flow forecast is only as honest as its coverage. If a credit-card
 * company debits your account every month and its transactions are not in the
 * system, the money still leaves - it just becomes an unexplained lump instead
 * of itemised spending, and the fixed/variable split silently understates
 * reality. Worse, if that lump is not classified as a transfer it gets counted
 * as variable spending, which is a double-counting waiting to happen the day you
 * do connect the card.
 *
 * The bank statement is the source of truth here: it names every card company
 * charging you. Compare that list against what is actually connected.
 */

export type SyncIssueKind =
  | 'provider_not_connected'
  | 'settlement_mismatch'
  | 'settlement_unclassified'
  | 'no_bank_connected'
  | 'stale_account'
  | 'sync_stalled'
  | 'provider_stale'
  | 'new_account' | 'material' | 'missing_balance' | 'coverage_review';

export interface SyncIssue {
  kind: SyncIssueKind;
  severity: 'error' | 'warning' | 'info';
  /** Short Hebrew headline for the dashboard */
  title: string;
  /** What to do about it */
  detail: string;
  /** Provider id when the issue is about a specific one */
  company?: string;
  amount?: number;
  lastSeen?: string;
  occurrences?: number;
  /** Present when the dashboard can open the evidence behind the warning. */
  drilldown?: { type: 'settlement_mismatch'; accountId: string; date: string };
}

/**
 * How each card company shows up in an Israeli bank statement. The scrapers'
 * company id is what we need to tell the user to connect.
 */
const SETTLEMENT_SIGNATURES: Array<{ company: string; label: string; patterns: RegExp }> = [
  { company: 'max', label: 'Max', patterns: /\bmax\b|מקס\s*איט|מקס|לאומי\s*קארד|leumi\s*card/i },
  { company: 'visaCal', label: 'כאל', patterns: /כאל|cal[\s-]*online|ויזה\s*כ\.?א\.?ל|כ\.א\.ל/i },
  { company: 'isracard', label: 'ישראכרט', patterns: /ישראכרט|isracard/i },
  { company: 'amex', label: 'אמריקן אקספרס', patterns: /אמריקן|american\s*express|amex/i },
  { company: 'behatsdaa', label: 'בהצדעה', patterns: /בהצדעה/i },
  // Diners in Israel is issued by Cal but billed separately, so a bank
  // statement can show a Diners debit while the Cal login shows nothing of it.
  { company: 'visaCal', label: 'דיינרס', patterns: /דיינרס|diners/i },
];

/** Descriptions that mean "a credit card was settled" without naming the issuer. */
const GENERIC_SETTLEMENT = /חיוב\s*כרטיס|כרטיסי?\s*אשראי|כ\.אשראי|מסב.*אשראי|כרטיס\s*חיוב/i;


/**
 * How fresh the data behind every number on the dashboard actually is.
 *
 * This is the one status a machine-hosted system has to state out loud. A cloud
 * service runs whether or not you are looking; this one runs when the computer
 * is on and logged in, so "the forecast is three days stale" is a normal state,
 * not an error - and a stale forecast that looks live is worse than no forecast.
 */
export interface SyncFreshness {
  /** Oldest successful scrape across active accounts, or null if nothing ever ran */
  lastSyncAt: string | null;
  hoursSince: number | null;
  /** 'fresh' | 'aging' | 'stalled' | 'never' */
  state: 'fresh' | 'aging' | 'stalled' | 'never';
  perAccount: Array<{ displayName: string; institution: string; scrapedAt: string | null }>;
}

export interface DataReliability {
  status: 'complete' | 'partial' | 'stale' | 'unavailable';
  label: string;
  state: 'high' | 'medium' | 'low';
  uncategorizedShare: number;
  detail: string;
}

async function reliabilityOf(issues: SyncIssue[]): Promise<DataReliability> {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const expenses = await prisma.transaction.findMany({
    where: { date: { gte: since }, amount: { lt: 0 } },
    select: { amount: true, categoryId: true, category: { select: { kind: true } } },
  });
  const countable = expenses.filter((t) => t.category?.kind !== 'transfer' && t.category?.kind !== 'excluded');
  const total = countable.reduce((sum, t) => sum + -t.amount, 0);
  const uncategorized = countable.filter((t) => !t.categoryId).reduce((sum, t) => sum + -t.amount, 0);
  const uncategorizedShare = total > 0 ? uncategorized / total : 0;
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const status = dataState(issues, uncategorizedShare);
  const state = status === 'complete' ? 'high' : status === 'partial' ? 'medium' : 'low';
  const labels = { complete: 'מלא ומעודכן', partial: 'תמונה חלקית', stale: 'נתונים לא מעודכנים', unavailable: 'לא ניתן להעריך' };
  return {
    status,
    label: labels[status],
    state,
    uncategorizedShare,
    detail: `${errors} בעיות קריטיות, ${warnings} אזהרות, ${Math.round(uncategorizedShare * 100)}% מההוצאות ב-90 הימים האחרונים ללא קטגוריה`,
  };
}

/**
 * Banks default to a ~weekly interval, so a two-day-old bank scrape is by
 * design and must not raise an alarm. What these thresholds actually detect is
 * the machine not running at all: past three days even the daily card scrape
 * has been missed, and past a week nothing has run under any schedule.
 */
const AGING_HOURS = 72;
const STALLED_HOURS = 168;

/**
 * How often each provider is expected to refresh. The single source of truth -
 * scrape-runner uses it to decide what to run, and the checks below use it to
 * decide what counts as overdue, so the two can never disagree.
 */
export function isBankProvider(company: string): boolean {
  const creditCards = new Set(['visaCal', 'max', 'isracard', 'amex', 'behatsdaa']);
  return !creditCards.has(company);
}

/**
 * How often each provider should refresh.
 *
 * The bank was on 156h on the theory that a bank balance moves slowly. It does
 * not: a balance six days old can be off by a six-figure amount, because one
 * large credit landed in between.
 * Every number on the dashboard is computed from that balance, so a stale bank
 * is not one stale panel - it is a stale system.
 *
 * 48h is the deliberate compromise. It is well inside the window where a large
 * movement stays invisible, and it is still a far quieter access pattern than a
 * person checking their balance on a phone - one login every two days, from the
 * same machine, with the same persistent browser profile and device-trust
 * cookie. Nightly bank logins are what would start to look mechanical.
 */
export function defaultEveryHours(company: string): number {
  return isBankProvider(company) ? 48 : 20;
}

/**
 * Providers that should have refreshed by now and have not.
 *
 * The global freshness above cannot catch this, and that gap produced a real
 * failure: Max synced forty minutes ago while Cal - the busiest card - had
 * failed hours earlier, so "last sync" read fresh and the daily digest cheerfully
 * announced a day with no spending. Staleness has to be judged per provider,
 * against that provider's own interval.
 *
 * The grace multiplier absorbs a single missed run; two in a row is a real
 * problem worth interrupting someone for.
 */
const OVERDUE_GRACE = 1.6;

export interface StaleProvider {
  company: string;
  displayName: string;
  hoursSince: number;
  expectedEveryHours: number;
  /** true = the last finished attempt errored, rather than simply being old */
  lastAttemptFailed?: boolean;
}

/**
 * The provider's name without a card number. A failure is the provider's, not
 * one card's - naming an arbitrary sibling ("כאל ••••1111" when the busy card is
 * ••••2222) sends you to look at the wrong place.
 */
function providerLabel(displayName: string): string {
  return displayName.replace(/\s*[•·*]{2,}\s*\d*\s*$/, '').trim() || displayName;
}

export function staleProvidersOf(
  accounts: Array<{ displayName: string; institution: string; scrapedAt: Date | null }>,
  now = new Date(),
): StaleProvider[] {
  const newestByCompany = new Map<string, { at: Date | null; displayName: string }>();
  for (const a of accounts) {
    const seen = newestByCompany.get(a.institution);
    // A recent sibling must not hide an account whose data stopped updating.
    if (!seen || !a.scrapedAt || (seen.at && a.scrapedAt < seen.at)) {
      newestByCompany.set(a.institution, { at: a.scrapedAt, displayName: a.displayName });
    }
  }

  const stale: StaleProvider[] = [];
  for (const [company, { at, displayName }] of newestByCompany) {
    if (!at) continue; // never scraped - a different problem, reported elsewhere
    const hoursSince = (now.getTime() - at.getTime()) / 3_600_000;
    const expected = defaultEveryHours(company);
    if (hoursSince > expected * OVERDUE_GRACE) {
      stale.push({
        company,
        displayName: providerLabel(displayName),
        hoursSince: Math.round(hoursSince),
        expectedEveryHours: expected,
      });
    }
  }
  return stale.sort((a, b) => b.hoursSince - a.hoursSince);
}

/**
 * Providers whose data is incomplete right now - either the last attempt failed,
 * or no attempt has happened for far too long.
 *
 * The failed-attempt half is the important one and cannot be inferred from age.
 * A card on a 20h interval that is scraped daily sits at ~24h since its last
 * success just before every run, which is indistinguishable from one that failed
 * this morning. Only the recorded outcome separates them - and getting this
 * wrong is exactly how a digest announced a spend-free day minutes after the
 * busiest card timed out.
 */
export async function staleProviders(now = new Date()): Promise<StaleProvider[]> {
  const accounts = await prisma.account.findMany({
    where: { lifecycle: 'active' },
    select: { displayName: true, institution: true, scrapedAt: true },
  });

  const byAge = staleProvidersOf(accounts, now);
  const seen = new Set(byAge.map((p) => p.company));

  // The most recent finished attempt per provider. `running` rows are skipped -
  // a scrape in flight is not a failure.
  const companies = [...new Set(accounts.map((a) => a.institution))];
  for (const company of companies) {
    const last = await prisma.syncRun.findFirst({
      where: { company, status: { in: ['success', 'failed'] } },
      orderBy: { startedAt: 'desc' },
      select: { status: true, startedAt: true },
    });
    if (!last || last.status !== 'failed' || seen.has(company)) continue;

    const account = accounts.find((a) => a.institution === company);
    const hoursSince = account?.scrapedAt
      ? Math.round((now.getTime() - account.scrapedAt.getTime()) / 3_600_000)
      : Math.round((now.getTime() - last.startedAt.getTime()) / 3_600_000);

    byAge.push({
      company,
      displayName: account ? providerLabel(account.displayName) : company,
      hoursSince,
      expectedEveryHours: defaultEveryHours(company),
      lastAttemptFailed: true,
    });
  }

  return byAge.sort((a, b) => b.hoursSince - a.hoursSince);
}

export function freshnessOf(
  accounts: Array<{ displayName: string; institution: string; scrapedAt: Date | null }>,
): SyncFreshness {
  const perAccount = accounts.map((a) => ({
    displayName: a.displayName,
    institution: a.institution,
    scrapedAt: a.scrapedAt ? a.scrapedAt.toISOString() : null,
  }));

  const stamps = accounts.map((a) => a.scrapedAt).filter((d): d is Date => d != null);
  if (stamps.length === 0) {
    return { lastSyncAt: null, hoursSince: null, state: 'never', perAccount };
  }

  const oldest = stamps.reduce((a, b) => (a < b ? a : b));
  const hoursSince = (Date.now() - oldest.getTime()) / 3_600_000;
  const state = stamps.length < accounts.length ? 'never' : hoursSince >= STALLED_HOURS ? 'stalled' : hoursSince >= AGING_HOURS ? 'aging' : 'fresh';
  return { lastSyncAt: oldest.toISOString(), hoursSince: Math.round(hoursSince), state, perAccount };
}

export async function analyseSyncHealth(): Promise<{
  issues: SyncIssue[];
  freshness: SyncFreshness;
  reliability: DataReliability;
  checkedAt: string;
}> {
  const issues: SyncIssue[] = [];

  const accounts = await prisma.account.findMany({ where: { lifecycle: 'active' } });
  const freshness = freshnessOf(accounts);
  if(accounts.some(a=>!a.scrapedAt))issues.push({kind:'provider_stale',severity:'error',title:'חלק מהחשבונות טרם סונכרנו',detail:'אין עדיין נתונים מאומתים מכל החשבונות הפעילים. עברו לחיבורים כדי להשלים משיכה או לסמן חשבון שאינו בשימוש.'});
  const review = await qualityItems();
  const unresolved = review.filter(i => i.kind === 'material');
  if (unresolved.length) issues.push({ kind: 'material', severity: 'warning', title: 'תנועות מהותיות מחכות להכרעה', detail: 'הסיווג שלהן עשוי לשנות את הסיכום. עברו למרכז איכות הנתונים לבדיקה.', occurrences: unresolved.length, amount: unresolved.reduce((s,i) => s+i.amount,0) });
  const unmatched = review.filter(i => i.canResolve);
  if (unmatched.length) issues.push({ kind: 'coverage_review', severity: 'warning', title: 'התאמות כספיות מחכות לבדיקה', detail: 'חיובים והעברות ללא התאמה מדויקת. ייתכן שמדובר בהעברה תקינה או בהיסטוריה חסרה.', occurrences: unmatched.length });
  if (accounts.some(a => a.type === 'bank' && a.balance == null)) issues.push({ kind: 'missing_balance', severity: 'error', title: 'חסרה יתרת בנק', detail: 'אי אפשר להציג תחזית יתרה מלאה עד לקבלת יתרה מכל חשבון פעיל.' });

  // Raised before anything else, because when this fires every other finding on
  // the page is being computed from data that stopped moving.
  if ((freshness.state === 'stalled' || freshness.state === 'aging') && accounts.every(a=>a.scrapedAt && Date.now()-a.scrapedAt.getTime()>=AGING_HOURS*3_600_000)) {
    const days = Math.floor((freshness.hoursSince ?? 0) / 24);
    issues.push({
      kind: 'sync_stalled',
      severity: freshness.state === 'stalled' ? 'error' : 'warning',
      title:
        days >= 1
          ? `הנתונים לא התעדכנו ${days} ימים`
          : `הנתונים לא התעדכנו ${freshness.hoursSince} שעות`,
      detail:
        'כל המספרים בדף מחושבים ממה שנמשך לאחרונה, ולכן הם מציגים מצב ישן. ' +
        'המשיכה רצה רק כשהמחשב דלוק ומחובר — בדקו שהמשימה היומית קיימת ' +
        'או הריצו משיכה ידנית מעמוד החיבורים.',
      lastSeen: freshness.lastSyncAt ?? undefined,
    });
  }

  // One provider failing while the others succeed. Invisible to the check above,
  // because "last sync" across all accounts stays minutes old - which is exactly
  // how a failed Cal scrape produced a digest announcing a spend-free day.
  for (const p of await staleProviders()) {
    issues.push({
      kind: 'provider_stale',
      severity: 'error',
      company: p.company,
      title: p.lastAttemptFailed
        ? `המשיכה מ${p.displayName} נכשלה`
        : `${p.displayName} לא סונכרן ${p.hoursSince} שעות`,
      detail:
        (p.lastAttemptFailed
          ? `הניסיון האחרון הסתיים בשגיאה, והנתונים עצרו לפני ${p.hoursSince} שעות. `
          : `אמור להתעדכן כל ~${p.expectedEveryHours} שעות. `) +
        `כל עוד זה נמשך, תנועות מהספק הזה חסרות וכל סיכום יומי או חודשי מציג פחות ממה שבאמת קרה. ` +
        `הריצו משיכה ידנית מעמוד החיבורים.`,
      occurrences: p.hoursSince,
    });
  }

  // A card that appeared on its own is worth saying out loud - it means someone
  // shared an account, or a provider issued a card you did not know about.
  const NEW_ACCOUNT_HOURS = 48;
  const newCutoff = new Date(Date.now() - NEW_ACCOUNT_HOURS * 3_600_000);
  for (const a of accounts.filter((x) => x.createdAt >= newCutoff)) {
    const count = await prisma.transaction.count({ where: { accountId: a.id } });
    // Providers routinely return empty card slots - Cal handed back three at
    // once. An account with no transactions is a listing artefact, not an event
    // worth an alert; the day it starts spending, it stops being empty.
    if (count === 0) continue;
    issues.push({
      kind: 'new_account',
      severity: 'info',
      company: a.institution,
      title: `חשבון חדש נוסף: ${a.displayName}`,
      detail:
        `נמצא במשיכה האחרונה עם ${count} תנועות. אם זה כרטיס שצורף לחשבון (למשל של בן/בת זוג), ` +
        `ההוצאות שלו נספרות מעכשיו בתזרים שלכם — שווה לעבור עליהן ולסווג.`,
      lastSeen: toISODate(a.createdAt),
      occurrences: count,
    });
  }

  const bankAccounts = accounts.filter((a) => a.type === 'bank');
  const cardAccounts = accounts.filter((a) => a.type === 'credit_card');
  const connectedCompanies = new Set(accounts.map((a) => a.institution));

  // Coverage warnings answer "is today's picture complete?". A card that was
  // cancelled months ago is useful history, but it is not a broken connection.
  // Keep the rows forever while limiting health reasoning to the same recent
  // window the scrapers fetch.
  const relevanceCutoff = new Date();
  relevanceCutoff.setHours(0, 0, 0, 0);
  relevanceCutoff.setMonth(relevanceCutoff.getMonth() - 3);

  if (bankAccounts.length === 0) {
    issues.push({
      kind: 'no_bank_connected',
      severity: 'error',
      title: 'אין חשבון בנק מחובר',
      detail:
        'בלי חשבון בנק אין יתרה, אין הכנסות, ואי אפשר לחשב תזרים. ' +
        'התנועות והקטגוריות עובדות, אבל המספר הראשי לא משקף מציאות.',
    });
    // Everything below reasons from bank statements, so stop here.
    return { issues, freshness, reliability: await reliabilityOf(issues), checkedAt: new Date().toISOString() };
  }

  const bankIds = new Set(bankAccounts.map((a) => a.id));
  const bankDebits = await prisma.transaction.findMany({
    where: { accountId: { in: [...bankIds] }, amount: { lt: 0 }, date: { gte: relevanceCutoff } },
    select: { date: true, amount: true, description: true, categoryId: true, category: { select: { kind: true } } },
    orderBy: { date: 'desc' },
  });

  // ---- 1. Which card issuers does the bank say are charging us? ----
  interface Seen {
    company: string;
    label: string;
    total: number;
    count: number;
    lastSeen: Date;
    unclassified: number;
  }
  const seen = new Map<string, Seen>();
  let genericSettlements = 0;
  let genericUnclassified = 0;

  for (const t of bankDebits) {
    const named = SETTLEMENT_SIGNATURES.find((s) => s.patterns.test(t.description));
    const looksLikeSettlement = named != null || GENERIC_SETTLEMENT.test(t.description);
    if (!looksLikeSettlement) continue;

    const isClassified = t.category?.kind === 'transfer';

    if (!named) {
      genericSettlements++;
      if (!isClassified) genericUnclassified++;
      continue;
    }

    const entry = seen.get(named.company) ?? {
      company: named.company,
      label: named.label,
      total: 0,
      count: 0,
      lastSeen: t.date,
      unclassified: 0,
    };
    entry.total += -t.amount;
    entry.count++;
    if (t.date > entry.lastSeen) entry.lastSeen = t.date;
    if (!isClassified) entry.unclassified++;
    seen.set(named.company, entry);
  }

  // ---- 2. Charged by a provider that is not connected ----
  for (const entry of seen.values()) {
    if (connectedCompanies.has(entry.company)) continue;
    issues.push({
      kind: 'provider_not_connected',
      severity: 'error',
      company: entry.company,
      title: `מחויב על ידי ${entry.label} — אבל הכרטיס לא מחובר`,
      detail:
        `נמצאו ${entry.count} חיובים בבנק בסך ${fmt(entry.total)} מ${entry.label}, ` +
        `האחרון ב-${toISODate(entry.lastSeen)}. בלי חיבור הכרטיס הכסף הזה נשאר גוש אחד ` +
        `בלי פירוט. הוסיפו אותו: npm run accounts -- add  (ספק: ${entry.company})`,
      amount: entry.total,
      lastSeen: toISODate(entry.lastSeen),
      occurrences: entry.count,
    });
  }

  // ---- 3. Settlements not classified as transfers (double-counting risk) ----
  const unclassifiedNamed = [...seen.values()].filter((e) => e.unclassified > 0);
  if (unclassifiedNamed.length > 0 || genericUnclassified > 0) {
    const total =
      unclassifiedNamed.reduce((s, e) => s + e.unclassified, 0) + genericUnclassified;
    issues.push({
      kind: 'settlement_unclassified',
      severity: 'error',
      title: 'חיובי אשראי נספרים כהוצאה',
      detail:
        `${total} חיובי כרטיס אשראי בבנק לא מסווגים כ"העברה", ולכן נספרים פעמיים: ` +
        `פעם כקנייה בכרטיס ופעם כחיוב בבנק. הוסיפו חוק שמפנה אותם לקטגוריה מסוג transfer.`,
      occurrences: total,
    });
  }

  // Statement reconciliation is reported by qualityItems() above. Keep a single
  // matcher for the review screen and reliability status: purchase-date cutoffs,
  // pending charges, currency aliases and reused bank rows must agree everywhere.

  // ---- 4b. A billing group with no card behind it ----
  // The strongest coverage signal there is, and the per-card amount check was
  // masking it: the bank names the exact group being settled, so a group that
  // matches none of the connected cards is a card you are paying for and cannot
  // see. Different from check 2 - the *issuer* is connected, just not this card.
  const connectedLastFour = new Set(
    cardAccounts.map((a) => a.displayName.replace(/\D/g, '').slice(-4)).filter(Boolean),
  );
  const orphanGroups = new Map<string, { total: number; count: number; last: Date; label: string }>();
  for (const t of bankDebits) {
    const named = SETTLEMENT_SIGNATURES.find((s) => s.patterns.test(t.description));
    if (!named) continue;
    const group = billingGroupOf(t.description);
    if (!group || connectedLastFour.has(group)) continue;
    const entry = orphanGroups.get(group) ?? { total: 0, count: 0, last: t.date, label: named.label };
    entry.total += -t.amount;
    entry.count++;
    if (t.date > entry.last) entry.last = t.date;
    orphanGroups.set(group, entry);
  }

  for (const [group, e] of orphanGroups) {
    issues.push({
      kind: 'provider_not_connected',
      severity: 'warning',
      title: `כרטיס ${e.label} ••••${group} מחויב אבל לא מחובר`,
      detail:
        `הבנק מציג ${e.count} חיובים בסך ${fmt(e.total)} תחת "${group} - ${e.label}", ` +
        `והאחרון ב-${toISODate(e.last)}. אף אחד מהכרטיסים המחוברים לא מסתיים ב-${group}, ` +
        `כך שההוצאות שמאחורי הסכום הזה לא מפורטות בשום מקום. ` +
        `ייתכן שזה כרטיס של בן/בת זוג, כרטיס שנסגר, או כרטיס שצריך להוסיף.`,
      amount: e.total,
      lastSeen: toISODate(e.last),
      occurrences: e.count,
    });
  }

  // ---- 5. Accounts that were active and then went quiet ----
  // A card with one or two charges months ago is dormant, not broken; saying
  // "the scrape may be failing" about it is noise. Only an account with a real
  // history going silent is worth an alert.
  const STALE_DAYS = 45;
  const MIN_HISTORY = 5;
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_DAYS);

  for (const account of accounts) {
    const [latest, count] = await Promise.all([
      prisma.transaction.findFirst({
        where: { accountId: account.id },
        orderBy: { date: 'desc' },
        select: { date: true },
      }),
      prisma.transaction.count({ where: { accountId: account.id } }),
    ]);
    if (!latest || count < MIN_HISTORY) continue;
    // Dormant/cancelled accounts older than the relevance window are history,
    // not sync incidents. Do not train the user to ignore real warnings.
    if (latest.date < relevanceCutoff) continue;
    if (latest.date >= staleCutoff) continue;
    issues.push({
      kind: 'stale_account',
      severity: 'info',
      company: account.institution,
      title: `${account.displayName} ללא פעילות לאחרונה`,
      detail:
        `${count} תנועות בהיסטוריה, אבל האחרונה מ-${toISODate(latest.date)} ` +
        `(לפני יותר מ-${STALE_DAYS} יום). חוסר פעילות אינו כשל בסנכרון. אם החשבון אינו בשימוש, אפשר לעדכן את מצבו בחיבורים.`,
      lastSeen: toISODate(latest.date),
      occurrences: count,
    });
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return { issues, freshness, reliability: await reliabilityOf(issues), checkedAt: new Date().toISOString() };
}

export interface SettlementMismatchDetail {
  account: { id: string; displayName: string; institution: string; lastFour: string };
  chargeDate: string;
  bankTotal: number;
  cardTotal: number;
  /** Signed magnitude: positive means the bank charged more than the card rows. */
  difference: number;
  chosenBankTransactionId: string;
  bankTransactions: Array<{ id: string; date: string; description: string; amount: number }>;
  cardTransactions: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    status: string;
    installmentNumber: number | null;
    installmentTotal: number | null;
  }>;
}

/** Evidence behind one mismatch warning, loaded only when the user asks for it. */
export async function settlementMismatchDetail(
  accountId: string,
  chargeDate: string,
): Promise<SettlementMismatchDetail | null> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(chargeDate);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const account = await prisma.account.findFirst({
    where: { id: accountId, type: 'credit_card' },
    select: { id: true, displayName: true, institution: true, lastFour: true },
  });
  if (!account) return null;

  const [cardRows, rawBankRows] = await Promise.all([
    prisma.transaction.findMany({
      where: { accountId, processedDate: { gte: start, lt: end } },
      select: {
        id: true,
        date: true,
        description: true,
        amount: true,
        status: true,
        installmentNumber: true,
        installmentTotal: true,
      },
      orderBy: [{ date: 'asc' }, { amount: 'asc' }],
    }),
    prisma.transaction.findMany({
      where: { account: { type: 'bank' }, date: { gte: start, lt: end }, amount: { lt: 0 } },
      select: { id: true, date: true, description: true, amount: true },
      orderBy: { amount: 'asc' },
    }),
  ]);
  if (cardRows.length === 0) return null;

  let bankRows = rawBankRows.filter((row) => {
    const named = SETTLEMENT_SIGNATURES.find((signature) => signature.patterns.test(row.description));
    if (named) return named.company === account.institution;
    return GENERIC_SETTLEMENT.test(row.description);
  });
  const cardLastFour = account.displayName.replace(/\D/g, '').slice(-4) || account.lastFour;
  const mine = bankRows.filter((row) => billingGroupOf(row.description) === cardLastFour);
  if (mine.length > 0) {
    bankRows = mine;
  } else if (cardLastFour) {
    bankRows = bankRows.filter((row) => {
      const group = billingGroupOf(row.description);
      return group === null || group === cardLastFour;
    });
  }
  if (bankRows.length === 0) return null;

  const expected = cardRows.reduce((sum, row) => sum + row.amount, 0);
  const chosen = bankRows.reduce((best, row) =>
    Math.abs(row.amount - expected) < Math.abs(best.amount - expected) ? row : best,
  );
  const bankTotal = Math.abs(chosen.amount);
  const cardTotal = Math.abs(expected);

  return {
    account,
    chargeDate,
    bankTotal,
    cardTotal,
    difference: bankTotal - cardTotal,
    chosenBankTransactionId: chosen.id,
    bankTransactions: bankRows.map((row) => ({ ...row, date: toISODate(row.date) })),
    cardTransactions: cardRows.map((row) => ({ ...row, date: toISODate(row.date) })),
  };
}

/**
 * Israeli banks prefix a card settlement with the billing group it covers -
 * `1234 - ישראכרט בע"מ`. That number is the last four of the card (or of the
 * group of cards) being settled, and it is the only reliable way to tell two
 * debits from the same issuer on the same day apart.
 *
 * Returns null when the description carries no such number, which is common and
 * simply means "cannot narrow it down".
 */
function billingGroupOf(description: string): string | null {
  const match = /(?:^|\s)(\d{4})\s*[-–]\s*\D/.exec(description);
  return match ? match[1] : null;
}

function fmt(agorot: number): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: 0,
  }).format(agorot / 100);
}

function displayDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
