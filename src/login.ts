/**
 * Guided first-time login:  npm run login -- visaCal
 *
 * Opens a real, visible browser using the provider's PERSISTENT profile and
 * parks it on the login page. You log in by hand, clear any SMS/OTP challenge,
 * and - crucially - tick whatever "remember this device" / "המשך להיות מזוהה"
 * option the site offers. The resulting device cookie is written into the
 * profile, so the automated headless runs afterwards are no longer treated as a
 * brand-new device.
 *
 * Nothing is typed for you and no credential is read by this script: you enter
 * them yourself, in a normal browser window.
 */
import { CompanyTypes, SCRAPERS } from 'israeli-bank-scrapers';
import { closeBrowserCleanly, launchPersistentBrowser, profileDirFor } from './browser.js';
import { withScrapeLock } from './scrape-lock.js';

/** Where each provider's human login flow starts. */
const LOGIN_URLS: Partial<Record<CompanyTypes, string>> = {
  [CompanyTypes.visaCal]: 'https://www.cal-online.co.il/',
  [CompanyTypes.max]: 'https://www.max.co.il/',
  [CompanyTypes.isracard]: 'https://digital.isracard.co.il/personalarea/Login/',
  [CompanyTypes.amex]: 'https://he.americanexpress.co.il/',
  [CompanyTypes.hapoalim]: 'https://login.bankhapoalim.co.il/',
  [CompanyTypes.leumi]: 'https://hb2.bankleumi.co.il/',
  [CompanyTypes.discount]: 'https://start.telebank.co.il/',
  [CompanyTypes.mercantile]: 'https://start.telebank.co.il/',
  [CompanyTypes.mizrahi]: 'https://www.mizrahi-tefahot.co.il/',
  [CompanyTypes.otsarHahayal]: 'https://digital.bankotsar.co.il/',
  [CompanyTypes.beinleumi]: 'https://online.fibi.co.il/',
  [CompanyTypes.oneZero]: 'https://www.onezerobank.com/',
};

async function main() {
  const requested = process.argv.slice(2).find((a) => !a.startsWith('-'));

  if (!requested) {
    console.error('Usage: npm run login -- <company>\n');
    console.error(`Available: ${Object.keys(SCRAPERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (!(requested in SCRAPERS)) {
    console.error(`Unknown company "${requested}".\nAvailable: ${Object.keys(SCRAPERS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const company = requested as CompanyTypes;

  console.log(`\nOpening a browser for ${company}`);
  console.log(`Profile: ${profileDirFor(company)}\n`);

  // An interactive login writes to the same profile a scrape reads from, and
  // the scheduled task has no idea you are sitting in front of a login form.
  // Taking the scrape lock turns "the window died halfway through the OTP" into
  // an upfront, explainable refusal.
  await withScrapeLock(`התחברות ידנית ל-${company}`, () => runLogin(company));
}

async function runLogin(company: CompanyTypes) {
  const url = LOGIN_URLS[company];
  const browser = await launchPersistentBrowser(company, { headless: false });

  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {
        console.log('(could not preload the login page - navigate there yourself)');
      });
    } else {
      console.log(`No known login URL for ${company} - navigate to it in the window.`);
    }

    console.log('What to do in the window that just opened:');
    console.log('  1. Log in with your own credentials.');
    console.log('  2. Complete any SMS / OTP challenge.');
    console.log('  3. Tick "remember this device" if the site offers it.');
    console.log('  4. Make sure you can see your transactions.');
    console.log('  5. Close the browser window.\n');
    console.log('Waiting for you to close the window...');

    await new Promise<void>((resolve) => browser.on('disconnected', resolve));

    console.log('\nProfile saved. Now run an automated scrape:');
    console.log(`  npm run scrape -- --company ${company}\n`);
  } finally {
    await closeBrowserCleanly(browser);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

