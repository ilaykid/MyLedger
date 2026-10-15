<script setup lang="ts">
/**
 * Am I spending faster than last cycle? Cumulative variable spend, this cycle vs
 * the previous one.
 *
 * Emphasis form rather than categorical: the current cycle is the point, the
 * previous one is context - so it gets the de-emphasis gray. Two series, so a
 * legend is present; the current line is also direct-labelled at its end.
 *
 * The svg stretches to the card (preserveAspectRatio="none"), which would turn
 * any circle drawn inside it into an ellipse - so the dots and the crosshair are
 * HTML overlays positioned in percent, and only the lines live in the svg.
 * Hover and keyboard give the same readout, and a table carries every value.
 */
import { computed, ref, watch } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const props = defineProps<{ pace: NonNullable<Cashflow['pace']>; daysElapsed: number }>();

const W = 100;
const H = 34;
const activeIndex = ref<number | null>(null);
const showTable = ref(false);
watch(() => props.pace, () => { activeIndex.value = null; });

const maxValue = computed(() => {
  const all = props.pace.series.flatMap((p) => [p.current ?? 0, p.previous ?? 0]);
  return Math.max(1, ...all);
});
const n = computed(() => Math.max(1, props.pace.series.length - 1));
const xOf = (i: number) => (i / n.value) * W;
const yOf = (v: number) => H - (v / maxValue.value) * H;
/** svg units -> percent of the overlay box (the viewBox starts at y=-3, height H+6). */
const leftPct = (i: number) => `${(xOf(i) / W) * 100}%`;
const topPct = (v: number) => `${((yOf(v) + 3) / (H + 6)) * 100}%`;

