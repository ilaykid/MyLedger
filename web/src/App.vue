<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from './components/AppIcon.vue';
import AppDialog from './components/AppDialog.vue';
import UndoNotice from './components/UndoNotice.vue';
import { api, reviewCounts } from './lib/api';
const route = useRoute();
const menu = ref(false);
const primary = [
  { to: '/', label: 'החודש', icon: 'home' },
  { to: '/transactions', label: 'תנועות', icon: 'transactions' },
  { to: '/planning', label: 'תכנון', icon: 'calendar' },
  { to: '/breakdown', label: 'לאן הכסף הולך', icon: 'chart' },
];
const management = [
  { to: '/connections', label: 'חשבונות וחיבורים', detail: 'יתרות, מקורות ועדכון נתונים', icon: 'wallet' },
  { to: '/recurring', label: 'קבועות', detail: 'הכנסות והוצאות קבועות', icon: 'calendar' },
  { to: '/categories', label: 'קטגוריות ותקציבים', detail: 'ארגון ההוצאות והיעדים', icon: 'tag' },
  { to: '/rules', label: 'חוקי סיווג', detail: 'הסיווג האוטומטי של תנועות', icon: 'settings' },
  { to: '/activity', label: 'היסטוריית שינויים', detail: 'בדיקה וביטול של שינויים', icon: 'history' },
  { to: '/settings', label: 'הגדרות', detail: 'העדפות המערכת', icon: 'settings' },
];
const selectedPath = computed(() => route.path === '/month-details' ? '/' : route.path);
type Theme = 'system' | 'light' | 'dark';
const theme = ref<Theme>('system');
function apply(next: Theme) {
  theme.value = next;
  if (next === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = next;
  try {
    if (next === 'system') localStorage.removeItem('myledger-theme');
    else localStorage.setItem('myledger-theme', next);
  } catch { /* the choice still applies for this visit */ }
}
const demo = ref(false);
/** Items waiting in "לטיפול", for the header badge. Null until known. */
const pending = ref<number | null>(null);
async function refreshPending() {
  try {
    const counts = await reviewCounts();
    pending.value = counts.classify + counts.quality;
  } catch { /* the badge is a hint; the link still works without it */ }
}
/** Classifying writes once per tap; recount after the taps settle. */
let recount: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(recount);
  recount = setTimeout(refreshPending, 1500);
}
onMounted(() => {
  try { const stored = localStorage.getItem('myledger-theme'); if (stored === 'dark' || stored === 'light') apply(stored); } catch { /* storage blocked: follow the system */ }
  api.meta().then(m => { demo.value = m.demo; }).catch(() => {});
  refreshPending();
  window.addEventListener('ledger:changed', scheduleRefresh);
  window.addEventListener('ledger:undone', scheduleRefresh);
});
onBeforeUnmount(() => {
  clearTimeout(recount);
  window.removeEventListener('ledger:changed', scheduleRefresh);
  window.removeEventListener('ledger:undone', scheduleRefresh);
});
// Cached for a minute in reviewCounts, so following links costs nothing.
watch(() => route.fullPath, () => { menu.value = false; refreshPending(); });
</script>
<template>
  <a href="#main" class="skip-link">דילוג לתוכן</a>
  <p v-if="demo" class="demo-banner" role="note">גרסת הדגמה · כל הנתונים בדויים. חיבור לבנקים ושליחת הודעות מנוטרלים.</p>
  <header class="workspace-header">
    <div class="workspace-header-inner">
      <RouterLink to="/" class="workspace-brand" aria-label="MyLedger — החודש"><AppIcon name="wallet" :size="23"/><span>MyLedger</span></RouterLink>
      <nav aria-label="ניווט ראשי" class="workspace-nav">
        <RouterLink v-for="item in primary" :key="item.to" :to="item.to" :class="{selected:selectedPath===item.to}" :aria-current="selectedPath===item.to?'page':undefined">{{item.label}}</RouterLink>
      </nav>
      <div class="workspace-actions">
        <RouterLink to="/review" class="review-entry" :class="{selected:route.path==='/review'}" :aria-label="pending?`לטיפול, ${pending===1?'פריט אחד ממתין':pending+' פריטים ממתינים'}`:undefined"><AppIcon name="review" :size="17"/><span>לטיפול</span><span v-if="pending" class="review-badge tnum" aria-hidden="true">{{pending>99?'99+':pending}}</span></RouterLink>
        <button class="icon-btn" aria-label="פתיחת תפריט ניהול" :aria-expanded="menu" @click="menu=true"><AppIcon name="menu"/></button>
      </div>
    </div>
  </header>
  <main id="main" class="app-main" tabindex="-1">
    <RouterView v-slot="{Component,route:r}"><component :is="Component" :key="r.path"/></RouterView>
  </main>
  <nav class="mobile-bottom-nav" aria-label="ניווט מהיר">
    <RouterLink v-for="item in primary" :key="item.to" :to="item.to" :class="{selected:selectedPath===item.to}" :aria-current="selectedPath===item.to?'page':undefined"><AppIcon :name="item.icon"/><span>{{item.label}}</span></RouterLink>
  </nav>
  <AppDialog :open="menu" title="ניהול והגדרות" drawer @close="menu=false">
    <nav class="management-list" aria-label="ניהול">
      <RouterLink v-for="item in management" :key="item.to" :to="item.to" @click="menu=false"><AppIcon :name="item.icon"/><span>{{item.label}}<small>{{item.detail}}</small></span><span aria-hidden="true">←</span></RouterLink>
    </nav>
    <div class="management-appearance"><label for="appearance">מראה המערכת</label><select id="appearance" :value="theme" class="field" @change="apply(($event.target as HTMLSelectElement).value as Theme)"><option value="system">לפי המכשיר</option><option value="light">בהיר</option><option value="dark">כהה</option></select></div>
    <p class="management-footnote"><span class="status-dot"></span> המידע נשמר במחשב הזה בלבד</p>
  </AppDialog>
  <UndoNotice/>
</template>

<style scoped>
.review-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--status-critical);color:#fff;font-size:11px;font-weight:700;line-height:1}
.mobile-bottom-nav a span{text-align:center;line-height:1.2}
</style>
