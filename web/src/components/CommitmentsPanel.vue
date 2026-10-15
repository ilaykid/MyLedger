<script setup lang="ts">
/**
 * The frame of the month: what you reliably earn against what you are already
 * committed to pay.
 *
 * This is the question underneath every other number on the dashboard. "Left to
 * spend" answers *this* cycle; coverage answers whether the shape of the month
 * works at all. At 48% the month has slack; at 91% almost every shekel of
 * dependable income is spoken for before any choice is made; past 100% the
 * commitments are only met by income that made no promise to arrive.
 *
 * WHY BOTH SIDES ARE SPLIT
 * Half of each side has not happened yet - salary still to land, standing orders
 * and instalments still to be charged. Showing only what has already moved makes
 * early-month look wealthy and late-month look grim, which is precisely the
 * illusion a cash-flow tool exists to remove. The forecast portion is drawn with
 * a hatch rather than a paler shade: texture survives colour-blindness, print,
 * and forced-colours mode, and it is labelled in words as well.
 *
 * Both bars share one denominator so their lengths are directly comparable -
 * two bars on independent scales would be a dual-axis chart wearing a disguise.
 */
import { computed, ref } from 'vue';
import type { Cashflow, SpreadPlan } from '../lib/api.js';
import { fmtCount, fmtILSRound, fmtSigned } from '../lib/format.js';

const props = defineProps<{ data: Cashflow; spreads?: SpreadPlan[]; month?: string }>();
const emit = defineEmits<{ saveNote: [transactionId: string, note: string | null] }>();

/**
 * Spread plans landing in the shown month.
 *
 * Part of "fixed income" here is recognition of a lump sum that arrived months
 * ago, and without saying so the figure is unexplainable - "why does the system
 * think this much salary arrived?" The note is the answer, so it belongs next to
 * the number it explains rather than only on the transaction row that caused it.
 */
const activeSpreads = computed(() =>
  (props.spreads ?? [])
    .map((p) => ({ plan: p, slice: p.slices.find((s) => s.month === props.month) }))
    .filter((x): x is { plan: SpreadPlan; slice: { month: string; amount: number } } => x.slice != null),
);

/**
 * The fixed charges still to come. "צפוי עוד ₪1,350" is a number you have to
 * take on faith unless it can be opened up - but the planning page already
 * lists every upcoming event once, so this links there instead of repeating it.
 */
const upcomingFixed = computed(() =>
  props.data.upcoming
    .filter((e) => e.kind === 'fixed' && !e.actual)
    .sort((a, b) => a.date.localeCompare(b.date)),
);

const editing = ref<string | null>(null);
const draft = ref('');
const saving = ref(false);

function startEdit(plan: SpreadPlan) {
  editing.value = plan.transactionId;
  draft.value = plan.note ?? '';
}

async function commit(plan: SpreadPlan) {
  saving.value = true;
  try {
    emit('saveNote', plan.transactionId, draft.value.trim() || null);
    editing.value = null;
  } finally {
    saving.value = false;
  }
}

/** Recurring income detected as regular; the only income worth planning around. */
const incomeArrived = computed(() => props.data.income.fixedReceived);
const incomeExpected = computed(() => props.data.income.expected);
const fixedIncome = computed(() => incomeArrived.value + incomeExpected.value);

const paid = computed(() => props.data.fixed.paid);
const upcoming = computed(() => props.data.fixed.upcoming);
const commitments = computed(() => props.data.fixed.total);

const leftover = computed(() => fixedIncome.value - commitments.value);
const covered = computed(() => leftover.value >= 0);

/** 0..1+ — how much of dependable income the commitments consume. */
const coverage = computed(() =>
  fixedIncome.value > 0 ? commitments.value / fixedIncome.value : commitments.value > 0 ? Infinity : 0,
);

const coveragePct = computed(() =>
  Number.isFinite(coverage.value) ? Math.round(coverage.value * 100) : null,
);

/** One shared scale, so bar length means the same thing on both rows. */
const scale = computed(() => Math.max(1, fixedIncome.value, commitments.value));
const pct = (v: number) => `${Math.max(0, (v / scale.value) * 100)}%`;

