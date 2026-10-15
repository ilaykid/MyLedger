import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SCRAPERS } from 'israeli-bank-scrapers';
import { prisma } from '../db.js';
import { CONFIG_PATH } from '../config.js';
import { isProtected, protect } from '../secrets.js';
import { hasProfile, removeProfile } from '../browser.js';
import { runScrapeAll, type ScrapeResult } from '../scrape-runner.js';
import { applyCategoryRules } from '../categorize.js';
import { detectRecurring } from '../recurring.js';
import { toISODate } from '../cycle.js';
import { safeErrorMessage } from '../redact.js';

/**
 * Everything the Connections page needs, so the whole system is usable without
 * a terminal.
 *
 * SECURITY: credentials are write-only across this boundary. They come in, get
 * sealed with DPAPI before anything is written, and are never sent back - the
 * API only ever reports *whether* a field is set and encrypted.
 */

const PROVIDERS = SCRAPERS as Record<string, { name: string; loginFields: string[] }>;
const CREDIT_CARD_COMPANIES = new Set(['visaCal', 'max', 'isracard', 'amex', 'behatsdaa']);

interface ConfigFile {
  accounts: Array<{ company: string; displayName?: string; credentials: Record<string, string> }>;
  [key: string]: unknown;
}

function readConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return { accounts: [] };
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ConfigFile;
  parsed.accounts ??= [];
  return parsed;
}

/**
 * Write-then-rename, so a crash mid-write leaves the old file intact instead
 * of a truncated one - losing this file means re-entering every credential.
 */
function writeConfig(config: ConfigFile): void {
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(temp, CONFIG_PATH);
}

/** Own keys only: `__proto__` or `constructor` must never resolve to a provider. */
function providerFor(company: string) {
  return Object.hasOwn(PROVIDERS, company) ? PROVIDERS[company] : undefined;
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, meta]) => ({
    id,
    name: meta.name,
    loginFields: meta.loginFields,
    type: CREDIT_CARD_COMPANIES.has(id) ? ('credit_card' as const) : ('bank' as const),
  }));
}

export async function listConnections() {
  const config = readConfig();
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: 'asc' } });

  const stats = new Map<
    string,
    { transactions: number; first: Date | null; last: Date | null; float: number }
  >();

  for (const account of accounts) {
    const [count, first, last, floating] = await Promise.all([
      prisma.transaction.count({ where: { accountId: account.id } }),
      prisma.transaction.findFirst({ where: { accountId: account.id }, orderBy: { date: 'asc' }, select: { date: true } }),
      prisma.transaction.findFirst({ where: { accountId: account.id }, orderBy: { date: 'desc' }, select: { date: true } }),
      prisma.transaction.findMany({
        where: { accountId: account.id, processedDate: { gt: new Date() } },
        select: { amount: true },
      }),
    ]);
    stats.set(account.id, {
      transactions: count,
      first: first?.date ?? null,
      last: last?.date ?? null,
      float: floating.reduce((s, t) => s + -t.amount, 0),
    });
  }

  return config.accounts.map((entry) => {
    const meta = providerFor(entry.company);
    const providerAccounts = accounts.filter((a) => a.institution === entry.company);
    const credentialFields = Object.entries(entry.credentials ?? {}).map(([field, value]) => ({
      field,
      encrypted: isProtected(value),
    }));

    return {
      company: entry.company,
      providerName: meta?.name ?? entry.company,
      displayName: entry.displayName ?? meta?.name ?? entry.company,
      type: CREDIT_CARD_COMPANIES.has(entry.company) ? 'credit_card' : 'bank',
      known: !!meta,
      expectedFields: meta?.loginFields ?? [],
      credentialFields,
      allEncrypted: credentialFields.length > 0 && credentialFields.every((f) => f.encrypted),
      hasBrowserProfile: hasProfile(entry.company),
      accounts: providerAccounts.map((a) => {
        const s = stats.get(a.id);
        return {
          id: a.id,
          lifecycle: a.lifecycle,
          balanceAt: a.balanceAt,
          coverageFrom: a.coverageFrom,
          coverageThrough: a.coverageThrough,
          displayName: a.displayName,
          lastFour: a.lastFour,
          type: a.type,
          balance: a.balance,
          billingDay: a.billingDay,
          scrapedAt: a.scrapedAt ? a.scrapedAt.toISOString() : null,
          transactions: s?.transactions ?? 0,
          firstTransaction: s?.first ? toISODate(s.first) : null,
          lastTransaction: s?.last ? toISODate(s.last) : null,
          float: s?.float ?? 0,
        };
      }),
    };
  });
}

