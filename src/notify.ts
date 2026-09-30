import 'dotenv/config';
import { prisma } from './db.js';
import * as summaries from './server/summaries.js';
import { analyseSyncHealth } from './sync-health.js';
import { getSettings } from './recurring.js';
import { unprotect } from './secrets.js';
import { buildDigest, digestForToday, type DigestKind } from './digests.js';
import { escapeHtml as esc } from './html.js';
import { safeErrorMessage } from './redact.js';

/**
 * Telegram notifications. Gracefully no-ops when TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID are not configured, so the rest of the system never
 * depends on Telegram being set up.
 *
 * SECURITY: the bot token grants full control of the bot - keep it in .env
 * only. This channel is strictly OUTBOUND: the machine dials api.telegram.org
 * to post a message and nothing else. There is no inbound port, no webhook,
 * and nothing a recipient can send back that this program will act on. Adding
 * a recipient therefore adds a destination for the digest, not a key to the
 * ledger - the only thing that changes is who reads the numbers.
 *
 * How much of your life those numbers describe is a separate dial:
 * `notificationDetail`, which applies to every recipient equally.
 */

interface TelegramConfig {
  token: string;
  /** Everyone the digest goes to. Never empty when this object exists. */
  chatIds: string[];
}

/**
 * Recipients are stored as one comma-separated string in a single sealed
 * field, so a household of two needs no schema change and a stored single id
 * keeps working untouched.
 */
export function parseChatIds(raw: string): string[] {
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Settings take precedence over environment variables: the settings row is
 * DPAPI-sealed and editable from the dashboard, while .env is plaintext and
 * needs a terminal. The env path stays as a fallback for headless setups.
 */
export async function telegramConfig(): Promise<TelegramConfig | null> {
  const settings = await getSettings();
  if (settings.telegramToken && settings.telegramChatId) {
    const chatIds = parseChatIds(await unprotect(settings.telegramChatId));
    if (chatIds.length > 0) return { token: await unprotect(settings.telegramToken), chatIds };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = parseChatIds(process.env.TELEGRAM_CHAT_ID ?? '');
  if (!token || chatIds.length === 0) return null;
  return { token, chatIds };
}

export async function isTelegramConfigured(): Promise<boolean> {
  return (await telegramConfig()) !== null;
}

/** One recipient. Telegram has no multi-chat send, so this runs per chat. */
async function postTo(token: string, chatId: string, text: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return safeErrorMessage(err, [token]);
  }

  if (res.ok) return null;

  // Telegram's own description is genuinely useful ("chat not found",
  // "Unauthorized"). It never echoes the token, so it is safe to surface.
  let description = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { description?: string };
    if (body.description) description = body.description;
  } catch {
    /* keep the status code */
  }
  return safeErrorMessage(description, [token]);
}

/**
 * Send to every recipient.
 *
 * `sent` is true when at least one delivery succeeded, because the alternative
 * makes a second recipient a liability: one person who never pressed /start
 * would turn every digest into a reported failure and there would be no way to
 * tell that the other one arrived. Per-recipient outcomes are in `failures`,
 * so a chat that is genuinely broken is still visible rather than swallowed.
 */
export async function sendTelegram(
  text: string,
): Promise<{ sent: boolean; error?: string; delivered?: number; failures?: Array<{ chatId: string; error: string }> }> {
  const cfg = await telegramConfig();
  if (!cfg) {
    console.log('[notify] Telegram not configured, skipping.');
    return { sent: false, error: 'not_configured' };
  }

  const results = await Promise.all(
    cfg.chatIds.map(async (chatId) => ({ chatId, error: await postTo(cfg.token, chatId, text) })),
  );
  const failures = results
    .filter((r): r is { chatId: string; error: string } => r.error !== null)
    .map((r) => ({ chatId: r.chatId, error: r.error }));
  const delivered = results.length - failures.length;

  for (const f of failures) console.error(`[notify] Telegram send to ${f.chatId} failed: ${f.error}`);

  if (delivered === 0) {
    return { sent: false, error: failures[0]?.error ?? 'unknown', delivered, failures };
  }
  return { sent: true, delivered, ...(failures.length > 0 ? { failures } : {}) };
}

const fmtILS = (agorot: number) =>
  new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(
    agorot / 100,
  );

/** Daily summary: yesterday's spending + budget alerts. */
export async function buildDailySummary(): Promise<string> {
  const now = new Date();
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const yesterdayTxns = await prisma.transaction.findMany({
    where: {
      date: { gte: yesterdayStart, lt: todayStart },
      status: 'completed',
      category: { isNot: { kind: 'transfer' } },
    },
    orderBy: { amount: 'asc' },
    include: { category: { select: { name: true, icon: true } } },
  });

  const spent = yesterdayTxns.filter((t) => t.amount < 0).reduce((s, t) => s + -t.amount, 0);
  const lines: string[] = [`<b>📒 MyLedger - סיכום יומי</b>`];

  if (yesterdayTxns.length === 0) {
    lines.push('אתמול לא נרשמו תנועות. 🎉');
  } else {
    lines.push(`אתמול ירדו <b>${fmtILS(spent)}</b> ב-${yesterdayTxns.filter((t) => t.amount < 0).length} תנועות:`);
    for (const t of yesterdayTxns.slice(0, 8)) {
      const icon = t.category?.icon ?? '❔';
      lines.push(`${esc(icon)} ${esc(t.description)} - <b>${fmtILS(Math.abs(t.amount))}</b>`);
    }
    if (yesterdayTxns.length > 8) lines.push(`...ועוד ${yesterdayTxns.length - 8} תנועות`);
  }

  // Coverage problems come first - they mean the numbers above are incomplete.
  const { issues } = await analyseSyncHealth();
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length > 0) {
    lines.push('', '<b>🔴 בעיות סנכרון:</b>');
    for (const issue of blocking) lines.push(`• ${esc(issue.title)}`);
  }

  // Budget alerts (>=80% of monthly budget)
  const budgets = await summaries.budgets(summaries.currentMonthKey());
  const alerts = budgets.filter((b) => b.spent / b.budget >= 0.8);
  if (alerts.length > 0) {
    lines.push('', '<b>⚠️ התראות תקציב:</b>');
    for (const b of alerts) {
      const pct = Math.round((b.spent / b.budget) * 100);
      lines.push(`${esc(b.icon)} ${esc(b.name)}: ${fmtILS(b.spent)} מתוך ${fmtILS(b.budget)} (${pct}%)`);
    }
  }

  return lines.join('\n');
}

/**
 * Send whichever digest today calls for - monthly on the 1st, weekly on Sunday,
 * daily otherwise. Pass a kind to override (used by the "send now" buttons).
 */
export async function sendDigest(kind?: DigestKind): Promise<{ sent: boolean; kind: DigestKind; error?: string }> {
  const chosen = kind ?? digestForToday();
  const text = await buildDigest(chosen);
  const result = await sendTelegram(text);
  return { ...result, kind: chosen };
}

/** @deprecated kept so existing callers keep working; use sendDigest(). */
export async function sendDailySummary(): Promise<void> {
  await sendDigest('daily');
}
