import { registerReviewRoutes, searchTransactions, saveRecurring } from './review.js';
import { withChange, ChangeConflict } from '../changes.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { z } from 'zod';
import 'dotenv/config';
import { prisma } from '../db.js';
import { applyCategoryRules, merchantPattern } from '../categorize.js';
import { CATEGORY_KINDS, cashflowSnapshot, monthlyHistory } from '../cashflow.js';
import { detectRecurring, getSettings } from '../recurring.js';
import { analyseSyncHealth, settlementMismatchDetail } from '../sync-health.js';
import { installmentSummary, listInstallmentPlans, planKeyFor } from '../installments.js';
import { sendTelegram, telegramConfig } from '../notify.js';
import { monthlyBreakdown } from '../breakdown.js';
import { buildDailyReview } from '../daily-review.js';
import {
  MAX_MONTHS,
  MIN_MONTHS,
  SpreadError,
  createSpreadPlan,
  deleteSpreadPlan,
  listSpreadPlans,
  slicesFor,
} from '../spread.js';
import { buildDigest, digestForToday } from '../digests.js';
import { generateInsights } from '../insights.js';
import { acceptSuggestions, llmStatus, suggestCategories } from '../llm.js';
import { protect } from '../secrets.js';
import { signatureOf } from '../cycle.js';
import * as connections from './connections.js';
import * as summaries from './summaries.js';
import { currentMonthKey, monthRange } from '../month.js';
import { compileSafeRegex } from '../safe-regex.js';
import { appPath } from '../paths.js';
import { backupStatus, confirmBackup, createBackup, prepareBackup } from '../backup-service.js';
import { ensureStarterCategories } from '../preset.js';
import { registerHttpSecurity } from './security.js';

const app = Fastify({ logger: { level: 'warn' } });

/**
 * Demo mode: the build handed to someone who is only looking.
 *
 * Enforced in the server rather than by shipping an empty config, because
 * "there are no credentials yet" is not a guarantee - it is an invitation to
 * type some in. Every route that could reach a bank, a card issuer or Telegram
 * refuses outright, so the worst a curious stranger can do is browse invented
 * numbers.
 */
const DEMO = process.env.MYLEDGER_DEMO === '1';

function demoBlocked(reply: import('fastify').FastifyReply) {
  return reply.code(403).send({
    error: 'demo',
    message: 'זו גרסת הדגמה — חיבור לחשבונות אמיתיים ושליחת הודעות מנוטרלים בה.',
  });
}

// SECURITY: this API has no authentication - it must only ever listen on
// localhost. Do not change HOST to 0.0.0.0 without adding auth first.
const HOST = '127.0.0.1';
const PORT = Number(process.env.API_PORT ?? 3010);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error('API_PORT must be a valid TCP port');

/** Custom header that forces a CORS preflight on mutating requests. */
const REQUEST_HEADER = 'x-myledger';

// No CORS by default. The production SPA is same-origin, and the Vite dev
// server proxies /api, so the browser never makes a cross-origin call. An
// allowlist of dev ports would hand every other local project that happens to
// run on 5173 read AND write access to the ledger. Opt in only when needed.
const DEV_ORIGINS = (process.env.MYLEDGER_DEV_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

registerHttpSecurity(app);

if (DEV_ORIGINS.length > 0) {
  await app.register(cors, {
    origin: DEV_ORIGINS,
    allowedHeaders: ['content-type', REQUEST_HEADER],
  });
}

/**
 * Demo guard, as one rule instead of a check per handler: a per-handler check
 * is only as good as the last route someone remembered to add it to. Any write
 * to a route that can reach a provider, Telegram or the disk outside the data
 * folder is refused.
 */
const DEMO_BLOCKED = /^\/api\/(connections|scrape|telegram|backup)(\/|$|\?)/;
app.addHook('preHandler', async (req, reply) => {
  if (!DEMO || req.method === 'GET' || req.method === 'HEAD') return;
  if (DEMO_BLOCKED.test(req.routeOptions.url ?? req.url)) return demoBlocked(reply);
});

/**
 * Zod validation failures are the client's fault, so they get a 400.
 *
 * MUST be declared before any route. Fastify binds the error handler to each
 * route as that route is registered, so an identical block placed at the bottom
 * of this file - where it used to live - silently covered nothing: every bad
 * request in the entire API answered 500 and echoed the raw Zod issue array,
 * which is both the wrong status and an internal detail leaking to the caller.
 */
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ChangeConflict) return reply.code(409).send({ error: err.message });
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: 'validation', issues: err.issues });
  }
  // Error messages/stacks from providers and Prisma can contain request bodies.
  // Log a correlation id, never a raw exception or a user's financial values.
  app.log.error({ requestId: _req.id }, 'Request failed');
  return reply.code(500).send({ error: 'internal error' });
});