/** Accounts in the database whose provider is no longer in the config. */
export async function listOrphanAccounts() {
  const config = readConfig();
  const configured = new Set(config.accounts.map((a) => a.company));
  const accounts = await prisma.account.findMany();
  const orphans = accounts.filter((a) => !configured.has(a.institution));
  // The count is what a delete would destroy, so the confirmation can say it.
  const counts = await Promise.all(
    orphans.map((a) => prisma.transaction.count({ where: { accountId: a.id } })),
  );
  return orphans.map((a, i) => ({
    id: a.id,
    institution: a.institution,
    displayName: a.displayName,
    lastFour: a.lastFour,
    lifecycle: a.lifecycle,
    transactions: counts[i],
  }));
}

export async function upsertConnection(input: {
  company: string;
  displayName?: string;
  credentials: Record<string, string>;
}): Promise<{ created: boolean }> {
  const meta = providerFor(input.company);
  if (!meta) throw new Error(`Unknown provider "${input.company}"`);

  const missing = meta.loginFields.filter((f) => !input.credentials[f]?.trim());
  if (missing.length > 0) {
    throw new Error(`${input.company} requires: ${missing.join(', ')}`);
  }

  // Seal every value before it can reach the disk.
  const sealed: Record<string, string> = {};
  for (const field of meta.loginFields) {
    sealed[field] = await protect(input.credentials[field].trim());
  }

  const config = readConfig();
  const existing = config.accounts.findIndex((a) => a.company === input.company);
  const entry = {
    company: input.company,
    displayName: input.displayName?.trim() || meta.name,
    credentials: sealed,
  };

  if (existing >= 0) config.accounts[existing] = entry;
  else config.accounts.push(entry);

  writeConfig(config);
  return { created: existing < 0 };
}

export function removeConnection(company: string): { removed: boolean; profileRemoved: boolean } {
  const config = readConfig();
  const before = config.accounts.length;
  config.accounts = config.accounts.filter((a) => a.company !== company);
  if (config.accounts.length === before) return { removed: false, profileRemoved: false };
  writeConfig(config);
  return { removed: true, profileRemoved: removeProfile(company) };
}

// ------------------------------------------------------------------ scraping

export interface ScrapeJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  companies: string[];
  startedAt: string;
  finishedAt: string | null;
  log: string[];
  failures: number;
  error: string | null;
  /** One entry per provider attempted, so the page can explain each outcome. */
  results: ScrapeResult[];
}

let currentJob: ScrapeJob | null = null;

export function getScrapeJob(): ScrapeJob | null {
  return currentJob;
}

/**
 * Kick off a scrape and return immediately; the page polls for progress.
 * Only one runs at a time - concurrent scrapes would fight over the same
 * browser profile directory.
 */
export function startScrape(companies: string[]): ScrapeJob {
  if (currentJob?.status === 'running') return currentJob;

  const job: ScrapeJob = {
    id: `job_${Date.now()}`,
    status: 'running',
    companies,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
    failures: 0,
    error: null,
    results: [],
  };
  currentJob = job;

  void (async () => {
    try {
      // Someone pressed a button, so run now. The per-provider interval exists
      // to keep the *scheduled* job from logging in more often than it needs
      // to - it should not make a deliberate click do nothing.
      job.failures = await runScrapeAll({
        only: companies.length ? companies : undefined,
        force: true,
        label: 'דשבורד',
        onLog: (line) => {
          job.log.push(line);
          if (job.log.length > 200) job.log.shift();
        },
        onResult: (result) => {
          job.results.push(result);
        },
      });

      job.log.push('מסווג תנועות חדשות…');
      const cat = await applyCategoryRules();
      job.log.push(cat.categorized === 1 ? 'תנועה אחת סווגה' : `${cat.categorized} תנועות סווגו`);

      job.log.push('מזהה הוצאות קבועות…');
      const rec = await detectRecurring();
      job.log.push(`${rec.detected} הוצאות קבועות מזוהות`);

      job.status = job.failures > 0 ? 'failed' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = safeErrorMessage(err);
      job.log.push(`שגיאה: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}
