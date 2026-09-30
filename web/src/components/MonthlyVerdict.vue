<script setup lang="ts">
/**
 * The headline question: did this month cost more than it earned?
 *
 * Two marks, deliberately:
 *  - a verdict for the selected month, stated in words as well as a number
 *  - twelve months of net as a diverging bar strip, so a single bad month is
 *    obviously different from a trend
 *
 * Diverging form (above/below a zero baseline) uses the validated blue↔red pair
 * with a neutral zero rule - not green/red, which is the single worst pair under
 * colour-blindness. Direction is never carried by colour alone: every bar has a
 * sign in its tooltip, the verdict says "חיובי"/"שלילי" in words, and the table
 * view lists every value.
 */
import { computed, ref } from 'vue';
import type { MonthlyNet } from '../lib/api.js';
import { fmtILS, fmtILSRound, fmtMonth, fmtMonthShort, fmtSigned, fmtSignedFull } from '../lib/format.js';

const props = defineProps<{
  months: MonthlyNet[];
  selectedMonth: string;
  /**
   * Where the cycle is heading, from the cash-flow engine. Only meaningful for
   * a month still in progress; pass null (or omit) otherwise.
   */
  projection?: {
    net: number;
    incomeExpected: number;
    stillToSpend: number;
    /** Income already received / fixed+variable already paid, from the SAME
     *  snapshot as `net` - so the three tiles below always sum to the headline
     *  exactly, instead of "roughly, unless the cycle anchor moves". */
    soFarIn: number;
    soFarOut: number;
    daysElapsed: number;
    daysTotal: number;
  } | null;
}>();

const showTable = ref(false);
const hovered = ref<string | null>(null);

const selected = computed(
  () => props.months.find((m) => m.month === props.selectedMonth) ?? props.months[props.months.length - 1] ?? null,
);

/**
 * WHICH NUMBER GETS THE HEADLINE
 *
 * Month-to-date net is structurally negative for the whole first half of every
 * month: salary lands in one beat, expenses flow daily. This card led with it in
 * 48px red - "🔴 תזרים שלילי" - on a day when most of the salary was
 * still due and the cycle was in fact fine. The caveat underneath ("החודש עוד
 * לא הסתיים") was true and useless: nobody reads a footnote after reading a
 * headline that size.
 *
 * So while the month runs, the verdict is the projection and the actual-so-far
 * figure moves down into the facts list. A finished month has nothing to
 * project and keeps the verdict it earned.
 */
const forecasting = computed(() => selected.value != null && !selected.value.complete && props.projection != null);
const verdictNet = computed(() =>
  forecasting.value ? (props.projection?.net ?? 0) : (selected.value?.net ?? 0),
);
const positive = computed(() => verdictNet.value >= 0);

/**
 * A forecast this close to zero has no business claiming a sign - it is built
 * from a median daily rate, not from receipts.
 */
const LEVEL = 50_000;
const level = computed(() => forecasting.value && Math.abs(verdictNet.value) < LEVEL);

/** What has actually happened so far - the first term of the equation below. */
const soFarNet = computed(() =>
  props.projection ? props.projection.soFarIn - props.projection.soFarOut : 0,
);

const verdict = computed(() => {
  if (level.value) return { icon: '⚖️', label: 'תזרים מאוזן', tone: 'var(--status-good)' };
  if (positive.value) {
    return {
      icon: '✅',
      label: forecasting.value ? 'צפוי להסתיים בחיוב' : 'תזרים חיובי',
      tone: 'var(--delta-up)',
    };
  }
  return {
    icon: forecasting.value ? '⚠️' : '🔴',
    label: forecasting.value ? 'צפוי להסתיים בחיסרון' : 'תזרים שלילי',
    // Amber for a forecast, red only for something that already happened.
    tone: forecasting.value ? 'var(--status-warning)' : 'var(--delta-down)',
  };
});