const verdict = computed(() => {
  if (fixedIncome.value === 0 && commitments.value === 0) return null;
  if (!Number.isFinite(coverage.value)) {
    return {
      tone: 'var(--status-critical)',
      icon: '🔴',
      text: 'יש הוצאות קבועות בלי הכנסה קבועה שתכסה אותן.',
    };
  }
  if (coverage.value > 1) {
    return {
      tone: 'var(--status-critical)',
      icon: '🔴',
      text: 'ההוצאות הקבועות גדולות מההכנסה הקבועה. הפער נסגר מהכנסה משתנה — שלא הבטיחה להגיע.',
    };
  }
  if (coverage.value >= 0.85) {
    return {
      tone: 'var(--status-warning)',
      icon: '⚠️',
      text: 'כמעט כל ההכנסה הקבועה תפוסה עוד לפני ההוצאות המשתנות.',
    };
  }
  return {
    tone: 'var(--status-good)',
    icon: '✅',
    text: 'אחרי כל ההוצאות הקבועות נשאר מרווח מההכנסה הקבועה להוצאות המשתנות.',
  };
});

const rows = computed(() => [
  {
    key: 'income',
    label: 'הכנסה קבועה',
    hue: 'var(--series-1)',
    total: fixedIncome.value,
    solid: incomeArrived.value,
    forecast: incomeExpected.value,
    solidLabel: 'נכנס',
    forecastLabel: 'צפוי עוד',
  },
  {
    key: 'fixed',
    label: 'הוצאות קבועות',
    hue: 'var(--series-8)',
    total: commitments.value,
    solid: paid.value,
    forecast: upcoming.value,
    solidLabel: 'שולם',
    forecastLabel: 'צפוי עוד',
  },
]);
</script>