// ---------- Meta ----------
// What the UI needs to know about this installation, not about the money:
// whether it is a demo build, and whether credentials can be sealed here
// (DPAPI is Windows-only, so connecting a provider elsewhere would fail late).
app.get('/api/meta', async () => ({
  demo: DEMO,
  platform: process.platform,
  canStoreCredentials: process.platform === 'win32',
}));

// ---------- Accounts ----------
app.get('/api/accounts', async () => {
  return prisma.account.findMany({ orderBy: { createdAt: 'asc' } });
});

// ---------- Transactions ----------
app.get('/api/transactions', async req => searchTransactions(req.query));

const TxnPatchSchema = z.object({
  categoryId: z.string().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

app.patch('/api/transactions/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = TxnPatchSchema.parse(req.body);

  const txn = await prisma.transaction.findUnique({ where: { id } });
  if (!txn) return reply.code(404).send({ error: 'transaction not found' });

  const data: {
    categoryId?: string | null;
    categoryLocked?: boolean;
    note?: string | null;
    classificationSource?: string;
    classificationRuleId?: string | null;
    categorizedAt?: Date;
  } = {};

  if (body.categoryId !== undefined) {
    // Manual assignment locks the category so the rules engine won't override
    // it. Clearing the category (null) unlocks it again.
    data.categoryId = body.categoryId;
    data.categoryLocked = body.categoryId !== null;
    data.classificationSource = body.categoryId ? 'manual' : 'unassigned';
    data.classificationRuleId = null;
    data.categorizedAt = new Date();
  }
  if (body.note !== undefined) {
    const trimmed = body.note?.trim();
    data.note = trimmed ? trimmed : null;
  }

  return withChange('עדכון תנועה', async (db, change) => {
    await change('transaction', id, data);
    return (await db.transaction.findUniqueOrThrow({ where: { id }, include: { category: true } }));
  });
});

// ---------- Standing notes ----------
// Attached to a merchant or to one instalment purchase rather than a single
// charge, so they also appear on rows scraped later.
app.get('/api/notes', async () => {
  return prisma.note.findMany({ orderBy: { updatedAt: 'desc' } });
});

app.put('/api/notes', async (req, reply) => {
  const body = z
    .object({
      scope: z.enum(['merchant', 'plan']),
      transactionId: z.string().min(1),
      note: z.string().max(500),
    })
    .parse(req.body);

  const txn = await prisma.transaction.findUnique({ where: { id: body.transactionId } });
  if (!txn) return reply.code(404).send({ error: 'transaction not found' });

  let key: string | null;
  let displayName: string;

  if (body.scope === 'plan') {
    key = planKeyFor(txn);
    if (!key) return reply.code(400).send({ error: 'this transaction is not part of an instalment plan' });
    displayName = `${txn.description} (${txn.installmentTotal} תשלומים)`;
  } else {
    key = signatureOf(txn.description);
    if (!key) return reply.code(400).send({ error: 'description has no matchable text' });
    displayName = txn.description;
  }

  const note = body.note.trim();
  if (!note) {
    await prisma.note.deleteMany({ where: { scope: body.scope, key } });
    return { ok: true, removed: true };
  }

  const saved = await prisma.note.upsert({
    where: { scope_key: { scope: body.scope, key } },
    create: { scope: body.scope, key, displayName, note },
    update: { displayName, note },
  });
  return { ok: true, note: saved };
});

app.delete('/api/notes/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  await prisma.note.delete({ where: { id } });
  reply.code(204);
});

