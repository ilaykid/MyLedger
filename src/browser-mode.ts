import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

/** Re-read only this setting so a running server picks up changes before syncing. */
export function readShowBrowser(envPath: string, fallback = process.env.SCRAPER_SHOW_BROWSER): boolean {
  let value = fallback;
  try {
    value = parse(readFileSync(envPath)).SCRAPER_SHOW_BROWSER ?? fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (value == null || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`SCRAPER_SHOW_BROWSER in ${envPath} must be true or false`);
}
