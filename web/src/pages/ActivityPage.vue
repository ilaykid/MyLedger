<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, type ForecastRecord } from '../lib/api';
import { fmtILSRound, fmtDate } from '../lib/format';
const changes = ref<Awaited<ReturnType<typeof api.changes>>>([]), forecasts = ref<ForecastRecord[]>([]), error = ref(''), busy = ref(''), loading = ref(true);
async function load() { loading.value = true; error.value = ''; try {
    [changes.value, forecasts.value] = await Promise.all([api.changes(), api.forecasts()]);
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
}
finally {
    loading.value = false;
} }
async function undo(id: string) { busy.value = id; error.value = ''; try {
    await api.undo(id);
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
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
<p>הבחירות שלך נשמרות. אפשר לחזור אחורה כל עוד הנתונים לא השתנו מאז.</p>
</div>
</div>
<p v-if="error" class="error-banner" role="alert">{{error}}</p>
<p v-if="loading" class="loading-line">טוען…</p>
<div v-else-if="!changes.length" class="card empty-state">
<h2>כאן יופיעו השינויים הבאים שלך</h2>
<p>סיווגים, חוקים ותיקוני התחייבויות יתועדו עם אפשרות ביטול.</p>
</div>
<div v-else class="card p-5 divide-y">
<div v-for="c in changes" :key="c.id" class="flex items-center justify-between gap-4 py-4">
<div>
<h2 class="font-semibold">{{c.title}}</h2>
<p class="text-xs muted mt-1">{{new Date(c.createdAt).toLocaleString('he-IL')}} · {{c.undoneAt?'בוטל':'נשמר'}}</p>
</div>
<button v-if="!c.undoneAt" class="btn btn-ghost" :disabled="!!busy" @click="undo(c.id)">{{busy===c.id?'מבטל…':'ביטול'}}</button>
</div>
</div>
<details class="fold">
<summary>תחזיות מול התוצאה בפועל</summary>
<p class="text-sm muted mb-4">התחזית הראשונה שנשמרה בכל יום אינה נכתבת מחדש לאחר תיקוני סיווג. השוואה מוצגת לאחר סיום המחזור, לפי אותן הגדרות הכנסה, הוצאה ופריסה.</p>
<p v-if="!forecasts.length" class="muted">לא נשמרו תחזיות עדיין. אפשר לשמור תמונת מצב ממסך הבית.</p>
<div class="overflow-x-auto">
<table v-if="forecasts.length" class="w-full text-sm">
<thead>
<tr class="text-start">
<th>נשמרה ביום</th>
<th>איכות בעת השמירה</th>
<th>תחזית</th>
<th>בפועל</th>
<th>פער</th>
</tr>
</thead>
<tbody>
<tr v-for="f in forecasts" :key="f.id">
<td class="py-3">{{fmtDate(f.asOf)}}</td>
<td>{{({complete:'שלמים',partial:'חלקיים',stale:'לא עדכניים',unavailable:'חסרים'} as Record<string,string>)[f.quality]}} · {{f.basisCycles}} מחזורי בסיס</td>
<td>{{fmtILSRound(f.predictedNet)}}</td>
<td>{{f.actualNet==null?'טרם ניתן להשוות':fmtILSRound(f.actualNet)}}</td>
<td>{{f.error==null?'—':fmtILSRound(f.error)}}</td>
</tr>
</tbody>
</table>
</div>
</details>
</div>
</template>