// ---------- Categories ----------
const CategorySchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
  monthlyBudget: z.number().int().min(0).nullable().optional(),
  kind: z.enum(CATEGORY_KINDS).optional(),
});

app.get('/api/categories', async () => {
  return prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { transactions: true, rules: true } } },
  });
});

app.post('/api/categories', async (req, reply) => {
  const body = CategorySchema.parse(req.body);
  reply.code(201);
  return withChange('הוספת קטגוריה',async(_db,change)=>change('category',null,body));
});

app.patch('/api/categories/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = CategorySchema.partial().parse(req.body);
  return withChange('עדכון קטגוריה', async (_db, change) => change('category', id, body));
});

app.delete('/api/categories/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  return withChange('מחיקת קטגוריה',async(db,change)=>{
    for(const t of await db.transaction.findMany({where:{categoryId:id}}))await change('transaction',t.id,{categoryId:null,categoryLocked:false,classificationSource:'manual',classificationRuleId:null,categorizedAt:new Date()});
    for(const r of await db.categoryRule.findMany({where:{categoryId:id}}))await change('categoryRule',r.id,null);
    for(const r of await db.recurringExpense.findMany({where:{categoryId:id}}))await change('recurringExpense',r.id,{categoryId:null});
    await change('category',id,null);return {ok:true};
  });
});

// ---------- Rules ----------
const RuleSchema = z.object({
  pattern: z.string().min(1).max(200),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  priority: z.number().int().default(0),
  categoryId: z.string(),
});

app.get('/api/rules', async () => {
  return prisma.categoryRule.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    include: { category: { select: { id: true, name: true, color: true, icon: true } } },
  });
});

app.post('/api/rules', async (req, reply) => {
  const body = RuleSchema.parse(req.body);
  if (body.matchType === 'regex') {
    try {
      compileSafeRegex(body.pattern);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid regex pattern' });
    }
  }
  reply.code(201);
  return withChange('הוספת חוק', async (_db, change) => change('categoryRule', null, body));
});

app.delete('/api/rules/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  return withChange('מחיקת חוק', async (_db, change) => { await change('categoryRule', id, null); return { ok: true }; });
});

/**
 * "Classify every charge from this merchant like this."
 *
 * Answering one card at a time is the right unit for a strange transaction and
 * the wrong one for a merchant you buy from weekly - there, the same decision
 * is asked twelve times and the queue stops feeling finishable. This turns one
 * answer into a standing rule: the name is extracted from the description, a
 * `contains` rule is stored so future scrapes land pre-classified, and every
 * uncategorised transaction already carrying that name is updated now.
 *
 * Only rows with no category are swept. Overwriting a classification the user
 * (or a more specific rule) already made would make this button dangerous, and
 * it needs to be safe enough to press without thinking.
 */
