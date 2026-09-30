import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
type Model = 'transaction' | 'categoryRule' | 'category' | 'recurringExpense' | 'account';
type Values = Record<string, unknown>;
interface Change {
    model: Model;
    id: string;
    before: Values | null;
    after: Values | null;
}
// Only these fields can be restored. Credentials and provider observations are
// deliberately outside the journal, so undo never rolls back a bank sync.
const fields: Record<Model, string[]> = {
    transaction: ['categoryId', 'categoryLocked', 'classificationSource', 'classificationRuleId', 'categorizedAt', 'note'],
    categoryRule: ['pattern', 'matchType', 'priority', 'categoryId'],
    category: ['name', 'color', 'icon', 'kind', 'monthlyBudget'],
    recurringExpense: ['signature', 'displayName', 'direction', 'expectedAmount', 'expectedDay', 'frequency', 'accountId', 'categoryId', 'active', 'source', 'validFrom', 'validUntil', 'lastSeen', 'occurrences', 'amountSpread'],
    account: ['lifecycle', 'displayName', 'billingDay'],
};
interface Delegate {
    findUnique(args: {
        where: {
            id: string;
        };
    }): Promise<Values | null>;
    create(args: {
        data: Values;
    }): Promise<Values>;
    update(args: {
        where: {
            id: string;
        };
        data: Values;
    }): Promise<Values>;
    delete(args: {
        where: {
            id: string;
        };
    }): Promise<Values>;
}
function delegate(db: Prisma.TransactionClient, model: Model): Delegate {
    return db[model] as unknown as Delegate;
}
function pick(row: Values, keys: string[]) {
    return Object.fromEntries(keys.map(key => [key, row[key] ?? null]));
}
const serial = (value: unknown) => JSON.stringify(value);
export class ChangeConflict extends Error {
}
export async function withChange<T>(title: string, action: (db: Prisma.TransactionClient, change: (model: Model, id: string | null, data: Values | null) => Promise<Values>) => Promise<T>): Promise<T & {
    changeId: string | null;
}> {
    return prisma.$transaction(async (db) => {
        const changes: Change[] = [];
        const change = async (model: Model, id: string | null, data: Values | null) => {
            const repo = delegate(db, model);
            const original = id ? await repo.findUnique({ where: { id } }) : null;
            if (id && !original)
                throw new ChangeConflict('הפריט כבר אינו קיים. רעננו ונסו שוב.');
            const keys = !id || data === null ? fields[model] : fields[model].filter(k => k in data);
            const before = original ? pick(original, keys) : null;
            const row = !id ? await repo.create({ data: data! }) : data === null
                ? await repo.delete({ where: { id } }) : await repo.update({ where: { id }, data });
            const after = data === null ? null : pick(row, keys);
            if (serial(before) !== serial(after))
                changes.push({ model, id: String(row.id), before, after });
            return row;
        };
        const result = await action(db, change);
        const entry = changes.length ? await db.financialChange.create({ data: { title, payload: serial(changes) } }) : null;
        return { ...result, changeId: entry?.id ?? null };
    }, { timeout: 60000 });
}
export async function undoChange(id: string) {
    return prisma.$transaction(async (db) => {
        const entry = await db.financialChange.findUnique({ where: { id } });
        if (!entry || entry.undoneAt)
            throw new ChangeConflict('השינוי כבר בוטל או אינו קיים.');
        const changes = JSON.parse(entry.payload) as Change[];
        for (const c of [...changes].reverse()) {
            const repo = delegate(db, c.model);
            const current = await repo.findUnique({ where: { id: c.id } });
            if (c.after ? !current || serial(pick(current, Object.keys(c.after))) !== serial(c.after) : !!current) {
                throw new ChangeConflict('הנתונים השתנו מאז. הביטול נעצר כדי לשמור על התיקונים החדשים.');
            }
            if (!c.before && c.model === 'category' && await db.transaction.count({ where: { categoryId: c.id } }))
                throw new ChangeConflict('הקטגוריה כבר נמצאת בשימוש. יש להסיר שיוכים לפני ביטול יצירתה.');
            if (!c.before && c.model === 'categoryRule') {
                const touched = changes.filter(x => x.model === 'transaction').map(x => x.id);
                if (await db.transaction.count({ where: { classificationRuleId: c.id, id: { notIn: touched } } })) {
                    throw new ChangeConflict('החוק כבר סיווג תנועות חדשות. יש לבדוק אותן לפני ביטול יצירת החוק.');
                }
            }
            if (!c.before)
                await repo.delete({ where: { id: c.id } });
            else if (!c.after)
                await repo.create({ data: { id: c.id, ...c.before } });
            else
                await repo.update({ where: { id: c.id }, data: c.before });
        }
        await db.financialChange.update({ where: { id }, data: { undoneAt: new Date() } });
        return { ok: true };
    }, { timeout: 60000 });
}
