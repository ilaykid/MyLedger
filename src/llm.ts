import { prisma } from './db.js';
import { signatureOf } from './cycle.js';
import { fetchLocalModel } from './local-fetch.js';

/**
 * Local LLM assistance, via Ollama on localhost.
 *
 * Three deliberate constraints:
 *
 *  1. **Local only.** Nothing leaves the machine, so the privacy question that
 *     made a hosted API awkward simply does not arise. The base URL is not
 *     configurable to a remote host by accident - see `fetchLocalModel`.
 *
 *  2. **No npm dependency.** Ollama speaks plain HTTP; `fetch` is enough. Adding
 *     an SDK would enlarge the supply chain of a project that holds bank
 *     credentials, to save a dozen lines.
 *
 *  3. **The model proposes RULES, it does not label transactions.** Its output
 *     is a merchant→category suggestion that becomes an ordinary CategoryRule
 *     once you accept it. That means every decision stays visible in the Rules
 *     page, editable, and reproducible without the model. A model that
 *     hallucinates gets a rule rejected; it never quietly mislabels history.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

/**
 * gemma2:9b, chosen by measurement rather than by size.
 *
 * Benchmarked on 54 merchants whose correct category is already known:
 *   qwen2.5:3b   15%  - and it corrupted Hebrew strings mid-word ("ビトוקים")
 *   qwen2.5:7b   19%  - same corruption, three times slower
 *   gemma2:9b    43%  - no corruption; every answer was a real category
 *
 * The gap is tokenisation, not knowledge: the Qwen models physically break
 * Hebrew words apart, and few-shot examples made that worse rather than better
 * (3B dropped to 0%). Gemma's tokeniser handles Hebrew, so it can be wrong in
 * sensible ways instead of unusable ways - and several of its "errors" were
 * defensible disagreements about taxonomy, one of which it got right and the
 * hand-written rule got wrong.
 *
 * 43% would be a poor autoclassifier. It is a good *suggester* for a long tail
 * that otherwise gets sorted by hand, which is why nothing is applied without a
 * tick.
 */
export const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'gemma2:9b';

export interface LlmStatus {
  available: boolean;
  model: string | null;
  installedModels: string[];
  error?: string;
}

