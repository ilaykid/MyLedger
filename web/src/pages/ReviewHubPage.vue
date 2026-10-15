<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import QualityPage from './QualityPage.vue';
import DailyPage from './DailyPage.vue';
import NotificationCenter from '../components/NotificationCenter.vue';
import { api, reviewCounts } from '../lib/api';
const route = useRoute();
type SectionId = 'classify' | 'quality' | 'insights';
const ids: SectionId[] = ['classify', 'quality', 'insights'];
const counts = ref<Record<SectionId, number | null>>({ classify: null, quality: null, insights: null });
/** Opening without a tab lands on the first one that has something in it. */
const fallback = ref<SectionId | null>(null);
const explicit = computed(() => ids.find((id) => id === route.query.tab) ?? null);
const section = computed<SectionId | null>(() => explicit.value ?? fallback.value);
const sections = computed(() => [
  { id: 'classify' as const, label: 'לסיווג' },
  { id: 'quality' as const, label: 'בדיקת נתונים' },
  { id: 'insights' as const, label: 'תובנות' },
].map((s) => ({ ...s, count: counts.value[s.id] })));

async function loadCounts(withInsights = true) {
  const [review, insights] = await Promise.allSettled([reviewCounts(), withInsights ? api.insights(30) : Promise.resolve(null)]);
  if (review.status === 'fulfilled') {
    counts.value.classify = review.value.classify;
    counts.value.quality = review.value.quality;
  }
  if (insights.status === 'fulfilled' && insights.value) counts.value.insights = insights.value.length;
  if (!fallback.value) fallback.value = ids.find((id) => (counts.value[id] ?? 0) > 0) ?? 'classify';
}
/** Classifying fires a write per tap; recount once the taps settle, not on each. */
let recount: ReturnType<typeof setTimeout> | undefined;
function scheduleRecount() {
  clearTimeout(recount);
  recount = setTimeout(() => loadCounts(section.value === 'insights'), 1500);
}
onMounted(() => {
  loadCounts();
  window.addEventListener('ledger:changed', scheduleRecount);
});
onBeforeUnmount(() => {
  clearTimeout(recount);
  window.removeEventListener('ledger:changed', scheduleRecount);
});
</script>
<template>
  <div class="review-workspace">
    <div class="page-heading"><div><h1>לטיפול</h1><p>מסווגים את התנועות, בודקים את הנתונים וממשיכים הלאה.</p></div><RouterLink to="/activity" class="text-link">שינויים אחרונים ←</RouterLink></div>
    <nav class="section-tabs" aria-label="תחומי טיפול"><RouterLink v-for="item in sections" :key="item.id" :to="{path:'/review',query:{tab:item.id}}" :class="{selected:section===item.id}" :aria-current="section===item.id?'page':undefined">{{item.label}}<span v-if="item.count!==null" class="tnum"> ({{item.count}})</span></RouterLink></nav>
    <p v-if="!section" class="loading-line" role="status">בודק מה מחכה לטיפול…</p>
    <DailyPage v-else-if="section==='classify'" embedded/>
    <QualityPage v-else-if="section==='quality'" embedded/>
    <NotificationCenter v-else embedded/>
  </div>
</template>
