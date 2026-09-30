<script setup lang="ts">
/**
 * Am I spending faster than last cycle? Cumulative variable spend, this cycle vs
 * the previous one.
 *
 * Emphasis form rather than categorical: the current cycle is the point, the
 * previous one is context - so it gets the de-emphasis gray. Two series, so a
 * legend is present; the current line is also direct-labelled at its end.
 */
import { computed } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const props = defineProps<{ pace: NonNullable<Cashflow['pace']>; daysElapsed: number }>();

const W = 100;
const H = 34;

const maxValue = computed(() => {
  const all = props.pace.series.flatMap((p) => [p.current ?? 0, p.previous ?? 0]);
  return Math.max(1, ...all);
});

function pathOf(key: 'current' | 'previous'): string {
  const pts = props.pace.series
    .map((p, i) => ({ i, v: p[key] }))
    .filter((p): p is { i: number; v: number } => p.v != null);
  if (pts.length === 0) return '';
  const n = Math.max(1, props.pace.series.length - 1);
  return pts
    .map((p, k) => `${k === 0 ? 'M' : 'L'}${((p.i / n) * W).toFixed(2)},${(H - (p.v / maxValue.value) * H).toFixed(2)}`)
    .join(' ');
}

const currentPath = computed(() => pathOf('current'));
const previousPath = computed(() => pathOf('previous'));

const endPoint = computed(() => {
  const pts = props.pace.series.map((p, i) => ({ i, v: p.current })).filter((p) => p.v != null);
  if (!pts.length) return null;
  const last = pts[pts.length - 1] as { i: number; v: number };
  const n = Math.max(1, props.pace.series.length - 1);
  return { x: (last.i / n) * W, y: H - (last.v / maxValue.value) * H };
});

const verdict = computed(() => {
  const d = props.pace.delta;
  if (Math.abs(d) < 5000) return { color: 'var(--text-secondary)', icon: '≈', text: 'כמעט זהה למחזור הקודם' };
  if (d > 0) return { color: 'var(--delta-down)', icon: '↑', text: `${fmtILSRound(d)} יותר מהמחזור הקודם` };
  return { color: 'var(--delta-up)', icon: '↓', text: `${fmtILSRound(Math.abs(d))} פחות מהמחזור הקודם` };
});
</script>

<template>
  <section class="card p-5">
    <h2 class="section-title">קצב ההוצאה</h2>
    <p class="section-hint mt-1">הוצאות משתנות מתחילת המחזור, מול אותה נקודה במחזור הקודם.</p>

    <div class="mt-3 flex items-baseline gap-2">
      <span class="tnum text-2xl font-bold">{{ fmtILSRound(pace.currentSpend) }}</span>
      <span class="text-sm font-semibold" :style="{ color: verdict.color }">
        <span aria-hidden="true">{{ verdict.icon }}</span> {{ verdict.text }}
      </span>
    </div>

    <svg
      class="mt-3 w-full"
      :viewBox="`0 -3 ${W} ${H + 6}`"
      :style="{ height: '58px' }"
      preserveAspectRatio="none"
      role="img"
      aria-label="גרף מגמה של הוצאות מצטברות במחזור הנוכחי מול המחזור הקודם"
    >
      <path
        v-if="previousPath"
        :d="previousPath"
        fill="none"
        :stroke="'var(--baseline)'"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
      />
      <path
        v-if="currentPath"
        :d="currentPath"
        fill="none"
        :stroke="'var(--brand)'"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <circle
        v-if="endPoint"
        :cx="endPoint.x"
        :cy="endPoint.y"
        r="4"
        :fill="'var(--brand)'"
        :stroke="'var(--surface-1)'"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <!-- Two series -> legend, keyed with a line stroke to mirror the marks -->
    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" :style="{ color: 'var(--text-muted)' }">
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 rounded-full" :style="{ background: 'var(--brand)' }"></span>
        המחזור הנוכחי (יום {{ daysElapsed }})
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-4 rounded-full" :style="{ background: 'var(--baseline)' }"></span>
        המחזור הקודם ({{ fmtILSRound(pace.previousSpendAtSameDay) }} באותו יום)
      </span>
    </div>
  </section>
</template>