app.post('/api/rules/from-transaction', async (req) => {
  const body = z.object({ transactionId:z.string(), categoryId:z.string(), preview:z.boolean().default(false) }).parse(req.body);
  const txn = await prisma.transaction.findUniqueOrThrow({where:{id:body.transactionId}});
  const pattern = merchantPattern(txn.description);
  if (!pattern) throw new ChangeConflict('לא נמצא שם בית עסק שניתן ליצור ממנו חוק.');
  const where={categoryId:null,categoryLocked:false,description:{contains:pattern}};
  if(body.preview) { const rows=await prisma.transaction.findMany({where}); if(!rows.some(t=>t.id===txn.id))rows.push(txn);return {pattern,applied:rows.length,count:rows.length,amount:rows.reduce((s,t)=>s+Math.abs(t.amount),0),samples:rows.slice(0,8)}; }
  return withChange('סיווג בית עסק ויצירת חוק',async(db,change)=>{
    const existing=await db.categoryRule.findFirst({where:{pattern,matchType:'contains'}});
    const rule=await change('categoryRule',existing?.id??null,{pattern,matchType:'contains',priority:existing?.priority??10,categoryId:body.categoryId});
    const rows=await db.transaction.findMany({where});
    for(const row of rows) await change('transaction',row.id,{categoryId:body.categoryId,classificationSource:'rule',classificationRuleId:String(rule.id),categorizedAt:new Date()});
    await change('transaction',txn.id,{categoryId:body.categoryId,categoryLocked:true,classificationSource:'manual',classificationRuleId:null,categorizedAt:new Date()});
    return {rule,pattern,applied:rows.length+(rows.some(t=>t.id===txn.id)?0:1)};
  });
});

app.post('/api/rules/apply', async (req) => {
  const body = z.object({ recategorize: z.boolean().default(false), preview: z.boolean().default(false) }).parse(req.body ?? {});
  return applyCategoryRules(body);
});

// ---------- Cash flow (the primary view) ----------
app.get('/api/cashflow', async (req) => {
  const { offset } = z
    .object({ offset: z.coerce.number().int().min(-36).max(0).default(0) })
    .parse(req.query);
  return cashflowSnapshot(offset);
});

// ---------- Monthly net (the "was this month positive" view) ----------
app.get('/api/monthly', async (req) => {
  const { months } = z
    .object({ months: z.coerce.number().int().min(1).max(36).default(12) })
    .parse(req.query);
  return monthlyHistory(months);
});

// ---------- Local LLM (Ollama) ----------
app.get('/api/llm/status', async () => llmStatus());

app.post('/api/llm/suggest', async (req, reply) => {
  const { limit } = z.object({ limit: z.number().int().min(1).max(80).default(40) }).parse(req.body ?? {});
  try {
    return await suggestCategories(limit);
  } catch (err) {
    return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/llm/accept', async (req) => {
  const body = z
    .object({
      accepted: z.array(z.object({ pattern: z.string().min(1), categoryId: z.string().min(1) })),
    })
    .parse(req.body);
  const result = await acceptSuggestions(body.accepted);
  // The point of turning suggestions into rules is that the ordinary engine
  // applies them - so run it and report what actually changed.
  const applied = await applyCategoryRules();
  return { ...result, categorized: applied.categorized };
});

// ---------- Insights ----------
app.get('/api/insights', async (req) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);
  return generateInsights(days);
});

app.put('/api/insights/:key/feedback', async (req) => {
  const { key } = z.object({ key: z.string().regex(/^[a-f0-9]{24}$/) }).parse(req.params);
  const body = z.object({
    kind: z.string().min(1).max(60),
    verdict: z.enum(['useful', 'not_relevant', 'resolved', 'snoozed']),
  }).parse(req.body);
  return prisma.insightFeedback.upsert({
    where: { insightKey: key },
    create: { insightKey: key, kind: body.kind, verdict: body.verdict, snoozedUntil: body.verdict === 'snoozed' ? new Date(Date.now()+7*86_400_000) : null },
    update: { kind: body.kind, verdict: body.verdict, snoozedUntil: body.verdict === 'snoozed' ? new Date(Date.now()+7*86_400_000) : null },
  });
});

// ---------- Instalment plans ----------
app.get('/api/installments', async () => ({
  plans: await listInstallmentPlans(),
  summary: await installmentSummary(),
}));

// ---------- Daily review ----------
app.get('/api/daily-review', async (req) => {
  const { scope } = z
    .object({ scope: z.enum(['daily', 'expenses']).default('daily') })
    .parse(req.query);
  return buildDailyReview(scope);
});

