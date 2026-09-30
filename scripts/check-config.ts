/**
 * Validates accounts.config.json WITHOUT ever printing a credential value.
 * Reports only: which providers are configured, whether the field names match
 * what the scraper expects, and whether any placeholder was left behind.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SCRAPERS } from 'israeli-bank-scrapers';

const configPath = path.resolve(process.cwd(), 'accounts.config.json');

interface Entry {
  company: string;
  displayName?: string;
  credentials: Record<string, string>;
}

function main() {
  let parsed: { accounts?: Entry[] };
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`Cannot read ${configPath}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }

  const accounts = parsed.accounts ?? [];
  if (accounts.length === 0) {
    console.error('No accounts configured.');
    process.exitCode = 1;
    return;
  }

  let problems = 0;

  for (const a of accounts) {
    const known = a.company in SCRAPERS;
    const expected: string[] = known
      ? ((SCRAPERS as Record<string, { loginFields: string[] }>)[a.company].loginFields ?? [])
      : [];
    const given = Object.keys(a.credentials ?? {});

    // Never log values - only key names and a coarse shape check.
    const missing = expected.filter((f) => !given.includes(f));
    const extra = given.filter((f) => !expected.includes(f));
    const placeholders = Object.entries(a.credentials ?? {})
      .filter(([, v]) => /^YOUR_|^LAST_6_/.test(String(v)))
      .map(([k]) => k);
    const empty = Object.entries(a.credentials ?? {})
      .filter(([, v]) => String(v).trim() === '')
      .map(([k]) => k);

    const ok = known && missing.length === 0 && placeholders.length === 0 && empty.length === 0;
    if (!ok) problems++;

    console.log(`${ok ? '✓' : '✗'} ${a.company}${a.displayName ? ` (${a.displayName})` : ''}`);
    if (!known) console.log(`    unknown company id`);
    else {
      console.log(`    expects: ${expected.join(', ')}`);
      console.log(`    given:   ${given.join(', ')} ${given.map((g) => `${g}=${'•'.repeat(6)}`).length ? '' : ''}`);
      if (missing.length) console.log(`    MISSING: ${missing.join(', ')}`);
      if (extra.length) console.log(`    ignored: ${extra.join(', ')}`);
      if (placeholders.length) console.log(`    STILL A PLACEHOLDER: ${placeholders.join(', ')}`);
      if (empty.length) console.log(`    EMPTY: ${empty.join(', ')}`);
    }
  }

  console.log(
    `\n${accounts.length} account(s) configured, ${problems} with problems.` +
      (problems === 0 ? ' Ready to scrape.' : ' Fix the above before scraping.'),
  );
  if (problems > 0) process.exitCode = 1;
}

main();
