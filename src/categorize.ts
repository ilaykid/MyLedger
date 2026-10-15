import { prisma } from './db.js';
import { compileSafeRegex } from './safe-regex.js';
import { withChange, ChangeConflict } from './changes.js';

export interface CategorizeStats {
  scanned: number;
  categorized: number;
  changeId?: string | null;
}

interface RuleForMatch {
  id: string;
  pattern: string;
  matchType: string;
  priority: number;
  categoryId: string;
}

export function ruleMatches(rule: RuleForMatch, description: string): boolean {
  if (rule.matchType === 'regex') {
    try {
      return compileSafeRegex(rule.pattern).test(description.slice(0, 500));
    } catch {
      return false; // invalid user-supplied regex - never crash the engine
    }
  }
  return description.toLowerCase().includes(rule.pattern.toLowerCase());
}

/**
 * The part of a description worth turning into a rule.
 *
 * Card descriptions carry noise unique to a single charge - an invoice number,
 * a card suffix, a date, a branch code. A rule built from the whole string
 * matches exactly one transaction and is therefore worthless as a rule. Cutting
 * the description at every run of digits and keeping the longest surviving
 * piece leaves the merchant's name behind.
 *
 * The result is always a contiguous slice of the original (only whitespace and
 * punctuation are trimmed, and only from the ends), so a `contains` rule built
 * from it is guaranteed to still match the transaction it came from.
 *
 * Returns '' when nothing usable is left - the caller should not offer to make
 * a rule out of a description that is mostly numbers.
 */
export function merchantPattern(description: string): string {
  const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
  let best = '';
  for (const run of description.split(/\d+/)) {
    const trimmed = run.replace(/^[\s\p{P}\p{S}]+/u, '').replace(/[\s\p{P}\p{S}]+$/u, '');
    if (letters(trimmed) > letters(best)) best = trimmed;
  }
  return letters(best) >= 3 ? best : '';
}

/**
 * Apply category rules to transactions.
 * - Rules are evaluated by priority (desc); first match wins.
 * - Transactions with categoryLocked=true (manual user assignment) are never touched.
 * - By default only uncategorized transactions are scanned; pass
 *   recategorize=true to re-evaluate every unlocked transaction (e.g. after
 *   editing rules).
 */
export async function applyCategoryRules(opts?: { recategorize?: boolean; preview?: boolean }): Promise<CategorizeStats & { samples?: unknown[] }> {
  const rules = await prisma.categoryRule.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });

  const txns = await prisma.transaction.findMany({
    where: {
      categoryLocked: false,
      ...(opts?.recategorize ? {} : { categoryId: null }),
    },
    select: { id: true, description: true, categoryId: true, amount: true },
  });

  // Group updates by target category so we can use updateMany per category
  const idsByCategory = new Map<string, string[]>();
  let categorized = 0;

  for (const t of txns) {
    const match = rules.find((r) => ruleMatches(r, t.description));
    if (match && match.categoryId !== t.categoryId) {
      const list = idsByCategory.get(match.categoryId) ?? [];
      list.push(t.id);
      idsByCategory.set(match.categoryId, list);
      categorized++;
    }
  }

  const changed = txns.filter(t => [...idsByCategory.values()].some(ids => ids.includes(t.id)));
  if (opts?.preview) return { scanned: txns.length, categorized, samples: changed.slice(0, 12) };
  return withChange('החלת חוקי סיווג', async (db, change) => {
    let applied = 0;
    for (const t of changed) {
      const current = await db.transaction.findUnique({ where: { id: t.id } });
      if (!current || current.categoryLocked || current.categoryId !== t.categoryId) continue;
      const rule = rules.find(r => ruleMatches(r, current.description));
      if (!rule) continue;
      await change('transaction', t.id, { categoryId: rule.categoryId, classificationSource: 'rule', classificationRuleId: rule.id, categorizedAt: new Date() });
      applied++;
    }
    return { scanned: txns.length, categorized: applied };
  });
}

interface RankedRule extends RuleForMatch {
  createdAt: Date;
}

/** Engine order: higher priority first, then the older rule. */
function outranks(other: RankedRule, rule: RankedRule): boolean {
  return other.priority > rule.priority || (other.priority === rule.priority && other.createdAt < rule.createdAt);
}

/**
 * The existing rows one rule would take on its own: unlocked, still without a
 * category, matching it, and not also claimed by a stronger rule pointing to a
 * different category - the full engine would hand those to the stronger rule,
 * so taking them here would classify them differently than a re-run would.
 */
export function claimableBy<T extends { description: string; categoryId: string | null; categoryLocked: boolean }>(rule: RankedRule, rules: RankedRule[], txns: T[]): T[] {
  const stronger = rules.filter(r => r.id !== rule.id && r.categoryId !== rule.categoryId && outranks(r, rule));
  return txns.filter(t => !t.categoryLocked && t.categoryId === null && ruleMatches(rule, t.description) && !stronger.some(r => ruleMatches(r, t.description)));
}

/**
 * Apply one rule, and only that rule, to the uncategorised history.
 *
 * Creating a rule and then running every rule would let other rules fill rows
 * too, so the count shown afterwards could not be attributed to the new rule.
 * This never overrides a choice already made, and the returned count is
 * exactly what this rule did.
 */
export async function applySingleRule(ruleId: string, opts?: { preview?: boolean }): Promise<CategorizeStats & { samples?: unknown[] }> {
  const rule = await prisma.categoryRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new ChangeConflict('החוק כבר אינו קיים. רעננו ונסו שוב.');
  const [rules, txns] = await Promise.all([
    prisma.categoryRule.findMany(),
    prisma.transaction.findMany({ where: { categoryLocked: false, categoryId: null }, select: { id: true, description: true, amount: true, categoryId: true, categoryLocked: true } }),
  ]);
  const claimed = claimableBy(rule, rules, txns);
  if (opts?.preview) return { scanned: txns.length, categorized: claimed.length, samples: claimed.slice(0, 12) };
  return withChange('החלת חוק סיווג', async (db, change) => {
    let applied = 0;
    for (const t of claimed) {
      const current = await db.transaction.findUnique({ where: { id: t.id } });
      if (!current || current.categoryLocked || current.categoryId !== null) continue;
      await change('transaction', t.id, { categoryId: rule.categoryId, classificationSource: 'rule', classificationRuleId: rule.id, categorizedAt: new Date() });
      applied++;
    }
    return { scanned: txns.length, categorized: applied };
  });
}

/** Review threshold only; never a classification decision. */
export const ANOMALY_THRESHOLD = 2_500_000;