function pathOf(key: 'current' | 'previous'): string {
  const pts = props.pace.series
    .map((p, i) => ({ i, v: p[key] }))
    .filter((p): p is { i: number; v: number } => p.v != null);
  if (pts.length === 0) return '';
  return pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${xOf(p.i).toFixed(2)},${yOf(p.v).toFixed(2)}`).join(' ');
}

const currentPath = computed(() => pathOf('current'));
const previousPath = computed(() => pathOf('previous'));

const lastCurrentIndex = computed(() => {
  let idx = -1;
  props.pace.series.forEach((p, i) => { if (p.current != null) idx = i; });
  return idx;
});
const endPoint = computed(() => {
  const i = lastCurrentIndex.value;
  const v = i >= 0 ? props.pace.series[i].current : null;
  return v == null ? null : { left: leftPct(i), top: topPct(v) };
});

const active = computed(() => (activeIndex.value == null ? null : (props.pace.series[activeIndex.value] ?? null)));
const readout = computed(() => {
  const a = active.value;
  if (!a) return '';
  const parts = [`יום ${a.day}`];
  if (a.current != null) parts.push(`המחזור הנוכחי ${fmtILSRound(a.current)}`);
  if (a.previous != null) parts.push(`המחזור הקודם ${fmtILSRound(a.previous)}`);
  return parts.join(' · ');
});

function onMove(event: PointerEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = (event.clientX - box.left) / box.width;
  activeIndex.value = Math.min(props.pace.series.length - 1, Math.max(0, Math.round(ratio * n.value)));
}

/** Time runs left to right, so ArrowRight moves later - matching what the eye sees. */
function onKey(event: KeyboardEvent) {
  const last = props.pace.series.length - 1;
  const current = activeIndex.value ?? Math.max(0, lastCurrentIndex.value);
  const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 };
  if (event.key in map) {
    activeIndex.value = Math.min(last, Math.max(0, current + map[event.key]));
    event.preventDefault();
  } else if (event.key === 'Home') {
    activeIndex.value = 0;
    event.preventDefault();
  } else if (event.key === 'End') {
    activeIndex.value = last;
    event.preventDefault();
  } else if (event.key === 'Escape') {
    activeIndex.value = null;
  }
}

const verdict = computed(() => {
  const d = props.pace.delta;
  if (Math.abs(d) < 5000) return { color: 'var(--text-secondary)', icon: '≈', text: 'כמעט זהה למחזור הקודם' };
  if (d > 0) return { color: 'var(--delta-down)', icon: '↑', text: `${fmtILSRound(d)} יותר מהמחזור הקודם` };
  return { color: 'var(--delta-up)', icon: '↓', text: `${fmtILSRound(Math.abs(d))} פחות מהמחזור הקודם` };
});
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 class="section-title">קצב ההוצאה</h2>
        <p class="section-hint mt-1">הוצאות משתנות מתחילת המחזור, מול אותה נקודה במחזור הקודם.</p>
      </div>
      <button class="btn btn-ghost !py-1 !text-xs" :aria-pressed="showTable" @click="showTable = !showTable">
        {{ showTable ? 'תצוגת גרף' : 'תצוגת טבלה' }}
      </button>
    </div>

    <div class="mt-3 flex items-baseline gap-2">
      <span class="tnum text-2xl font-bold">{{ fmtILSRound(pace.currentSpend) }}</span>
      <span class="text-sm font-semibold" :style="{ color: verdict.color }">
        <span aria-hidden="true">{{ verdict.icon }}</span> {{ verdict.text }}
      </span>
    </div>

    <!-- Table view: the same values, reachable without hovering -->
    <div v-if="showTable" class="mt-3 max-h-56 overflow-y-auto rounded-xl border" :style="{ borderColor: 'var(--gridline)' }">
      <table class="w-full text-sm">
        <caption class="sr-only">הוצאות משתנות מצטברות לפי יום במחזור</caption>
        <thead class="sticky top-0" :style="{ background: 'var(--surface-2)' }">
          <tr class="text-right" :style="{ color: 'var(--text-muted)' }">
            <th scope="col" class="px-3 py-2 font-medium">יום במחזור</th>
            <th scope="col" class="px-3 py-2 font-medium">המחזור הנוכחי</th>
            <th scope="col" class="px-3 py-2 font-medium">המחזור הקודם</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in pace.series" :key="p.day" class="border-t" :style="{ borderColor: 'var(--gridline)' }">
            <td class="tnum px-3 py-1.5">{{ p.day }}</td>
            <td class="tnum px-3 py-1.5 font-semibold">{{ p.current == null ? '—' : fmtILSRound(p.current) }}</td>
            <td class="tnum px-3 py-1.5" :style="{ color: 'var(--text-muted)' }">{{ p.previous == null ? '—' : fmtILSRound(p.previous) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-else>
      <!-- Readout line: always reserves its height so hovering does not shift the card -->
      <p class="tnum mt-3 min-h-[1.25rem] text-xs" :style="{ color: 'var(--text-secondary)' }" aria-live="polite">{{ readout }}</p>
      <div
        class="pace-plot relative mt-1"
        tabindex="0"
        role="img"
        aria-label="גרף הוצאות מצטברות במחזור הנוכחי מול המחזור הקודם. החץ ימינה עובר ליום הבא והחץ שמאלה ליום הקודם."
        @pointermove="onMove"
        @pointerleave="activeIndex = null"
        @keydown="onKey"
        @blur="activeIndex = null"
      >
        <svg class="block w-full" :viewBox="`0 -3 ${W} ${H + 6}`" :style="{ height: '58px' }" preserveAspectRatio="none" aria-hidden="true">
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
        </svg>
        <!-- HTML overlays stay round whatever the svg's aspect ratio -->
        <span v-if="activeIndex != null" class="pace-cross" :style="{ left: leftPct(activeIndex) }" aria-hidden="true"></span>
        <span v-if="active && active.previous != null && activeIndex != null" class="pace-dot pace-dot-prev" :style="{ left: leftPct(activeIndex), top: topPct(active.previous) }" aria-hidden="true"></span>
        <span v-if="active && active.current != null && activeIndex != null" class="pace-dot" :style="{ left: leftPct(activeIndex), top: topPct(active.current) }" aria-hidden="true"></span>
        <span v-if="endPoint && activeIndex == null" class="pace-dot" :style="endPoint" aria-hidden="true"></span>
      </div>
    </template>

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

<style scoped>
.pace-plot{direction:ltr;touch-action:pan-y;border-radius:6px}.pace-plot:focus-visible{outline:2px solid var(--brand);outline-offset:4px}
.pace-dot{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--brand);border:2px solid var(--surface-1);transform:translate(-50%,-50%);pointer-events:none}
.pace-dot-prev{background:var(--baseline)}
.pace-cross{position:absolute;top:0;bottom:0;width:1px;background:var(--baseline);transform:translateX(-50%);pointer-events:none}
</style>
