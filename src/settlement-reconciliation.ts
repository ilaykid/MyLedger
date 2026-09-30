import { dayDiff, toISODate } from './cycle.js';
import { normalizeCurrency } from './currency.js';

export interface SettlementRow {
    id: string; accountId: string; amount: number; currency: string; status: string;
    date: Date; processedDate: Date | null; description: string;
    account: { type: string; institution: string; displayName: string; lastFour: string; lifecycle: string };
}
export interface Settlement {
    id: string; account: string; date: string; currency: string; count: number;
    cardAmount: number; bankAmount: number | null; difference: number | null;
    bankId: string | null; bankDate: string | null; href: string;
    status: 'matched' | 'review' | 'balanced'; reason: string;
}
const issuers = [
    { institution: 'visaCal', pattern: /כאל|דיינרס|\bcal\b|\bdiners\b/i },
    { institution: 'isracard', pattern: /ישראכרט|\bisracard\b/i },
    { institution: 'max', pattern: /מקס|לאומי קארד|\bmax\b/i },
];
export function isCardSettlement(description: string) { return issuers.some(i => i.pattern.test(description)); }
function sameIssuer(card: SettlementRow, bank: SettlementRow) {
    const issuer = issuers.find(i => i.institution.toLowerCase() === card.account.institution.toLowerCase());
    if (!issuer?.pattern.test(bank.description)) return false;
    // Issuers sometimes identify the card in a leading four-digit label.
    const explicitCard = bank.description.match(/^\s*(\d{4})\s*[-–]/)?.[1];
    return !explicitCard || explicitCard === card.account.lastFour;
}
/** Match complete signed statement totals, with no bank row reused or ambiguous guesses. */
export function reconcileSettlements(rows: SettlementRow[], since: Date, today: Date) {
    const groups = new Map<string, SettlementRow[]>();
    for (const row of rows) {
        if (row.account.type !== 'credit_card' || row.status !== 'completed' || !row.processedDate
            || row.processedDate < since || toISODate(row.processedDate) > toISODate(today)) continue;
        const key = `${row.accountId}:${toISODate(row.processedDate)}:${normalizeCurrency(row.currency)}`;
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    const bank = rows.filter(r => r.account.type === 'bank' && r.status === 'completed' && toISODate(r.date) <= toISODate(today));
    const candidates = [...groups].map(([id, group]) => {
        const first = group[0], total = group.reduce((sum, r) => sum + r.amount, 0);
        const nearby = bank.filter(b => normalizeCurrency(b.currency) === normalizeCurrency(first.currency) && sameIssuer(first, b)
            && Math.sign(b.amount) === Math.sign(total) && Math.abs(dayDiff(first.processedDate!, b.date)) <= 3);
        return { id, group, first, total, nearby, exact: nearby.filter(b => b.amount === total) };
    });
    const matchedBank = new Set<string>();
    const settlements: Settlement[] = candidates.map(c => {
        // Even equal totals are ambiguous when two cards can consume the same bank debit.
        const match = c.exact.length === 1 && candidates.filter(other => other.exact.some(b => b.id === c.exact[0].id)).length === 1 ? c.exact[0] : null;
        if (match) matchedBank.add(match.id);
        const comparison = match ?? (c.nearby.length === 1 ? c.nearby[0] : null);
        const status = c.total === 0 ? 'balanced' : match ? 'matched' : 'review';
        return { id: c.id, account: c.first.account.displayName, date: toISODate(c.first.processedDate!), currency: normalizeCurrency(c.first.currency),
            count: c.group.length, cardAmount: c.total, bankAmount: comparison?.amount ?? null,
            difference: comparison ? c.total - comparison.amount : null, bankId: comparison?.id ?? null,
            bankDate: comparison ? toISODate(comparison.date) : null,
            href: `/transactions?account=${c.first.accountId}&chargeDate=${toISODate(c.first.processedDate!)}&status=completed&currency=${encodeURIComponent(normalizeCurrency(c.first.currency))}`,
            status, reason: status === 'balanced' ? 'החיובים והזיכויים בכרטיס מתקזזים לאפס.' : match
                ? (toISODate(match.date) === toISODate(c.first.processedDate!) ? 'התאמה מלאה בסכום, במטבע ובחברת האשראי.' : 'התאמה מלאה בסכום ובחברת האשראי; תאריך הרישום בבנק שונה בעד שלושה ימים.')
                : c.exact.length ? 'קיימת יותר מאפשרות אחת לשיוך החיוב. נדרשת בדיקה.'
                : comparison ? 'נמצאה תנועת בנק אפשרית מאותה חברת אשראי, אך הסכומים שונים. השיוך טרם אומת.'
                : 'לא נמצאה תנועה יחידה תואמת בבנק. ייתכן חיוב מאוחד או מידע חסר.' };
    });
    return { settlements: settlements.sort((a, b) => b.date.localeCompare(a.date) || a.account.localeCompare(b.account)), matchedBank, groups };
}
