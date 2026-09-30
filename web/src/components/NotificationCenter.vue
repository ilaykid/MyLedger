<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type Insight } from '../lib/api.js';

const props = defineProps<{ embedded?: boolean }>();
const root = ref<HTMLElement | null>(null);
const open = ref(!!props.embedded);
const loading = ref(false);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const insights = ref<Insight[]>([]);

const iconFor = (kind: string) => ({
  card_fee: '💳',
  duplicate_charge: '⚠️',
  unusual_amount: '↗',
  recurring_increase: '📈',
  installment_ending: '✓',
  new_merchant: '✨',
}[kind] ?? '💡');

async function load() {
  loading.value = true;
  error.value = null;
  try {
    insights.value = await api.insights(30);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function toggle() {
  open.value = !open.value;
  if (open.value) await load();
}

async function feedback(insight: Insight, verdict: 'useful' | 'not_relevant' | 'resolved' | 'snoozed') {
  busy.value = insight.key;
  error.value = null;
  try {
    await api.setInsightFeedback(insight, verdict);
    if(verdict==='useful')insight.feedback='useful';
    // Useful feedback does not dismiss an unresolved finding.
    if(verdict !== 'useful') insights.value = insights.value.filter((item) => item.key !== insight.key);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

function outside(event: PointerEvent) {
  if (!props.embedded && open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function keydown(event: KeyboardEvent) {
  if (!props.embedded && event.key === 'Escape') open.value = false;
}

onMounted(() => {
  load();
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', keydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', keydown);
});
</script>

<template>
  <div ref="root" class="relative shrink-0">
    <button v-if="!embedded"
      class="icon-btn relative"
      type="button"
      aria-label="התראות ותובנות"
      title="התראות ותובנות"
      :aria-expanded="open"
      @click="toggle"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span
        v-if="insights.length"
        class="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
        style="background: var(--status-critical)"
      >{{ insights.length > 9 ? '9+' : insights.length }}</span>
    </button>

    <Transition name="notifications">
      <section
        v-if="open"
        :class="embedded ? 'insights-workspace' : 'absolute end-0 top-full z-50 mt-2 flex max-h-[72vh] w-[min(29rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border'"
        :style="{ background: embedded ? 'transparent' : 'var(--surface-1)', borderColor: 'var(--border)', boxShadow: embedded ? 'none' : 'var(--shadow-lift)' }"
        aria-label="מרכז ההתראות"
      >
        <header class="flex items-center justify-between border-b px-4 py-3" :style="{ borderColor: 'var(--gridline)' }">
          <div>
            <h2 class="text-sm font-bold">התראות ותובנות</h2>
            <p class="text-xs" :style="{ color: 'var(--text-muted)' }">חריגות ושינויים שכדאי לבדוק בתנועות</p>
          </div>
          <button class="text-link" :disabled="loading" @click="load">{{loading?'בודק…':'בדיקה מחדש'}}</button>
        </header>

        <div v-if="loading && !insights.length" class="p-8 text-center text-sm" :style="{ color: 'var(--text-muted)' }">טוען…</div>
        <div v-else-if="!insights.length && !error" class="p-8 text-center">
          <div class="text-2xl" aria-hidden="true">✨</div>
          <p class="mt-2 text-sm font-semibold">הכול נקי כרגע</p>
          <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">אין תובנות שמחכות לבדיקה.</p>
        </div>
        <div v-else-if="insights.length" class="divide-y" :class="{'overflow-y-auto':!embedded}" :style="{ borderColor: 'var(--gridline)' }">
          <article v-for="insight in insights" :key="insight.key" class="flex gap-3 px-4 py-3.5">
            <div v-if="!embedded" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-sm" :style="{ background: 'var(--surface-2)' }">
              {{ iconFor(insight.kind) }}
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold">{{ insight.title }}</h3>
              <p class="mt-1 text-xs leading-5" :style="{ color: 'var(--text-muted)' }">{{ insight.detail }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <RouterLink class="btn btn-ghost !text-xs" :to="{path:'/transactions',query:{month:'all',q:insight.merchant ?? undefined}}" @click="open=false">בדיקת תנועות</RouterLink>
                <button class="btn btn-ghost !text-xs" :disabled="busy === insight.key" @click="feedback(insight, 'resolved')">טופל</button>
                <details class="insight-options"><summary>אפשרויות נוספות</summary><div class="flex flex-wrap gap-2 mt-2">
                  <button class="btn btn-ghost !text-xs" :disabled="busy === insight.key" @click="feedback(insight, 'snoozed')">להזכיר בעוד שבוע</button>
                  <button class="btn btn-ghost !text-xs" :disabled="busy === insight.key" @click="feedback(insight, 'useful')">{{insight.feedback==='useful'?'סומן כמועיל':'מועיל לי'}}</button>
                  <button class="btn btn-ghost !text-xs" :disabled="busy === insight.key" @click="feedback(insight, 'not_relevant')">לא רלוונטי</button>
                </div></details>
              </div>
            </div>
          </article>
        </div>
        <p v-if="error" class="border-t px-4 py-2 text-xs" :style="{ borderColor: 'var(--gridline)', color: 'var(--status-critical)' }">{{ error }}</p>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.insights-workspace>header{padding:0 0 20px;border:0}.insights-workspace article{padding:22px 0}.insights-workspace article h3{font-size:15px;font-weight:550}.insights-workspace article p{font-size:13px;line-height:1.8;max-width:680px}.insight-options{font-size:12px;color:var(--text-muted)}.insight-options summary{cursor:pointer;padding:10px}.insight-options[open]{flex-basis:100%}

.notifications-enter-active,
.notifications-leave-active {
  transition: opacity 0.15s var(--ease), transform 0.15s var(--ease);
  transform-origin: top right;
}
.notifications-enter-from,
.notifications-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.98);
}
</style>
