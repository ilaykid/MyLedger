<script setup lang="ts">
/**
 * Card charges not yet settled (the "float"): money already spent that has not left the account yet.
 * This is the single biggest reason an Israeli bank balance flatters you, so it
 * gets its own panel rather than being buried in a total.
 */
import { computed } from 'vue';
import type { Cashflow } from '../lib/api.js';
import { fmtDayMonth, fmtILSRound } from '../lib/format.js';

const props = defineProps<{ data: Cashflow }>();

const afterCycle = computed(() => props.data.cardFloat.total - props.data.cardFloat.withinCycle);
const sorted = computed(() => [...props.data.cardFloat.byAccount].sort((a, b) => b.amount - a.amount));
</script>

<template>
  <section class="card p-5">
    <h2 class="section-title">חיובי אשראי שעוד לא ירדו</h2>
    <p class="section-hint mt-1">כבר הוצא באשראי — עוד לא ירד מהעו״ש.</p>

    <p class="tnum mt-3 text-3xl font-bold">{{ fmtILSRound(data.cardFloat.total) }}</p>

    <ul v-if="sorted.length" class="mt-4 space-y-2">
      <li
        v-for="a in sorted"
        :key="a.accountId"
        class="flex items-baseline justify-between gap-2 border-b pb-2 text-sm last:border-0 last:pb-0"
        :style="{ borderColor: 'var(--gridline)' }"
      >
        <span class="min-w-0">
          <span class="block truncate" :style="{ color: 'var(--text-secondary)' }">
            <span class="me-1" aria-hidden="true">💳</span>{{ a.displayName }}
          </span>
          <span v-if="a.chargeDate" class="text-xs" :style="{ color: 'var(--text-muted)' }">
            יורד ב-{{ fmtDayMonth(a.chargeDate) }}
          </span>
        </span>
        <span class="tnum shrink-0 font-semibold">{{ fmtILSRound(a.amount) }}</span>
      </li>
    </ul>

    <p v-else class="mt-3 text-sm" :style="{ color: 'var(--text-muted)' }">אין חיובים ממתינים.</p>

    <p
      v-if="data.cardFloat.total > 0"
      class="mt-3.5 border-t pt-3 text-xs"
      :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }"
    >
      {{ fmtILSRound(data.cardFloat.withinCycle) }} מזה יורדים עוד במחזור הזה<template v-if="afterCycle > 0">,
      ו-{{ fmtILSRound(afterCycle) }} רק במחזור הבא</template>.
    </p>
  </section>
</template>