/**
 * "I have dealt with this" for a review card.
 *
 * Categorising a transaction removes its card on its own - the queue only ever
 * selects uncategorised rows. Advice cards have no such natural end, so without
 * this they return every single day and the queue stops being finishable, which
 * is the one property it depends on.
 */
app.post('/api/daily-review/dismiss', async (req) => {
  const body = z.object({ id: z.string().min(1).max(80), kind: z.string().min(1).max(40) }).parse(req.body);
  return prisma.insightFeedback.upsert({
    where: { insightKey: body.id },
    create: { insightKey: body.id, kind: body.kind, verdict: 'dismissed' },
    update: { kind: body.kind, verdict: 'dismissed' },
  });
});

// ---------- By-category breakdown ----------
app.get('/api/breakdown', async (req) => {
  const { month } = z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthKey()) })
    .parse(req.query);
  return monthlyBreakdown(month);
});

// ---------- Spread plans (recognise a lump sum across months) ----------
app.get('/api/spreads', async () => ({ plans: await listSpreadPlans() }));

app.post('/api/spreads', async (req, reply) => {
  const body = z
    .object({
      transactionId: z.string().min(1),
      months: z.coerce.number().int().min(MIN_MONTHS).max(MAX_MONTHS),
      offsetMonths: z.coerce.number().int().min(0).max(24).default(0),
      note: z.string().trim().max(500).nullish(),
    })
    .parse(req.body);

  try {
    return await createSpreadPlan(body);
  } catch (err) {
    if (err instanceof SpreadError) return reply.code(400).send({ error: err.message });
    throw err;
  }
});

app.delete('/api/spreads/:transactionId', async (req, reply) => {
  const { transactionId } = z.object({ transactionId: z.string().min(1) }).parse(req.params);
  const removed = await deleteSpreadPlan(transactionId);
  if (!removed) return reply.code(404).send({ error: 'לא נמצאה פריסה לתנועה הזאת' });
  return { ok: true };
});

// ---------- Sync health ----------
app.get('/api/sync-health', async () => analyseSyncHealth());

app.get('/api/sync-health/settlement-mismatch', async (req, reply) => {
  const { accountId, date } = z.object({
    accountId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.query);
  const detail = await settlementMismatchDetail(accountId, date);
  if (!detail) return reply.code(404).send({ error: 'mismatch detail not found' });
  return detail;
});

app.get('/api/sync-runs', async (req) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
  return prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
});

// ---------- Encrypted backups ----------
app.get('/api/backup', async () => backupStatus());
app.post('/api/backup/prepare', async (req, reply) => {
  const body = z.object({ destination: z.string().min(3).max(500), keep: z.number().int().min(3).max(90).default(14) }).parse(req.body);
  try { return prepareBackup(body.destination, body.keep); }
  catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid destination' }); }
});
app.post('/api/backup/confirm', async (req, reply) => {
  const { setupId } = z.object({ setupId: z.string().uuid() }).parse(req.body);
  try { return await confirmBackup(setupId); }
  catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : 'backup setup failed' }); }
});
app.post('/api/backup/run', async (_req, reply) => {
  try { return await createBackup(); }
  catch (err) { return reply.code(500).send({ error: err instanceof Error ? err.message : 'backup failed' }); }
});

// ---------- Connections ----------
// Credentials are write-only here: they go in, get sealed with DPAPI, and are
// never returned. The API reports only whether a field is set and encrypted.
app.get('/api/connections', async () => ({
  connections: await connections.listConnections(),
  orphanAccounts: await connections.listOrphanAccounts(),
  providers: connections.listProviders(),
}));

const ConnectionSchema = z.object({
  company: z.string().min(1),
  displayName: z.string().max(60).optional(),
  credentials: z.record(z.string(), z.string().min(1)),
});

app.post('/api/connections', async (req, reply) => {
  if (DEMO) return demoBlocked(reply);
  const body = ConnectionSchema.parse(req.body);
  try {
    const { created } = await connections.upsertConnection(body);
    reply.code(created ? 201 : 200);
    return { ok: true, created };
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid connection' });
  }
});

