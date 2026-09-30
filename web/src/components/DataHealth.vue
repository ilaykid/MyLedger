<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type SyncHealth } from '../lib/api';
const props = defineProps<{
    health?: SyncHealth | null;
    error?: string;
    loading?: boolean;
    standalone?: boolean;
    compact?: boolean;
    hideLink?: boolean;
}>();
const own = ref<SyncHealth | null>(null), ownError = ref('');
async function load() { ownError.value = ''; try {
    own.value = await api.syncHealth();
}
catch {
    ownError.value = 'מצב הנתונים לא נבדק';
} }
onMounted(() => { if (props.standalone)
    load(); });
const health = computed(() => props.health ?? own.value);
const label = computed(() => props.error || ownError.value ? 'מצב הנתונים לא נבדק' : health.value?.reliability.label ?? 'בודק את מצב הנתונים…');
</script>
<template>
<div class="health-bar" :class="{'health-limited':!health||health.reliability.status!=='complete','health-compact':compact}" role="status">
<div class="health-indicator" aria-hidden="true">{{health?.reliability.status==='complete'?'✓':'!'}}</div>
<div class="flex-1 min-w-0">
<strong>{{label}}</strong>
<p v-if="health&&!compact">{{health.reliability.status==='complete'?'כל המקורות הפעילים עודכנו ולא נמצאו פערים פתוחים.':health.issues.find(i=>i.severity!=='info')?.title??health.reliability.detail}}</p>
<p v-else-if="!compact">עד לבדיקה מוצלחת, המספרים הם תמונה שלא אומתה.</p>
</div>
<RouterLink v-if="!hideLink" to="/review" class="health-link">{{health?.reliability.status==='complete'?'פרטי הנתונים':'לבדיקה ותיקון'}} <span aria-hidden="true">←</span>
</RouterLink>
</div>
</template>
<style scoped>.health-bar{display:flex;gap:12px;align-items:center;padding:14px 18px;border:1px solid var(--border);background:var(--surface-1);border-radius:13px;font-size:12px}.health-bar strong{font-size:13px}.health-bar p{color:var(--text-muted);margin-top:3px}.health-indicator{display:grid;place-items:center;width:28px;height:28px;flex-shrink:0;border-radius:50%;background:color-mix(in srgb,var(--status-good) 12%,transparent);color:var(--status-good);font-weight:750}.health-limited .health-indicator{background:color-mix(in srgb,var(--status-warning) 12%,transparent);color:var(--status-warning)}.health-link{color:var(--brand);font-weight:650;white-space:nowrap}@media(max-width:500px){.health-bar{flex-wrap:wrap}.health-link{margin-inline-start:40px}}.health-compact{background:transparent;border:0;border-radius:0;padding:0;font-size:12px}.health-compact .health-indicator{width:20px;height:20px;font-size:11px}.health-compact strong{font-size:12px;font-weight:500}.health-compact .health-link{font-size:12px;font-weight:400}.health-compact .flex-1{flex:initial}</style>