/** Both directions collapse to one figure on the card; the caveat splits them. */
const excluded = computed(() => (selected.value?.excludedIn ?? 0) + (selected.value?.excludedOut ?? 0));

/** Share of the month's income that was not the plannable kind, 0-100. */
const reliance = computed(() => {
  const m = selected.value;
  if (!m || m.income <= 0) return null;
  return Math.round((m.incomeVariable / m.income) * 100);
});
/** No movement at all is not a positive month - it is an empty one. */
const empty = computed(() => !selected.value || (selected.value.income === 0 && selected.value.expense === 0));

/**
 * Without a bank account there is no income, so every month looks catastrophic.
 * That is a coverage gap, not a finding, and saying so is the difference between
 * a useful dashboard and an alarming one.
 */
const noIncomeTracked = computed(() => props.months.every((m) => m.income === 0));

/** Only completed months can be judged; the current one is still moving. */
const finished = computed(() => props.months.filter((m) => m.complete && (m.income > 0 || m.expense > 0)));
const positiveCount = computed(() => finished.value.filter((m) => m.net >= 0).length);
const averageNet = computed(() =>
  finished.value.length ? Math.round(finished.value.reduce((s, m) => s + m.net, 0) / finished.value.length) : 0,
);

/** Symmetric scale so a +1000 bar and a -1000 bar are the same length. */
const scale = computed(() => Math.max(1, ...props.months.map((m) => Math.abs(m.net))));
const heightPct = (net: number) => (Math.abs(net) / scale.value) * 100;

const active = computed(() => props.months.find((m) => m.month === hovered.value) ?? null);
</script>