app.delete('/api/connections/:company', async (req, reply) => {
  const { company } = req.params as { company: string };
  const result = connections.removeConnection(company);
  if (!result.removed) return reply.code(404).send({ error: 'not configured' });
  return { ok: true, profileRemoved: result.profileRemoved };
});

const AccountPatchSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  billingDay: z.number().int().min(1).max(31).nullable().optional(),
  lifecycle: z.enum(['active', 'dormant', 'closed']).optional(),
});

app.patch('/api/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = AccountPatchSchema.parse(req.body);
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) return reply.code(404).send({ error: 'account not found' });
  return withChange('עדכון חשבון',async(_db,change)=>change('account',id,body));
});

app.delete('/api/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  // Cascades to its transactions - this is how you drop an expired card.
  await prisma.account.delete({ where: { id } });
  reply.code(204);
});

// ---------- Scraping from the browser ----------
app.post('/api/scrape', async (req, reply) => {
  if (DEMO) return demoBlocked(reply);
  const body = z.object({ companies: z.array(z.string()).default([]) }).parse(req.body ?? {});
  return connections.startScrape(body.companies);
});

app.get('/api/scrape/status', async () => connections.getScrapeJob() ?? { status: 'idle' });

// ---------- Recurring charges ----------
app.get('/api/recurring', async () => {
  return prisma.recurringExpense.findMany({
    orderBy: [{ direction: 'asc' }, { expectedDay: 'asc' }],
    include: {
      category: { select: { id: true, name: true, color: true, icon: true } },
      account: { select: { id: true, displayName: true, type: true } },
    },
  });
});

app.patch('/api/recurring/:id', async (req) => {
  const { id } = req.params as { id: string };
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length === 1 && 'active' in req.body) {
    const body = z.object({ active:z.boolean() }).parse(req.body);
    return withChange('עדכון התחייבות', async (_db, change) => change('recurringExpense', id, { ...body, source:'confirmed' }));
  }
  return saveRecurring(id, req.body);
});

app.post('/api/recurring/detect', async () => detectRecurring());

// ---------- Settings ----------
// The Telegram token is a credential: reported as set/unset, never returned.
app.get('/api/settings', async () => {
  const s = await getSettings();
  return {
    id: s.id,
    cycleAnchorDay: s.cycleAnchorDay,
    forecastLookbackCycles: s.forecastLookbackCycles,
    notificationDetail: s.notificationDetail,
    telegramConfigured: !!(s.telegramToken && s.telegramChatId),
  };
});

app.patch('/api/settings', async (req) => {
  const body = z
    .object({
      cycleAnchorDay: z.number().int().min(1).max(28).optional(),
      forecastLookbackCycles: z.number().int().min(1).max(12).optional(),
      notificationDetail: z.enum(['full', 'amounts', 'minimal']).optional(),
    })
    .parse(req.body);
  await getSettings(); // ensure the singleton exists
  const s = await prisma.settings.update({ where: { id: 1 }, data: body });
  return {
    id: s.id,
    cycleAnchorDay: s.cycleAnchorDay,
    forecastLookbackCycles: s.forecastLookbackCycles,
    notificationDetail: s.notificationDetail,
    telegramConfigured: !!(s.telegramToken && s.telegramChatId),
  };
});

// ---------- Telegram ----------

/**
 * Find the chat id for a freshly created bot.
 *
 * Creating the bot is the easy half - BotFather walks you through it in a
 * thirty-second chat. The numeric chat id is the half that stops people: it is
 * not shown anywhere in Telegram, and the usual advice is to go message a
 * *second* stranger bot to be told a number you then copy by hand.
 *
 * Since the bot has just been created, its update queue contains exactly one
 * thing: the message the user sent it. Reading that is strictly less work than
 * asking a human to transcribe an 10-digit number, and it cannot be mistyped.
 *
 * Only private chats with a positive id are offered; a group chat would deliver
 * a household's finances to everyone in the group.
 */
