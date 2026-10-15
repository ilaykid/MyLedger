import { createScraper, CompanyTypes, SCRAPERS } from 'israeli-bank-scrapers';
import { loadConfig, type AccountConfig } from './config.js';
import { ingestScrapedAccount, type ScrapedAccount, type IngestStats } from './ingest.js';
import { clearGateCookies, closeBrowserCleanly, hasProfile, launchPersistentBrowser } from './browser.js';
import { withScrapeLock } from './scrape-lock.js';
import { prisma } from './db.js';
import { redactSecrets, safeErrorMessage } from './redact.js';

// Shared with the health checks so "when should this refresh" has exactly one
// definition - otherwise the runner and the staleness warning drift apart and
// the dashboard contradicts the scheduler.
import { defaultEveryHours, isBankProvider as isBank } from './sync-health.js';

/**
 * When this provider was last scraped successfully, or null if never.
 * Taken from the accounts it produced rather than tracked separately, so it
 * stays true even if the config is edited.
 */
async function lastScrapedAt(company: string): Promise<Date | null> {
  const newest = await prisma.account.findFirst({
    where: { institution: company, scrapedAt: { not: null } },
    orderBy: { scrapedAt: 'desc' },
    select: { scrapedAt: true },
  });
  return newest?.scrapedAt ?? null;
}

