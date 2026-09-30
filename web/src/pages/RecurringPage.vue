<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { api, type Recurring, type Account, type Category } from '../lib/api.js';
import { fmtDate, fmtILSRound } from '../lib/format.js';
import AppDialog from '../components/AppDialog.vue';
const items = ref<Recurring[]>([]), accounts = ref<Account[]>([]), categories = ref<Category[]>([]), error = ref(''), loading = ref(true), busy = ref(false), open = ref(false), editing = ref<string | null>(null), review = ref(false);
const form = reactive({ displayName: '', direction: 'expense', amount: 0, expectedDay: 1, frequency: 'monthly', accountId: '', categoryId: '', active: true, validFrom: '', validUntil: '' });
const labels: Record<string, string> = { active: 'נכלל בחיזוי כשטרם שולם', inactive: 'מושהה', future: 'טרם התחיל', expired: 'הסתיים', stale: 'נדרש אישור מחדש' };
const totals = computed(() => items.value.filter(i => i.forecastState === 'active').reduce((s, i) => { s[i.direction === 'income' ? 'income' : 'expense'] += Math.abs(i.expectedAmount) / (i.frequency === 'bimonthly' ? 2 : 1); return s; }, { income: 0, expense: 0 }));
async function load() { loading.value = true; try {
    [items.value, accounts.value, categories.value] = await Promise.all([api.recurringStatus(), api.accounts(), api.categories()]);
    error.value = '';
}
catch (e) {
    error.value = String(e);
}
finally {
    loading.value = false;
} }
onMounted(() => { load(); window.addEventListener('ledger:undone', load); });
onBeforeUnmount(() => window.removeEventListener('ledger:undone', load));
function edit(item?: Recurring) { editing.value = item?.id ?? null; Object.assign(form, { displayName: item?.displayName ?? '', direction: item?.direction ?? 'expense', amount: Math.abs(item?.expectedAmount ?? 0) / 100, expectedDay: item?.expectedDay ?? 1, frequency: item?.frequency ?? 'monthly', accountId: item?.accountId ?? '', categoryId: item?.categoryId ?? '', active: item?.active ?? true, validFrom: item?.validFrom?.slice(0, 10) ?? '', validUntil: item?.validUntil?.slice(0, 10) ?? '' }); review.value = false; error.value = ''; open.value = true; }
async function save() { busy.value = true; try {
    await api.saveRecurring(editing.value, { ...form, expectedAmount: Math.round(form.amount * 100) * (form.direction === 'expense' ? -1 : 1), accountId: form.accountId || null, categoryId: form.categoryId || null, validFrom: form.validFrom || null, validUntil: form.validUntil || null });
    open.value = false;
    await load();
}
catch (e) {
    error.value = String(e);
}
finally {
    busy.value = false;
} }
async function toggle(i: Recurring) { busy.value = true; try {
    await api.setRecurringActive(i.id, !i.active);
    await load();
}
catch (e) {
    error.value = String(e);
}
finally {
    busy.value = false;
} }
async function detect() { busy.value = true; try {
    await api.detectRecurring();
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
<p class="eyebrow">תכנון קדימה</p>
<h1>הוצאות והכנסות קבועות</h1>
<p>מה צפוי להיכנס ולצאת, ומדוע הוא נכלל בתחזית.</p>
</div>
<div class="flex gap-2">
<button class="btn btn-ghost" :disabled="busy" @click="detect">זיהוי מההיסטוריה</button>
<button class="btn btn-primary" @click="edit()">הוספת התחייבות</button>
</div>
</header>
<p v-if="error" role="alert" class="error-box">{{error}}</p>
<div class="metric-grid">
<div class="metric-card">
<span>הכנסה חודשית מתוכננת</span>
<strong>{{loading?'—':fmtILSRound(totals.income)}}</strong>
</div>
<div class="metric-card">
<span>הוצאה חודשית מתוכננת</span>
<strong>{{loading?'—':fmtILSRound(totals.expense)}}</strong>
</div>
</div>
<p class="section-hint">סכומים פעילים ובתוקף. דו־חודשי מחושב כמחצית; סכום זה שונה מהיתרה שעוד נותרה לתשלום במחזור.</p>
<p v-if="loading" class="empty-state">טוען התחייבויות…</p>
<div v-else class="space-y-3">
<article v-for="item in items" :key="item.id" class="card p-5 recurring-row">
<div>
<h2 class="font-bold">{{item.displayName}}</h2>
<p class="section-hint">{{item.account?.displayName??'כל החשבונות'}} · ביום {{item.expectedDay}} · {{item.frequency==='monthly'?'חודשי':'דו־חודשי'}}</p>
<p class="section-hint">{{item.source==='detected'?'זוהה מההיסטוריה · '+item.occurrences+' תנועות':'אושר ידנית'}}<span v-if="item.occurrences"> · אחרון {{fmtDate(item.lastSeen)}}</span>
</p>
<p class="mt-2 text-xs">{{labels[item.forecastState??'inactive']}}<span v-if="item.validUntil"> · עד {{fmtDate(item.validUntil)}}</span>
</p>
</div>
<strong class="tnum text-xl">{{fmtILSRound(item.expectedAmount)}}</strong>
<div class="flex gap-2">
<button class="btn btn-ghost" @click="edit(item)">עריכה</button>
<button class="btn btn-ghost" :disabled="busy" @click="toggle(item)">{{item.active?'השהיה':'הפעלה'}}</button>
</div>
</article>
<p v-if="!items.length" class="empty-state">אין עדיין התחייבויות. אפשר להוסיף ידנית או לזהות מההיסטוריה.</p>
</div>
<AppDialog :open="open" :title="editing?'עריכת התחייבות':'התחייבות חדשה'" @close="!busy&&(open=false)">
<form class="space-y-4" @submit.prevent="review?save():review=true">
<p v-if="error" class="error-box">{{error}}</p>
<template v-if="!review">
<label class="block">שם כפי שמופיע בתנועה<input v-model="form.displayName" class="field w-full" required minlength="2" maxlength="120"/>
</label>
<div class="form-grid">
<label>כיוון<select v-model="form.direction" class="field w-full">
<option value="expense">הוצאה</option>
<option value="income">הכנסה</option>
</select>
</label>
<label>סכום בשקלים<input v-model.number="form.amount" class="field w-full" type="number" min="0.01" step="0.01" required/>
</label>
<label>יום בחודש<input v-model.number="form.expectedDay" class="field w-full" type="number" min="1" max="31" required/>
</label>
<label>תדירות<select v-model="form.frequency" class="field w-full">
<option value="monthly">חודשי</option>
<option value="bimonthly">דו־חודשי</option>
</select>
</label>
<label>חשבון<select v-model="form.accountId" class="field w-full">
<option value="">כל החשבונות</option>
<option v-for="a in accounts" :key="a.id" :value="a.id">{{a.displayName}}</option>
</select>
</label>
<label>קטגוריה<select v-model="form.categoryId" class="field w-full">
<option value="">ללא</option>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
</select>
</label>
<label>מתאריך<input v-model="form.validFrom" type="date" class="field w-full"/>
</label>
<label>עד תאריך<input v-model="form.validUntil" type="date" :min="form.validFrom" class="field w-full"/>
</label>
</div>
<label class="flex gap-2">
<input v-model="form.active" type="checkbox"/>נכלל בתכנון</label>
<p class="section-hint">התאמה לתשלום מבוססת על שם, חשבון וכיוון. התחייבות ידנית אינה פגה בגלל היעדר תנועות.</p>
</template>
<div v-else class="notice-panel">
<h3 class="font-bold">השפעה על התחזית</h3>
<p>{{form.displayName}} · {{fmtILSRound(form.amount*100)}} · {{form.direction==='expense'?'הוצאה':'הכנסה'}} {{form.frequency==='monthly'?'חודשית':'דו־חודשית'}}</p>
<p>{{form.active?'יובא בחשבון בתאריכים שנבחרו, אם לא נמצא תשלום תואם.':'לא ייכלל בתחזית.'}}</p>
<p class="section-hint">תנועות קיימות אינן משתנות. אפשר לבטל את השינוי ביומן הפעולות.</p>
</div>
<div class="flex gap-2">
<button class="btn btn-primary" :disabled="busy">{{review?'שמירה':'בדיקת השינוי'}}</button>
<button v-if="review" type="button" class="btn btn-ghost" @click="review=false">חזרה לעריכה</button>
</div>
</form>
</AppDialog>
</div>
</template>
<style scoped>.recurring-row{display:grid;grid-template-columns:1fr auto auto;gap:24px;align-items:center}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:700px){.recurring-row{grid-template-columns:1fr auto}.recurring-row>div:last-child{grid-column:1/-1}}</style>