app.post('/api/telegram/detect-chat', async (req, reply) => {
  if (DEMO) return demoBlocked(reply);
  // Optional once a bot is connected: adding a second recipient later happens
  // on a screen that never sees the token, and asking for it again there would
  // mean digging the secret back out to do the one routine change there is.
  const { token: supplied } = z
    .object({ token: z.string().min(20).max(200).optional() })
    .parse(req.body ?? {});
  const token = supplied?.trim() || (await telegramConfig())?.token;
  if (!token) return reply.code(400).send({ error: 'no_token', message: 'צריך טוקן של בוט.' });

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return reply.code(502).send({ error: 'unreachable', message: 'לא הצלחתי להגיע לטלגרם. בדקו את החיבור לאינטרנט.' });
  }

  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; description?: string; result?: Array<{ message?: { chat?: { id: number; type: string; first_name?: string; username?: string } } }> }
    | null;

  if (!body?.ok) {
    // Telegram's own wording ("Unauthorized") is the useful part, and it never
    // echoes the token back.
    return reply.code(400).send({ error: 'rejected', message: body?.description ?? 'הטוקן נדחה על ידי טלגרם.' });
  }

  const chats = new Map<number, { id: string; name: string }>();
  for (const update of body.result ?? []) {
    const chat = update.message?.chat;
    if (!chat || chat.type !== 'private' || chat.id <= 0) continue;
    chats.set(chat.id, {
      id: String(chat.id),
      name: chat.first_name ?? chat.username ?? String(chat.id),
    });
  }

  return { chats: [...chats.values()] };
});

/** A private chat's user id: positive, digits only. */
const ChatId = z.string().regex(/^\d+$/, 'use the positive user id of a private chat');

app.put('/api/telegram', async (req, reply) => {
  const body = z
    .object({ token: z.string().min(20), chatIds: z.array(ChatId).min(1).max(10) })
    .parse(req.body);
  await getSettings();
  await prisma.settings.update({
    where: { id: 1 },
    data: {
      telegramToken: await protect(body.token.trim()),
      telegramChatId: await protect([...new Set(body.chatIds)].join(',')),
    },
  });
  reply.code(200);
  return { ok: true };
});

/**
 * The recipient list, after setup.
 *
 * Adding someone used to mean disconnecting the bot and pasting the token in
 * again, because the whole Telegram form disappeared once it was configured -
 * so the one change a household actually makes was the one thing you could not
 * do. This edits the list on its own, leaving the token alone.
 *
 * The ids are returned in the clear. They are chat identifiers, not secrets:
 * knowing one buys nothing without the token, and you cannot manage a list you
 * cannot see.
 */
app.get('/api/telegram/recipients', async () => {
  const cfg = await telegramConfig();
  return { chatIds: cfg?.chatIds ?? [] };
});

app.put('/api/telegram/recipients', async (req, reply) => {
  const body = z.object({ chatIds: z.array(ChatId).min(1).max(10) }).parse(req.body);
  const settings = await getSettings();
  if (!settings.telegramToken) {
    return reply.code(400).send({ error: 'not_configured', message: 'צריך לחבר בוט לפני שמגדירים נמענים.' });
  }
  await prisma.settings.update({
    where: { id: 1 },
    data: { telegramChatId: await protect([...new Set(body.chatIds)].join(',')) },
  });
  return { chatIds: [...new Set(body.chatIds)] };
});

/**
 * Send one message to a single chat, to prove it works before it joins the
 * list. Without this, adding a partner means waiting until tomorrow morning to
 * discover they never pressed /start.
 */