export async function scrapeOne(
  cfg: AccountConfig,
  monthsBack: number,
  showBrowser: boolean,
  onLog?: (line: string) => void,
) {
  const companyId = cfg.company as CompanyTypes;
  if (!(companyId in SCRAPERS)) {
    throw new Error(
      `Unknown company "${cfg.company}". Valid values: ${Object.keys(SCRAPERS).join(', ')}`,
    );
  }

  if (!hasProfile(cfg.company)) {
    console.log(
      `  הערה: אין פרופיל דפדפן שמור ל-${cfg.company}. אם העדכון ייעצר על קוד SMS, ` +
        `הריצו פעם אחת npm run login -- ${cfg.company} בטרמינל בתיקיית MyLedger.`,
    );
  }

  const hasHistory = (await prisma.transaction.count({ where: { account: { institution: cfg.company } } })) > 0;
  // The first import is deliberately deep. Later runs overlap enough history
  // to catch pending/completed changes without downloading the same 18 months
  // every morning (which is slower and looks much less like normal use).
  const effectiveMonthsBack = hasHistory ? Math.min(monthsBack, 3) : monthsBack;
  const startDate = new Date();
  if (isBank(cfg.company)) {
    // Bank history is a true rolling time window.
    startDate.setMonth(startDate.getMonth() - effectiveMonthsBack);
  } else {
    // "Three months" for a card means three BILLING cycles, not purchases
    // made after today's calendar day three months ago. The oldest retained
    // charge cycle can contain a purchase from the preceding month (e.g. a
    // 04/05 purchase billed on 10/06), so start at that month's first day.
    startDate.setMonth(startDate.getMonth() - effectiveMonthsBack, 1);
    startDate.setHours(0, 0, 0, 0);
  }
  if (hasHistory && effectiveMonthsBack < monthsBack) {
    const line = `  רענון מצטבר: ${effectiveMonthsBack} חודשים אחרונים (היסטוריה עמוקה כבר שמורה)`;
    console.log(line);
    onLog?.(line);
  }
  if (!isBank(cfg.company)) {
    const line = `  חלון אשראי: ${effectiveMonthsBack} מחזורי חיוב (עסקאות מ-${startDate.toLocaleDateString('he-IL')})`;
    console.log(line);
    onLog?.(line);
  }

  // Own the browser ourselves so it keeps a persistent profile across runs -
  // see src/browser.ts for why this matters.
  const browser = await launchPersistentBrowser(cfg.company, { headless: !showBrowser });

  try {
    // A previous run may have left us parked in a bot-protection queue. The
    // cookie that holds that place survives in the profile and silently breaks
    // login, so clear it before we even try. See clearGateCookies.
    const cleared = await clearGateCookies(browser);
    if (cleared > 0) {
      const line = `  ניקיתי ${cleared} עוגיות חסימה שנשארו מהרצה קודמת`;
      console.log(line);
      onLog?.(line);
    }

    const PROGRESS_HE: Record<string, string> = {
      INITIALIZING: 'מאתחל',
      START_SCRAPING: 'מתחיל',
      LOGGING_IN: 'מתחבר',
      LOGIN_SUCCESS: 'התחברות הצליחה',
      LOGIN_FAILED: 'התחברות נכשלה',
      CHANGE_PASSWORD: 'נדרשת החלפת סיסמה',
      END_SCRAPING: 'קריאת הנתונים הסתיימה',
      TERMINATING: 'מסיים',
    };
    const attempt = async () => {
      const scraper = createScraper({
        companyId,
        startDate,
        combineInstallments: false,
        browser,
        skipCloseBrowser: true, // we close it in the finally below
        timeout: 120_000,
      });
      scraper.onProgress((_company, payload) => {
        const line = `  ${PROGRESS_HE[payload.type] ?? payload.type}`;
        console.log(line);
        onLog?.(line);
      });
      return scraper.scrape(cfg.credentials as never);
    };

    let result = await attempt();

    // A bot-protection block can also be handed to us mid-run, and it looks
    // like a plain network error. One retry with a clean slate settles whether
    // it was that or a genuine failure - measured on Isracard, this is the
    // difference between "works" and "never works again".
    if (!result.success && isTransientBlock(result.errorType, result.errorMessage)) {
      const line = '  נראה כמו חסימה זמנית — מנקה ומנסה שוב';
      console.log(line);
      onLog?.(line);
      await clearGateCookies(browser);
      await new Promise((r) => setTimeout(r, 5_000));
      result = await attempt();
    }

    if (!result.success) {
      throw new ScrapeFailure(
        cfg.company,
        result.errorType,
        redactSecrets(result.errorMessage ?? 'no further detail', Object.values(cfg.credentials)),
      );
    }

    const accounts = (result.accounts ?? []) as unknown as ScrapedAccount[];
    if (accounts.length === 0) {
      console.log('  אזהרה: ההתחברות הצליחה אבל לא הוחזרו חשבונות');
    }

    const totals: IngestStats = { inserted: 0, updated: 0, pendingMatched: 0, pendingDropped: 0, skipped: 0 };

    for (const scrapedAccount of accounts) {
      // One provider often returns several cards. Without the last four they all
      // land under the same name and become impossible to tell apart.
      const base = cfg.displayName ?? cfg.company;
      const lastFour = scrapedAccount.accountNumber.replace(/\D/g, '').slice(-4);
      const displayName = accounts.length > 1 ? `${base} ••••${lastFour}` : base;

      const stats = await ingestScrapedAccount(
        cfg.company,
        isBank(cfg.company) ? 'bank' : 'credit_card',
        displayName,
        scrapedAccount,
        startDate,
      );
      totals.inserted += stats.inserted;
      totals.updated += stats.updated;
      totals.pendingMatched += stats.pendingMatched;
      totals.pendingDropped += stats.pendingDropped;
      totals.skipped += stats.skipped;
      console.log(
        `  [${cfg.company}/••••${lastFour}] ` +
          `+${stats.inserted} new, ${stats.updated} completed, ` +
          `${stats.pendingMatched} pending-matched, ` +
          `${stats.pendingDropped} pending-dropped, ${stats.skipped} already known`,
      );
    }

    return totals;
  } finally {
    await closeBrowserCleanly(browser);
  }
}

/**
 * Does this failure look like a bot-protection block rather than a real one?
 *
 * `Failed to fetch` is what a browser `fetch()` throws when the request never
 * completes - which is exactly what a Cloudflare waiting room looks like from
 * inside the page. It says nothing about the credentials.
 */
/** The request never completed - bot protection, or the connection dropped. */
function looksBlocked(message: string | undefined): boolean {
  return /failed to fetch|network|ERR_FAILED|ERR_CONNECTION|socket hang up|ECONNRESET/i.test(
    message ?? '',
  );
}

/**
 * The page simply took too long. A card site answering "Navigation timeout of
 * 30000 ms exceeded" with no retry loses the whole day's data to one slow page
 * load.
 */
function looksSlow(message: string | undefined): boolean {
  return /navigation timeout|timeout of \d+ ?ms exceeded|waiting for selector/i.test(message ?? '');
}

function isTransientBlock(errorType: string | undefined, message: string | undefined): boolean {
  if (errorType !== 'GENERIC' && errorType !== 'TIMEOUT') return false;
  return looksBlocked(message) || looksSlow(message);
}

