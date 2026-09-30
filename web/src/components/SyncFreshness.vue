<script setup lang="ts">
/**
 * How old the data on this page is - stated permanently, next to the title.
 *
 * A hosted service syncs whether or not anyone is watching. This one syncs when
 * the machine is on and logged in, so "three days stale" is an ordinary state
 * rather than a fault. That makes silence dangerous: a forecast computed from
 * last Tuesday looks exactly like a forecast computed this morning, and the
 * whole page reads as current. So the freshness is always on screen, not only
 * when it crosses a threshold into SyncAlerts.
 *
 * Colour is never the only channel - the state is spelled out in words, and the
 * dot carries a shape difference (filled vs ring) as well as a hue.
 */
import { computed } from 'vue';
import type { SyncFreshness } from '../lib/api.js';

const props = defineProps<{ freshness: SyncFreshness | null }>();

const relative = computed(() => {
  const hours = props.freshness?.hoursSince;
  if (hours == null) return null;
  if (hours < 1) return 'הרגע';
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'אתמול' : `לפני ${days} ימים`;
});

const tone = computed(() => {
  switch (props.freshness?.state) {
    case 'fresh':
      return { color: 'var(--status-good)', filled: true, label: 'מעודכן' };
    case 'aging':
      return { color: 'var(--status-warning)', filled: false, label: 'לא טרי' };
    case 'stalled':
      return { color: 'var(--status-critical)', filled: false, label: 'תקוע' };
    default:
      return { color: 'var(--text-muted)', filled: false, label: 'לא נמשך מעולם' };
  }
});

/** The full picture on hover: nothing here is hidden behind the summary. */
const detail = computed(() => {
  const accounts = props.freshness?.perAccount ?? [];
  if (accounts.length === 0) return 'אין חשבונות מחוברים';
  return accounts
    .map((a) => `${a.displayName}: ${a.scrapedAt ? new Date(a.scrapedAt).toLocaleString('he-IL') : 'לא נמשך'}`)
    .join('\n');
});
</script>

<template>
  <div
    v-if="freshness"
    class="flex items-center gap-1.5 text-sm"
    :style="{ color: 'var(--text-muted)' }"
    :title="detail"
  >
    <span
      class="inline-block h-2 w-2 shrink-0 rounded-full"
      :style="{
        backgroundColor: tone.filled ? tone.color : 'transparent',
        boxShadow: tone.filled ? 'none' : `inset 0 0 0 1.5px ${tone.color}`,
      }"
      aria-hidden="true"
    />
    <span>
      סונכרן
      <template v-if="relative">{{ relative }}</template>
      <template v-else>— טרם</template>
    </span>
    <span :style="{ color: tone.color }">· {{ tone.label }}</span>
  </div>
</template>
