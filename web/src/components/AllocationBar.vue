<script setup lang="ts">
/**
 * Where the cycle's income goes: fixed commitments, variable spending, and what
 * is left. Part-to-whole with three segments, so a stacked bar - separated by
 * 2px surface gaps rather than borders, and every segment carries a visible text
 * label (three of the light palette slots sit under 3:1 on white, so colour is
 * never the only channel).
 */
import { computed } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const props = defineProps<{ data: Cashflow }>();

const segments = computed(() => {
  const total = props.data.income.total;
  const leftover = Math.max(0, props.data.available);
  const rows = [
    { key: 'fixed', label: 'הוצאות קבועות', amount: props.data.fixed.total, color: 'var(--series-1)' },
    { key: 'variable', label: 'הוצאות משתנות', amount: props.data.variable.spent, color: 'var(--series-2)' },
    { key: 'left', label: 'פנוי', amount: leftover, color: 'var(--series-3)' },
  ];
  const denominator = total > 0 ? total : rows.reduce((s, r) => s + r.amount, 0) || 1;
  return rows.map((r) => ({ ...r, share: r.amount / denominator }));
});

const overspent = computed(() => props.data.available < 0);
const fixedShare = computed(() =>
  props.data.income.total > 0 ? props.data.fixed.total / props.data.income.total : 0,
);
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="section-title">לאן הולכת ההכנסה</h2>
      <span class="tnum text-sm" :style="{ color: 'var(--text-muted)' }">
        מתוך {{ fmtILSRound(data.income.total) }}
      </span>
    </div>

    <!-- gap-0.5 = the 2px surface gap between touching segments -->
    <div class="mt-4 flex h-9 gap-0.5 overflow-hidden rounded-lg">
      <div
        v-for="s in segments"
        :key="s.key"
        class="grid place-items-center transition-[flex-grow] duration-700 first:rounded-s-lg last:rounded-e-lg"
        :style="{
          flexGrow: Math.max(s.share, 0.001),
          flexBasis: 0,
          background: s.color,
          transitionTimingFunction: 'var(--ease)',
        }"
        :title="`${s.label}: ${fmtILSRound(s.amount)}`"
      >
        <!-- Only label inside when it comfortably fits; otherwise the row list below carries it -->
        <span v-if="s.share > 0.14" class="tnum px-1 text-xs font-semibold text-white">
          {{ Math.round(s.share * 100) }}%
        </span>
      </div>
    </div>

    <ul class="mt-3.5 space-y-1.5">
      <li v-for="s in segments" :key="s.key" class="flex items-baseline justify-between gap-3 text-sm">
        <span class="inline-flex items-center gap-2 truncate">
          <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" :style="{ background: s.color }"></span>
          <span :style="{ color: 'var(--text-secondary)' }">{{ s.label }}</span>
        </span>
        <span class="tnum shrink-0 font-semibold">{{ fmtILSRound(s.amount) }}</span>
      </li>
    </ul>

    <p class="mt-3.5 border-t pt-3 text-xs" :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }">
      <template v-if="overspent">
        ההוצאות עוברות את ההכנסה ב-{{ fmtILSRound(Math.abs(data.available)) }} במחזור הזה.
      </template>
      <template v-else>
        ההוצאות הקבועות תופסות {{ Math.round(fixedShare * 100) }}% מההכנסה — מה שנשאר הוא מה שבאמת בשליטתך.
      </template>
    </p>
  </section>
</template>