app.post('/api/telegram/recipients/test', async (req, reply) => {
  const { chatId } = z.object({ chatId: ChatId }).parse(req.body);
  const cfg = await telegramConfig();
  if (!cfg) return reply.code(400).send({ error: 'not_configured' });

  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '📒 MyLedger — הודעת בדיקה. אם הגיעה, הסיכומים היומיים יגיעו לכאן.',
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (res?.ok) return { sent: true };
  const detail = (await res?.json().catch(() => null)) as { description?: string } | null;
  return reply
    .code(200)
    .send({ sent: false, error: detail?.description ?? 'הצ׳אט לא נמצא. צריך לשלוח /start לבוט מהחשבון הזה ולנסות שוב.' });
});

app.delete('/api/telegram', async () => {
  await getSettings();
  await prisma.settings.update({
    where: { id: 1 },
    data: { telegramToken: null, telegramChatId: null },
  });
  return { ok: true };
});

app.post('/api/telegram/test', async (_req, reply) => {
  if (DEMO) return demoBlocked(reply);
  const result = await sendTelegram(
    '<b>📒 MyLedger</b>\nההתחברות עובדת. מכאן יגיע כל בוקר סיכום של אתמול ומצב המחזור — ' +
      'בשקט בימים רגילים, ועם צליל כשיש משהו לבדוק (חשבון שלא התעדכן, חיוב חשוד, צפי למינוס).',
  );
  return result;
});

app.post('/api/telegram/summary', async (req, reply) => {
  if (DEMO) return demoBlocked(reply);
  const { kind } = z
    .object({ kind: z.enum(['daily', 'weekly', 'monthly']).optional() })
    .parse(req.body ?? {});
  const chosen = kind ?? digestForToday();
  const text = await buildDigest(chosen);
  const result = await sendTelegram(text);
  return { ...result, kind: chosen, preview: text };
});

/** Renders a digest without sending it, so the UI can show what would go out. */
app.get('/api/telegram/preview', async (req) => {
  const { kind } = z
    .object({ kind: z.enum(['daily', 'weekly', 'monthly']).default(digestForToday()) })
    .parse(req.query);
  return { kind, preview: await buildDigest(kind) };
});

// ---------- Summaries ----------
app.get('/api/summary/overview', async () => summaries.overview());

app.get('/api/summary/cashflow', async (req) => {
  const { months } = z
    .object({ months: z.coerce.number().int().min(1).max(36).default(8) })
    .parse(req.query);
  return summaries.cashflow(months);
});

app.get('/api/summary/categories', async (req) => {
  const { month } = z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthKey()) })
    .parse(req.query);
  return summaries.categoryBreakdown(month);
});

app.get('/api/summary/budgets', async (req) => {
  const { month } = z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(currentMonthKey()) })
    .parse(req.query);
  return summaries.budgets(month);
});

app.get('/api/summary/trend', async (req) => {
  const { months, top } = z
    .object({
      months: z.coerce.number().int().min(1).max(36).default(6),
      top: z.coerce.number().int().min(1).max(8).default(5),
    })
    .parse(req.query);
  return summaries.categoryTrend(months, top);
});

await registerReviewRoutes(app);

// ---------- Static SPA (production build) ----------
const webDist = appPath('web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback for client-side routes; API 404s stay JSON
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

// Zod validation errors -> 400 instead of 500

/**
 * Exit code for "the port is already taken", kept distinct so the supervisor
 * loop in scripts/api.cmd can tell "someone beat me to it, stand down" from
 * "the server crashed, restart it". Without that distinction the logon task and
 * a manually started server spin against each other forever.
 */
const EXIT_ALREADY_RUNNING = 3;

if (await ensureStarterCategories()) console.log('Fresh install: added the starter categories and rules');

try {
  await app.listen({ host: HOST, port: PORT });
  console.log(`MyLedger API listening on http://${HOST}:${PORT}`);

} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use - MyLedger is most likely already running.\n` +
        `Open http://${HOST}:${PORT} , or set API_PORT to use a different port.`,
    );
    process.exit(EXIT_ALREADY_RUNNING);
  }
  console.error(err);
  process.exit(1);
}