export async function llmStatus(): Promise<LlmStatus> {
  try {
    const res = await fetchLocalModel(OLLAMA_URL, '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false, model: null, installedModels: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const installed = (body.models ?? []).map((m) => m.name);
    const model = installed.find((m) => m === DEFAULT_MODEL) ?? installed.find((m) => m.startsWith(DEFAULT_MODEL.split(':')[0])) ?? null;
    return { available: model != null, model, installedModels: installed };
  } catch (err) {
    return {
      available: false,
      model: null,
      installedModels: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface GenerateOptions {
  system: string;
  prompt: string;
  /** Ollama can constrain output to a JSON schema - use it rather than hoping. */
  format?: unknown;
  timeoutMs?: number;
}

// A 9B model on a 4 GB card spills to CPU: about 100 s per batch of twelve.
// The old 120 s ceiling would have failed on the first slow batch.
async function generate({ system, prompt, format, timeoutMs = 300_000 }: GenerateOptions): Promise<string> {
  const res = await fetchLocalModel(OLLAMA_URL, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      stream: false,
      format,
      options: {
        // Classification wants the most likely label, not creativity.
        temperature: 0,
        num_predict: 2048,
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? '';
}

export interface MerchantSuggestion {
  merchant: string;
  /** Occurrences in the data, so the biggest wins are obvious */
  count: number;
  total: number;
  category: string;
  categoryId: string;
  /** The pattern that would become a rule */
  pattern: string;
}

/**
 * Ask the model to file each unknown merchant under one of the existing
 * categories. Only merchant NAMES are sent - no amounts, no dates, no account
 * details - which keeps the prompt small and the exposure minimal even though it
 * never leaves the machine anyway.
 */
export async function suggestCategories(limit = 40): Promise<{
  suggestions: MerchantSuggestion[];
  skipped: string[];
  model: string;
}> {
  const status = await llmStatus();
  if (!status.available) {
    throw new Error(status.error ?? `Model ${DEFAULT_MODEL} is not installed in Ollama`);
  }

  // Transfers and non-cash-flow items are judgement calls about *your* money,
  // not about what the merchant is - a model cannot tell a gift from a loan
  // repayment from the description. Offering them only invites wrong guesses on
  // the classifications that matter most.
  const categories = await prisma.category.findMany({
    where: { kind: { notIn: ['transfer', 'excluded'] } },
    select: { id: true, name: true, kind: true },
    orderBy: { name: 'asc' },
  });
  const byName = new Map(categories.map((c) => [c.name, c]));

  const uncategorised = await prisma.transaction.findMany({
    where: { categoryId: null, amount: { lt: 0 } },
    select: { description: true, amount: true },
  });

  const merchants = new Map<string, { count: number; total: number }>();
  for (const t of uncategorised) {
    const e = merchants.get(t.description) ?? { count: 0, total: 0 };
    e.count++;
    e.total += Math.abs(t.amount);
    merchants.set(t.description, e);
  }

  const ranked = [...merchants.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, limit);

  if (ranked.length === 0) return { suggestions: [], skipped: [], model: DEFAULT_MODEL };

  const suggestions: MerchantSuggestion[] = [];
  const skipped: string[] = [];

  // Small batches. Asked for 40 answers in one go, a small model loses the JSON
  // structure entirely - measured: the whole response became unparseable, while
  // batches of 12 came back clean.
  for (let i = 0; i < ranked.length; i += BATCH_SIZE) {
    const batch = ranked.slice(i, i + BATCH_SIZE);
    try {
      const result = await classifyBatch(batch, categories, byName);
      suggestions.push(...result.suggestions);
      skipped.push(...result.skipped);
    } catch {
      // One bad batch should not lose the others.
      skipped.push(...batch.map(([name]) => name));
    }
  }

  return { suggestions, skipped, model: DEFAULT_MODEL };
}

const BATCH_SIZE = 12;

async function classifyBatch(
  batch: Array<[string, { count: number; total: number }]>,
  categories: Array<{ id: string; name: string; kind: string }>,
  byName: Map<string, { id: string; name: string; kind: string }>,
): Promise<{ suggestions: MerchantSuggestion[]; skipped: string[] }> {
  const system = [
    'אתה מסווג שמות בתי עסק ישראליים לקטגוריות הוצאה.',
    'קיבלת רשימת קטגוריות אפשריות. לכל בית עסק החזר בדיוק אחת מהן.',
    'אם אינך בטוח, החזר null עבור אותו בית עסק. אל תמציא קטגוריה שאינה ברשימה.',
    'החזר JSON בלבד.',
  ].join(' ');

  const prompt = [
    'קטגוריות אפשריות:',
    categories.map((c) => `- ${c.name}`).join('\n'),
    '',
    'בתי עסק לסיווג:',
    batch.map(([name], i) => `${i + 1}. ${name}`).join('\n'),
    '',
    'החזר אובייקט JSON במבנה: {"results": [{"merchant": "<השם המדויק>", "category": "<שם קטגוריה מהרשימה או null>"}]}',
  ].join('\n');

  const raw = await generate({
    system,
    prompt,
    // Constrain the shape so we are not parsing prose.
    format: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              merchant: { type: 'string' },
              category: { type: ['string', 'null'] },
            },
            required: ['merchant', 'category'],
          },
        },
      },
      required: ['results'],
    },
  });

  let parsed: { results?: Array<{ merchant?: string; category?: string | null }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The model did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const suggestions: MerchantSuggestion[] = [];
  const skipped: string[] = [];
  const wanted = new Map(batch);

  for (const row of parsed.results ?? []) {
    const merchant = row.merchant?.trim();
    if (!merchant || !wanted.has(merchant)) continue; // it invented a merchant

    const category = row.category ? byName.get(row.category.trim()) : null;
    if (!category) {
      // Either it declined, or it invented a category. Both mean "leave alone".
      skipped.push(merchant);
      continue;
    }

    const stats = wanted.get(merchant)!;
    suggestions.push({
      merchant,
      count: stats.count,
      total: stats.total,
      category: category.name,
      categoryId: category.id,
      pattern: patternFor(merchant),
    });
  }

  // Anything the model never mentioned is also "leave alone".
  for (const [merchant] of batch) {
    if (!suggestions.some((s) => s.merchant === merchant) && !skipped.includes(merchant)) {
      skipped.push(merchant);
    }
  }

  return { suggestions, skipped };
}

/**
 * A "contains" pattern that matches this merchant without being so generic it
 * catches others. Provider descriptions carry branch names and digits, so the
 * leading words are usually the identifying part.
 */
function patternFor(merchant: string): string {
  const cleaned = signatureOf(merchant);
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0) return merchant.trim();
  // Two words is usually the brand ("בי דראגסטורס"); one is too broad.
  const candidate = words.slice(0, 2).join(' ');
  return candidate.length >= 4 ? candidate : words.slice(0, 3).join(' ') || merchant.trim();
}

/** Turn accepted suggestions into ordinary rules and apply them. */
export async function acceptSuggestions(
  accepted: Array<{ pattern: string; categoryId: string }>,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const item of accepted) {
    const pattern = item.pattern.trim();
    if (!pattern) {
      skipped++;
      continue;
    }
    const exists = await prisma.categoryRule.findFirst({ where: { pattern } });
    if (exists) {
      skipped++;
      continue;
    }
    const category = await prisma.category.findUnique({ where: { id: item.categoryId } });
    if (!category) {
      skipped++;
      continue;
    }
    await prisma.categoryRule.create({
      data: { pattern, matchType: 'contains', priority: 5, categoryId: item.categoryId },
    });
    created++;
  }

  return { created, skipped };
}
