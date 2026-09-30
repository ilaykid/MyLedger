/**
 * Compatibility summaries for older dashboard endpoints.
 *
 * Every number delegates to the canonical cash-flow/breakdown engines. This is
 * intentionally a thin adapter: maintaining a second finance engine here once
 * caused spreads, excluded money and split income to disagree across screens.
 */
import { prisma } from '../db.js';
import { monthlyHistory } from '../cashflow.js';
import { monthlyBreakdown } from '../breakdown.js';
import { currentMonthKey, monthRange } from '../month.js';

export { currentMonthKey, monthRange };

export async function overview() {
  const [accounts, breakdown] = await Promise.all([
    prisma.account.findMany({ orderBy: { createdAt: 'asc' } }),
    monthlyBreakdown(currentMonthKey()),
  ]);
  const pendingExpense = await prisma.transaction.aggregate({
    where: { status: 'pending', amount: { lt: 0 } },
    _sum: { amount: true },
  });
  return {
    month: breakdown.month,
    totalBalance: accounts.reduce((sum, account) => sum + (account.balance ?? 0), 0),
    income: breakdown.income.total,
    expense: breakdown.expense.total,
    net: breakdown.net,
    pendingExpense: Math.max(0, -(pendingExpense._sum.amount ?? 0)),
    accounts,
  };
}

export async function cashflow(months: number) {
  return (await monthlyHistory(months)).map(({ month, income, expense, net }) => ({
    month,
    income,
    expense,
    net,
  }));
}

export async function categoryBreakdown(month: string) {
  return (await monthlyBreakdown(month)).expense.lines.map((line) => ({
    categoryId: line.categoryId,
    name: line.name,
    color: line.color,
    icon: line.icon,
    amount: line.amount,
  }));
}

export async function budgets(month: string) {
  return (await monthlyBreakdown(month)).expense.lines
    .filter((line) => line.budget != null && line.budget > 0)
    .map((line) => ({
      categoryId: line.categoryId,
      name: line.name,
      color: line.color,
      icon: line.icon,
      budget: line.budget!,
      spent: Math.max(0, line.amount),
    }));
}

/** Spending trend for the largest categories over the requested calendar months. */
export async function categoryTrend(months: number, top: number) {
  const history = await monthlyHistory(months);
  const breakdowns = await Promise.all(history.map((row) => monthlyBreakdown(row.month)));
  const totals = new Map<string, number>();
  const metadata = new Map<string, { name: string; color: string }>();

  for (const breakdown of breakdowns) {
    for (const line of breakdown.expense.lines) {
      if (!line.categoryId) continue;
      totals.set(line.categoryId, (totals.get(line.categoryId) ?? 0) + Math.max(0, line.amount));
      metadata.set(line.categoryId, { name: line.name, color: line.color });
    }
  }

  const topIds = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([id]) => id);

  return {
    months: history.map((row) => row.month),
    series: topIds.map((id) => ({
      categoryId: id,
      name: metadata.get(id)?.name ?? '?',
      color: metadata.get(id)?.color ?? '#898781',
      values: breakdowns.map(
        (breakdown) => Math.max(0, breakdown.expense.lines.find((line) => line.categoryId === id)?.amount ?? 0),
      ),
    })),
  };
}
