const ilsFull = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const ilsRound = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
});

/** agorot -> "₪1,234.56" */
export const fmtILS = (agorot: number) => ilsFull.format(agorot / 100);
/** agorot -> "₪1,235" (charts, tiles) */
export const fmtILSRound = (agorot: number) => ilsRound.format(agorot / 100);

const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
const monthShortFmt = new Intl.DateTimeFormat('he-IL', { month: 'short' });

/** "2026-07" -> "יולי 2026" */
export function fmtMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return monthFmt.format(new Date(y, m - 1, 1));
}

/** "2026-07" -> "יולי" */
export function fmtMonthShort(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return monthShortFmt.format(new Date(y, m - 1, 1));
}

export function fmtDate(iso: string): string {
  const date = new Date(iso);
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');
}

export function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** A date-only ISO string is a calendar day, not UTC midnight: read it locally. */
function parseDay(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

/**
 * Short Israeli date: "15/09". The year is appended only when it is not the
 * current one ("15/09/2025"), so this cycle's dates stay compact.
 */
export function fmtDayMonth(iso: string): string {
  const date = parseDay(iso);
  const short = String(date.getDate()).padStart(2, '0') + '/' + String(date.getMonth() + 1).padStart(2, '0');
  return date.getFullYear() === new Date().getFullYear() ? short : `${short}/${date.getFullYear()}`;
}

/** Whole days from today to the given day (0 = today, 1 = tomorrow, -1 = yesterday). */
function daysFromToday(iso: string): number {
  const d = parseDay(iso), now = new Date();
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

/** Dates in upcoming lists: "היום" / "מחר", otherwise the short date. */
export function fmtRelativeDay(iso: string): string {
  const diff = daysFromToday(iso);
  return diff === 0 ? 'היום' : diff === 1 ? 'מחר' : fmtDayMonth(iso);
}

/** The same as a phrase after a noun: "היום" / "מחר" / "ב-15/10". */
export function fmtWhen(iso: string): string {
  const diff = daysFromToday(iso);
  return diff === 0 || diff === 1 ? fmtRelativeDay(iso) : `ב-${fmtDayMonth(iso)}`;
}

const timeFmt = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Data freshness: "עודכן היום 13:00" / "עודכן אתמול 08:00" / "עודכן ב-12/10". */
export function fmtUpdatedAt(iso: string): string {
  const diff = daysFromToday(iso);
  if (diff === 0) return `עודכן היום ${timeFmt.format(new Date(iso))}`;
  if (diff === -1) return `עודכן אתמול ${timeFmt.format(new Date(iso))}`;
  return `עודכן ב-${fmtDayMonth(iso)}`;
}

/**
 * Hebrew counts that agree: fmtCount(1, 'יום אחד', 'ימים') -> "יום אחד",
 * fmtCount(5, 'יום אחד', 'ימים') -> "5 ימים".
 */
export function fmtCount(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** Compact form for axis ticks: 12,400 -> "12.4 אלף", 1,250,000 -> "1.3 מיליון" */
export function fmtCompact(agorot: number): string {
  const shekels = agorot / 100;
  const abs = Math.abs(shekels);
  const short = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (abs >= 1_000_000) return `${short(shekels / 1_000_000)} מיליון`;
  if (abs >= 1000) return `${short(shekels / 1000)} אלף`;
  return String(Math.round(shekels));
}

const ilsSignedRound = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
});
const ilsSignedFull = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

/**
 * Signed, for deltas and incoming money: "+320 ₪" / "-320 ₪".
 *
 * The sign comes from Intl, never glued on by hand. Intl wraps a signed number
 * in direction marks (RLM, LRM, sign, digits), so "+" and "-" land in the same
 * place in a right-to-left line; a "+" prepended to an already formatted
 * amount floats to the far end instead and reads as "₪ 7,260+".
 */
export const fmtSigned = (agorot: number) => ilsSignedRound.format(agorot / 100);
export const fmtSignedFull = (agorot: number) => ilsSignedFull.format(agorot / 100);

/** Last N month keys, oldest first, ending at the current month. */
export function lastMonthKeys(n: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
