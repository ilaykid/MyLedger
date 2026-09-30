<script setup lang="ts">
/**
 * The signature chart: projected bank balance across the cash-flow cycle.
 *
 * A single series (balance), so no legend box is needed - the title names it.
 * Past days are solid, projected days lighter, split by a labelled "today"
 * divider. Event markers use SHAPE for direction (triangle up = money in, down =
 * money out) so direction never depends on colour. Hover and keyboard both
 * produce the same readout, and a table view carries every value without
 * hovering at all.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TimelinePoint } from '../lib/api.js';
import { fmtCompact, fmtDayMonth, fmtILS, fmtILSRound } from '../lib/format.js';

const props = defineProps<{
  points: TimelinePoint[];
  todayISO: string;
  overdraftDate: string | null;
}>();

const PAD = { top: 18, right: 14, bottom: 26, left: 52 };
const HEIGHT = 260;

const host = ref<HTMLElement | null>(null);
const width = ref(720);
const activeIndex = ref<number | null>(null);
const showTable = ref(false);

/**
 * The viewBox width tracks the container 1:1 so labels render at their true size
 * rather than being scaled down on narrow screens.
 *
 * Measured directly rather than relying only on ResizeObserver: the observer is
 * the efficient path for live resizes, but its callbacks are tied to the
 * rendering lifecycle and are not delivered in every environment (headless
 * capture, a backgrounded tab that never composites). A direct read plus a
 * window-resize listener keeps the chart correctly scaled regardless.
 *
 * Re-measured whenever the chart element is recreated - the table view unmounts
 * it, and an observer left pointing at the old node silently stops updating.
 */
let observer: ResizeObserver | null = null;

function measure() {
  const w = host.value?.clientWidth;
  if (w && w > 0) width.value = w;
}

function attach() {
  measure();
  observer?.disconnect();
  if (!host.value || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w && w > 0) width.value = w;
  });
  observer.observe(host.value);
}

onMounted(() => {
  attach();
  window.addEventListener('resize', measure);
});
watch(showTable, attach, { flush: 'post' });
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', measure);
});

const plotWidth = computed(() => Math.max(1, width.value - PAD.left - PAD.right));
const plotHeight = HEIGHT - PAD.top - PAD.bottom;

/** Zero is always included so a dip toward overdraft is honestly scaled. */
const scale = computed(() => {
  const values = props.points.map((p) => p.balance);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const span = rawMax - rawMin || 1;
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.12;
  return {
    min,
    max,
    x: (i: number) =>
      PAD.left + (props.points.length <= 1 ? plotWidth.value / 2 : (i / (props.points.length - 1)) * plotWidth.value),
    y: (v: number) => PAD.top + plotHeight - ((v - min) / (max - min)) * plotHeight,
  };
});

const zeroY = computed(() => scale.value.y(0));
const showZeroLine = computed(() => scale.value.min < 0);

/** Four rounded gridline values across the range. */
const ticks = computed(() => {
  const { min, max } = scale.value;
  const step = niceStep((max - min) / 4);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
});

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / pow;
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return factor * pow;
}

const lastActualIndex = computed(() => {
  let idx = -1;
  props.points.forEach((p, i) => {
    if (p.actual) idx = i;
  });
  return idx;
});

