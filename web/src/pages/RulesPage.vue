<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api, type Rule, type Category, type Preview } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';
import LlmSuggestions from '../components/LlmSuggestions.vue';
import AppDialog from '../components/AppDialog.vue';
const route = useRoute();
const rules = ref<Rule[]>([]), categories = ref<Category[]>([]), error = ref(''), message = ref(''), busy = ref(false), loaded = ref(false), query = ref(''), open = ref(false), editing = ref<string | null>(null), preview = ref<Preview | null>(null), applyPreview = ref<Awaited<ReturnType<typeof api.applyRules>> | null>(null), recategorize = ref(false), deleting = ref<Rule | null>(null), applyExisting = ref(true);
const form = reactive({ pattern: '', matchType: 'contains' as 'contains' | 'regex', priority: 10, categoryId: '' });
const filtered = computed(() => rules.value.filter(r => (r.pattern + ' ' + r.category.name).toLowerCase().includes(query.value.toLowerCase())));
const msg = (e: unknown) => e instanceof Error ? e.message : 'הפעולה לא הושלמה. נסו שוב.';
const countLabel = (n: number) => n === 1 ? 'תנועה אחת' : n + ' תנועות';
/** Existing rows this rule would take: still uncategorised, and not claimed by a stronger rule. Exact, from the server. */
const claimable = computed(() => preview.value?.claimable ?? 0);
// The transaction drawer links here with ?pattern=…, so arriving lands on that rule.
watch(() => route.query.pattern, p => { if (typeof p === 'string') query.value = p; }, { immediate: true });
async function load() { try {
    [rules.value, categories.value] = await Promise.all([api.rules(), api.categories()]);
}
catch (e) {
    error.value = msg(e);
}
finally {
    loaded.value = true;
} }
onMounted(() => { load(); window.addEventListener('ledger:undone', load); });
onBeforeUnmount(() => window.removeEventListener('ledger:undone', load));
function edit(r?: Rule, pattern = '') { editing.value = r?.id ?? null; Object.assign(form, { pattern: r?.pattern ?? pattern, matchType: r?.matchType ?? 'contains', priority: r?.priority ?? 10, categoryId: r?.categoryId ?? '' }); preview.value = null; applyExisting.value = true; error.value = ''; open.value = true; }
async function check() { busy.value = true; error.value = ''; try {
    preview.value = await api.previewRule({ ...form, id: editing.value ?? undefined });
    applyExisting.value = true;
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function save() { busy.value = true; error.value = ''; try {
    const id = editing.value ?? (await api.createRule(form)).id;
    if (editing.value)
        await api.editRule(id, form);
    let text = 'החוק נשמר. תנועות חדשות שיתאימו לו יסווגו אוטומטית.';
    if (applyExisting.value && claimable.value > 0) {
        // Only this rule runs, and only rows with no category are filled.
        const result = await api.applyRule(id);
        text = result.categorized ? `החוק נשמר ו־${countLabel(result.categorized)} ${result.categorized === 1 ? 'סווגה' : 'סווגו'}. אפשר לבטל בהיסטוריית השינויים.` : 'החוק נשמר. לא נמצאו תנועות ללא קטגוריה שמתאימות לו.';
    }
    open.value = false;
    message.value = text;
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function checkApply(all: boolean) { busy.value = true; error.value = ''; recategorize.value = all; try {
    applyPreview.value = await api.applyRules(all, true);
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function apply() { busy.value = true; try {
    const result = await api.applyRules(recategorize.value);
    message.value = `${countLabel(result.categorized)} ${result.categorized === 1 ? 'סווגה' : 'סווגו'}. אפשר לבטל בהיסטוריית השינויים.`;
    applyPreview.value = null;
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function remove() { if (!deleting.value)
    return; busy.value = true; try {
    await api.deleteRule(deleting.value.id);
    deleting.value = null;
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
</script>
<template>
<div class="space-y-5">
<header class="page-heading">
<div>
<p class="eyebrow">אוטומציה עם שליטה</p>
<h1>חוקי סיווג</h1>
<p>רואים מה יתאים לפני ששומרים. סיווג ידני תמיד נשמר.</p>
</div>
<button class="btn btn-primary" @click="edit()">חוק חדש</button>
</header>
<p v-if="error&&!open&&!applyPreview&&!deleting" role="alert" class="error-box">{{error}}</p>
<p v-if="message" role="status" class="notice-panel">{{message}}</p>
<div class="card p-4 flex flex-wrap gap-3 items-center justify-between">
<label>חיפוש חוק<input v-model="query" type="search" class="field ms-2" placeholder="שם בית עסק או קטגוריה"/>
</label>
<div class="flex flex-wrap gap-2">
<button class="btn btn-ghost" :disabled="busy" @click="checkApply(false)">סיווג תנועות ללא קטגוריה</button>
<button class="btn btn-ghost" :disabled="busy" @click="checkApply(true)">בדיקת סיווג מחדש</button>
</div>
</div>
<p class="section-hint">העדיפות הגבוהה מנצחת; בשוויון, החוק הוותיק קודם.</p>
<div class="space-y-2">
<article v-for="r in filtered" :key="r.id" class="card p-4 flex flex-wrap items-center justify-between gap-4">
<div>
<h2 class="font-semibold" dir="auto">{{r.pattern}}</h2>
<p class="section-hint">{{r.category.name}} · {{r.matchType==='regex'?'ביטוי רגולרי':'מכיל טקסט'}} · עדיפות {{r.priority}}</p>
</div>
<div class="flex gap-2">
<button class="btn btn-ghost" @click="edit(r)">עריכה</button>
<button class="btn btn-danger-ghost" @click="error='';deleting=r">מחיקה</button>
</div>
</article>
<div v-if="loaded&&!rules.length" class="empty-state">
<h2>עדיין אין חוקים</h2>
<p>חוק מסווג אוטומטית כל תנועה שמכילה טקסט מסוים, למשל: כל תנועה שמכילה ״שופרסל״ תסווג ל״סופרמרקט״. אפשר ליצור חוק כאן, או לסמן ״להחיל על כל תנועה מבית העסק״ כשמסווגים תנועה.</p>
</div>
<div v-else-if="loaded&&!filtered.length" class="empty-state">
<p>אין חוקים שמתאימים לחיפוש ״{{query}}״.</p>
<button class="btn btn-ghost mt-3" @click="edit(undefined,query.trim())">חוק חדש עבור ״{{query.trim()}}״</button>
</div>
</div>
<details class="fold-panel">
<summary>הצעות סיווג ממודל מקומי</summary>
<div class="p-4">
<LlmSuggestions @applied="load"/>
</div>
</details>
<AppDialog :open="open" :title="editing?'עריכת חוק':'חוק חדש'" @close="!busy&&(open=false)">
<form class="space-y-4" @submit.prevent="preview?save():check()">
<p v-if="error" class="error-box" role="alert">{{error}}</p>
<template v-if="!preview">
<label class="block">טקסט לחיפוש<input v-model="form.pattern" class="field w-full" required/>
</label>
<label class="block">סוג התאמה<select v-model="form.matchType" class="field w-full">
<option value="contains">מכיל טקסט</option>
<option value="regex">ביטוי רגולרי (מתקדם)</option>
</select>
</label>
<label class="block">קטגוריה<select v-model="form.categoryId" class="field w-full" required>
<option value="" disabled>בחירת קטגוריה…</option>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
</select>
</label>
<label class="block">עדיפות<input v-model.number="form.priority" type="number" class="field w-full" required/>
</label>
</template>
<div v-else class="space-y-3">
<h3 class="font-bold">{{preview.count===1?'תנועה אחת תואמת':preview.count+' תנועות תואמות'}} · {{fmtILSRound(preview.amount)}}</h3>
<p class="section-hint">{{preview.locked??0}} סווגו ידנית ויישמרו · {{preview.conflicts??0}} תואמות גם לחוק בעדיפות גבוהה או שווה.</p>
<ul class="space-y-2">
<li v-for="t in preview.samples" :key="t.id" class="flex justify-between gap-3">
<span>{{t.description}}</span>
<span class="tnum">{{fmtILSRound(t.amount)}}</span>
</li>
</ul>
<label v-if="claimable>0" class="flex items-start gap-2">
<input v-model="applyExisting" type="checkbox" class="mt-1"/>
<span>לסווג גם את התנועות הקיימות ({{countLabel(claimable)}})<span class="block section-hint">רק תנועות שעדיין ללא קטגוריה יסווגו; סיווגים קיימים לא ישתנו.</span></span>
</label>
<p v-else class="section-hint">החוק יחול על תנועות חדשות שיתאימו לו.</p>
</div>
<div class="flex gap-2">
<button class="btn btn-primary" :disabled="busy||!form.categoryId">{{preview?'שמירת החוק':'תצוגה מקדימה'}}</button>
<button v-if="preview" type="button" class="btn btn-ghost" @click="preview=null">חזרה</button>
</div>
</form>
</AppDialog>
<AppDialog :open="!!applyPreview" title="בדיקת השפעה על תנועות" @close="!busy&&(applyPreview=null)">
<div v-if="applyPreview" class="space-y-4">
<p v-if="error" class="error-box" role="alert">{{error}}</p>
<h3 class="text-xl font-bold">{{applyPreview.categorized===1?'תנועה אחת תשתנה':applyPreview.categorized+' תנועות ישתנו'}}</h3>
<p>מתוך {{countLabel(applyPreview.scanned)}} שנבדקו. בחירות ידניות נשמרות.</p>
<ul>
<li v-for="t in applyPreview.samples" :key="t.id" class="flex justify-between gap-3 py-2">
<span>{{t.description}}</span>
<span>{{fmtILSRound(t.amount)}}</span>
</li>
</ul>
<button class="btn btn-primary" :disabled="busy||!applyPreview.categorized" @click="apply">אישור הסיווג</button>
</div>
</AppDialog>
<AppDialog :open="!!deleting" title="מחיקת חוק" @close="!busy&&(deleting=null)">
<p>למחוק את החוק ״{{deleting?.pattern}}״? הסיווגים הקיימים יישמרו. אפשר לבטל בהיסטוריית השינויים.</p>
<p v-if="error" class="error-box" role="alert">{{error}}</p>
<div class="flex gap-2 mt-4">
<button class="btn btn-danger" :disabled="busy" @click="remove">{{busy?'מוחק…':'מחיקת החוק'}}</button>
<button class="btn btn-ghost" :disabled="busy" @click="deleting=null">ביטול</button>
</div>
</AppDialog>
</div>
</template>
<style scoped>.btn-danger{background:var(--status-critical);color:#fff}.btn-danger:not(:disabled):hover{filter:brightness(1.08)}</style>
