/** Proves every monthly headline equals the corresponding by-category view. */
import { monthlyHistory } from '../src/cashflow.js';
import { monthlyBreakdown } from '../src/breakdown.js';
import { prisma } from '../src/db.js';

const history = await monthlyHistory(24);
let failed = 0;
for (const row of history) {
  const breakdown = await monthlyBreakdown(row.month);
  const fields = [
    ['income', row.income, breakdown.income.total],
    ['expense', row.expense, breakdown.expense.total],
    ['net', row.net, breakdown.net],
  ] as const;
  for (const [field, headline, byCategory] of fields) {
    if (headline === byCategory) continue;
    console.error(`✗ ${row.month} ${field}: headline=${headline}, categories=${byCategory}`);
    failed++;
  }
}
if (!failed) console.log(`✓ ${history.length} months: headline, categories and net agree to the agora`);
await prisma.$disconnect();
if (failed) process.exitCode = 1;