<template>
  <section class="card rise p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="section-title">התזרים החודשי</h2>
        <p class="section-hint mt-0.5">{{ selected ? fmtMonth(selected.month) : '' }}</p>
      </div>
      <button class="btn btn-ghost !py-1 !text-xs" :aria-pressed="showTable" @click="showTable = !showTable">
        {{ showTable ? 'תצוגת גרף' : 'תצוגת טבלה' }}
      </button>
    </div>

    <!-- the verdict, then the numbers it is made of - one column, one order -->
    <div v-if="selected" class="mt-4">
      <div>
        <template v-if="empty">
          <p class="text-2xl font-bold" :style="{ color: 'var(--text-muted)' }">
            <span aria-hidden="true">📭</span> אין עדיין תנועות
          </p>
          <p class="mt-1.5 text-sm" :style="{ color: 'var(--text-muted)' }">
            לא נרשמה שום תנועה בחודש הזה.
          </p>
        </template>

        <template v-else>
          <p class="text-2xl font-bold" :style="{ color: verdict.tone }">
            <span aria-hidden="true">{{ verdict.icon }}</span>
            {{ verdict.label }}
          </p>
          <p class="hero-figure mt-1.5" :style="{ color: verdict.tone }">
            {{ fmtSignedFull(verdictNet) }}
          </p>
          <!-- Context only. The actual figures live in the equation below, once. -->
          <p v-if="forecasting && projection" class="mt-1.5 text-xs" :style="{ color: 'var(--text-muted)' }">
            צפי לסוף החודש · יום {{ projection.daysElapsed }} מתוך {{ projection.daysTotal }}
          </p>
          <p v-else-if="!selected.complete" class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
            החודש עוד לא הסתיים — המספר ישתנה
          </p>
        </template>
      </div>

      <!--
        THE EQUATION, IN STORY ORDER.

        These numbers used to be scattered three ways: a side list, a clause in
        the subtitle, and a footnote row - three glances to reconstruct one
        piece of arithmetic. But they ARE arithmetic: what has happened, plus
        what is still coming in, minus what is still going out, IS the headline.
        So they sit in one row, in that order, each with its sign, and the sum
        is the number above them. Everything appears exactly once.

        All three come from the same snapshot as the headline, so the equation
        balances to the agora by construction, not by coincidence.
      -->
      <div v-if="!empty" class="mt-4 grid gap-2 sm:grid-cols-3">
        <template v-if="forecasting && projection">
          <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">מאזן בפועל עד היום</p>
            <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--text-secondary)' }">
              {{ fmtSigned(soFarNet) }}
            </p>
            <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">
              נכנס {{ fmtILSRound(projection.soFarIn) }} · יצא {{ fmtILSRound(projection.soFarOut) }}
            </p>
          </div>
          <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">+ צפוי עוד להיכנס</p>
            <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-1)' }">
              {{ fmtILSRound(projection.incomeExpected) }}
            </p>
            <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">משכורות וקבועות שטרם הגיעו</p>
          </div>
          <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">− צפוי עוד לצאת</p>
            <p class="tnum mt-0.5 text-lg font-semibold">{{ fmtILSRound(projection.stillToSpend) }}</p>
            <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">קבועות שטרם חויבו + קצב ההוצאות</p>
          </div>
        </template>

        <!-- A closed month is a shorter story: in, out, and what was put aside. -->
        <template v-else>
          <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">נכנס</p>
            <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-1)' }">
              {{ fmtILSRound(selected.income) }}
            </p>
            <p
              v-if="selected.incomeVariable > 0 && selected.incomeFixed > 0"
              class="mt-0.5 text-xs"
              :style="{ color: 'var(--text-muted)' }"
            >
              קבועה {{ fmtILSRound(selected.incomeFixed) }} · משתנה {{ fmtILSRound(selected.incomeVariable) }}
            </p>
          </div>
          <div class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">− יצא</p>
            <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--series-8)' }">
              {{ fmtILSRound(selected.expense) }}
            </p>
          </div>
          <div v-if="selected.savings > 0" class="rounded-lg p-3" :style="{ background: 'var(--surface-2)' }">
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }"><span aria-hidden="true">🐷</span> הופקד לחיסכון</p>
            <p class="tnum mt-0.5 text-lg font-semibold" :style="{ color: 'var(--status-good)' }">
              {{ fmtILSRound(selected.savings) }}
            </p>
            <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">מחוץ לנטו — הכסף עדיין שלך</p>
          </div>
        </template>
      </div>

      <!-- Outside the equation on purpose: a deposit is not part of the verdict. -->
      <p
        v-if="!empty && forecasting && selected.savings > 0"
        class="mt-2 text-xs"
        :style="{ color: 'var(--text-muted)' }"
      >
        <span aria-hidden="true">🐷</span>
        בנוסף הופקדו <span class="tnum font-semibold">{{ fmtILSRound(selected.savings) }}</span> לחיסכון —
        מחוץ למשוואה שלמעלה, הכסף עדיין שלך.
      </p>
    </div>

    <!--
      How much of the month rested on income that may simply not arrive again.
      Past a threshold this is the single most important thing on the card: a
      positive month carried by a tax refund is not a repeatable positive month.
    -->
    <p
      v-if="reliance != null && reliance >= 30"
      class="mt-3 rounded-lg p-3 text-sm"
      :style="{ background: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', color: 'var(--text-secondary)' }"
    >
      <span aria-hidden="true">📈</span>
      <span class="font-semibold">{{ reliance }}%</span>
      מההכנסה החודש הייתה הכנסה משתנה. אל תתכנן את החודש הבא לפי המספר הזה.
    </p>

    <!--
      The verdict deliberately excludes non-cash-flow items, so in a month that
      had one the headline and the bank balance disagree. Saying so is the
      difference between a model and a lie.
    -->
    <p
      v-if="selected && excluded > 0"
      class="mt-3 rounded-lg p-3 text-sm"
      :style="{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }"
    >
      <span aria-hidden="true">⚡</span>
      בנוסף
      <template v-if="selected.excludedOut > 0">
        יצאו <span class="tnum font-semibold">{{ fmtILSRound(selected.excludedOut) }}</span>
      </template>
      <template v-if="selected.excludedOut > 0 && selected.excludedIn > 0"> ו־ </template>
      <template v-if="selected.excludedIn > 0">
        נכנסו <span class="tnum font-semibold">{{ fmtILSRound(selected.excludedIn) }}</span>
      </template>
      שסומנו כלא-תזרימיים. הם שינו את היתרה אבל לא נספרים בתזרים — הם לא מלמדים כלום על החודש הבא.
    </p>

    <!-- The number is only as honest as its inputs - say so rather than alarm. -->
    <p
      v-if="noIncomeTracked"
      class="mt-3 rounded-lg p-3 text-sm"
      :style="{ background: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', color: 'var(--text-secondary)' }"
    >
      <span aria-hidden="true">⚠️</span>
      אין הכנסות רשומות — רק כרטיסי אשראי מחוברים, ולכן כל חודש נראה שלילי.
      חברו חשבון בנק בעמוד <RouterLink to="/connections" class="font-semibold underline">חיבורים</RouterLink>
      כדי לקבל תזרים אמיתי.
    </p>

    <!-- table view: every value, no hovering needed -->
    <div
      v-if="showTable"
      class="mt-5 max-h-64 overflow-y-auto rounded-xl border"
      :style="{ borderColor: 'var(--gridline)' }"
    >
      <table class="w-full text-sm">
        <caption class="sr-only">תזרים נטו לפי חודש</caption>
        <thead class="sticky top-0" :style="{ background: 'var(--surface-2)' }">
          <tr class="text-right" :style="{ color: 'var(--text-muted)' }">
            <th scope="col" class="px-3 py-2 font-medium">חודש</th>
            <th scope="col" class="px-3 py-2 font-medium">נכנס</th>
            <th scope="col" class="px-3 py-2 font-medium">מזה משתנה</th>
            <th scope="col" class="px-3 py-2 font-medium">יצא</th>
            <th scope="col" class="px-3 py-2 font-medium">לחיסכון</th>
            <th scope="col" class="px-3 py-2 font-medium">לא תזרימי</th>
            <th scope="col" class="px-3 py-2 font-medium">נטו</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in [...months].reverse()"
            :key="m.month"
            class="border-t"
            :style="{ borderColor: 'var(--gridline)' }"
          >
            <td class="px-3 py-1.5">
              {{ fmtMonth(m.month) }}
              <span v-if="!m.complete" class="text-xs" :style="{ color: 'var(--text-muted)' }">(חלקי)</span>
            </td>
            <td class="tnum px-3 py-1.5">{{ fmtILSRound(m.income) }}</td>
            <td class="tnum px-3 py-1.5" :style="{ color: 'var(--text-muted)' }">
              {{ m.incomeVariable > 0 ? fmtILSRound(m.incomeVariable) : '—' }}
            </td>
            <td class="tnum px-3 py-1.5">{{ fmtILSRound(m.expense) }}</td>
            <td class="tnum px-3 py-1.5" :style="{ color: m.savings > 0 ? 'var(--status-good)' : 'var(--text-muted)' }">
              {{ m.savings > 0 ? fmtILSRound(m.savings) : '—' }}
            </td>
            <td class="tnum px-3 py-1.5" :style="{ color: 'var(--text-muted)' }">
              {{ m.excludedIn + m.excludedOut > 0 ? fmtILSRound(m.excludedIn + m.excludedOut) : '—' }}
            </td>
            <td
              class="tnum px-3 py-1.5 font-semibold"
              :style="{ color: m.net >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }"
            >
              {{ fmtSigned(m.net) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 12-month diverging strip -->
    <div v-else class="mt-5">
      <div class="relative" :style="{ height: '132px' }" @pointerleave="hovered = null">
        <!-- zero baseline -->
        <div
          class="absolute inset-x-0 h-px"
          :style="{ top: '50%', background: 'var(--baseline)' }"
          aria-hidden="true"
        ></div>

        <div class="flex h-full items-stretch gap-1">
          <button
            v-for="m in months"
            :key="m.month"
            type="button"
            class="group relative flex-1 cursor-default"
            :aria-label="`${fmtMonth(m.month)}: נטו ${m.net >= 0 ? 'חיובי' : 'שלילי'} ${fmtILSRound(Math.abs(m.net))}${m.excludedIn + m.excludedOut > 0 ? `, ובנוסף ${fmtILSRound(m.excludedIn + m.excludedOut)} לא תזרימי` : ''}`"
            @pointerenter="hovered = m.month"
            @focus="hovered = m.month"
            @blur="hovered = null"
          >
            <!-- upper half: positive months grow up from the baseline -->
            <span
              v-if="m.net >= 0"
              class="absolute inset-x-0 rounded-t"
              :style="{
                bottom: '50%',
                height: `${heightPct(m.net) / 2}%`,
                background: 'var(--series-1)',
                opacity: m.complete ? 1 : 0.55,
                outline: hovered === m.month ? '2px solid var(--text-primary)' : 'none',
                outlineOffset: '1px',
              }"
            ></span>
            <!-- lower half: negative months grow down -->
            <span
              v-else
              class="absolute inset-x-0 rounded-b"
              :style="{
                top: '50%',
                height: `${heightPct(m.net) / 2}%`,
                background: 'var(--series-8)',
                opacity: m.complete ? 1 : 0.55,
                outline: hovered === m.month ? '2px solid var(--text-primary)' : 'none',
                outlineOffset: '1px',
              }"
            ></span>
          </button>
        </div>

        <!-- readout -->
        <div
          v-if="active"
          class="pointer-events-none absolute inset-x-0 top-0 text-center text-xs"
          :style="{ color: 'var(--text-secondary)' }"
        >
          <span class="tnum font-bold" :style="{ color: active.net >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }">
            {{ fmtSigned(active.net) }}
          </span>
          · {{ fmtMonth(active.month) }}
        </div>
      </div>

      <!-- A ⚡ marks a month whose bar deliberately omits non-cash-flow money, so
           the strip never quietly disagrees with the balance. Shape, not colour. -->
      <div class="mt-1.5 flex gap-1 text-center text-xs" :style="{ color: 'var(--text-muted)' }">
        <span v-for="m in months" :key="m.month" class="flex-1 truncate">
          <span
            v-if="m.excludedIn + m.excludedOut > 0"
            :title="`בנוסף ${fmtILSRound(m.excludedIn + m.excludedOut)} לא תזרימי`"
            >⚡</span
          >
          {{ fmtMonthShort(m.month) }}
        </span>
      </div>
    </div>

    <!-- the trend, in one sentence -->
    <p
      v-if="finished.length && !noIncomeTracked"
      class="mt-4 border-t pt-3 text-sm"
      :style="{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }"
    >
      <span class="font-semibold">{{ positiveCount }} מתוך {{ finished.length }}</span>
      החודשים האחרונים הסתיימו בחיוב, בממוצע
      <span class="tnum font-semibold" :style="{ color: averageNet >= 0 ? 'var(--delta-up)' : 'var(--delta-down)' }">
        {{ fmtSigned(averageNet) }}
      </span>
      לחודש.
    </p>

    <!-- Without income the net is meaningless, but the spend trend still is. -->
    <p
      v-else-if="finished.length"
      class="mt-4 border-t pt-3 text-sm"
      :style="{ borderColor: 'var(--gridline)', color: 'var(--text-secondary)' }"
    >
      הוצאת בממוצע
      <span class="tnum font-semibold">{{ fmtILSRound(Math.abs(averageNet)) }}</span>
      לחודש ב-{{ finished.length }} החודשים האחרונים.
    </p>
  </section>
</template>
