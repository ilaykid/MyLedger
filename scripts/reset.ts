/**
 * Clear scraped data so a real account can start from a clean slate.
 *   npm run reset            wipe accounts + transactions + recurring,
 *                            KEEP categories and rules (your configuration)
 *   npm run reset -- all     also wipe categories and rules (the starter set
 *                            comes back on the next dashboard start)
 *   ... force                required when real, scraped accounts exist
 *
 * Keeping categories and rules by default is deliberate: they are the work you
 * have put in, and they make freshly scraped transactions categorise themselves
 * on arrival instead of landing in one undifferentiated pile.
 *
 * The usual reason to run this is clearing the demo household before
 * connecting real accounts - so demo data goes without a word, and real
 * history (which cannot always be scraped again) needs an explicit `force`.
 */
import { prisma } from '../src/db.js';

/** The accounts prisma/seed.ts creates. Anything else was scraped. */
const DEMO_ACCOUNTS = new Set(['hapoalim:4471', 'max:5216', 'isracard:8830']);

async function main() {
  // Bare words as well as flags: npm can swallow `--flags` (see src/index.ts).
  const has = (word: string) => process.argv.includes(word) || process.argv.includes(`--${word}`);
  const wipeConfig = has('all');

  const real = (await prisma.account.findMany({ select: { institution: true, lastFour: true, displayName: true } }))
    .filter((a) => !DEMO_ACCOUNTS.has(`${a.institution}:${a.lastFour}`));
  if (real.length && !has('force')) {
    console.error(
      `\nRefusing: this would permanently delete ${real.length} real account(s) and their history:\n` +
        real.map((a) => `  - ${a.displayName}`).join('\n') +
        '\n\nOld periods may not be available to scrape again. Take a backup first (npm run backup),\n' +
        'then, if you are sure:  npm run reset -- force\n',
    );
    process.exitCode = 1;
    return;
  }

  const before = {
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    recurring: await prisma.recurringExpense.count(),
    categories: await prisma.category.count(),
    rules: await prisma.categoryRule.count(),
  };

  console.log('Before:', before);

  // Order matters: recurring and transactions reference accounts/categories.
  await prisma.recurringExpense.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.account.deleteMany();

  if (wipeConfig) {
    await prisma.categoryRule.deleteMany();
    await prisma.category.deleteMany();
  }

  const after = {
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    recurring: await prisma.recurringExpense.count(),
    categories: await prisma.category.count(),
    rules: await prisma.categoryRule.count(),
  };

  console.log('After: ', after);
  console.log(
    wipeConfig
      ? '\nEverything cleared. The starter categories return the next time the dashboard starts.'
      : `\nData cleared; kept ${after.categories} categories and ${after.rules} rules so new transactions categorise on arrival.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
