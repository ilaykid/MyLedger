<script setup lang="ts">
/**
 * Where the *steerable* money went. Fixed commitments are excluded on purpose -
 * they are already accounted for in the forecast and are not what a person can
 * change this week.
 *
 * Horizontal magnitude bars: identity comes from the row label, the value is
 * direct-labelled, and the budget marker (when set) rides the track.
 */
import { computed } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const props = defineProps<{ rows: Cashflow['variableByCategory']; total: number }>();

const max = computed(() => Math.max(1, ...props.rows.map((r) => r.amount)));

function budgetPct(row: Cashflow['variableByCategory'][number]): number | null {
  if (!row.budget) return null;
  return Math.min(100, (row.budget / max.value) * 100);
}
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="section-title">הוצאות משתנות לפי קטגוריה</h2>
      <span class="tnum text-sm" :style="{ color: 'var(--text-muted)' }">{{ fmtILSRound(total) }}</span>
    </div>

    <p v-if="rows.length === 0" class="mt-4 text-sm" :style="{ color: 'var(--text-muted)' }">
      אין הוצאות משתנות במחזור הזה.
    </p>

    <ul v-else class="mt-4 space-y-3">
      <li v-for="r in rows" :key="r.categoryId ?? 'none'">
        <div class="mb-1 flex items-baseline justify-between gap-2 text-sm">
          <span class="min-w-0 truncate" :style="{ color: 'var(--text-secondary)' }">
            <span class="me-1" aria-hidden="true">{{ r.icon }}</span>{{ r.name }}
          </span>
          <span class="shrink-0">
            <span class="tnum font-semibold">{{ fmtILSRound(r.amount) }}</span>
            <span v-if="r.budget" class="tnum ms-1 text-xs" :style="{ color: 'var(--text-muted)' }">
              / {{ fmtILSRound(r.budget) }}
            </span>
          </span>
        </div>
        <div class="relative h-2.5 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
          <div
            class="h-full rounded-full transition-[width] duration-700"
            :style="{ width: `${(r.amount / max) * 100}%`, background: r.color, transitionTimingFunction: 'var(--ease)' }"
          ></div>
          <!-- budget marker: a hairline the bar can visibly pass -->
          <div
            v-if="budgetPct(r) != null"
            class="absolute top-0 h-full w-0.5"
            :style="{ insetInlineStart: `${budgetPct(r)}%`, background: 'var(--text-muted)' }"
            :title="`תקציב: ${fmtILSRound(r.budget!)}`"
          ></div>
        </div>
        <p
          v-if="r.budget && r.amount > r.budget"
          class="mt-0.5 text-xs"
          :style="{ color: 'var(--status-critical)' }"
        >
          חריגה של {{ fmtILSRound(r.amount - r.budget) }}
        </p>

        <!--
          What this category usually ends the cycle at, from its own history.
          Shown for every category, including the ones nobody budgeted - which is
          most of them.
        -->
        <p v-if="r.forecast != null" class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">
          צפוי לצאת <span class="tnum">{{ fmtILSRound(r.forecast) }}</span>
          <template v-if="r.forecast > r.amount">
            · נשאר <span class="tnum">{{ fmtILSRound(r.forecast - r.amount) }}</span>
          </template>
          <!-- The budget says one thing, history says another. That gap is the
               finding: a budget nobody meets is a number, not a plan. -->
          <span v-if="r.budget && r.forecast > r.budget" :style="{ color: 'var(--status-warning)' }">
            · לפי ההיסטוריה תחרוג מהתקציב ב-{{ fmtILSRound(r.forecast - r.budget) }}
          </span>
        </p>
      </li>
    </ul>
  </section>
</template>
