import { SCRAPERS } from 'israeli-bank-scrapers';
import { runScrapeAll } from './scrape-runner.js';
import { applyCategoryRules } from './categorize.js';
import { detectRecurring } from './recurring.js';
import { prisma } from './db.js';

/**
 * Scrape CLI.
 *   npm run scrape                every provider that is due
 *   npm run scrape -- visaCal     one provider (runs regardless of interval)
 *   npm run scrape -- visaCal max several
 *   npm run scrape -- force       every provider, ignoring intervals
 *
 * Arguments are BARE WORDS, not flags. npm's own parser eats `--anything` even
 * after `--`: it silently swallowed `--only`, then `--preview`, then
 * `--company`, each time leaving the script to run with no arguments and do the
 * wrong thing quietly. Positional words survive intact, so the CLI matches
 * company ids by name and treats `force` as a keyword.
 *
 * `--company` is still honoured for direct `npx tsx src/index.ts` use.
 */
function parseArgs(argv: string[]): { companies?: string[]; force: boolean } {
  const force = argv.includes('force') || argv.includes('--force');
  const known = new Set(Object.keys(SCRAPERS));
  const companies = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // --company visaCal  /  --company=visaCal  (direct invocation only)
    if (arg === '--company' || arg.startsWith('--company=')) {
      const raw = arg.includes('=') ? arg.split('=').slice(1).join('=') : argv[++i];
      for (const c of (raw ?? '').split(',')) if (c.trim()) companies.add(c.trim());
      continue;
    }
    if (arg.startsWith('-') || arg === 'force') continue;

    // A bare word: accept it only if it names a real provider, so a typo is a
    // loud error rather than a silent full run.
    for (const part of arg.split(',')) {
      const id = part.trim();
      if (!id) continue;
      if (!known.has(id)) {
        throw new Error(`Unknown provider "${id}". Valid: ${[...known].join(', ')}`);
      }
      companies.add(id);
    }
  }

  return { companies: companies.size ? [...companies] : undefined, force };
}

async function main() {
  const { companies, force } = parseArgs(process.argv.slice(2));
  const failures = await runScrapeAll({ only: companies, force, label: 'שורת פקודה' });

  const catStats = await applyCategoryRules();
  if (catStats.categorized > 0) {
    console.log(`\nAuto-categorized ${catStats.categorized} new transaction(s).`);
  }

  // Recurring detection needs a few cycles of history; harmless before that.
  const recStats = await detectRecurring();
  console.log(`Recurring charges known: ${recStats.detected}`);

  await prisma.$disconnect();

  if (failures > 0) {
    console.error(`\nDone with ${failures} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log('\nDone. Check the dashboard, then run "npm run audit".');
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
