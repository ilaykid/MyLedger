<script setup lang="ts">
/**
 * "What if I spend X a day for the rest of the cycle?"
 *
 * Break-even is exactly `dailyAllowance`, so the slider's position relative to
 * that marker IS the answer - and the projected leftover updates live. Recomputed
 * client-side, so dragging is instant.
 */
import { computed, ref, watch } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtILSRound, fmtMonth } from '../lib/format.js';

const props = defineProps<{ data: Cashflow; limited?: boolean }>();

const daysRemaining = computed(() => Math.max(0, props.data.cycle.daysRemaining));
/** Upper bound: comfortably past both the historical burn and break-even. */
const maxDaily = computed(() =>
  Math.max(200_00, Math.round(Math.max(props.data.variable.dailyBurn, props.data.dailyAllowance) * 2.2)),
);

// Start at what the current cash flow can actually afford. Historical spending
// is context, not a recommendation and certainly not a prediction.
const plannedDaily = ref(Math.max(0, Math.floor(props.data.dailyAllowance/100)*100));
watch(
  () => props.data.dailyAllowance,
  (v) => {
    plannedDaily.value = Math.max(0, Math.floor(v/100)*100);
  },
);

const leftover = computed(() => props.data.available - plannedDaily.value * daysRemaining.value);
const breakEven = computed(() => Math.max(0, props.data.dailyAllowance));
const breakEvenPct = computed(() => Math.min(100, (breakEven.value / maxDaily.value) * 100));

const tone = computed(() => {
  if (leftover.value < 0) return { color: 'var(--status-critical)', icon: '🔴', text: 'בתרחיש הזה ההוצאות יעברו את מה שנשאר להוציא' };
  // Less than two days of normal spending left over is "on the edge".
  if (leftover.value < props.data.variable.dailyBurn * 2)
    return { color: 'var(--status-warning)', icon: '⚠️', text: 'בתרחיש הזה נשאר מרווח קטן' };
  return { color: 'var(--status-good)', icon: '✅', text: 'בתרחיש הזה נשאר מרווח עד סוף המחזור' };
});

const basis = computed(() => props.data.variable.forecastBasis ?? []);
const daysPhrase = computed(() => (daysRemaining.value === 1 ? 'ביום שנותר' : `ב-${daysRemaining.value} הימים שנותרו`));
</script>

<template>
  <section class="card p-5">
    <h2 class="section-title">תכנון עד סוף המחזור</h2>
    <p class="section-hint mt-1">
      בדקו איך הוצאה יומית תשפיע על מה שנשאר להוציא {{ daysPhrase }}. זהו תרחיש חישובי, ולא הבטחה ליתרה בעו״ש.
    </p>

    <p v-if="limited" class="mt-3 text-xs" :style="{color:'var(--status-warning)'}">החישוב מבוסס על נתונים חלקיים ועשוי להשתנות לאחר הבדיקה.</p>
    <div class="mt-4">
      <div class="flex items-baseline justify-between">
        <label for="planner" class="text-sm" :style="{ color: 'var(--text-muted)' }">הוצאה מתוכננת ליום</label>
        <span class="tnum text-lg font-bold">{{ fmtILSRound(plannedDaily) }}</span>
      </div>

      <div class="relative mt-1">
        <input
          id="planner"
          v-model.number="plannedDaily"
          class="slider"
          type="range"
          min="0"
          :max="maxDaily"
          step="100"
          :aria-valuetext="`${fmtILSRound(plannedDaily)} ליום`"
        />
        <!-- break-even marker: the rate that lands exactly on zero -->
        <div
          v-if="daysRemaining > 0 && breakEvenPct < 100"
          class="pointer-events-none absolute top-0 h-6 w-px"
          :style="{ insetInlineStart: `${breakEvenPct}%`, background: 'var(--text-muted)' }"
          aria-hidden="true"
        ></div>
      </div>

      <div class="flex justify-between text-xs" :style="{ color: 'var(--text-muted)' }">
        <span>0</span>
        <span v-if="daysRemaining > 0">נקודת האיזון {{ fmtILSRound(breakEven) }}</span>
        <span>{{ fmtILSRound(maxDaily) }}</span>
      </div>
    </div>

    <div aria-live="polite" class="mt-4 rounded-xl p-3.5" :style="{ background: 'var(--surface-sunken)' }">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">נשאר בסוף המחזור בתרחיש הזה</span>
        <span class="tnum text-xl font-bold" :style="{ color: leftover < 0 ? 'var(--status-critical)' : 'var(--text-primary)' }">
          {{ fmtILSRound(leftover) }}
        </span>
      </div>
      <p class="mt-1.5 text-xs" :style="{ color: 'var(--text-muted)' }">
        <span aria-hidden="true">{{ tone.icon }}</span> {{ tone.text }}
      </p>
    </div>

    <details v-if="basis.length" class="mt-3 rounded-xl border px-3.5 py-2.5 text-xs" :style="{ borderColor: 'var(--gridline)' }">
      <summary class="cursor-pointer font-semibold" :style="{ color: 'var(--text-secondary)' }">
        איך חושב הקצב הטיפוסי: {{ fmtILSRound(data.variable.dailyBurn) }} ליום
      </summary>
      <p class="mt-2 leading-5" :style="{ color: 'var(--text-muted)' }">
        זהו החציון של ההוצאות המשתנות בכל מחזור מלא — לא ממוצע שמאפשר למחזור חריג להשתלט על התחזית.
      </p>
      <ul class="mt-2 space-y-1">
        <li v-for="row in basis" :key="row.start" class="flex items-center justify-between gap-3">
          <span>{{ fmtMonth(row.start.slice(0, 7)) }}</span>
          <span class="tnum">{{ fmtILSRound(row.total) }} במחזור · {{ fmtILSRound(row.daily) }} ליום</span>
        </li>
      </ul>
      <p v-if="data.variable.dailyBurn > data.dailyAllowance" class="mt-2 font-medium" :style="{ color: 'var(--status-warning)' }">
        כרגע נשאר להוציא רק {{ fmtILSRound(data.dailyAllowance) }} ליום; הפער הוא התרעה, לא הנחה שההוצאות ימשיכו בקצב ההיסטורי.
      </p>
    </details>
  </section>
</template>
