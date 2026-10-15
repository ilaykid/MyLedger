<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type QualityResponse, type QualityItem, type SyncHealth } from '../lib/api';
import { fmtILS, fmtDate } from '../lib/format';
import DataHealth from '../components/DataHealth.vue';
import SyncAlerts from '../components/SyncAlerts.vue';
import AppDialog from '../components/AppDialog.vue';
import { useLatest } from '../lib/useLatest';
defineProps<{ embedded?: boolean }>();
const data = ref<QualityResponse | null>(null), health = ref<SyncHealth | null>(null), error = ref(''), loading = ref(true), busy = ref(false), selected = ref<QualityItem | null>(null), note = ref('');
const latest = useLatest();
const matched = computed(() => data.value?.settlements.filter(s => s.status === 'matched').length ?? 0);
const toReview = computed(() => data.value?.settlements.filter(s => s.status === 'review').length ?? 0);
const statementMonth = ref('');
const statementMonths = computed(() => [...new Set(data.value?.settlements.map(s => s.date.slice(0, 7)) ?? [])]);
const visibleStatements = computed(() => data.value?.settlements.filter(s => !statementMonth.value || s.date.startsWith(statementMonth.value)) ?? []);
function money(amount: number | null, currency: string) {
    if (amount === null) return 'לא זוהה';
    try { return new Intl.NumberFormat('he-IL', {style:'currency',currency,minimumFractionDigits:2}).format(amount / 100); }
    catch { return (amount / 100).toLocaleString('he-IL', {minimumFractionDigits:2,maximumFractionDigits:2}) + ' ' + currency; }
}
async function load() { const current = latest(); loading.value = true; error.value = ''; try {
    const [d, h] = await Promise.all([api.quality(), api.syncHealth()]);
    if (current()) {
        data.value = d;
        health.value = h;
    }
}
catch (e) {
    if (current())
        error.value = String(e instanceof Error ? e.message : e);
}
finally {
    if (current())
        loading.value = false;
} }
async function resolve() { if (!selected.value)
    return; busy.value = true; try {
    await api.resolveQuality(selected.value.key, note.value);
    selected.value = null;
    note.value = '';
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
}
finally {
    busy.value = false;
} }
async function reopen(key: string) { try {
    await api.reopenQuality(key);
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
} }
onMounted(load);
</script>
<template>
<div class="space-y-5">
<div v-if="!embedded" class="page-heading">
<div>
<p class="eyebrow">תמונה שאפשר לסמוך עליה</p>
<h1>איכות הנתונים</h1>
<p>ממצאים לבדיקה, המקורות שלהם וההחלטות שכבר התקבלו.</p>
</div>
<button class="btn btn-ghost" :disabled="loading" @click="load">בדיקה מחדש</button>
</div>
<div class="flex flex-wrap items-center justify-between gap-3"><DataHealth :health="health" :error="error" compact hide-link/><button v-if="embedded" class="text-link" :disabled="loading" @click="load">בדיקה מחדש</button></div>
<p v-if="error" class="error-banner" role="alert">{{error}}</p>
<p v-if="loading" class="loading-line" role="status">בודק מקורות והתאמות…</p>
<template v-if="data">
<section class="settlement-overview" aria-label="התאמת אשראי לבנק">
<div class="settlement-intro"><div><p class="eyebrow">האשראי והבנק, באותה תמונה</p><h2>{{toReview?'בואו נעשה סדר בחיובים':matched?'החיובים מתחברים':'בודקים את מחזורי האשראי'}}</h2><p>{{matched}} מחזורי חיוב תואמים לבנק בדיוק<span v-if="toReview"> · {{toReview}} דורשים בדיקה</span>.</p></div><span class="reconcile-mark" aria-hidden="true">↔</span></div>
<details class="settlement-details"><summary>איך הסכומים מתחברים? <span>פירוט {{data.settlements.length}} מחזורי חיוב</span></summary>
<p class="settlement-note">מחזורי חיוב מ־{{fmtDate(data.since)}}. כל העסקאות שהושלמו במועד החיוב נכללות, גם אם נקנו קודם; זיכויים מופחתים מהסכום. השוואה באותו מטבע וחברת אשראי, עד 3 ימים ממועד החיוב. סכום שלילי הוא חיוב.</p>
<label class="statement-filter">מועד חיוב <select v-model="statementMonth" class="field"><option value="">כל התקופה</option><option v-for="month in statementMonths" :key="month" :value="month">{{new Date(month+'-01T12:00:00').toLocaleDateString('he-IL',{month:'long',year:'numeric'})}}</option></select></label>
<article v-for="s in visibleStatements" :key="s.id" class="statement-row">
<div class="statement-title"><div><h3>{{s.account}}</h3><p>{{fmtDate(s.date)}} · {{s.count===1?'עסקה אחת':s.count+' עסקאות'}}</p></div><span class="statement-status" :class="{'needs-review':s.status==='review'}">{{s.status==='matched'?'תואם בדיוק':s.status==='balanced'?'מתקזז לאפס':'לבדיקה'}}</span></div>
<dl class="statement-equation"><div><dt>נטו בכרטיס</dt><dd>{{money(s.cardAmount,s.currency)}}</dd></div><div><dt>{{s.status==='review'?'תנועה אפשרית בבנק':'בבנק'}}</dt><dd>{{money(s.bankAmount,s.currency)}}</dd></div><div><dt>הפרש</dt><dd>{{s.difference===null?'—':money(s.difference,s.currency)}}</dd></div></dl>
<p class="settlement-note">{{s.reason}}<span v-if="s.bankDate&&s.bankDate!==s.date"> תאריך בבנק: {{fmtDate(s.bankDate)}}.</span></p>
<div class="statement-links"><RouterLink :to="s.href" class="text-link">עסקאות הכרטיס ←</RouterLink><RouterLink v-if="s.bankId" :to="'/transactions?transaction='+s.bankId" class="text-link">התנועה בבנק ←</RouterLink></div>
</article>
<p v-if="!visibleStatements.length" class="settlement-note">אין מחזורי חיוב שהושלמו בתקופה הזו.</p>
</details>
</section>
<div class="flex flex-wrap items-center justify-between gap-3">
<h2 class="font-bold">{{data.items.length===1?'ממצא פתוח אחד':data.items.length+' ממצאים פתוחים'}}</h2>
<RouterLink to="/connections" class="text-link">חשבונות וחיבורים ←</RouterLink>
</div>
<SyncAlerts :issues="health?.issues.filter(i=>i.severity!=='info'&&!['material','coverage_review'].includes(i.kind))??[]"/>
<details v-if="health?.issues.some(i=>i.severity==='info')" class="fold"><summary>מידע נוסף על החשבונות</summary><SyncAlerts :issues="health.issues.filter(i=>i.severity==='info')"/></details>
<p class="text-sm muted">אי־התאמה אינה בהכרח טעות. חיוב מאוחד, העברה פנימית או היסטוריה חסרה עשויים להסביר אותה.</p>
<details v-for="item in data.items" :key="item.key" class="quality-finding">
<summary>
<div class="flex flex-wrap justify-between gap-3">
<div>
<span class="eyebrow">{{item.kind==='material'?'תנועה גדולה שצריך לסווג':'פער לבדיקה'}} · {{item.count===1?'תנועה אחת':item.count+' תנועות'}}</span>
<h3 class="font-bold">{{item.title}}</h3><p v-if="item.evidence[0]" class="quality-preview">{{item.evidence[0].description}} · {{fmtDate(item.evidence[0].date)}}<span v-if="item.count>1"> ועוד</span></p>
</div>
<div class="text-xl tnum font-semibold">{{fmtILS(item.amount)}}</div>
</div>
</summary><div class="quality-evidence"><p class="text-sm muted leading-6">{{item.detail}}</p>
<details class="mt-3 text-sm">
<summary class="cursor-pointer">הראיות · {{item.count===1?'תנועה אחת':item.count+' תנועות'}}</summary>
<ul class="mt-3 divide-y">
<li v-for="row in item.evidence" :key="row.id" class="py-2 flex justify-between gap-4">
<RouterLink :to="'/transactions?transaction='+row.id" class="text-link">{{row.description}} <span class="muted">{{fmtDate(row.date)}}</span>
</RouterLink>
<span class="tnum shrink-0">{{fmtILS(row.amount)}}</span>
</li>
</ul>
</details>
<div class="mt-4 flex gap-2 flex-wrap">
<RouterLink :to="item.href" class="btn btn-primary">{{item.kind==='material'?'בדיקה וסיווג':'פתיחת התנועות'}}</RouterLink>
<button v-if="item.canResolve" class="btn btn-ghost" @click="selected=item;note=''">בדקתי, הנתון תקין</button>
</div>
</div></details>
<div v-if="!data.items.length" class="card empty-state">
<h2>אין ממצאים פתוחים</h2>
<p>הכול מתאים. נבדוק שוב בעדכון הבא.</p>
</div>
<details v-if="data.decisions.length" class="fold">
<summary>החלטות קודמות · {{data.decisions.length}}</summary>
<div v-for="d in data.decisions" :key="d.key" class="flex justify-between gap-4 py-3 border-b" :style="{borderColor:'var(--border)'}">
<div>
<p>{{d.note}}</p>
<small class="muted">{{fmtDate(d.createdAt)}}</small>
</div>
<button class="btn btn-ghost" @click="reopen(d.key)">פתיחה מחדש</button>
</div>
</details>
</template>
<AppDialog :open="!!selected" title="תיעוד הבדיקה" @close="selected=null">
<p class="text-sm muted">מה מסביר את הפער? ההחלטה נשמרת לממצא הזה בלבד; נתונים חדשים ייבדקו שוב.</p>
<label class="block mt-4 text-sm">הסבר לבדיקה<textarea v-model="note" class="field w-full mt-2" rows="3" aria-describedby="quality-note-hint" placeholder="למשל: העברה בין שני חשבונות שלי"/>
</label>
<p id="quality-note-hint" class="mt-1 text-xs muted">לפחות 3 תווים<span v-if="note.trim().length>0&&note.trim().length<3"> · עוד {{3-note.trim().length}}</span></p>
<p v-if="error" class="error-banner mt-3">{{error}}</p>
<button class="btn btn-primary mt-4" :disabled="busy||note.trim().length<3" @click="resolve">{{busy?'שומר…':'אישור ושמירה'}}</button>
</AppDialog>
</div>
</template>

<style scoped>.quality-finding{border-bottom:1px solid var(--border)}.quality-finding>summary{cursor:pointer;padding:20px 0;list-style:none}.quality-finding>summary .eyebrow{display:block;margin-bottom:4px}.quality-finding>summary h3{font-size:15px;font-weight:550}.quality-finding>summary h3:after{content:" +";color:var(--brand);margin-inline-start:10px}.quality-finding[open]>summary h3:after{content:" −"}.quality-evidence{padding:0 0 24px}.quality-finding>summary .text-xl{font-size:20px;font-weight:500}.quality-preview{font-size:12px;color:var(--text-muted);margin-top:5px;overflow-wrap:anywhere}</style>
