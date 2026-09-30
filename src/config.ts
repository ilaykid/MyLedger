import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import 'dotenv/config';
import { isProtected, unprotectAll } from './secrets.js';
import { dataPath } from './paths.js';
import { readShowBrowser } from './browser-mode.js';

const AccountConfigSchema = z.object({
  company: z.string().min(1),
  displayName: z.string().optional(),
  credentials: z.record(z.string(), z.string()),
  /**
   * Minimum hours between scrapes of this provider. Skipped if it was scraped
   * more recently than this, unless the run is forced.
   *
   * Login FREQUENCY is the one behavioural signal that plausibly matters to a
   * bank - the time of day does not, and neither does jitter around it. A bank
   * account's useful content (salary, standing orders, balance) changes a
   * handful of times a month, so a weekly login there costs almost nothing in
   * freshness while cutting logins by 85%. Cards genuinely change daily and are
   * far more tolerant, so they stay daily.
   *
   * Defaults: 20 hours for cards, 48 for banks. See defaultEveryHours.
   */
  everyHours: z.number().int().min(1).max(24 * 30).optional(),
});

const ConfigSchema = z.object({
  accounts: z.array(AccountConfigSchema).min(1),
});

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export interface AppConfig {
  accounts: AccountConfig[];
  monthsBack: number;
  showBrowser: boolean;
  /** true when at least one credential was stored encrypted */
  encrypted: boolean;
}

export const CONFIG_PATH = dataPath('accounts.config.json');

/** Parse the file without touching credentials - used by tooling that must not decrypt. */
export function readRawConfig(): z.infer<typeof ConfigSchema> {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy accounts.config.example.json to accounts.config.json and fill in your credentials.`,
    );
  }
  return ConfigSchema.parse(JSON.parse(raw));
}

/**
 * Load the config, decrypting any DPAPI-protected credential on the way.
 * Plaintext values still work, so an unencrypted config keeps running - but
 * `npm run secure` will encrypt it in place.
 */
export async function loadConfig(): Promise<AppConfig> {
  const parsed = readRawConfig();

  const encrypted = parsed.accounts.some((a) => Object.values(a.credentials).some(isProtected));

  const accounts: AccountConfig[] = [];
  for (const account of parsed.accounts) {
    accounts.push({ ...account, credentials: await unprotectAll(account.credentials) });
  }

  return {
    accounts,
    monthsBack: Number(process.env.SCRAPE_MONTHS_BACK ?? 3),
    showBrowser: readShowBrowser(process.env.DOTENV_CONFIG_PATH ?? dataPath('.env')),
    encrypted,
  };
}
