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

/** Exact dates use the user's preferred Israeli DD/MM/YYYY format everywhere. */
export function fmtDayMonth(iso: string): string {
  return fmtDate(iso);
}

/** Compact form for axis ticks: 12,400 -> "12.4K" */
export function fmtCompact(agorot: number): string {
  const shekels = agorot / 100;
  const abs = Math.abs(shekels);
  if (abs >= 1000) {
    const k = shekels / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
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
