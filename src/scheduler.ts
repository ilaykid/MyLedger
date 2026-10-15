import cron from 'node-cron';
import 'dotenv/config';
import { sendDigest, sendTelegram } from './notify.js';
import { applyCategoryRules } from './categorize.js';
import { safeErrorMessage } from './redact.js';
import { escapeHtml as esc } from './html.js';

/**
 * Long-running scheduler process (npm run scheduler).
 *
 * - once a day (10:00 unless SCRAPE_CRON says otherwise): scrape all accounts
 *   -> categorize -> Telegram digest.
 *
 * Alternative deployments: Windows Task Scheduler / cron / GitHub Actions
 * calling `npm run scrape && npm run notify` - this process is just the
 * self-contained option.
 */

const SCRAPE_CRON = process.env.SCRAPE_CRON ?? '0 10 * * *';

async function dailyJob() {
  console.log(`[scheduler] daily job started ${new Date().toISOString()}`);

  // A failed scrape is a reason to send the digest, not to skip it: the digest
  // names the accounts that did not update, and yesterday's numbers from the
  // others are still worth having. Per-provider failures never reach here - the
  // runner records them and the digest reports them - so this catches the run
  // as a whole failing (configuration, the scrape lock, the browser).
  try {
    const { runScrapeAll } = await import('./scrape-runner.js');
    await runScrapeAll({ label: 'תזמון פנימי' });
  } catch (err) {
    const msg = safeErrorMessage(err);
    console.error('[scheduler] scrape failed:', msg);
    await sendTelegram(
      '<b>🛑 העדכון האוטומטי של היום לא רץ</b>\n' +
        'ייתכן שהסיכום שיגיע עכשיו לא כולל את התנועות האחרונות.\n' +
        'אפשר להריץ עדכון ידני מעמוד החשבונות במחשב.\n' +
        // Telegram caps a message at 4,096 characters; the cause needs a line.
        `<i>${esc(msg.slice(0, 300))}</i>`,
    );
  }

  try {
    const stats = await applyCategoryRules();
    console.log(`[scheduler] categorized ${stats.categorized} new transactions`);
    const digest = await sendDigest();
    console.log(
      `[scheduler] ${digest.kind} digest ${digest.sent ? `sent${digest.silent ? ' silently' : ''}` : `not sent (${digest.error})`}`,
    );
  } catch (err) {
    console.error('[scheduler] digest failed:', safeErrorMessage(err));
  }
}

cron.schedule(SCRAPE_CRON, dailyJob);
console.log(`[scheduler] running, daily job scheduled at "${SCRAPE_CRON}"`);
