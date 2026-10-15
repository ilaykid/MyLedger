<script setup lang="ts">
/**
 * "מה נכנס ומה יצא החודש, לפי נושאים."
 *
 * The three tiles at the top are hero numbers, not a chart - one number each is
 * the whole story, and a three-bar chart of them would say less. Everything
 * below is the same month grouped by category.
 *
 * The uncategorised call-out is not decoration. On a fresh import most of both sides
 * landed in "ללא קטגוריה", and a by-topic screen where one topic is "unknown"
 * answers nothing. So the gap is stated first, with its size, and links straight
 * to the transactions that cause it.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api, type Breakdown, type SyncHealth } from '../lib/api.js';
import { fmtILSRound, fmtMonth, fmtSigned, lastMonthKeys } from '../lib/format.js';
import DataHealth from '../components/DataHealth.vue';
import {useLatest} from '../lib/useLatest.js';
import BreakdownSection from '../components/BreakdownSection.vue';
import MonthlyExpenses from '../components/MonthlyExpenses.vue';

const months = lastMonthKeys(12).reverse();
const month = ref(months[0]);
const data = ref<Breakdown | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const latest=useLatest(),health=ref<SyncHealth|null>(null);
async function load() {
  const current=latest();
  loading.value = true;
  error.value = null;
  data.value = null;
  try {
    const result=await Promise.all([api.breakdown(month.value),api.syncHealth()]);
    if(!current())return;[data.value,health.value]=result;
  } catch (err) {
    if(current())error.value = err instanceof Error ? err.message : 'טעינה נכשלה';
  } finally {
    if(current())loading.value = false;
  }
}

onMounted(load);
watch(month, load);

/**
 * WHICH NET IS THE HEADLINE
 *
 * A month-to-date net is structurally negative for its whole first half:
 * salary lands in one beat, expenses flow every day. On day 11 this screen led
 * with a large "שלילי" in red while most of the salary was still due and the
 * dashboard was calling the very same cycle healthy. The number was true and
 * the story it told was false, which is worse than being wrong - a red verdict
 * that appears every month before payday teaches you to stop reading verdicts.
 *
 * So while the month is running, the projection is the headline and the
 * month-to-date figure is demoted to a supporting line that says out loud why
 * it looks the way it does. Once the month is over there is nothing to
 * project, and the actual net is the right and only answer.
 */
const verdictNet = computed(() => data.value?.projection?.net ?? data.value?.net ?? 0);
const positive = computed(() => verdictNet.value >= 0);
const running = computed(() => data.value?.projection != null);

/**
 * A forecast within a few hundred shekels of zero is not "positive" or
 * "negative" - it is level, and claiming a sign there is false precision from a
 * median-based estimate. A closed month has no such excuse and gets a verdict.
 */
const verdict = computed(() => {
  if (!data.value) return { label: '', tone: 'var(--text-muted)' };
  if(health.value?.reliability.status!=='complete')return {label:running.value?'הערכה · נתונים חלקיים':'סיכום הנתונים שנקלטו',tone:'var(--text-muted)'};
  if (!running.value) {
    return positive.value
      ? { label: 'עודף', tone: 'var(--status-good)' }
      : { label: 'גירעון', tone: 'var(--status-critical)' };
  }
  if (Math.abs(verdictNet.value) < 50_000) return { label: 'מאוזן', tone: 'var(--status-good)' };
  return positive.value
    ? { label: 'עודף צפוי', tone: 'var(--status-good)' }
    : { label: 'גירעון צפוי', tone: 'var(--status-warning)' };
});

/**
 * The projection's own components, derived from it rather than fetched
 * separately - so the three tiles under the headline sum to it exactly.
 */
const soFar = computed(() => {
  const p = data.value?.projection;
  if (!p) return null;
  const inSoFar = p.income - p.incomeExpected;
  const outSoFar = p.expense - p.fixedUpcoming - p.variableProjectedRest;
  return { in: inSoFar, out: outSoFar, net: inSoFar - outSoFar, still: p.fixedUpcoming + p.variableProjectedRest };
});

/** Amber, not red, for a projected shortfall: it is a heads-up, not a fact. */
const verdictFigureColor = computed(() =>
  !running.value
    ? positive.value
      ? 'var(--delta-up)'
      : 'var(--delta-down)'
    : Math.abs(verdictNet.value) < 50_000 || positive.value
      ? 'var(--delta-up)'
      : 'var(--status-warning)',
);
const empty = computed(() => data.value != null && data.value.income.total === 0 && data.value.expense.total === 0);