<template>
  <!-- Nothing fixed either way: the panel has no question to answer. -->
  <section v-if="verdict" class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 class="section-title">הכנסות קבועות מול הוצאות קבועות</h2>
        <p class="section-hint mt-0.5">מה שבטוח נכנס, מול מה שכבר מחויב לצאת</p>
      </div>
      <!-- Gated on `verdict`, not on the number: a month with no fixed income
           and no commitments has a defined 0% that means nothing, and a
           "0% תפוס" badge on an empty month reads as a real finding. -->
      <span
        v-if="verdict && coveragePct != null"
        class="chip"
        :style="{
          background: `color-mix(in srgb, ${verdict.tone} 14%, transparent)`,
          color: 'var(--text-primary)',
        }"
      >
        <span aria-hidden="true">{{ verdict.icon }}</span>
        {{ coveragePct }}% מההכנסה הקבועה תפוס
      </span>
    </div>

    <ul class="mt-5 space-y-4">
      <li v-for="r in rows" :key="r.key">
        <div class="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
          <span :style="{ color: 'var(--text-secondary)' }">{{ r.label }}</span>
          <span class="tnum font-semibold">{{ fmtILSRound(r.total) }}</span>
        </div>

        <!-- one shared scale; the forecast segment is hatched, not just paler -->
        <div
          class="flex h-2.5 gap-0.5 overflow-hidden rounded-full"
          :style="{ background: 'var(--surface-sunken)' }"
          role="img"
          :aria-label="`${r.label}: ${fmtILSRound(r.total)}, מתוכם ${fmtILSRound(r.solid)} ${r.solidLabel} ו-${fmtILSRound(r.forecast)} ${r.forecastLabel}`"
        >
          <span
            v-if="r.solid > 0"
            class="fill-in h-full rounded-full"
            :style="{ width: pct(r.solid), background: r.hue }"
          ></span>
          <span
            v-if="r.forecast > 0"
            class="fill-in h-full rounded-full"
            :style="{
              width: pct(r.forecast),
              background: `repeating-linear-gradient(135deg, ${r.hue} 0 3px, color-mix(in srgb, ${r.hue} 30%, transparent) 3px 7px)`,
            }"
          ></span>
        </div>

        <div class="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">
          <span>{{ r.solidLabel }} <span class="tnum">{{ fmtILSRound(r.solid) }}</span></span>
          <span v-if="r.forecast > 0">
            <span aria-hidden="true">▨</span>
            {{ r.forecastLabel }} <span class="tnum">{{ fmtILSRound(r.forecast) }}</span>
          </span>
          <!-- The forecast is only trustworthy if you can open it up: one list, on this page -->
          <a v-if="r.key === 'fixed' && upcomingFixed.length" href="#upcoming" class="tap-target underline">
            {{ fmtCount(upcomingFixed.length, 'חיוב קבוע אחד', 'חיובים קבועים') }} בדרך ←
          </a>
        </div>
      </li>
    </ul>

    <!--
      What part of "fixed income" is a spread lump sum, and why. Editable here
      because this is where the number needs explaining, not only on the row.
    -->
    <ul v-if="activeSpreads.length" class="mt-4 space-y-2">
      <li
        v-for="{ plan, slice } in activeSpreads"
        :key="plan.transactionId"
        class="rounded-lg p-2.5 text-xs"
        :style="{ background: 'var(--surface-2)' }"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span :style="{ color: 'var(--text-secondary)' }">
            <span aria-hidden="true">🗓️</span>
            מזה <span class="tnum font-semibold">{{ fmtILSRound(Math.abs(slice.amount)) }}</span>
            מפריסה של {{ plan.months }} חודשים
          </span>
          <button
            v-if="editing !== plan.transactionId"
            class="btn btn-ghost !px-2 !py-0.5 !text-xs"
            @click="startEdit(plan)"
          >
            {{ plan.note ? 'עריכת ההערה' : 'הוספת הערה' }}
          </button>
        </div>

        <p v-if="plan.note && editing !== plan.transactionId" class="mt-1" :style="{ color: 'var(--text-primary)' }">
          {{ plan.note }}
        </p>
        <p
          v-else-if="editing !== plan.transactionId"
          class="mt-1"
          :style="{ color: 'var(--text-muted)' }"
        >
          בלי הערה — כדאי לכתוב למה זה נפרס, כדי שבעוד חצי שנה זה עדיין יהיה ברור.
        </p>

        <div v-else class="mt-2 flex flex-wrap items-center gap-2">
          <input
            v-model="draft"
            type="text"
            maxlength="500"
            placeholder="למשל: בונוס שנתי — פרוס על השנה"
            class="field min-w-0 grow !py-1 text-xs"
            @keyup.enter="commit(plan)"
            @keyup.esc="editing = null"
          />
          <button class="btn btn-primary !py-1 !text-xs" :disabled="saving" @click="commit(plan)">שמירה</button>
          <button class="btn btn-ghost !py-1 !text-xs" :disabled="saving" @click="editing = null">ביטול</button>
        </div>
      </li>
    </ul>

    <!--
      The one outgoing worth celebrating - but only when the cycle can afford
      it. Shown as a share of income because "₪3,000" means nothing without
      knowing what came in; shown in green only while `available` is still
      positive, because a deposit made out of a cycle that has already overrun
      is a transfer between accounts, not saving, and colouring it as an
      achievement teaches the opposite of the truth.
    -->
    <div
      v-if="data.savings.deposited > 0"
      class="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-lg p-3"
      :style="{
        background: `color-mix(in srgb, ${data.available >= 0 ? 'var(--status-good)' : 'var(--text-muted)'} 10%, transparent)`,
      }"
    >
      <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">
        <span aria-hidden="true">🐷</span> הופקד לחיסכון
      </span>
      <span class="text-sm">
        <span
          class="tnum font-bold"
          :style="{ color: data.available >= 0 ? 'var(--delta-up)' : 'var(--text-primary)' }"
        >
          {{ fmtILSRound(data.savings.deposited) }}
        </span>
        <span v-if="data.savings.rateOfIncome > 0" :style="{ color: 'var(--text-muted)' }">
          · {{ Math.round(data.savings.rateOfIncome * 100) }}% מההכנסה
        </span>
        <span v-if="data.available < 0" :style="{ color: 'var(--text-muted)' }">· מהיתרה, לא מעודף המחזור</span>
      </span>
    </div>

    <!-- the bottom line, stated rather than left to be inferred from two bars -->
    <div
      v-if="verdict"
      class="mt-4 flex items-baseline justify-between gap-3 border-t pt-3.5"
      :style="{ borderColor: 'var(--gridline)' }"
    >
      <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">הכנסות קבועות פחות הוצאות קבועות</span>
      <span
        class="tnum text-lg font-bold"
        :style="{ color: covered ? 'var(--delta-up)' : 'var(--delta-down)' }"
      >
        {{ fmtSigned(leftover) }}
      </span>
    </div>
    <p v-if="verdict" class="mt-1.5 text-xs" :style="{ color: 'var(--text-secondary)' }">
      <span aria-hidden="true">{{ verdict.icon }}</span> {{ verdict.text }}
    </p>
  </section>
</template>
