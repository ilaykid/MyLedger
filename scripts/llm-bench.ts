import { prisma } from '../src/db.js';

/**
 * Benchmark a local model on Hebrew merchant classification.
 *
 *   npm run llm:bench                          the configured default
 *   npm run llm:bench -- gemma2:9b qwen2.5:7b  compare several
 *   npm run llm:bench -- gemma2:9b noshots     without few-shot examples
 *
 * Ground truth comes from merchants the hand-written rules already categorise -
 * those labels are known-good. The label is hidden, the model is asked, and the
 * answers are scored. Without this you are guessing about whether the model is
 * guessing.
 *
 * Measured on one household's history (54 merchants, 22 categories):
 *   qwen2.5:3b  15%   corrupts Hebrew mid-word
 *   qwen2.5:7b  19%   same, 3x slower
 *   gemma2:9b   43%   clean output - the current default
 *
 * Re-run it before switching models. Note that some "errors" are legitimate
 * taxonomy disagreements, so treat the number as a floor.
 */
const OLLAMA = 'http://127.0.0.1:11434';

interface Sample {
  merchant: string;
  truth: string;
}

async function buildSample(size = 60): Promise<{ samples: Sample[]; categories: string[] }> {
  const categories = await prisma.category.findMany({
    where: { kind: { not: 'transfer' } },
    select: { name: true },
    orderBy: { name: 'asc' },
  });

  const txns = await prisma.transaction.findMany({
    where: { categoryId: { not: null }, amount: { lt: 0 } },
    select: { description: true, category: { select: { name: true, kind: true } } },
  });

  // One row per merchant, and only categories a human would agree with.
  const byMerchant = new Map<string, string>();
  for (const t of txns) {
    if (!t.category || t.category.kind === 'transfer') continue;
    if (!byMerchant.has(t.description)) byMerchant.set(t.description, t.category.name);
  }

  // Spread across categories so the score is not dominated by groceries.
  const perCategory = new Map<string, Sample[]>();
  for (const [merchant, truth] of byMerchant) {
    const list = perCategory.get(truth) ?? [];
    list.push({ merchant, truth });
    perCategory.set(truth, list);
  }

  const samples: Sample[] = [];
  const perBucket = Math.max(2, Math.floor(size / perCategory.size));
  for (const list of perCategory.values()) {
    samples.push(...list.slice(0, perBucket));
  }

  return { samples: samples.slice(0, size), categories: categories.map((c) => c.name) };
}

/** Small batches: a long answer gives a small model more room to lose the JSON. */
const BATCH = 12;

async function askModel(model: string, allSamples: Sample[], categories: string[], shots: Sample[] = []) {
  let correct = 0;
  let wrong = 0;
  let declined = 0;
  let failedBatches = 0;
  const mistakes: string[] = [];
  const started = Date.now();

  for (let i = 0; i < allSamples.length; i += BATCH) {
    const batch = allSamples.slice(i, i + BATCH);
    const r = await askBatch(model, batch, categories, shots);
    if (!r.ok) {
      failedBatches++;
      declined += batch.length;
      continue;
    }
    correct += r.correct;
    wrong += r.wrong;
    declined += r.declined;
    for (const m of r.mistakes) if (mistakes.length < 8) mistakes.push(m);
  }

  return {
    ok: true as const,
    seconds: (Date.now() - started) / 1000,
    correct,
    wrong,
    declined,
    failedBatches,
    total: allSamples.length,
    mistakes,
  };
}

async function askBatch(model: string, samples: Sample[], categories: string[], shots: Sample[] = []) {
  const system =
    'אתה מסווג שמות בתי עסק ישראליים לקטגוריות הוצאה. לכל בית עסק החזר בדיוק אחת מהקטגוריות ברשימה. אם אינך בטוח החזר null. החזר JSON בלבד.';
  const prompt = [
    'קטגוריות אפשריות:',
    categories.map((c) => `- ${c}`).join('\n'),
    ...(shots.length
      ? ['', 'דוגמאות נכונות:', ...shots.map((s) => `${s.merchant} → ${s.truth}`)]
      : []),
    '',
    'בתי עסק:',
    samples.map((s, i) => `${i + 1}. ${s.merchant}`).join('\n'),
    '',
    'החזר: {"results":[{"merchant":"<שם מדויק>","category":"<קטגוריה או null>"}]}',
  ].join('\n');

  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(900_000),
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0, num_predict: 4096 },
      format: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { merchant: { type: 'string' }, category: { type: ['string', 'null'] } },
              required: ['merchant', 'category'],
            },
          },
        },
        required: ['results'],
      },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };

  const body = (await res.json()) as { message?: { content?: string } };
  let parsed: { results?: Array<{ merchant?: string; category?: string | null }> };
  try {
    parsed = JSON.parse(body.message?.content ?? '');
  } catch {
    return { ok: false as const, error: 'invalid JSON' };
  }

  const answers = new Map<string, string | null>();
  for (const r of parsed.results ?? []) {
    if (r.merchant) answers.set(r.merchant.trim(), r.category?.trim() ?? null);
  }

  let correct = 0;
  let wrong = 0;
  let declined = 0;
  const mistakes: string[] = [];

  for (const s of samples) {
    const got = answers.get(s.merchant);
    if (got == null) {
      declined++;
    } else if (got === s.truth) {
      correct++;
    } else {
      wrong++;
      if (mistakes.length < 8) mistakes.push(`${s.merchant.slice(0, 26)} → ${got} (נכון: ${s.truth})`);
    }
  }

  return { ok: true as const, correct, wrong, declined, mistakes };
}

async function main() {
  const { samples, categories } = await buildSample(120);
  // Hold out the first slice as few-shot examples; score on the rest, so the
  // model is never graded on something it was shown.
  const shots = samples.slice(0, 22);
  const test = samples.slice(22, 76);
  const useShots = !process.argv.includes('noshots');

  console.log(
    `${test.length} merchants to classify, ${categories.length} categories, ` +
      `${useShots ? `${shots.length} few-shot examples` : 'NO examples (baseline)'}\n`,
  );

  const models = process.argv.slice(2).filter((a) => !a.startsWith('-') && a !== 'noshots');
  if (!models.length) models.push(process.env.OLLAMA_MODEL ?? 'gemma2:9b');

  for (const model of models) {
    process.stdout.write(`${model.padEnd(16)} … `);
    const r = await askModel(model, test, categories, useShots ? shots : []);
    r.total = test.length;
    const accuracy = ((r.correct / r.total) * 100).toFixed(0);
    const ofAnswered = r.correct + r.wrong > 0 ? ((r.correct / (r.correct + r.wrong)) * 100).toFixed(0) : '—';
    console.log(
      `${r.correct}/${r.total} correct (${accuracy}%) | of answered: ${ofAnswered}% | declined ${r.declined}` +
        `${r.failedBatches ? ` | ${r.failedBatches} bad batches` : ''} | ${r.seconds.toFixed(0)}s`,
    );
    for (const m of r.mistakes) console.log(`     ✗ ${m}`);
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
