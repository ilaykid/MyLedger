<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ForecastRecord } from '../lib/api';
import { fmtSigned, fmtDate } from '../lib/format';
const changes = ref<Awaited<ReturnType<typeof api.changes>>>([]), forecasts = ref<ForecastRecord[]>([]), error = ref(''), busy = ref(''), loading = ref(true);
async function load() { loading.value = true; error.value = ''; try {
    [changes.value, forecasts.value] = await Promise.all([api.changes(), api.forecasts()]);
}
catch (e) {
    error.value = e instanceof Error ? e.message : 'הפעולה לא הושלמה. נסו שוב.';
}
finally {
    loading.value = false;
} }
async function undo(id: string) { busy.value = id; error.value = ''; try {
    await api.undo(id);
    await load();
}
catch (e) {
    error.value = e instanceof Error ? e.message : 'הפעולה לא הושלמה. נסו שוב.';
}
finally {
    busy.value = '';
} }
onMounted(load);
</script>
<template>
<div class="space-y-5">
<div class="page-heading">
<div>
<h1>היסטוריית שינויים</h1>
<p>הבחירות שלכם נשמרות. אפשר לחזור אחורה כל עוד הנתונים לא השתנו מאז.</p>
</div>
</div>
<p v-if="error" class="error-banner" role="alert">{{error}}</p>
<p v-if="loading" class="loading-line">טוען…</p>
<div v-else-if="!changes.length" class="card empty-state">
<h2>כאן יופיעו השינויים הבאים שלכם</h2>
<p>סיווגים, חוקים ותיקונים בקבועות יתועדו עם אפשרות ביטול.</p>
</div>
<div v-else class="card p-5 divide-y">
<div v-for="c in changes" :key="c.id" class="flex items-center justify-between gap-4 py-4">
<div>
<h2 class="font-semibold">{{c.title}}</h2>
<p class="text-xs muted mt-1">{{new Date(c.createdAt).toLocaleString('he-IL')}} · {{c.undoneAt?'בוטל':'נשמר'}}</p>
</div>
<button v-if="!c.undoneAt" class="btn btn-ghost" :disabled="!!busy" @click="undo(c.id)">{{busy===c.id?'מבטל…':'ביטול השינוי'}}</button>
</div>
</div>
<details class="fold">
<summary>תחזיות מול התוצאה בפועל</summary>
<p class="text-sm muted mb-4">נשמרת תחזית אחת לכל יום, והיא לא משתנה גם אם מתקנים סיווגים אחר כך. כשהמחזור נגמר, משווים אותה לעודף או לגירעון שהיו בפועל.</p>
<p v-if="!forecasts.length" class="muted">לא נשמרו תחזיות עדיין. שמירת תחזית נעשית ממסך התכנון.</p>
<div class="overflow-x-auto">
<table v-if="forecasts.length" class="w-full text-sm">
<thead>
<tr class="text-start">
<th>נשמרה ביום</th>
<th>הנתונים ביום השמירה</th>
<th>עודף/גירעון צפוי</th>
<th>בפועל</th>
<th>הפרש</th>
</tr>
</thead>
<tbody>
<tr v-for="f in forecasts" :key="f.id">
<td class="py-3">{{fmtDate(f.asOf)}}</td>
<td>{{({complete:'מלאים',partial:'חלקיים',stale:'לא מעודכנים',unavailable:'חסרים'} as Record<string,string>)[f.quality]??f.quality}} · {{f.basisCycles===1?'לפי מחזור קודם אחד':'לפי '+f.basisCycles+' מחזורים קודמים'}}</td>
<td>{{fmtSigned(f.predictedNet)}}</td>
<td>{{f.actualNet==null?'המחזור עוד לא נגמר':fmtSigned(f.actualNet)}}</td>
<td>{{f.error==null?'—':fmtSigned(f.error)}}</td>
</tr>
</tbody>
</table>
</div>
</details>
</div>
</template>