/** The share of each side sitting in no category at all. */
const unknown = computed(() => {
  const d = data.value;
  if (!d) return null;
  const inLine = d.income.lines.find((l) => l.categoryId == null);
  const outLine = d.expense.lines.find((l) => l.categoryId == null);
  const amount = (inLine?.amount ?? 0) + (outLine?.amount ?? 0);
  const total = d.income.total + d.expense.total;
  if (amount === 0 || total === 0) return null;
  return { amount, pct: Math.round((amount / total) * 100) };
});

// Compare deposits to the calculated surplus without inferring their funding source.
const savingsVerdict = computed(() => {
  const d=data.value;
  if(!d||!d.savings.total)return null;
  const surplus=d.projection?.net??d.net;
  const covered=Math.max(0,Math.min(d.savings.total,surplus));
  const partial=health.value?.reliability.status!=='complete';
  return {
    tone: partial?'neutral' as const:covered>=d.savings.total?'good' as const:'partial' as const,
    icon:'',
    headline:partial?'הפקדות שנקלטו · התמונה עדיין חלקית':covered>=d.savings.total?'העודף המחושב מכסה את ההפקדות':'ההפקדות גבוהות מהעודף המחושב',
    line:partial?'הסכום מתאר העברות לחיסכון. נתונים חסרים עשויים לשנות את מאזן החודש.':running.value?'ההשוואה מבוססת על תחזית לסוף החודש, ועשויה להשתנות.':'השוואה בין ההפקדות לעודף שנקלט בחודש. אינה קובעת מאיזה מקור מומנו ההפקדות.',
    covered,
  };
});

/** Green only when the month actually paid for the deposit. */
const savingsTint = computed(() => {
  const tone = savingsVerdict.value?.tone;
  if (tone === 'good') return 'var(--status-good)';
  if (tone === 'partial') return 'var(--status-warning)';
  return 'var(--text-secondary)';
});

const budgetPct = computed(() => {
  const b = data.value?.budget;
  if (!b || b.totalBudget === 0) return null;
  return Math.round((b.totalSpent / b.totalBudget) * 100);
});
</script>