/** Carries the scraper's own error type so the runner can explain it usefully. */
export class ScrapeFailure extends Error {
  constructor(
    readonly company: string,
    readonly errorType: string | undefined,
    readonly detail: string | undefined,
  ) {
    super(`[${errorType ?? 'unknown'}] ${detail ?? 'no further detail'}`);
    this.name = 'ScrapeFailure';
  }
}

/**
 * What went wrong, grouped by what the person should do about it. The
 * scraper's own errorType stays machine-readable in the message (and in
 * syncRun.error); this is the coarser grouping the Connections page acts on.
 */
export type ScrapeCause =
  | 'invalid_password'
  | 'change_password'
  | 'blocked'
  | 'slow'
  | 'otp'
  | 'account_blocked'
  | 'unknown';

export function classifyFailure(failure: ScrapeFailure): ScrapeCause {
  switch (failure.errorType) {
    case 'INVALID_PASSWORD':
      return 'invalid_password';
    case 'CHANGE_PASSWORD':
      return 'change_password';
    case 'ACCOUNT_BLOCKED':
      return 'account_blocked';
    case 'TIMEOUT':
    case 'GENERIC':
      // These two look identical from the outside but need opposite responses:
      // one wants a human at the keyboard, the other wants you to stop trying
      // for a while. Sending someone to do an interactive login while they are
      // sitting in a bot-protection queue just deepens the block.
      if (looksBlocked(failure.detail)) return 'blocked';
      if (looksSlow(failure.detail)) return 'slow';
      return 'otp';
    default:
      return 'unknown';
  }
}

/**
 * Turn a scraper failure into something actionable rather than a raw code.
 * Hebrew, and pointing at the Connections page rather than at config files -
 * that page can fix every one of these.
 */
function explain(failure: ScrapeFailure): string | null {
  switch (classifyFailure(failure)) {
    case 'invalid_password':
      return 'האתר דחה את פרטי ההתחברות. בדקו אותם מול אתר הבנק או חברת האשראי ועדכנו אותם בעמוד "חשבונות וחיבורים" ← "עדכון פרטים".';
    case 'change_password':
      return 'האתר דורש להחליף סיסמה. היכנסו אליו בדפדפן, בחרו סיסמה חדשה ועדכנו אותה בעמוד "חשבונות וחיבורים" ← "עדכון פרטים".';
    case 'blocked':
      return (
        'הבקשה לא הגיעה לאתר — זו חסימה זמנית מפני רובוטים, לא בעיה בסיסמה. ' +
        'ניסיון חוזר כבר נעשה ונכשל, כך שהחסימה עדיין פעילה. נסו שוב בעוד כ-10 דקות, פעם אחת: ' +
        'ניסיונות חוזרים רק מאריכים את החסימה.'
      );
    case 'slow':
      return (
        'האתר לא סיים להיטען בזמן, פעמיים. בדרך כלל האתר פשוט איטי ואין בעיה בחשבון — ' +
        'העדכון המתוזמן הבא כנראה יצליח. אפשר גם לנסות שוב מעמוד "חשבונות וחיבורים".'
      );
    case 'otp':
      return (
        'כנראה נדרש אימות SMS או אישור "מכשיר חדש", ואי אפשר לענות עליו אוטומטית. ' +
        `הריצו npm run login -- ${failure.company} בטרמינל בתיקיית MyLedger, היכנסו ידנית וסמנו "זכור את המכשיר", ואז נסו שוב.`
      );
    case 'account_blocked':
      return 'החשבון חסום אצל הבנק או חברת האשראי. צריך לפתור את זה מולם ישירות.';
    default:
      return null;
  }
}

/** One provider's outcome, for the Connections page's result cards. */
export interface ScrapeResult {
  company: string;
  label: string;
  ok: boolean;
  /** Set when ok */
  inserted?: number;
  skipped?: number;
  /** Set when failed: what to do about it */
  cause?: ScrapeCause;
  /** The scraper's own machine-readable error type, e.g. INVALID_PASSWORD */
  errorType?: string;
  /** Hebrew explanation, when there is one */
  hint?: string;
}

/**
 * Scrape configured accounts. Returns the number of failures.
 * `only` restricts the run to specific company ids - handy for testing one
 * provider without touching the others.
 */
