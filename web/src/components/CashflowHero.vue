<script setup lang="ts">
/**
 * The one number the dashboard leads with: what is genuinely left to spend for
 * the rest of the cycle. Everything else on the page explains it.
 *
 * The paired progress tracks are the insight: when the money bar runs ahead of
 * the time bar, spending is outpacing the calendar - visible at a glance without
 * reading any figure.
 */
import { computed, toRef } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtDayMonth, fmtILS, fmtILSRound } from '../lib/format.js';
import { useAnimatedNumber } from '../lib/useAnimatedNumber.js';

const props = defineProps<{ data: Cashflow }>();

const available = toRef(() => props.data.available);
const animated = useAnimatedNumber(available);

const status = computed(() => {
  switch (props.data.status) {
    case 'over':
      return { color: 'var(--status-critical)', icon: '🔴', label: 'חרגת מהתזרים' };
    case 'tight':
      return { color: 'var(--status-warning)', icon: '⚠️', label: 'התזרים לחוץ' };
    default:
      return { color: 'var(--status-good)', icon: '✅', label: 'אתה בכיוון טוב' };
  }
});

/**
 * The ring restates spendProgress as a shape, so the headline reads at a glance
 * from across the room. It is a second encoding of a number already written
 * beside it - never the only way to know the value.
 */
const RING = 34;
const CIRC = 2 * Math.PI * RING;
const ringOffset = computed(() => CIRC * (1 - Math.min(1, Math.max(0, props.data.spendProgress))));

/** Spending ahead of the clock is the thing worth surfacing in words. */
const paceHint = computed(() => {
  const { timeProgress, daysRemaining, isCurrent } = props.data.cycle;
  if (!isCurrent) return null;
  const gap = props.data.spendProgress - timeProgress;
  if (gap > 0.08) return 'ההוצאות מקדימות את הזמן — כדאי להאט כדי לסיים בשחור';
  if (gap < -0.08) return 'אתה מוציא לאט יותר מקצב המחזור';
  if (daysRemaining <= 3) return `נותרו ${daysRemaining} ימים לסוף המחזור`;
  return null;
});
</script>

<template>
  <section
    class="card aura rise p-5 sm:p-7"
    :style="{ '--aura': `color-mix(in srgb, ${status.color} 13%, transparent)` }"
  >
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm" :style="{ color: 'var(--text-muted)' }">
          {{ data.cycle.isCurrent ? 'נשאר לך להוציא' : 'נותר בסוף המחזור' }}
        </p>
        <p
          class="hero-figure mt-1"
          :style="{ color: data.available < 0 ? 'var(--status-critical)' : 'var(--text-primary)' }"
        >
          {{ fmtILS(animated) }}
        </p>
        <p class="mt-2 text-sm" :style="{ color: 'var(--text-secondary)' }">
          <template v-if="data.cycle.isCurrent && data.cycle.daysRemaining > 0">
            <span class="font-semibold">{{ fmtILSRound(data.dailyAllowance) }}</span> ליום ·
            {{ data.cycle.daysRemaining }} ימים עד {{ fmtDayMonth(data.cycle.lastDay) }}
          </template>
          <template v-else>
            המחזור הסתיים ב-{{ fmtDayMonth(data.cycle.lastDay) }}
          </template>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-4">
        <span
          class="chip"
          :style="{ background: `color-mix(in srgb, ${status.color} 14%, transparent)`, color: 'var(--text-primary)' }"
        >
          <span aria-hidden="true">{{ status.icon }}</span>
          {{ status.label }}
        </span>

        <!-- The same percentage as the track below, as a shape. Decorative by
             itself, which is why it is hidden from assistive tech. -->
        <div v-if="data.cycle.isCurrent" class="relative hidden sm:block" aria-hidden="true">
          <svg width="84" height="84" viewBox="0 0 84 84" class="-rotate-90">
            <circle cx="42" cy="42" :r="RING" fill="none" stroke="var(--surface-sunken)" stroke-width="7" />
            <circle
              cx="42"
              cy="42"
              :r="RING"
              fill="none"
              :stroke="status.color"
              stroke-width="7"
              stroke-linecap="round"
              :stroke-dasharray="CIRC"
              :stroke-dashoffset="ringOffset"
              class="ring-draw"
            />
          </svg>
          <span
            class="absolute inset-0 grid place-items-center text-sm font-bold"
            :style="{ color: 'var(--text-primary)' }"
          >
            {{ Math.round(data.spendProgress * 100) }}%
          </span>
        </div>
      </div>
    </div>

    <!-- Time vs money: two tracks, same width, so the gap is the message -->
    <div class="mt-6 space-y-2.5">
      <div>
        <div class="mb-1 flex items-baseline justify-between text-xs">
          <span :style="{ color: 'var(--text-muted)' }">התקדמות בזמן</span>
          <span class="tnum" :style="{ color: 'var(--text-muted)' }">
            {{ data.cycle.daysElapsed }} מתוך {{ data.cycle.daysTotal }} ימים
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
          <div
            class="fill-in h-full rounded-full transition-[width] duration-700"
            :style="{ width: `${data.cycle.timeProgress * 100}%`, background: 'var(--baseline)', transitionTimingFunction: 'var(--ease)' }"
          ></div>
        </div>
      </div>

      <div>
        <div class="mb-1 flex items-baseline justify-between text-xs">
          <span :style="{ color: 'var(--text-muted)' }">מהכסף הפנוי נוצל</span>
          <span class="tnum" :style="{ color: 'var(--text-muted)' }">
            {{ Math.round(data.spendProgress * 100) }}%
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
          <div
            class="fill-in h-full rounded-full transition-[width] duration-700"
            :style="{ width: `${data.spendProgress * 100}%`, background: status.color, transitionTimingFunction: 'var(--ease)' }"
          ></div>
        </div>
      </div>

      <p v-if="paceHint" class="pt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">{{ paceHint }}</p>
    </div>
  </section>
</template>

<style scoped>
/* The arc sweeps to its value once, on arrival. */
@keyframes ring-draw {
  from {
    stroke-dashoffset: v-bind(CIRC);
  }
}
.ring-draw {
  animation: ring-draw 1s var(--ease) both;
  transition: stroke-dashoffset 0.7s var(--ease);
}

@media (prefers-reduced-motion: reduce) {
  .ring-draw {
    animation: none;
  }
}
</style>
