import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
const directory = mkdtempSync(path.join(tmpdir(), 'myledger-rule-apply-'));
writeFileSync(path.join(directory, 'test.db'), '');
process.env.DATABASE_URL = 'file:' + path.join(directory, 'test.db').replaceAll('\\', '/');
let db: typeof import('../src/db.js').prisma;
let changes: typeof import('../src/changes.js');
let review: typeof import('../src/server/review.js');
let categorize: typeof import('../src/categorize.js');
before(async () => {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/db.js')).prisma;
    changes = await import('../src/changes.js');
    review = await import('../src/server/review.js');
    categorize = await import('../src/categorize.js');
});
after(async () => { await db?.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
beforeEach(async () => { await db.financialChange.deleteMany(); await db.transaction.deleteMany(); await db.account.deleteMany(); await db.categoryRule.deleteMany(); await db.category.deleteMany(); });
async function account() { return db.account.create({ data: { institution: 'fixture', displayName: 'בדיקה', type: 'bank', lastFour: '0000', balance: 100000, scrapedAt: new Date(), balanceAt: new Date() } }); }
async function transaction(accountId: string, description: string, amount = -1000) { return db.transaction.create({ data: { accountId, amount, date: new Date(), description, descriptionRaw: description, dedupHash: crypto.randomUUID() } }); }
const category = (name: string, kind = 'variable') => db.category.create({ data: { name, kind } });
const categoryOf = async (id: string) => (await db.transaction.findUniqueOrThrow({ where: { id } })).categoryId;

test('applying one rule fills only its own rows, counts exactly, and undoes', async () => {
    const a = await account(), food = await category('אוכל'), fuel = await category('דלק');
    const mine = await transaction(a.id, 'שופרסל דיל'), mine2 = await transaction(a.id, 'שופרסל אקספרס');
    const other = await transaction(a.id, 'פז תחנת דלק');
    const locked = await transaction(a.id, 'שופרסל אונליין');
    await db.transaction.update({ where: { id: locked.id }, data: { categoryLocked: true } });
    const done = await transaction(a.id, 'שופרסל ישן');
    await db.transaction.update({ where: { id: done.id }, data: { categoryId: fuel.id } });
    // Another rule that a full apply would also run.
    await db.categoryRule.create({ data: { pattern: 'פז', categoryId: fuel.id, priority: 10 } });
    const rule = await db.categoryRule.create({ data: { pattern: 'שופרסל', categoryId: food.id, priority: 10 } });

    const preview = await categorize.applySingleRule(rule.id, { preview: true });
    assert.equal(preview.categorized, 2);
    assert.equal(await db.financialChange.count(), 0);

    const result = await categorize.applySingleRule(rule.id);
    assert.equal(result.categorized, 2);
    assert.equal(await categoryOf(mine.id), food.id);
    assert.equal(await categoryOf(mine2.id), food.id);
    assert.equal(await categoryOf(other.id), null, 'other rules must not run');
    assert.equal(await categoryOf(locked.id), null, 'manual locks are respected');
    assert.equal(await categoryOf(done.id), fuel.id, 'existing classifications are kept');
    const row = await db.transaction.findUniqueOrThrow({ where: { id: mine.id } });
    assert.equal(row.classificationSource, 'rule');
    assert.equal(row.classificationRuleId, rule.id);

    await changes.undoChange(result.changeId!);
    assert.equal(await categoryOf(mine.id), null);
    assert.equal(await categoryOf(mine2.id), null);
});

test('a stronger rule for another category keeps its rows, and the rule preview reports the same exact count', async () => {
    const a = await account(), food = await category('אוכל'), pharm = await category('פארם');
    const plain = await transaction(a.id, 'שופרסל דיל'), contested = await transaction(a.id, 'שופרסל BE פארם');
    await db.categoryRule.create({ data: { pattern: 'BE', categoryId: pharm.id, priority: 20 } });
    const app = Fastify();
    await review.registerReviewRoutes(app);
    const preview = await app.inject({ method: 'POST', url: '/api/rules/preview', payload: { pattern: 'שופרסל', matchType: 'contains', priority: 10, categoryId: food.id } });
    assert.equal(preview.json().claimable, 1);
    const rule = await db.categoryRule.create({ data: { pattern: 'שופרסל', categoryId: food.id, priority: 10 } });
    const applied = await app.inject({ method: 'POST', url: `/api/rules/${rule.id}/apply`, payload: {} });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().categorized, 1);
    assert.equal(await categoryOf(plain.id), food.id);
    assert.equal(await categoryOf(contested.id), null);
    await app.close();
});

test('applying a rule that no longer exists is a conflict, not a crash', async () => {
    await assert.rejects(categorize.applySingleRule('missing'), changes.ChangeConflict);
});

test('the summary can leave internal transfers out while the list keeps them', async () => {
    const a = await account(), transfer = await category('העברה', 'transfer');
    await transaction(a.id, 'קניה', -1000);
    await transaction(a.id, 'משכורת', 5000);
    const moved = await transaction(a.id, 'העברה לחיסכון', -3000);
    await db.transaction.update({ where: { id: moved.id }, data: { categoryId: transfer.id } });

    const all = await review.searchTransactions({});
    assert.equal(all.total, 3);
    assert.deepEqual([all.summary.income, all.summary.expense, all.summary.net], [5000, 4000, 1000]);

    const net = await review.searchTransactions({ summaryTransfers: 'exclude' });
    assert.equal(net.total, 3, 'transfer rows stay in the list');
    assert.ok(net.items.some(t => t.id === moved.id));
    assert.deepEqual([net.summary.income, net.summary.expense, net.summary.net], [5000, 1000, 4000]);
    assert.equal(net.summary.transfersExcluded, true);

    // Filtering to a flow means the user asked for exactly those rows' totals.
    const onlyTransfers = await review.searchTransactions({ summaryTransfers: 'exclude', flow: 'transfer' });
    assert.equal(onlyTransfers.summary.expense, 3000);
    assert.equal(onlyTransfers.summary.transfersExcluded, false);
    await assert.rejects(review.searchTransactions({ summaryTransfers: 'maybe' }));
});
