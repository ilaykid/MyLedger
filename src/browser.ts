import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer';
import { dataPath } from './paths.js';

/**
 * Persistent browser profiles - the single most important thing for making
 * unattended scraping actually work.
 *
 * israeli-bank-scrapers launches Chromium with no `userDataDir`, so every run
 * starts from a blank profile: no cookies, no device token. To the bank that is
 * a brand-new device every single night, which is exactly the condition that
 * triggers an SMS/OTP challenge - and the card scrapers have no OTP hook, so the
 * run just fails.
 *
 * Giving each provider its own persistent profile means the "remember this
 * device" cookie survives between runs: you authenticate once interactively
 * (`npm run login <company>`) and the nightly runs go through quietly.
 *
 * SECURITY: a profile directory holds live session cookies for your bank. Treat
 * it exactly like accounts.config.json - it is gitignored, and it belongs on an
 * encrypted disk.
 */

const PROFILE_ROOT = dataPath('.browser-profiles');

export function profileDirFor(company: string): string {
  // Company ids come from a fixed enum, but never let one escape into a path.
  const safe = company.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error(`Invalid company id: "${company}"`);
  return path.join(PROFILE_ROOT, safe);
}

export function hasProfile(company: string): boolean {
  return existsSync(profileDirFor(company));
}

export interface LaunchOptions {
  /** false opens a visible window - required for the first interactive login */
  headless: boolean;
  timeout?: number;
}

/**
 * Close any browser we launched if the process is interrupted. Without this a
 * Ctrl-C or a timeout kills Node while Chromium keeps running, and the orphan
 * holds the profile's SingletonLock - which makes the *next* run hang instead of
 * failing cleanly.
 */
const live = new Set<Browser>();
const liveCompanies = new Set<string>();
let cleanupInstalled = false;

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const close = () => {
    for (const b of live) {
      try {
        b.process()?.kill();
      } catch {
        /* best effort - we are on the way out */
      }
    }
  };
  process.once('SIGINT', () => {
    close();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(143);
  });
  process.once('exit', close);
}

/**
 * Cookies that gate access rather than identify us.
 *
 * Isracard sits behind a Cloudflare waiting room. Log in a few times in quick
 * succession and Cloudflare parks you in a virtual queue, writing a
 * `__cfwaitingroom` cookie that holds your place. With a persistent profile that
 * cookie *sticks*, and every later attempt dies inside the login POST with a
 * bare `TypeError: Failed to fetch` - the request never reaches Isracard at all.
 * Measured: clearing these cookies turns an unfixable-looking failure into a
 * clean `200` on the very next request.
 *
 * These carry no device trust, so dropping them costs nothing. The
 * "remember this device" cookies that justify the persistent profile in the
 * first place are left alone.
 */
const GATE_COOKIES = /^(__cfwaitingroom|__cf_bm|cf_clearance)$/;

/**
 * Drop the gate cookies before a login attempt. Returns how many were cleared,
 * which is worth logging: a non-zero count means the previous run left us
 * queued.
 */
export async function clearGateCookies(browser: Browser): Promise<number> {
  const stale = (await browser.cookies()).filter((c) => GATE_COOKIES.test(c.name));
  if (stale.length > 0) await browser.deleteCookie(...stale);
  return stale.length;
}

export async function launchPersistentBrowser(company: string, options: LaunchOptions): Promise<Browser> {
  const userDataDir = profileDirFor(company);
  mkdirSync(userDataDir, { recursive: true });
  installCleanup();

  try {
    const browser = await puppeteer.launch({
      headless: options.headless,
      userDataDir,
      timeout: options.timeout ?? 120_000,
      // A stable window size keeps the fingerprint consistent between the
      // interactive login and the headless runs that follow it. Headless
      // Chrome otherwise reports an 800x600 screen, which also breaks
      // responsive layouts on bank sites that render a mobile view below a
      // width threshold.
      defaultViewport: { width: 1280, height: 900 },
      args: [
        '--window-size=1280,900',
        // The pages we scrape are Hebrew. Chrome defaults to en-US, which asks
        // Israeli sites for English content and then fails to find Hebrew
        // selectors - a real functional bug, not cosmetics.
        '--lang=he-IL',
        // The profile is often marked "crashed" (see the kill in installCleanup),
        // and the restore offer would sit over every interactive login.
        '--hide-crash-restore-bubble',
      ],
      env: { ...process.env, LANGUAGE: 'he_IL' },
    });
    live.add(browser);
    liveCompanies.add(company);
    browser.on('disconnected', () => {
      live.delete(browser);
      liveCompanies.delete(company);
    });

    /**
     * Start from one blank tab, whatever the last run left behind.
     *
     * A timed-out or interrupted run is hard-killed on purpose (an orphaned
     * Chromium holds the SingletonLock), which marks this persistent profile
     * as crashed - and a crashed profile resurrects the dead run's tabs on the
     * next launch. Every scrape leaves two or three pages open, so a few bad
     * nights compound into a wall of about:blank and stale bank tabs greeting
     * the next `npm run login`. Pruning here makes each launch deterministic:
     * one tab, blank, no matter what history the profile carries.
     */
    const pages = await browser.pages();
    for (const page of pages.slice(1)) await page.close().catch(() => {});
    if (pages[0] && pages[0].url() !== 'about:blank') {
      await pages[0].goto('about:blank').catch(() => {});
    }

    return browser;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/profile|SingletonLock|already running/i.test(message)) {
      throw new Error(
        `The browser profile for "${company}" is already in use. Close any window left open from ` +
          `"npm run login ${company}" (or delete ${path.join(userDataDir, 'SingletonLock')}) and try again.`,
      );
    }
    throw err;
  }
}

/**
 * Close the browser the way a person would: tabs first, then the window.
 *
 * Chromium continuously records the open tabs as the session to restore after
 * a crash, and with our kill-based safety net crashes are routine. Closing the
 * pages before the browser writes an empty session, so even a later hard kill
 * has nothing to resurrect beyond what that run itself opened. `browser.close()`
 * alone preserves the tabs - it reads as quitting, but to the session file it
 * is indistinguishable from "closed the window with everything still open".
 */
export async function closeBrowserCleanly(browser: Browser): Promise<void> {
  if (!browser.connected) return;
  try {
    for (const page of await browser.pages()) {
      await page.close().catch(() => {});
    }
  } catch {
    // Closing a page on a dying browser can throw; the close below still runs.
  }
  if (browser.connected) await browser.close();
}

/** Delete cookies/device tokens together with a removed connection. */
export function removeProfile(company: string): boolean {
  if (liveCompanies.has(company)) throw new Error(`Cannot remove profile for "${company}" while its browser is open`);
  const target = profileDirFor(company);
  const resolvedRoot = path.resolve(PROFILE_ROOT) + path.sep;
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot)) throw new Error('Refusing to remove a profile outside its root');
  if (!existsSync(resolvedTarget)) return false;
  rmSync(resolvedTarget, { recursive: true, force: true });
  return true;
}
