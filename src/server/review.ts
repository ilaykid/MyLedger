import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { withChange, undoChange, ChangeConflict } from '../changes.js';
import { qualityItems, qualityReport } from '../finance-quality.js';
import { normalizeCurrency } from '../currency.js';
import { ruleMatches } from '../categorize.js';
import { compileSafeRegex } from '../safe-regex.js';
import { classify, cashflowSnapshot, monthlyHistory } from '../cashflow.js';
import { slicesFor } from '../spread.js';
import { monthRange } from '../month.js';
import { planKeyFor } from '../installments.js';
import { signatureOf, toISODate, cycleOrdinal } from '../cycle.js';
import { getSettings } from '../recurring.js';
import { analyseSyncHealth } from '../sync-health.js';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(new Date(s).getTime()) && new Date(s).toISOString().slice(0, 10) === s);
export const recurringSchema = z.object({
    displayName: z.string().trim().min(2).max(120),
    direction: z.enum(['income', 'expense']), expectedAmount: z.number().int().refine(n => n !== 0 && Math.abs(n) <= 1000000000),
    expectedDay: z.number().int().min(1).max(31), frequency: z.enum(['monthly', 'bimonthly']),
    accountId: z.string().nullable(), categoryId: z.string().nullable(), active: z.boolean().default(true),
    validFrom: date.nullable(), validUntil: date.nullable(),
});
export async function saveRecurring(id: string | null, input: unknown) {
    const body = recurringSchema.parse(input);
    if ((body.direction === 'expense') !== (body.expectedAmount < 0))
        throw new ChangeConflict('כיוון התנועה אינו מתאים לסימן הסכום.');
    if (body.validFrom && body.validUntil && body.validUntil < body.validFrom)
        throw new ChangeConflict('תאריך הסיום קודם לתאריך ההתחלה.');
    if (body.accountId) {
        const signature = body.accountId + '|' + body.direction + '|' + signatureOf(body.displayName);
        const existing = await prisma.recurringExpense.findUnique({ where: { signature } });
        if (existing && existing.id !== id)
            throw new ChangeConflict('כבר קיימת התחייבות בשם זה באותו חשבון ובאותו כיוון. ערכו את ההתחייבות הקיימת.');
    }
    return withChange(id ? 'עדכון התחייבות' : 'הוספת התחייבות', async (_db, change) => change('recurringExpense', id, {
        ...body, source: id ? 'confirmed' : 'manual',
        signature: body.accountId ? body.accountId + '|' + body.direction + '|' + signatureOf(body.displayName) : 'manual:' + randomUUID(),
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        ...(!id ? { occurrences: 0, lastSeen: new Date(body.validFrom ?? Date.now()) } : {}),
    }));
}
export async function searchTransactions(input: unknown) {
    const q = z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/).optional(), accountId: z.string().optional(), categoryId: z.string().optional(),
        transaction: z.string().optional(), uncategorized: z.string().optional(), includeSpread: z.string().optional(),
        start: date.optional(), end: date.optional(), chargeDate: date.optional(), status: z.enum(['pending', 'completed']).optional(), currency: z.string().min(1).max(12).optional(),
        min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(),
        flow: z.enum(['fixed', 'variable', 'income', 'transfer', 'excluded', 'savings']).optional(), q: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(input);
    if (q.start && q.end && q.end < q.start)
        throw new ChangeConflict('טווח התאריכים אינו תקין.');
    if (q.min != null && q.max != null && q.min > q.max)
        throw new ChangeConflict('הסכום המינימלי גדול מהמקסימלי.');
    const range = q.month ? monthRange(q.month) : null;
    const start = q.start ? new Date(q.start + 'T00:00:00') : range?.start;
    const end = q.end ? new Date(new Date(q.end + 'T00:00:00').getTime() + 86400000) : range?.end;
    const [rows, notes, rules] = await Promise.all([
        prisma.transaction.findMany({ where: {
                ...(q.transaction ? { id: q.transaction } : {}), ...(q.accountId ? { accountId: q.accountId } : {}),
                ...(q.uncategorized === 'true' ? { categoryId: null } : q.categoryId ? { categoryId: q.categoryId } : {}),
                ...(q.status ? { status: q.status } : {}), ...(q.q ? { description: { contains: q.q } } : {}),
            }, include: { account: { select: { id: true, displayName: true, type: true } }, category: true, spread: true }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
        prisma.note.findMany(), prisma.categoryRule.findMany({ orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] }),
    ]);
    const inRange = (d: Date) => (!start || d >= start) && (!end || d < end);
    const filtered = rows.flatMap(t => {
        if (q.currency && normalizeCurrency(t.currency) !== normalizeCurrency(q.currency)) return [];
        const flow = classify(t);
        if (q.flow && !(q.flow === 'income' ? flow.startsWith('income') : flow === q.flow))
            return [];
        if (q.chargeDate && (!t.processedDate || toISODate(t.processedDate) !== q.chargeDate))
            return [];
        if ((q.min != null && Math.abs(t.amount) < q.min) || (q.max != null && Math.abs(t.amount) > q.max))
            return [];
        let contribution = t.amount;
        if ((start || end) && q.includeSpread === 'true' && t.spread) {
            const slices = slicesFor({ ...t.spread, transaction: t }).filter(s => inRange(s.date));
            if (!slices.length)
                return [];
            contribution = slices.reduce((sum, s) => sum + s.amount, 0);
        }
        else if (!inRange(t.date))
            return [];
        const planKey = planKeyFor(t);
        const matched = rules.filter(r => ruleMatches(r, t.description));
        const source = t.categoryLocked ? 'manual' : t.classificationSource;
        return [{ ...t, contribution, flow, planKey,
                planNote: notes.find(n => n.scope === 'plan' && n.key === planKey)?.note ?? null,
                merchantNote: notes.find(n => n.scope === 'merchant' && n.key === signatureOf(t.description))?.note ?? null,
                explanation: source === 'manual' ? 'סווג ידנית; חוקים אוטומטיים לא ידרסו את הבחירה.' : source === 'rule'
                    ? `סווג לפי חוק: ${rules.find(r => r.id === t.classificationRuleId)?.pattern ?? 'החוק אינו קיים עוד'}`
                    : t.categoryId ? 'סיווג קודם; המקור לא תועד. ניתן לאשר או לתקן.' : 'ללא סיווג: ההשפעה נקבעת לפי כיוון התנועה וסוג החשבון.',
                matchingRules: matched.map(r => ({ id: r.id, pattern: r.pattern, priority: r.priority })),
            }];
    });
    return { items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length, page: q.page, pageSize: q.pageSize,
        summary: { income: filtered.reduce((s, t) => s + Math.max(0, t.contribution), 0), expense: filtered.reduce((s, t) => s + Math.max(0, -t.contribution), 0), net: filtered.reduce((s, t) => s + t.contribution, 0), basis: q.includeSpread === 'true' ? 'accrual' : 'transactions' } };
}
export async function registerReviewRoutes(app: FastifyInstance) {
    app.get('/api/quality', async () => ({ ...await qualityReport(), decisions: await prisma.qualityDecision.findMany({ orderBy: { createdAt: 'desc' } }) }));
    app.post('/api/quality/resolve', async (req) => {
        const b = z.object({ key: z.string().length(64), note: z.string().trim().min(3).max(500) }).parse(req.body);
        const item = (await qualityItems()).find(i => i.key === b.key);
        if (!item?.canResolve)
            throw new ChangeConflict('הממצא השתנה או דורש תיקון סיווג. רעננו את הרשימה.');
        return prisma.qualityDecision.create({ data: b });
    });
    app.delete('/api/quality/:key', async (req) => {
        const { key } = z.object({ key: z.string().length(64) }).parse(req.params);
        await prisma.qualityDecision.deleteMany({ where: { key } });
        return { ok: true };
    });
    app.get('/api/changes', async () => prisma.financialChange.findMany({ take: 30, orderBy: { createdAt: 'desc' }, select: { id: true, title: true, createdAt: true, undoneAt: true } }));
    app.post('/api/changes/:id/undo', async (req) => undoChange(z.object({ id: z.string() }).parse(req.params).id));
    app.post('/api/transactions/bulk', async (req) => {
        const b = z.object({ ids: z.array(z.string()).min(1).max(200), categoryId: z.string().nullable(), preview: z.boolean().default(false) }).parse(req.body);
        const ids = [...new Set(b.ids)];
        if (b.preview) {
            const rows = await prisma.transaction.findMany({ where: { id: { in: ids } }, include: { category: true } });
            return { count: rows.length, amount: rows.reduce((s, t) => s + t.amount, 0), samples: rows.slice(0, 8) };
        }
        return withChange('סיווג תנועות', async (db, change) => {
            if (b.categoryId && !(await db.category.findUnique({ where: { id: b.categoryId } })))
                throw new ChangeConflict('הקטגוריה כבר אינה קיימת.');
            for (const id of ids)
                await change('transaction', id, { categoryId: b.categoryId, categoryLocked: b.categoryId !== null, classificationSource: b.categoryId ? 'manual' : 'unassigned', classificationRuleId: null, categorizedAt: new Date() });
            return { count: ids.length };
        });
    });
    app.post('/api/rules/preview', async (req) => {
        const b = z.object({ id: z.string().optional(), pattern: z.string().min(1).max(200), matchType: z.enum(['contains', 'regex']), priority: z.number().int(), categoryId: z.string() }).parse(req.body);
        if (b.matchType === 'regex')
            compileSafeRegex(b.pattern);
        const [rows, rules] = await Promise.all([prisma.transaction.findMany({ include: { category: true } }), prisma.categoryRule.findMany({ orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] })]);
        const candidate = { ...b, id: b.id ?? 'preview' };
        const matched = rows.filter(t => ruleMatches(candidate, t.description));
        return { count: matched.length, locked: matched.filter(t => t.categoryLocked).length, conflicts: matched.filter(t => rules.some(r => r.id !== b.id && r.categoryId !== b.categoryId && r.priority >= b.priority && ruleMatches(r, t.description))).length, amount: matched.reduce((s, t) => s + Math.abs(t.amount), 0), samples: matched.slice(0, 10) };
    });
    app.patch('/api/rules/:id', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const b = z.object({ pattern: z.string().min(1).max(200), matchType: z.enum(['contains', 'regex']), priority: z.number().int(), categoryId: z.string() }).parse(req.body);
        if (b.matchType === 'regex')
            compileSafeRegex(b.pattern);
        return withChange('עריכת חוק', async (_db, change) => change('categoryRule', id, b));
    });
    app.post('/api/categories/:id/preview', async (req) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        const rows = await prisma.transaction.findMany({ where: { categoryId: id } });
        return { count: rows.length, amount: rows.reduce((s, t) => s + Math.abs(t.amount), 0), samples: rows.slice(0, 8) };
    });
    app.post('/api/recurring', async (req) => saveRecurring(null, req.body));
    app.get('/api/recurring/status', async () => {
        const settings = await getSettings();
        const now = new Date();
        return (await prisma.recurringExpense.findMany({ include: { account: true, category: true }, orderBy: { expectedDay: 'asc' } })).map(r => ({ ...r,
            forecastState: !r.active ? 'inactive' : r.validFrom && toISODate(r.validFrom) > toISODate(now) ? 'future' : r.validUntil && toISODate(r.validUntil) < toISODate(now) ? 'expired' : r.source === 'detected' && cycleOrdinal(now, settings.cycleAnchorDay) - cycleOrdinal(r.lastSeen, settings.cycleAnchorDay) >= (r.frequency === 'bimonthly' ? 4 : 2) ? 'stale' : 'active',
        }));
    });
    app.get('/api/forecast-history', async () => {
        const today = toISODate(new Date());
        const actuals = new Map<string, number>();
        const records = await prisma.forecastRecord.findMany({ orderBy: { asOf: 'desc' }, take: 90 });
        const result = [];
        for (const r of records) {
            const key = r.cycleStart + '/' + r.cycleEnd;
            if (r.cycleEnd < today && !actuals.has(key)) {
                // Sum each cashflow family with the same outflow-only policy as the dashboard.
                const families = await Promise.all(['income', 'fixed', 'variable'].map(flow => searchTransactions({ start: r.cycleStart, end: r.cycleEnd, includeSpread: 'true', flow })));
                actuals.set(key, Math.max(0, families[0].summary.net) - families[1].summary.expense - Math.max(0, -families[2].summary.net));
            }
            const actualNet = actuals.get(key) ?? null;
            result.push({ ...r, actualNet, error: actualNet === null ? null : r.predictedNet - actualNet });
        }
        return result;
    });
    app.post('/api/forecast-history', async () => {
        const [snap, health] = await Promise.all([cashflowSnapshot(), analyseSyncHealth()]);
        const data = { cycleStart: snap.cycle.start, cycleEnd: snap.cycle.lastDay, asOf: toISODate(new Date()), predictedNet: snap.projectedNet, basisCycles: snap.forecastCoverage.usableCycles, quality: health.reliability.status };
        // Keep the first observation each day; later edits cannot silently rewrite history.
        return prisma.forecastRecord.upsert({ where: { cycleStart_asOf: { cycleStart: data.cycleStart, asOf: data.asOf } }, create: data, update: {} });
    });
}
