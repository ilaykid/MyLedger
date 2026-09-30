<script setup lang="ts">
/**
 * Instalment plans — the part of the fixed load that expires.
 *
 * The useful thing here is not the list, it is the release schedule: knowing
 * that ₪500 stops leaving your account in November changes what you can commit
 * to. Every other "fixed expense" view treats commitments as permanent.
 */
import { computed } from 'vue';
import type { InstallmentPlan, InstallmentSummary } from '../lib/api.js';
import { fmtDayMonth, fmtILSRound, fmtMonth } from '../lib/format.js';

const props = defineProps<{ plans: InstallmentPlan[]; summary: InstallmentSummary }>();

const active = computed(() => props.plans.filter((p) => p.status === 'active'));
const finishedCount = computed(() => props.plans.filter((p) => p.status === 'finished').length);
const progress = (p: InstallmentPlan) => (p.paidPayments / p.totalPayments) * 100;
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="section-title">תשלומים שנותרו</h2>
      <span class="text-sm" :style="{ color: 'var(--text-muted)' }">
        <span class="tnum font-semibold" :style="{ color: 'var(--text-primary)' }">
          {{ fmtILSRound(summary.monthlyLoad) }}
        </span>
        לחודש
      </span>
    </div>

    <p v-if="active.length === 0" class="mt-4 text-sm" :style="{ color: 'var(--text-muted)' }">
      אין תוכניות תשלומים פעילות.
      <template v-if="finishedCount">{{ finishedCount }} תוכניות הסתיימו.</template>
    </p>

    <template v-else>
      <p class="section-hint mt-1">
        {{ active.length }} תוכניות פעילות · נותר לשלם
        <span class="tnum font-semibold">{{ fmtILSRound(summary.totalRemaining) }}</span>
      </p>

      <ul class="mt-4 space-y-3.5">
        <li v-for="p in active" :key="p.id">
          <div class="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span class="min-w-0 truncate" :style="{ color: 'var(--text-secondary)' }" :title="p.description">
              {{ p.description }}
            </span>
            <span class="tnum shrink-0 font-semibold">{{ fmtILSRound(p.perPayment) }}</span>
          </div>

          <!-- payment progress; the label carries the numbers, not the colour -->
          <div class="h-2 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
            <div
              class="h-full rounded-full transition-[width] duration-700"
              :style="{ width: `${progress(p)}%`, background: 'var(--series-1)', transitionTimingFunction: 'var(--ease)' }"
            ></div>
          </div>

          <div class="mt-1 flex flex-wrap justify-between gap-x-3 text-xs" :style="{ color: 'var(--text-muted)' }">
            <span>שולמו {{ p.paidPayments }} מתוך {{ p.totalPayments }}</span>
            <span>
              עוד {{ p.remainingPayments }} · מסתיים
              <span :style="{ color: 'var(--text-secondary)' }">{{ p.endsOn ? fmtDayMonth(p.endsOn) : '' }}</span>
            </span>
          </div>
        </li>
      </ul>

      <!-- the release schedule: when this money comes back -->
      <div v-if="summary.freeingUp.length" class="mt-4 border-t pt-3" :style="{ borderColor: 'var(--gridline)' }">
        <h3 class="text-sm font-semibold">מתי הכסף משתחרר</h3>
        <ul class="mt-2 space-y-1.5">
          <li
            v-for="f in summary.freeingUp"
            :key="f.month"
            class="flex items-baseline justify-between gap-3 text-sm"
          >
            <span class="min-w-0 truncate" :style="{ color: 'var(--text-secondary)' }" :title="f.plans.join(', ')">
              {{ fmtMonth(f.month) }}
              <span class="text-xs" :style="{ color: 'var(--text-muted)' }">— {{ f.plans.join(', ') }}</span>
            </span>
            <span class="tnum shrink-0 font-semibold" :style="{ color: 'var(--delta-up)' }">
              +{{ fmtILSRound(f.amount) }}
            </span>
          </li>
        </ul>
        <p class="mt-2.5 text-xs" :style="{ color: 'var(--text-muted)' }">
          מהחודש הזה ואילך זה כסף שמפסיק לצאת — לא הכנסה חדשה, אבל מקום שמתפנה בתזרים.
        </p>
      </div>
    </template>
  </section>
</template>
