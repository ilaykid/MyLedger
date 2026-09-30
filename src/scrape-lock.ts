import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Cross-process mutual exclusion for scraping.
 *
 * The API already refuses to start a second scrape while one of its own is
 * running - but that guard lives in a module variable, so it only knows about
 * the API process. Scraping actually has three independent entry points:
 *
 *   npm run scrape          the CLI
 *   npm run scheduler       the long-running cron process
 *   the "משיכה" button      inside the API process
 *
 * and Windows Task Scheduler fires the first one on its own timetable. Two of
 * them overlapping is not theoretical: the nightly task at 10:00 lands on a
 * button press often enough to matter. When it happens they fight over the
 * Chromium profile directory (whoever loses gets a SingletonLock error) and
 * write to the same SQLite file concurrently, which is a BUSY error at best.
 *
 * A lockfile is the right primitive here because the participants are separate
 * processes: `wx` makes creation atomic at the filesystem level, so there is no
 * check-then-write window for two starts to slip through.
 */

const LOCK_PATH = path.resolve(process.cwd(), '.scrape.lock');

/**
 * A scrape of every provider takes minutes, not hours. Past this age the holder
 * is assumed dead in a way that left the file behind - a hard power cut, say,
 * where the pid check below can be fooled by a reused pid.
 */
const MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

interface LockInfo {
  pid: number;
  startedAt: string;
  /** What was running, so the error message can say something useful */
  label: string;
}

/** Thrown instead of running, so callers can report rather than queue. */
export class ScrapeLockedError extends Error {
  constructor(readonly holder: LockInfo) {
    const since = new Date(holder.startedAt);
    const minutes = Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
    super(
      `משיכה כבר רצה (${holder.label}, תהליך ${holder.pid}, התחילה לפני ${minutes} דקות). ` +
        `שתי משיכות במקביל נלחמות על אותו פרופיל דפדפן ועל אותו קובץ DB, ולכן הריצה הזו לא התחילה.`,
    );
    this.name = 'ScrapeLockedError';
  }
}

/**
 * Is that pid still around? Signal 0 performs the permission and existence
 * checks without delivering anything. EPERM means the process exists but
 * belongs to someone else, which still counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, label: parsed.label ?? 'לא ידוע' };
  } catch {
    // Missing, truncated, or half-written - either way there is no usable holder.
    return null;
  }
}

/** A lock is stale when its owner is gone, or when it is older than any real run. */
function isStale(lock: LockInfo): boolean {
  if (!isAlive(lock.pid)) return true;
  return Date.now() - new Date(lock.startedAt).getTime() > MAX_LOCK_AGE_MS;
}

function tryCreate(info: LockInfo): boolean {
  try {
    writeFileSync(LOCK_PATH, JSON.stringify(info, null, 2), { flag: 'wx', encoding: 'utf-8' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Run `fn` while holding the scrape lock, or throw ScrapeLockedError if another
 * process holds it. The lock is released even if `fn` throws.
 *
 * Not re-entrant on purpose: nothing here nests, and a counter would need to be
 * per-process state that the whole point of this file is to avoid trusting.
 */
export async function withScrapeLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const mine: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), label };

  if (!tryCreate(mine)) {
    const holder = readLock();

    // An unreadable lock file is treated as stale: it means a previous run was
    // killed mid-write, and refusing forever on a corrupt file would be worse.
    if (holder && !isStale(holder)) throw new ScrapeLockedError(holder);

    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* someone else cleaned it up first - the retry below settles it */
    }
    if (!tryCreate(mine)) {
      const winner = readLock();
      throw new ScrapeLockedError(winner ?? { pid: -1, startedAt: mine.startedAt, label: 'לא ידוע' });
    }
  }

  try {
    return await fn();
  } finally {
    // Only remove a lock we still own. If it was stolen as stale while we were
    // running, deleting it would unlock someone else's live scrape.
    const current = readLock();
    if (current?.pid === process.pid && current.startedAt === mine.startedAt) {
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        /* already gone */
      }
    }
  }
}