<template>
  <div class="space-y-4">
    <div class="page-heading">
      <div><h1>לאן הכסף הולך</h1><p>הכנסות והוצאות לפי קטגוריה.</p></div>
      <!-- filters in one row above the content; this page alone counts calendar months, so it says so here -->
      <label class="period-picker">
        <span class="sr-only">חודש לניתוח</span>
        <select v-model="month" class="field" aria-describedby="breakdown-period-hint">
          <option v-for="m in months" :key="m" :value="m">{{ fmtMonth(m) }}</option>
        </select>
        <small id="breakdown-period-hint">לפי חודש קלנדרי (1 עד סוף החודש)</small>
      </label>
    </div>

    <DataHealth :health="health" :error="error??undefined" :loading="loading" compact/>
    <div v-if="error" class="error-banner" role="alert">{{ error }} <button class="text-link" @click="load">ניסיון חוזר</button></div>
    <p v-if="loading" class="loading-line" role="status">טוען את הנתונים…</p>

    <p v-if="empty" class="card p-6 text-center text-sm" :style="{ color: 'var(--text-muted)' }">
      <span aria-hidden="true">📭</span> אין תנועות בחודש הזה.
    </p>

    <template v-else-if="data">
      <!--
        THE CONCLUSION, FIRST AND BIGGEST.

        While the month runs this is the projection; once it is over it is the
        actual net. The two figures the projection is built from - what has come
        in and what has gone out so far - sit underneath at a quarter of the
        weight, because they are evidence for the conclusion rather than the
        conclusion. The previous layout gave all three equal billing and let the
        most misleading of them wear the verdict badge.
      -->
      <div class="analysis-summary" :class="{ 'opacity-50': loading }">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-semibold" :style="{ color: 'var(--text-secondary)' }">
            <!-- The projection is the current cycle's (the same figure as the home
                 screen), which can run past the calendar month - so it says so. -->
            {{ running ? (positive ? 'עודף צפוי בסוף המחזור' : 'גירעון צפוי בסוף המחזור') : 'מאזן החודש' }}
          </p>
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold"
            :style="{
              color: verdict.tone,
              background: `color-mix(in srgb, ${verdict.tone} 12%, transparent)`,
            }"
          >
            <span class="h-1.5 w-1.5 rounded-full" :style="{ background: verdict.tone }"></span>
            {{ verdict.label }}
          </span>
        </div>

        <p class="hero-figure mt-2" :style="{ color: verdictFigureColor, fontSize: 'clamp(2rem, 7vw, 3rem)' }">
          {{ fmtSigned(verdictNet) }}
        </p>

        <p v-if="data.projection" class="mt-1.5 text-sm" :style="{ color: 'var(--text-secondary)' }">
          יום {{ data.projection.daysElapsed }} מתוך {{ data.projection.daysTotal }} במחזור · כמו במסך החודש
        </p>
        <p v-else class="mt-1.5 text-sm" :style="{ color: 'var(--text-secondary)' }">
          החודש נסגר. הכנסות פחות הוצאות שנספרות בתזרים, בלי הפקדות לחיסכון.
        </p>

        <!--
          The equation, same shape as the dashboard card: what happened, plus
          what is still coming, minus what is still going out - the headline is
          their sum. One row, each figure exactly once; the previous layout
          spread the same numbers over a sentence AND a stat row.
        -->
        <details class="mt-4"><summary class="text-link">המרכיבים של מאזן החודש</summary><div class="mt-4 grid gap-2 sm:grid-cols-3">
          <template v-if="running && soFar">
            <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">מאזן בפועל עד היום</p>
              <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--text-secondary)' }">
                {{ fmtSigned(soFar.net) }}
              </p>
              <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">
                נכנס {{ fmtILSRound(soFar.in) }} · יצא {{ fmtILSRound(soFar.out) }}
              </p>
            </div>
            <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">+ צפוי עוד להיכנס</p>
              <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-1)' }">
                {{ fmtILSRound(data.projection!.incomeExpected) }}
              </p>
              <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">משכורות וקבועות שטרם הגיעו</p>
            </div>
            <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">− צפוי עוד לצאת</p>
              <p class="tnum mt-0.5 text-lg font-semibold">{{ fmtILSRound(soFar.still) }}</p>
              <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">קבועות שטרם חויבו + קצב ההוצאות</p>
            </div>
          </template>

          <template v-else>
            <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">נכנס</p>
              <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-1)' }">
                {{ fmtILSRound(data.income.total) }}
              </p>
            </div>
            <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">− יצא</p>
              <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-8)' }">
                {{ fmtILSRound(data.expense.total) }}
              </p>
            </div>
          </template>
        </div></details>
      </div>

      <!-- The screen is worthless while this is large, so it goes first. -->
      <p
        v-if="unknown && unknown.pct >= 10"
        class="card p-4 text-sm"
        :style="{ background: 'color-mix(in srgb, var(--status-warning) 12%, var(--surface-1))', color: 'var(--text-secondary)' }"
      >
        <span aria-hidden="true">⚠️</span>
        <span class="font-semibold">{{ unknown.pct }}%</span>
        מהתנועות החודש ({{ fmtILSRound(unknown.amount) }}) עוד לא מסווגות, ולכן החלוקה לנושאים חלקית.
        <RouterLink :to="`/transactions?month=${month}&category=none`" class="font-semibold underline">
          לסווג אותן ←
        </RouterLink>
      </p>

      <MonthlyExpenses :expense="data.expense" :month="month" />
      <div>
        <BreakdownSection
          title="הכנסות"
          direction="in"
          :lines="data.income.lines"
          :total="data.income.total"
          fixed-label="קבועה"
          :fixed-amount="data.income.fixed"
          variable-label="משתנה"
          :variable-amount="data.income.variable"
          :month="month"
        />
      </div>

      <!--
        Saving, separately from the two ledgers: it is not
        an expense, and the whole point is that it does not read as one.
      -->
      <details v-if="savingsVerdict && data.savings" class="fold"><summary>הפקדות לחיסכון · {{fmtILSRound(data.savings.total)}}</summary><div>
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="section-title">
            <span aria-hidden="true">{{ savingsVerdict.icon }}</span> הפקדות לחיסכון
          </h2>
          <p class="hero-figure" :style="{ color: savingsTint }">
            {{ fmtILSRound(data.savings.total) }}
          </p>
        </div>
        <p class="mt-1 text-sm font-semibold" :style="{ color: savingsTint }">
          {{ savingsVerdict.headline }}
        </p>
        <p class="mt-0.5 text-sm" :style="{ color: 'var(--text-secondary)' }">{{ savingsVerdict.line }}</p>

        <!--
          Share of income, against the 20% mark rather than against 100%: a bar
          that can only ever fill a fifth says nothing.

          Shown only when the month paid for the deposit. A full green bar above
          a deficit is the exact reading this panel exists to avoid.
        -->
        <template v-if="savingsVerdict.covered >= data.savings.total && data.income.total > 0">
          <div class="mt-3 h-2 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
            <div
              class="fill-in h-full rounded-full"
              :style="{
                width: `${Math.min(100, data.savings.rateOfIncome * 500)}%`,
                background: savingsTint,
              }"
            ></div>
          </div>
          <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
            {{ Math.round(data.savings.rateOfIncome * 100) }}% מההכנסות
          </p>
        </template>

        <!-- Otherwise the honest bar is how much of the deposit the month covered. -->
        <template v-else>
          <div class="mt-3 h-2 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
            <div
              class="fill-in h-full rounded-full"
              :style="{
                width: `${Math.min(100, (savingsVerdict.covered / data.savings.total) * 100)}%`,
                background: savingsTint,
              }"
            ></div>
          </div>
          <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
            {{ fmtILSRound(savingsVerdict.covered) }} מתוך {{ fmtILSRound(data.savings.total) }} מכוסים בעודף המחושב
          </p>
        </template>

        <ul class="mt-3 space-y-1 text-sm">
          <li
            v-for="l in data.savings.lines"
            :key="l.categoryId ?? '__none__'"
            class="flex items-baseline gap-2"
          >
            <span aria-hidden="true">{{ l.icon }}</span>
            <span class="min-w-0 grow truncate">{{ l.name }}</span>
            <span class="tnum shrink-0 font-semibold">{{ fmtILSRound(l.amount) }}</span>
          </li>
        </ul>
        <p class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
          הסכום הזה לא נכלל ב"יצא" ולא במאזן — הוא עבר חשבון, לא נעלם.
        </p>
      </div></details>

      <!-- budget, only when there is something to say -->
      <div v-if="budgetPct != null" class="card p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="section-title">התקציבים</h2>
          <p class="text-sm" :style="{ color: 'var(--text-secondary)' }">
            <span class="tnum font-semibold">{{ fmtILSRound(data.budget.totalSpent) }}</span>
            מתוך
            <span class="tnum font-semibold">{{ fmtILSRound(data.budget.totalBudget) }}</span>
            ב-{{ data.budget.tracked }} קטגוריות
          </p>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
          <div
            class="fill-in h-full rounded-full"
            :style="{
              width: `${Math.min(100, budgetPct)}%`,
              background: budgetPct > 100 ? 'var(--status-critical)' : budgetPct >= 85 ? 'var(--status-warning)' : 'var(--status-good)',
            }"
          ></div>
        </div>
        <p class="mt-2 text-sm" :style="{ color: 'var(--text-secondary)' }">
          <template v-if="data.budget.over > 0">
            <span aria-hidden="true">🔴</span>
            <span class="font-semibold">{{ data.budget.over }}</span>
            {{ data.budget.over === 1 ? 'קטגוריה חרגה' : 'קטגוריות חרגו' }} מהתקציב.
          </template>
          <template v-else><span class="font-semibold" :style="{ color: 'var(--status-good)' }">בתוך התקציב.</span> כל הקטגוריות המוגדרות עומדות ביעד.</template>
          <span v-if="data.budget.unbudgeted > 0" :style="{ color: 'var(--text-muted)' }">
            עוד {{ fmtILSRound(data.budget.unbudgeted) }} יצאו בקטגוריות בלי תקציב מוגדר.
          </span>
        </p>
      </div>

      <!-- Shown separately on purpose: real money, deliberately outside the verdict. -->
      <details v-if="data.excluded.lines.length > 0" class="fold"><summary>תנועות שלא נספרות במאזן החודשי</summary>
      <BreakdownSection
        title="לא נספר בתזרים"
        direction="out"
        :lines="data.excluded.lines"
        :total="data.excluded.in + data.excluded.out"
        fixed-label="נכנס"
        :fixed-amount="data.excluded.in"
        variable-label="יצא"
        :variable-amount="data.excluded.out"
        :month="month"
      />
      <p v-if="data.excluded.lines.length > 0" class="text-xs" :style="{ color: 'var(--text-muted)' }">
        הסכומים האלה שינו את היתרה בבנק אבל לא נספרים במאזן למעלה — הם לא מלמדים על החודש הבא.
      </p></details>
    </template>
  </div>
</template>

<style scoped>.period-picker{display:flex;flex-direction:column;gap:4px}.period-picker small{font-size:12px;color:var(--text-muted)}.analysis-summary{padding:20px 0 24px;border-bottom:1px solid var(--border)}.analysis-summary>.hero-figure{color:var(--text-primary)!important;font-weight:550}.analysis-summary>p{max-width:720px}</style>
