import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { coveredCycle, dataState } from '../src/forecast-policy.js';
const directory = mkdtempSync(path.join(tmpdir(), 'myledger-review-'));
writeFileSync(path.join(directory, 'test.db'), '');
process.env.DATABASE_URL = 'file:' + path.join(directory, 'test.db').replaceAll('\\', '/');
let db: typeof import('../src/db.js').prisma;
let changes: typeof import('../src/changes.js');
let review: typeof import('../src/server/review.js');
let categorize: typeof import('../src/categorize.js');
let recurring: typeof import('../src/recurring.js');
let cashflow: typeof import('../src/cashflow.js');
let quality: typeof import('../src/finance-quality.js');
before(async () => {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/db.js')).prisma;
    changes = await import('../src/changes.js');
    review = await import('../src/server/review.js');
    categorize = await import('../src/categorize.js');
    recurring = await import('../src/recurring.js');
    cashflow = await import('../src/cashflow.js');
    quality = await import('../src/finance-quality.js');
});
after(async () => { await db?.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
beforeEach(async () => { await db.financialChange.deleteMany(); await db.qualityDecision.deleteMany(); await db.recurringExpense.deleteMany(); await db.transaction.deleteMany(); await db.account.deleteMany(); await db.categoryRule.deleteMany(); await db.category.deleteMany(); });
async function account() { return db.account.create({ data: { institution: 'fixture', displayName: 'בדיקה', type: 'bank', lastFour: '0000', balance: 100000, scrapedAt: new Date(), balanceAt: new Date() } }); }
async function transaction(accountId: string, amount = -1000, date = new Date(), description = 'בדיקת תנועה') { return db.transaction.create({ data: { accountId, amount, date, description, descriptionRaw: description, dedupHash: crypto.randomUUID() } }); }
test('coverage excludes partial account histories and distinguishes failed sources', () => {
    const start = new Date('2026-01-01'), end = new Date('2026-02-01');
    const a = { lifecycle: 'active', coverageFrom: start, coverageThrough: end };
    assert.equal(coveredCycle([a], start, end), true);
    assert.equal(coveredCycle([a, { ...a, coverageFrom: new Date('2026-01-15') }], start, end), false);
    assert.equal(coveredCycle([], start, end), false);
    assert.equal(dataState([{ kind: 'provider_stale', severity: 'error' }]), 'stale');
    assert.equal(dataState([{ kind: 'missing_balance', severity: 'error' }]), 'unavailable');
    assert.equal(dataState([], 0.01), 'partial');
});
test('large unknown bank amounts remain included and require a review decision', async () => {
    const a = await account(), t = await transaction(a.id, -3000000);
    await categorize.applyCategoryRules();
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: t.id } })).categoryId, null);
    assert.equal(cashflow.classify({ amount: t.amount, account: a, category: null }), 'variable');
    assert.ok((await quality.qualityItems()).some(i => i.kind === 'material' && i.evidence.some(e => e.id === t.id)));
});
test('undo restores financial edits atomically and refuses to overwrite later choices', async () => {
    const a = await account(), t = await transaction(a.id), c = await db.category.create({ data: { name: 'אוכל', kind: 'variable' } });
    const changed = await changes.withChange('test', async (_db, change) => change('transaction', t.id, { categoryId: c.id, categoryLocked: true, classificationSource: 'manual', categorizedAt: new Date() }));
    await changes.undoChange(changed.changeId!);
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: t.id } })).categoryId, null);
    const second = await changes.withChange('test', async (_db, change) => change('transaction', t.id, { note: 'first' }));
    await db.transaction.update({ where: { id: t.id }, data: { note: 'later' } });
    await assert.rejects(changes.undoChange(second.changeId!), changes.ChangeConflict);
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: t.id } })).note, 'later');
    await assert.rejects(changes.withChange('atomic', async (_db, change) => { await change('transaction', t.id, { note: 'rollback' }); throw new Error('stop'); }));
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: t.id } })).note, 'later');
});
test('rule preview is read only and manual selections survive automatic categorization', async () => {
    const a = await account(), one = await transaction(a.id), two = await transaction(a.id), c = await db.category.create({ data: { name: 'קטגוריה', kind: 'variable' } });
    await db.transaction.update({ where: { id: two.id }, data: { categoryLocked: true } });
    await db.categoryRule.create({ data: { pattern: 'בדיקת', categoryId: c.id, priority: 10 } });
    const preview = await categorize.applyCategoryRules({ preview: true });
    assert.equal(preview.categorized, 1);
    assert.equal(await db.financialChange.count(), 0);
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: one.id } })).categoryId, null);
    const applied = await categorize.applyCategoryRules();
    assert.equal(applied.categorized, 1);
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: two.id } })).categoryId, null);
    await changes.undoChange(applied.changeId!);
    assert.equal((await db.transaction.findUniqueOrThrow({ where: { id: one.id } })).categoryId, null);
});
test('recurring matches never cross account or payment direction; manual contracts accept corrections', async () => {
    const a = await account(), signature = recurring.recurringSignature(a.id, 'מנוי', -5000), r = { accountId: a.id, signature, direction: 'expense', displayName: 'מנוי' };
    assert.ok(recurring.recurringMatches({ accountId: a.id, description: 'מנוי', amount: -5000 }, r));
    assert.equal(recurring.recurringMatches({ accountId: 'other', description: 'מנוי', amount: -5000 }, r), false);
    assert.equal(recurring.recurringMatches({ accountId: a.id, description: 'מנוי', amount: 5000 }, r), false);
    const saved = await review.saveRecurring(null, { displayName: 'מנוי', accountId: a.id, categoryId: null, direction: 'expense', expectedAmount: -5000, expectedDay: 12, frequency: 'monthly', active: true, validFrom: null, validUntil: null });
    assert.equal(saved.source, 'manual');
    await assert.rejects(review.saveRecurring(null, { displayName: 'שגוי', accountId: a.id, categoryId: null, direction: 'expense', expectedAmount: 5000, expectedDay: 12, frequency: 'monthly', validFrom: null, validUntil: null }));
});
test('accrual drilldowns and pace recognize the same spread slices in both months', async () => {
    const a = await account(), now = new Date(), prior = new Date(now.getFullYear(), now.getMonth() - 1, 1), t = await transaction(a.id, -12000, prior);
    await db.spreadPlan.create({ data: { transactionId: t.id, months: 3, offsetMonths: 0 } });
    const current = await cashflow.cashflowSnapshot();
    assert.equal(current.variable.spent, 4000);
    assert.equal(current.pace?.previousSpendAtSameDay, 4000);
    assert.equal(current.pace?.currentSpend, 4000);
    const rows = await review.searchTransactions({ start: current.cycle.start, end: current.cycle.lastDay, includeSpread: 'true', flow: 'variable' });
    assert.equal(rows.summary.expense, current.variable.spent);
    assert.equal(rows.items[0].amount, -12000);
    assert.equal(rows.items[0].contribution, -4000);
    assert.equal(current.forecastCoverage.usableCycles, 0);
    await assert.rejects(review.searchTransactions({ start: '2026-02-31' }));
    await assert.rejects(review.searchTransactions({ start: '2026-02-10', end: '2026-02-01' }));
});
test('balance reconstruction aligns each bank to its observation day', async () => {
    const a = await account(), now = new Date(), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    await db.account.update({ where: { id: a.id }, data: { balance: 100000, balanceAt: yesterday } });
    await transaction(a.id, 12300, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const snap = await cashflow.cashflowSnapshot();
    assert.equal(snap.bankBalance, 100000);
    assert.equal(snap.timeline.filter(p => p.actual).at(-1)?.balance, 112300);
});
test('bulk preview is read-only and a batch with a missing transaction is atomic',async()=>{
 const Fastify=(await import('fastify')).default,app=Fastify();await review.registerReviewRoutes(app);
 try{const a=await account(),t=await transaction(a.id),c=await db.category.create({data:{name:'בדיקה',kind:'variable'}});
 const preview=await app.inject({method:'POST',url:'/api/transactions/bulk',payload:{ids:[t.id],categoryId:c.id,preview:true}});assert.equal(preview.statusCode,200);assert.equal(preview.json().count,1);assert.equal((await db.transaction.findUniqueOrThrow({where:{id:t.id}})).categoryId,null);
 const failed=await app.inject({method:'POST',url:'/api/transactions/bulk',payload:{ids:[t.id,'missing'],categoryId:c.id}});assert.ok(failed.statusCode>=400);assert.equal((await db.transaction.findUniqueOrThrow({where:{id:t.id}})).categoryId,null);
 const saved=await app.inject({method:'POST',url:'/api/transactions/bulk',payload:{ids:[t.id],categoryId:c.id}});assert.equal(saved.statusCode,200);await changes.undoChange(saved.json().changeId);assert.equal((await db.transaction.findUniqueOrThrow({where:{id:t.id}})).categoryId,null);
 }finally{await app.close()}
});
test('changed evidence reopens a resolved transfer; pending card charges are not mismatches',async()=>{
 const a=await account(),t=await transaction(a.id),c=await db.category.create({data:{name:'העברה',kind:'transfer'}});await db.transaction.update({where:{id:t.id},data:{categoryId:c.id}});
 const item=(await quality.qualityItems()).find(i=>i.kind==='transfer')!;await db.qualityDecision.create({data:{key:item.key,note:'בדיקה תקינה'}});assert.equal((await quality.qualityItems()).some(i=>i.key===item.key),false);
 await db.transaction.update({where:{id:t.id},data:{amount:-2000}});assert.ok((await quality.qualityItems()).some(i=>i.kind==='transfer'&&i.key!==item.key));
 const card=await db.account.create({data:{type:'credit_card',displayName:'כרטיס בדיקה',lastFour:'0001',institution:'fixture'}});const pending=await transaction(card.id);await db.transaction.update({where:{id:pending.id},data:{status:'pending',processedDate:new Date()}});assert.equal((await quality.qualityItems()).some(i=>i.kind==='unmatched_card'),false);
});

test('quality query retrieves full statements even when purchases predate the review window', async () => {
    const bank = await account(), now = new Date(), chargeDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
    const oldDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const card = await db.account.create({ data: { type: 'credit_card', displayName: 'כאל בדיקה', lastFour: '2222', institution: 'visaCal' } });
    const category = await db.category.create({ data: { name: 'העברה', kind: 'transfer' } });
    const purchase = await transaction(card.id, -120000, oldDate), refund = await transaction(card.id, 10000, chargeDate);
    await db.transaction.updateMany({ where: { id: { in: [purchase.id, refund.id] } }, data: { processedDate: chargeDate } });
    const debit = await transaction(bank.id, -110000, chargeDate, 'הרשאה דיינרס');
    await db.transaction.update({ where: { id: debit.id }, data: { categoryId: category.id } });
    const report = await quality.qualityReport();
    assert.equal(report.settlements.length, 1);
    assert.equal(report.settlements[0].status, 'matched');
    assert.equal(report.settlements[0].cardAmount, -110000);
    assert.equal(report.settlements[0].count, 2);
    assert.equal(report.items.some(i => ['unmatched_card', 'transfer'].includes(i.kind)), false);
    const pending = await transaction(card.id, -800, chargeDate), foreign = await transaction(card.id, -900, chargeDate);
    await db.transaction.update({where:{id:pending.id},data:{processedDate:chargeDate,status:'pending'}});
    await db.transaction.update({where:{id:foreign.id},data:{processedDate:chargeDate,currency:'USD'}});
    await db.transaction.update({where:{id:purchase.id},data:{currency:'₪'}});
    const drilldown = await review.searchTransactions({accountId:card.id,chargeDate:report.settlements[0].date,status:'completed',currency:'ILS'});
    assert.equal(drilldown.total, 2);
    assert.deepEqual(new Set(drilldown.items.map(t=>t.id)), new Set([purchase.id,refund.id]));
    await db.transaction.update({ where: { id: debit.id }, data: { amount: -110001 } });
    const changed = await quality.qualityReport();
    assert.equal(changed.items.find(i => i.kind === 'unmatched_card')?.amount, 110000);
    assert.equal(changed.settlements.find(s=>s.currency==='ILS')?.difference, 1);
});
test('detector separates identical merchant names across accounts and directions',async()=>{
 const a=await account(),b=await account(),now=new Date();for(let m=1;m<=3;m++){const date=new Date(now.getFullYear(),now.getMonth()-m,10);await transaction(a.id,-5000,date,'מנוי בדיקה');await transaction(a.id,10000,date,'מנוי בדיקה');await transaction(b.id,-3000,date,'מנוי בדיקה');}
 await recurring.detectRecurring();assert.equal(await db.recurringExpense.count(),3);
 const first=await db.recurringExpense.findFirstOrThrow({where:{accountId:a.id,direction:'expense'}});await review.saveRecurring(first.id,{displayName:first.displayName,accountId:a.id,categoryId:null,direction:'expense',expectedAmount:-7000,expectedDay:15,frequency:'monthly',active:true,validFrom:null,validUntil:null});await recurring.detectRecurring();assert.equal(await db.recurringExpense.count(),3);assert.equal((await db.recurringExpense.findUniqueOrThrow({where:{id:first.id}})).expectedAmount,-7000);
});
