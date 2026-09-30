import cron from 'node-cron';
import 'dotenv/config';
import { sendDigest, sendTelegram } from './notify.js';
import { applyCategoryRules } from './categorize.js';

/**
 * Long-running scheduler process (npm run scheduler).
 *
 * - 05:30 every day: scrape all accounts -> categorize -> Telegram summary.
 *
 * Alternative deployments: Windows Task Scheduler / cron / GitHub Actions
 * calling `npm run scrape && npm run notify` - this process is just the
 * self-contained option.
 */

const SCRAPE_CRON = process.env.SCRAPE_CRON ?? '0 10 * * *';

async function nightlyJob() {
  console.log(`[scheduler] nightly job started ${new Date().toISOString()}`);
  try {
    // Import lazily so the scheduler can run without scraper credentials configured
    const { runScrapeAll } = await import('./scrape-runner.js');
    await runScrapeAll({ label: 'תזמון פנימי' });
    const stats = await applyCategoryRules();
    console.log(`[scheduler] categorized ${stats.categorized} new transactions`);
    const digest = await sendDigest();
    console.log(`[scheduler] ${digest.kind} digest ${digest.sent ? 'sent' : `not sent (${digest.error})`}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scheduler] nightly job failed:', msg);
    await sendTelegram(`🛑 MyLedger: משיכת הנתונים הלילית נכשלה\n${msg}`);
  }
}

cron.schedule(SCRAPE_CRON, nightlyJob);
console.log(`[scheduler] running, nightly job scheduled at "${SCRAPE_CRON}"`);
