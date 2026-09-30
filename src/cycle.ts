/**
 * The cash-flow cycle - the single most important concept in this system.
 *
 * Money does not arrive on the 1st of the month, it arrives on payday. So every
 * number in the dashboard is framed around a cycle that STARTS on payday
 * (`cycleAnchorDay`) rather than around the calendar month. A cycle anchored on
 * the 9th runs 9 Jul -> 8 Aug inclusive.
 *
 * All dates here are local-midnight `Date` objects; `end` is exclusive.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface Cycle {
  /** 0 = the cycle containing "now", -1 = the previous one, +1 = the next one */
  offset: number;
  /** inclusive */
  start: Date;
  /** exclusive - equals the next cycle's start */
  end: Date;
  anchorDay: number;
  totalDays: number;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** An anchor of 31 has to mean "28" in February. */
export function clampDay(year: number, monthIndex: number, day: number): number {
  return Math.min(Math.max(1, day), daysInMonth(year, monthIndex));
}

/** Move to the anchor day `months` away from `base`, clamped to that month's length. */
function anchorAtMonthOffset(base: Date, months: number, anchorDay: number): Date {
  const raw = base.getMonth() + months;
  const year = base.getFullYear() + Math.floor(raw / 12);
  const monthIndex = ((raw % 12) + 12) % 12;
  return new Date(year, monthIndex, clampDay(year, monthIndex, anchorDay));
}

/** The most recent anchor date at or before `date`. */
function anchorOnOrBefore(date: Date, anchorDay: number): Date {
  const thisMonth = new Date(
    date.getFullYear(),
    date.getMonth(),
    clampDay(date.getFullYear(), date.getMonth(), anchorDay),
  );
  return date >= thisMonth ? thisMonth : anchorAtMonthOffset(thisMonth, -1, anchorDay);
}

export function cycleFor(date: Date, anchorDay: number, offset = 0): Cycle {
  const current = anchorOnOrBefore(startOfDay(date), anchorDay);
  const start = offset === 0 ? current : anchorAtMonthOffset(current, offset, anchorDay);
  const end = anchorAtMonthOffset(start, 1, anchorDay);
  return {
    offset,
    start,
    end,
    anchorDay,
    totalDays: Math.round((end.getTime() - start.getTime()) / DAY_MS),
  };
}

/**
 * The single date inside `cycle` that falls on day-of-month `day`.
 * A cycle spans two calendar months, so exactly one of them contains it.
 */
export function dateInCycleForDay(cycle: Cycle, day: number): Date | null {
  for (const monthOffset of [0, 1]) {
    const raw = cycle.start.getMonth() + monthOffset;
    const year = cycle.start.getFullYear() + Math.floor(raw / 12);
    const monthIndex = ((raw % 12) + 12) % 12;
    const candidate = new Date(year, monthIndex, clampDay(year, monthIndex, day));
    if (candidate >= cycle.start && candidate < cycle.end) return candidate;
  }
  return null;
}

/**
 * A monotonically increasing integer identifying the cycle a date falls in.
 * Consecutive cycles differ by exactly 1, which makes period detection
 * ("every cycle" vs "every other cycle") plain integer arithmetic.
 */
export function cycleOrdinal(date: Date, anchorDay: number): number {
  const { start } = cycleFor(date, anchorDay);
  return start.getFullYear() * 12 + start.getMonth();
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Whole days between two local-midnight dates. */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS);
}

/**
 * A stable "merchant signature" used to group repeated charges: lowercase,
 * digits removed (card suffixes, invoice numbers, dates) and punctuation
 * stripped, keeping letters only. Unicode-aware so Hebrew survives.
 */
export function signatureOf(description: string): string {
  return description
    .toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
