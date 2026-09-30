import { createHash } from 'node:crypto';
import { prisma } from './db.js';
import { ANOMALY_THRESHOLD } from './categorize.js';
import { addDays, startOfDay, toISODate } from './cycle.js';
import { isCardSettlement, reconcileSettlements } from './settlement-reconciliation.js';
import { normalizeCurrency } from './currency.js';
export interface QualityItem {
    key: string;
    kind: string;
    title: string;
    detail: string;
    amount: number;
    count: number;
    href: string;
    canResolve: boolean;
    evidence: Array<{
        id: string;
        description: string;
        amount: number;
        date: string;
    }>;
}
const keyOf = (kind: string, evidence: unknown) => createHash('sha256').update(JSON.stringify([kind, evidence])).digest('hex');
/** No automatic financial decisions: observations remain visible until reviewed. */
export async function qualityReport() {
    const today = new Date(), since = startOfDay(today);
    const day = since.getDate();
    since.setDate(1);
    since.setMonth(since.getMonth() - 3);
    since.setDate(Math.min(day, new Date(since.getFullYear(), since.getMonth() + 1, 0).getDate()));
    const [rows, decisions] = await Promise.all([
        // Purchase date must never truncate a statement being reconciled by charge date.
        prisma.transaction.findMany({ where: { OR: [
            { date: { gte: addDays(since, -3) } },
            { account: { type: 'credit_card' }, processedDate: { gte: since, lt: addDays(startOfDay(today), 1) } },
        ] }, include: { account: true, category: true }, orderBy: { date: 'desc' } }),
        prisma.qualityDecision.findMany(),
    ]);
    const resolved = new Set(decisions.map(d => d.key));
    const items: QualityItem[] = [];
    const add = (kind: string, title: string, detail: string, group: typeof rows, href: string, canResolve = true, net = false, context?: unknown) => {
        const evidence = group.map(t => ({ id: t.id, description: t.description, amount: t.amount, date: toISODate(t.date) }));
        const facts = group.map(t => [t.id, t.amount, t.categoryId, t.status, t.date.toISOString(), t.processedDate?.toISOString()]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const key = keyOf(kind, context === undefined ? facts : [facts, context]);
        if (resolved.has(key))
            return;
        items.push({ key, kind, title, detail, amount: net ? Math.abs(group.reduce((s, t) => s + t.amount, 0)) : group.reduce((s, t) => s + Math.abs(t.amount), 0), count: group.length, href, canResolve, evidence });
    };
    const recent = rows.filter(t => t.date >= since && toISODate(t.date) <= toISODate(today));
    for (const row of recent) {
        if (row.account.type !== 'bank' || row.categoryLocked || Math.abs(row.amount) < ANOMALY_THRESHOLD)
            continue;
        if (row.categoryId && !(row.category?.kind === 'excluded' && row.classificationSource === 'legacy'))
            continue;
        add('material', 'תנועה מהותית מחכה להכרעה', row.categoryId
            ? 'הסיווג הישן החריג את התנועה. יש לאשר אם זו העברה, הוצאה אמיתית או הכנסה.'
            : 'הסכום נכלל כרגע לפי כיוון התנועה. הסיווג עשוי לשנות משמעותית את הסיכום.', [row], `/transactions?transaction=${row.id}`, false);
    }
    const bank = recent.filter(t => t.account.type === 'bank' && t.status === 'completed');
    const { settlements, matchedBank } = reconcileSettlements(rows, since, today);
    for (const statement of settlements.filter(s => s.status === 'review')) {
        const group = rows.filter(t => t.account.type === 'credit_card' && t.status === 'completed' && t.processedDate
            && `${t.accountId}:${toISODate(t.processedDate)}:${normalizeCurrency(t.currency)}` === statement.id);
        if (group[0].account.lifecycle === 'active')
            add('unmatched_card', 'חיוב אשראי לבדיקה', `${statement.account} · ${statement.date}. ${statement.reason} הסכום הוא נטו, אחרי זיכויים.`, group, statement.href, true, true,
                [statement.currency, statement.bankId, statement.bankAmount, statement.bankDate, statement.reason]);
    }
    for (const t of bank.filter(t => t.category?.kind === 'transfer' && !matchedBank.has(t.id))) {
        add('transfer', isCardSettlement(t.description) ? 'תנועת חברת אשראי לבדיקה' : 'העברה שכדאי לאמת', isCardSettlement(t.description)
            ? 'התנועה בבנק אינה משויכת למחזור כרטיס תואם. ייתכן כרטיס נוסף, זיכוי נפרד או חיוב מאוחד.'
            : 'התנועה מסווגת כהעברה ולכן אינה נכללת בהוצאות או בהכנסות. אם זו העברה פנימית אפשר לאשר; אחרת יש לתקן את הסיווג.', [t], `/transactions?transaction=${t.id}`);
    }
    const unknown = recent.filter(t => !t.categoryId && Math.abs(t.amount) < ANOMALY_THRESHOLD);
    if (unknown.length)
        add('uncategorized', 'תנועות ללא קטגוריה', 'הסכומים נכללים לפי הכיוון, אבל החלוקה לקבוע ומשתנה עדיין חלקית.', unknown, `/transactions?category=none&start=${toISODate(since)}&end=${toISODate(new Date())}`, false);
    return { items: items.sort((a, b) => Number(b.kind === 'material') - Number(a.kind === 'material') || b.amount - a.amount), settlements, since: toISODate(since) };
}
export async function qualityItems(): Promise<QualityItem[]> { return (await qualityReport()).items; }
