<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { api, type Rule, type Category, type Preview } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';
import LlmSuggestions from '../components/LlmSuggestions.vue';
import AppDialog from '../components/AppDialog.vue';
const rules = ref<Rule[]>([]), categories = ref<Category[]>([]), error = ref(''), message = ref(''), busy = ref(false), query = ref(''), open = ref(false), editing = ref<string | null>(null), preview = ref<Preview | null>(null), applyPreview = ref<Awaited<ReturnType<typeof api.applyRules>> | null>(null), recategorize = ref(false), deleting = ref<Rule | null>(null);
const form = reactive({ pattern: '', matchType: 'contains' as 'contains' | 'regex', priority: 10, categoryId: '' });
const filtered = computed(() => rules.value.filter(r => (r.pattern + ' ' + r.category.name).toLowerCase().includes(query.value.toLowerCase())));
async function load() { try {
    [rules.value, categories.value] = await Promise.all([api.rules(), api.categories()]);
}
catch (e) {
    error.value = String(e);
} }
onMounted(() => { load(); window.addEventListener('ledger:undone', load); });
onBeforeUnmount(() => window.removeEventListener('ledger:undone', load));
function edit(r?: Rule) { editing.value = r?.id ?? null; Object.assign(form, { pattern: r?.pattern ?? '', matchType: r?.matchType ?? 'contains', priority: r?.priority ?? 10, categoryId: r?.categoryId ?? categories.value[0]?.id ?? '' }); preview.value = null; error.value = ''; open.value = true; }
async function check() { busy.value = true; try {
    preview.value = await api.previewRule({ ...form, id: editing.value ?? undefined });
}
catch (e) {
    error.value = String(e);
}
finally {
    busy.value = false;
} }
async function save() { busy.value = true; try {
    if (editing.value)
        await api.editRule(editing.value, form);
    else
        await api.createRule(form);
    open.value = false;
    message.value = 'החוק נשמר. החלה על היסטוריה נעשית בנפרד, אחרי תצוגה מקדימה.';
    await load();
}
catch (e) {
    error.value = String(e);
}
finally {
    busy.value = false;
} }
async function checkApply(all: boolean) { busy.value = true; error.value = ''; recategorize.value = all; try {
    applyPreview.value = await api.applyRules(all, true);
}
catch (e) {
    error.value = String(e);
}
finally {
    busy.value = false;
} }
async function apply() { busy.value = true; try {
    const result = await api.applyRules(recategorize.value);
    message.value = result.categorized + ' תנועות סווגו. אפשר לבטל ביומן הפעולות.';
    applyPreview.value = null;
    await load();
}
catch (e) {
    error.value = String(e);
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
    error.value = String(e);
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
<p v-if="error" role="alert" class="error-box">{{error}}</p>
<p v-if="message" role="status" class="notice-panel">{{message}}</p>
<div class="card p-4 flex flex-wrap gap-3 items-center justify-between">
<label>חיפוש חוק<input v-model="query" class="field ms-2" placeholder="שם בית עסק או קטגוריה"/>
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
<button class="btn btn-danger-ghost" @click="deleting=r">מחיקה</button>
</div>
</article>
<p v-if="!filtered.length" class="empty-state">אין חוקים שמתאימים לחיפוש.</p>
</div>
<details class="fold-panel">
<summary>הצעות סיווג בעזרת AI</summary>
<div class="p-4">
<LlmSuggestions @applied="load"/>
</div>
</details>
<AppDialog :open="open" :title="editing?'עריכת חוק':'חוק חדש'" @close="!busy&&(open=false)">
<form class="space-y-4" @submit.prevent="preview?save():check()">
<p v-if="error" class="error-box">{{error}}</p>
<template v-if="!preview">
<label class="block">טקסט לחיפוש<input v-model="form.pattern" class="field w-full" required/>
</label>
<label class="block">סוג התאמה<select v-model="form.matchType" class="field w-full">
<option value="contains">מכיל טקסט</option>
<option value="regex">ביטוי רגולרי (מתקדם)</option>
</select>
</label>
<label class="block">קטגוריה<select v-model="form.categoryId" class="field w-full" required>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
</select>
</label>
<label class="block">עדיפות<input v-model.number="form.priority" type="number" class="field w-full" required/>
</label>
</template>
<div v-else class="space-y-3">
<h3 class="font-bold">{{preview.count}} תנועות תואמות · {{fmtILSRound(preview.amount)}}</h3>
<p class="section-hint">{{preview.locked??0}} סווגו ידנית ויישמרו · {{preview.conflicts??0}} תואמות גם לחוק בעדיפות גבוהה או שווה.</p>
<ul class="space-y-2">
<li v-for="t in preview.samples" :key="t.id" class="flex justify-between gap-3">
<span>{{t.description}}</span>
<span class="tnum">{{fmtILSRound(t.amount)}}</span>
</li>
</ul>
<p class="notice-panel">שמירת החוק משפיעה על סיווגים עתידיים. לסיווג תנועות קיימות, השתמשו בפעולת ההחלה בראש המסך.</p>
</div>
<div class="flex gap-2">
<button class="btn btn-primary" :disabled="busy">{{preview?'שמירת החוק':'תצוגה מקדימה'}}</button>
<button v-if="preview" type="button" class="btn btn-ghost" @click="preview=null">חזרה</button>
</div>
</form>
</AppDialog>
<AppDialog :open="!!applyPreview" title="בדיקת השפעה על תנועות" @close="!busy&&(applyPreview=null)">
<div v-if="applyPreview" class="space-y-4">
<p v-if="error" class="error-box">{{error}}</p>
<h3 class="text-xl font-bold">{{applyPreview.categorized}} תנועות ישתנו</h3>
<p>מתוך {{applyPreview.scanned}} תנועות שנבדקו. בחירות ידניות נשמרות.</p>
<ul>
<li v-for="t in applyPreview.samples" :key="t.id" class="flex justify-between gap-3 py-2">
<span>{{t.description}}</span>
<span>{{fmtILSRound(t.amount)}}</span>
</li>
</ul>
<button class="btn btn-primary" :disabled="busy||!applyPreview.categorized" @click="apply">אישור הסיווג</button>
</div>
</AppDialog>
<AppDialog :open="!!deleting" title="מחיקת חוק" @close="deleting=null">
<p>למחוק את החוק ״{{deleting?.pattern}}״? הסיווגים הקיימים יישמרו. אפשר לבטל ביומן הפעולות.</p>
<p v-if="error" class="error-box">{{error}}</p>
<button class="btn btn-primary mt-4" :disabled="busy" @click="remove">מחיקת החוק</button>
</AppDialog>
</div>
</template>