export interface ScrapeOptions {
  /** Restrict to these company ids */
  only?: string[];
  /** Ignore the per-provider interval and scrape anyway */
  force?: boolean;
  /** Who asked, shown to whoever collides with this run. See scrape-lock.ts. */
  label?: string;
  onLog?: (line: string) => void;
  /** Called once per provider actually attempted, with its outcome. */
  onResult?: (result: ScrapeResult) => void;
}

export async function runScrapeAll(
  onlyOrOptions?: string[] | ScrapeOptions,
  onLogArg?: (line: string) => void,
): Promise<number> {
  const options: ScrapeOptions = Array.isArray(onlyOrOptions)
    ? { only: onlyOrOptions, onLog: onLogArg }
    : (onlyOrOptions ?? { onLog: onLogArg });
  const { only, force = false, label = 'הרצה', onLog = onLogArg, onResult } = options;

  // Every entry point funnels through here, so this is the one place the lock
  // has to be taken for it to actually mean anything.
  return withScrapeLock(label, () => runScrape(only, force, onLog, onResult));
}

async function runScrape(
  only: string[] | undefined,
  force: boolean,
  onLog?: (line: string) => void,
  onResult?: (result: ScrapeResult) => void,
): Promise<number> {
  const say = (line: string) => {
    console.log(line);
    onLog?.(line);
  };
  const config = await loadConfig();

  const selected = only?.length
    ? config.accounts.filter((a) => only.includes(a.company))
    : config.accounts;

  if (only?.length && selected.length === 0) {
    throw new Error(
      `No configured account matches --company ${only.join(',')}. ` +
        `Configured: ${config.accounts.map((a) => a.company).join(', ') || '(none)'}`,
    );
  }

  say(
    `${selected.length} חשבונות, ${config.monthsBack} חודשים אחורה · ` +
      `סיסמאות ${config.encrypted ? 'מוצפנות בחשבון Windows' : 'בטקסט גלוי — הריצו npm run secure'}`,
  );

  let failures = 0;

  for (const accountCfg of selected) {
    const label = accountCfg.displayName ?? accountCfg.company;

    // Respect the per-provider interval unless explicitly forced. An explicit
    // --company request counts as intent, so it is never skipped.
    if (!force && !only?.length) {
      const interval = accountCfg.everyHours ?? defaultEveryHours(accountCfg.company);
      const last = await lastScrapedAt(accountCfg.company);
      if (last) {
        const hoursSince = (Date.now() - last.getTime()) / 3_600_000;
        if (hoursSince < interval) {
          const nextIn = Math.ceil(interval - hoursSince);
          say(`⏭ ${label}: עודכן לפני ${Math.floor(hoursSince)} שעות, הבא בעוד ~${nextIn} שעות`);
          continue;
        }
      }
    }

    say(`מעדכן נתונים מ${label}…`);
    const syncRun = await prisma.syncRun.create({
      data: { company: accountCfg.company, status: 'running', trigger: label },
    });
    try {
      const totals = await scrapeOne(accountCfg, config.monthsBack, config.showBrowser, onLog);
      await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
          inserted: totals.inserted,
          updated: totals.updated + totals.pendingMatched,
          skipped: totals.skipped,
        },
      });
      say(`✓ ${label}: ${totals.inserted} חדשות, ${totals.skipped} כבר קיימות`);
      onResult?.({ company: accountCfg.company, label, ok: true, inserted: totals.inserted, skipped: totals.skipped });
    } catch (err) {
      failures++;
      const safe = safeErrorMessage(err, Object.values(accountCfg.credentials));
      await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { status: 'failed', finishedAt: new Date(), error: safe },
      });
      if (err instanceof ScrapeFailure) {
        say(`✗ ${label}: ${err.message}`);
        const hint = explain(err);
        if (hint) say(`  ${hint}`);
        onResult?.({
          company: accountCfg.company,
          label,
          ok: false,
          cause: classifyFailure(err),
          errorType: err.errorType,
          hint: hint ?? undefined,
        });
      } else {
        say(`✗ ${label}: ${safe}`);
        onResult?.({ company: accountCfg.company, label, ok: false, cause: 'unknown' });
      }
    }
  }

  const keepSince = new Date();
  keepSince.setDate(keepSince.getDate() - 90);
  await prisma.syncRun.deleteMany({ where: { startedAt: { lt: keepSince } } });

  return failures;
}