function pathFor(from: number, to: number): string {
  const s = scale.value;
  const segment = props.points.slice(from, to + 1);
  if (segment.length === 0) return '';
  return segment.map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(from + i).toFixed(1)},${s.y(p.balance).toFixed(1)}`).join(' ');
}

const actualPath = computed(() => (lastActualIndex.value >= 0 ? pathFor(0, lastActualIndex.value) : ''));
/** Starts at the last actual point so the two segments meet without a gap. */
const projectedPath = computed(() =>
  lastActualIndex.value >= 0 && lastActualIndex.value < props.points.length - 1
    ? pathFor(lastActualIndex.value, props.points.length - 1)
    : props.points.length && lastActualIndex.value < 0
      ? pathFor(0, props.points.length - 1)
      : '',
);

const actualArea = computed(() => {
  if (lastActualIndex.value < 0) return '';
  const s = scale.value;
  const base = Math.min(zeroY.value, PAD.top + plotHeight);
  return `${pathFor(0, lastActualIndex.value)} L${s.x(lastActualIndex.value).toFixed(1)},${base.toFixed(1)} L${s.x(0).toFixed(1)},${base.toFixed(1)} Z`;
});

const hasForecast = computed(() => lastActualIndex.value >= 0 && lastActualIndex.value < props.points.length - 1);
/** The divider marks where fact ends and forecast begins - so it is only
 *  meaningful when there IS a forecast. A finished cycle is all fact. */
const todayX = computed(() => (hasForecast.value ? scale.value.x(lastActualIndex.value) : null));

/** Days carrying a notable event get a marker; direction comes from shape. */
const markers = computed(() =>
  props.points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.events.length > 0)
    .map(({ p, i }) => {
      const net = p.events.reduce((s, e) => s + e.amount, 0);
      return { index: i, x: scale.value.x(i), y: scale.value.y(p.balance), inflow: net >= 0, point: p };
    }),
);

/** X-axis labels, thinned so they never collide on narrow screens. */
const xLabels = computed(() => {
  const every = Math.max(1, Math.ceil(props.points.length / (plotWidth.value < 420 ? 5 : 9)));
  return props.points
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i % every === 0 || i === props.points.length - 1);
});

const active = computed(() => (activeIndex.value == null ? null : (props.points[activeIndex.value] ?? null)));

/** Keep the tooltip inside the card on both sides (RTL-safe). */
const tooltipStyle = computed(() => {
  if (activeIndex.value == null) return {};
  const x = scale.value.x(activeIndex.value);
  const clamped = Math.min(Math.max(x, 108), width.value - 108);
  return { left: `${clamped}px` };
});

function indexFromPointer(event: PointerEvent | MouseEvent) {
  const svg = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratio = (event.clientX - svg.left) / svg.width;
  const px = ratio * width.value - PAD.left;
  const step = plotWidth.value / Math.max(1, props.points.length - 1);
  return Math.min(props.points.length - 1, Math.max(0, Math.round(px / step)));
}

function onMove(event: PointerEvent) {
  activeIndex.value = indexFromPointer(event);
}

function onKey(event: KeyboardEvent) {
  const last = props.points.length - 1;
  const current = activeIndex.value ?? Math.max(0, lastActualIndex.value);
  // RTL: ArrowLeft advances in time, ArrowRight goes back.
  const map: Record<string, number> = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 1, ArrowDown: -1 };
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

watch(
  () => props.points,
  () => {
    activeIndex.value = null;
  },
);

const eventKindLabel: Record<string, string> = {
  income: 'הכנסה',
  fixed: 'הוצאה קבועה',
  card_settlement: 'חיוב אשראי',
  excluded: 'לא תזרימי',
};
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <p class="section-hint">
        {{ hasForecast ? 'שחזור מהיתרות האחרונות והתנועות שנמשכו; מכאן והלאה הערכה. יתרות ממועדים שונים עלולות ליצור סטייה.' : 'שחזור היתרה מהנתונים שנמשכו, ולא דוח יתרות יומי מהבנק.' }}
      </p>
      <button class="btn btn-ghost !py-1 !text-xs" :aria-pressed="showTable" @click="showTable = !showTable">
        {{ showTable ? 'תצוגת גרף' : 'תצוגת טבלה' }}
      </button>
    </div>

    <!-- Table view: the same values, reachable without hovering -->
    <div v-if="showTable" class="max-h-72 overflow-y-auto rounded-xl border" :style="{ borderColor: 'var(--gridline)' }">
      <table class="w-full text-sm">
        <caption class="sr-only">יתרה יומית לאורך המחזור</caption>
        <thead class="sticky top-0" :style="{ background: 'var(--surface-2)' }">
          <tr class="text-right" :style="{ color: 'var(--text-muted)' }">
            <th scope="col" class="px-3 py-2 font-medium">תאריך</th>
            <th scope="col" class="px-3 py-2 font-medium">יתרה</th>
            <th scope="col" class="px-3 py-2 font-medium">הוצאה משתנה</th>
            <th scope="col" class="px-3 py-2 font-medium">אירועים</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in points" :key="p.date" class="border-t" :style="{ borderColor: 'var(--gridline)' }">
            <td class="tnum px-3 py-1.5">{{ fmtDayMonth(p.date) }}</td>
            <td class="tnum px-3 py-1.5 font-semibold" :style="{ color: p.balance < 0 ? 'var(--status-critical)' : undefined }">
              {{ fmtILSRound(p.balance) }}
            </td>
            <td class="tnum px-3 py-1.5" :style="{ color: 'var(--text-muted)' }">
              {{ p.variableSpend > 0 ? fmtILSRound(p.variableSpend) : '—' }}
            </td>
            <td class="px-3 py-1.5 text-xs" :style="{ color: 'var(--text-secondary)' }">
              {{ p.events.map((e) => e.label).join(' · ') || '—' }}
              <span v-if="!p.actual" :style="{ color: 'var(--text-muted)' }">(תחזית)</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Chart view -->
    <div v-else ref="host" class="relative">
      <svg
        :viewBox="`0 0 ${width} ${HEIGHT}`"
        :style="{ width: '100%', height: `${HEIGHT}px`, touchAction: 'pan-y' }"
        role="img"
        tabindex="0"
        aria-label="גרף יתרת החשבון לאורך המחזור. השתמשו במקשי החצים לעיון בימים."
        @pointermove="onMove"
        @pointerleave="activeIndex = null"
        @keydown="onKey"
        @blur="activeIndex = null"
      >
        <!-- gridlines: solid hairlines, one step off the surface -->
        <g>
          <line
            v-for="t in ticks"
            :key="`g${t}`"
            :x1="PAD.left"
            :x2="width - PAD.right"
            :y1="scale.y(t)"
            :y2="scale.y(t)"
            :stroke="'var(--gridline)'"
            stroke-width="1"
          />
        </g>

        <!-- y tick labels -->
        <g :fill="'var(--text-muted)'" font-size="11" text-anchor="end">
          <text v-for="t in ticks" :key="`t${t}`" :x="PAD.left - 8" :y="scale.y(t) + 4" style="font-variant-numeric: tabular-nums">
            {{ fmtCompact(t) }}
          </text>
        </g>

        <!-- overdraft region: below zero reads as danger, and is labelled -->
        <template v-if="showZeroLine">
          <rect
            :x="PAD.left"
            :y="zeroY"
            :width="plotWidth"
            :height="Math.max(0, PAD.top + plotHeight - zeroY)"
            :fill="'var(--status-critical)'"
            opacity="0.07"
          />
          <line
            :x1="PAD.left"
            :x2="width - PAD.right"
            :y1="zeroY"
            :y2="zeroY"
            :stroke="'var(--status-critical)'"
            stroke-width="1"
          />
        </template>

        <!-- past: 10% area wash + 2px line -->
        <path v-if="actualArea" :d="actualArea" :fill="'var(--brand)'" opacity="0.1" />
        <path
          v-if="actualPath"
          :d="actualPath"
          fill="none"
          :stroke="'var(--brand)'"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <!-- forecast: same hue, lighter, so the change in certainty is visible -->
        <path
          v-if="projectedPath"
          :d="projectedPath"
          fill="none"
          :stroke="'var(--brand)'"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          opacity="0.45"
        />

        <!-- "today" divider -->
        <template v-if="todayX != null">
          <line
            :x1="todayX"
            :x2="todayX"
            :y1="PAD.top - 6"
            :y2="PAD.top + plotHeight"
            :stroke="'var(--baseline)'"
            stroke-width="1"
          />
          <text :x="todayX" :y="PAD.top - 10" text-anchor="middle" font-size="10" :fill="'var(--text-muted)'">היום</text>
        </template>

        <!-- event markers: shape carries direction, 2px surface ring -->
        <g>
          <template v-for="m in markers" :key="`m${m.index}`">
            <path
              :d="
                m.inflow
                  ? `M${m.x},${m.y - 6.5} L${m.x + 5.5},${m.y + 3.5} L${m.x - 5.5},${m.y + 3.5} Z`
                  : `M${m.x},${m.y + 6.5} L${m.x + 5.5},${m.y - 3.5} L${m.x - 5.5},${m.y - 3.5} Z`
              "
              :fill="'var(--text-secondary)'"
              :stroke="'var(--surface-1)'"
              stroke-width="2"
            />
          </template>
        </g>

        <!-- crosshair + focused point -->
        <template v-if="activeIndex != null && active">
          <line
            :x1="scale.x(activeIndex)"
            :x2="scale.x(activeIndex)"
            :y1="PAD.top"
            :y2="PAD.top + plotHeight"
            :stroke="'var(--baseline)'"
            stroke-width="1"
          />
          <circle
            :cx="scale.x(activeIndex)"
            :cy="scale.y(active.balance)"
            r="5"
            :fill="'var(--brand)'"
            :stroke="'var(--surface-1)'"
            stroke-width="2"
          />
        </template>

        <!-- x tick labels -->
        <g :fill="'var(--text-muted)'" font-size="11" text-anchor="middle">
          <text v-for="l in xLabels" :key="`x${l.i}`" :x="scale.x(l.i)" :y="HEIGHT - 8">
            {{ l.p.dayOfMonth }}
          </text>
        </g>
      </svg>

      <!-- Tooltip: value leads, label follows -->
      <div
        v-if="active"
        class="pointer-events-none absolute top-1 z-10 w-52 -translate-x-1/2 rounded-xl p-2.5 text-xs"
        :style="{
          ...tooltipStyle,
          background: 'var(--surface-1)',
          border: '1px solid var(--gridline)',
          boxShadow: 'var(--shadow-lift)',
        }"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="tnum text-sm font-bold" :style="{ color: active.balance < 0 ? 'var(--status-critical)' : 'var(--text-primary)' }">
            {{ fmtILS(active.balance) }}
          </span>
          <span :style="{ color: 'var(--text-muted)' }">{{ fmtDayMonth(active.date) }}</span>
        </div>
        <div class="mt-0.5" :style="{ color: 'var(--text-muted)' }">
          {{ active.actual ? 'יתרה משוחזרת' : 'יתרה חזויה' }}
        </div>
        <div v-if="active.variableSpend > 0" class="mt-1.5 flex items-center gap-1.5">
          <span class="inline-block h-0.5 w-3 rounded-full" :style="{ background: 'var(--series-2)' }"></span>
          <span class="tnum font-semibold">{{ fmtILSRound(active.variableSpend) }}</span>
          <span :style="{ color: 'var(--text-muted)' }">
            {{ active.actual ? 'הוצאה משתנה בפועל' : 'תחזית הוצאה ישירה מהעו״ש' }}
          </span>
        </div>
        <ul v-if="active.events.length" class="mt-1.5 space-y-1 border-t pt-1.5" :style="{ borderColor: 'var(--gridline)' }">
          <li v-for="(e, i) in active.events" :key="i" class="flex items-baseline justify-between gap-2">
            <span class="truncate" :style="{ color: 'var(--text-secondary)' }" :title="e.label">{{ e.label }}</span>
            <span class="tnum shrink-0 font-semibold" :style="{ color: e.amount > 0 ? 'var(--delta-up)' : 'var(--text-primary)' }">
              {{ fmtILSRound(e.amount) }}
            </span>
          </li>
        </ul>
      </div>
    </div>

    <!-- Legend for the marker shapes (identity never rests on colour alone) -->
    <div v-if="!showTable" class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" :style="{ color: 'var(--text-muted)' }">
      <span class="inline-flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <path d="M5.5,1 L10,8.5 L1,8.5 Z" :fill="'var(--text-secondary)'" />
        </svg>
        כסף נכנס
      </span>
      <span class="inline-flex items-center gap-1.5">
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <path d="M5.5,10 L10,2.5 L1,2.5 Z" :fill="'var(--text-secondary)'" />
        </svg>
        כסף יוצא
      </span>
      <span v-if="overdraftDate" :style="{ color: 'var(--status-critical)' }">
        🔴 צפויה יציאה למינוס ב-{{ fmtDayMonth(overdraftDate) }}
      </span>
    </div>
  </div>
</template>
