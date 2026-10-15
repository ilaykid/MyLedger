import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'myledger-insights-'));
writeFileSync(path.join(directory, 'test.db'), '');
process.env.DATABASE_URL = 'file:' + path.join(directory, 'test.db').replaceAll('\\', '/');

let db: typeof import('../src/db.js').prisma;
let insights: typeof import('../src/insights.js');

before(async () => {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });
  db = (await import('../src/db.js')).prisma;
  insights = await import('../src/insights.js');
});
after(async () => {
  await db?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.transaction.deleteMany();
  await db.account.deleteMany();
  await db.category.deleteMany();
});

async function fixture() {
  const account = await db.account.create({
    data: { institution: 'fixture', displayName: 'כרטיס', type: 'card', lastFour: '0000', scrapedAt: new Date() },
  });
  const groceries = await db.category.create({ data: { name: 'סופר', kind: 'variable' } });
  const spend = (date: Date, amount: number, description = 'מכולת השכונה') =>
    db.transaction.create({
      data: {
        accountId: account.id, categoryId: groceries.id, amount: -amount, date, description,
        descriptionRaw: description, dedupHash: crypto.randomUUID(),
      },
    });
  return { spend };
}

test('a normal month of many small purchases is not "higher than usual"', async () => {
  const { spend } = await fixture();
  const now = new Date();
  // Four earlier months and this one: ten ₪150 runs in the first days of each.
  for (let back = 4; back >= 0; back--) {
    for (let i = 0; i < 10; i++) {
      await spend(new Date(now.getFullYear(), now.getMonth() - back, 1, 9, i), 150_00);
    }
  }
  const found = await insights.generateInsights(7);
  assert.equal(
    found.some((i) => i.kind === 'category_jump'),
    false,
    'this month equals every earlier month; comparing it to one purchase made it look 10x',
  );
});

test('a look back at a finished month sees nothing after it', async () => {
  const { spend } = await fixture();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // History, so new-merchant detection has something to compare against.
  for (let back = 5; back >= 2; back--) await spend(new Date(now.getFullYear(), now.getMonth() - back, 3), 100_00);
  await spend(new Date(now.getFullYear(), now.getMonth() - 1, 12), 300_00, 'חנות שהייתה בחודש שעבר');
  await spend(new Date(now.getFullYear(), now.getMonth(), 1, 12), 300_00, 'חנות מהחודש הנוכחי');

  const lastMonth = await insights.generateInsights(27, monthStart);
  const merchants = lastMonth.filter((i) => i.kind === 'new_merchant').map((i) => i.merchant);
  assert.ok(merchants.includes('חנות שהייתה בחודש שעבר'));
  assert.ok(!merchants.includes('חנות מהחודש הנוכחי'), 'the current month leaked into last month\'s summary');
});
