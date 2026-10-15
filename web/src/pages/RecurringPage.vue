<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { api, type Recurring, type Account, type Category } from '../lib/api.js';
import { fmtDate, fmtDayMonth, fmtILSRound } from '../lib/format.js';
import AppDialog from '../components/AppDialog.vue';
const items = ref<Recurring[]>([]), accounts = ref<Account[]>([]), categories = ref<Category[]>([]), anchorDay = ref(1), error = ref(''), message = ref(''), loading = ref(true), busy = ref(false), open = ref(false), editing = ref<string | null>(null);
const form = reactive({ displayName: '', direction: 'expense', amount: 0, expectedDay: 1, frequency: 'monthly', accountId: '', categoryId: '', active: true, validFrom: '', validUntil: '' });
const labels: Record<string, string> = { active: 'צפוי — עוד לא שולם במחזור', inactive: 'מושהה', future: 'טרם התחיל', expired: 'הסתיים', stale: 'לא נראה תשלום כבר כמה מחזורים, ולכן לא נכלל בתחזית' };
const msg = (e: unknown) => e instanceof Error ? e.message : 'הפעולה לא הושלמה. נסו שוב.';
const totals = computed(() => items.value.filter(i => i.forecastState === 'active').reduce((s, i) => { s[i.direction === 'income' ? 'income' : 'expense'] += Math.abs(i.expectedAmount) / (i.frequency === 'bimonthly' ? 2 : 1); return s; }, { income: 0, expense: 0 }));
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const dayIn = (y: number, m: number, day: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth();
/** Start of the current salary cycle, from the anchor day in settings. */
const cycleStart = computed(() => { const t = today(), here = dayIn(t.getFullYear(), t.getMonth(), anchorDay.value); return t >= here ? here : dayIn(t.getFullYear(), t.getMonth() - 1, anchorDay.value); });
const paidThisCycle = (i: Recurring) => i.occurrences > 0 && new Date(i.lastSeen) >= cycleStart.value;
/** The next date this item is expected, after any payment already seen this cycle. */
function nextDue(i: Recurring) {
  const t = today(), last = new Date(i.lastSeen), step = i.frequency === 'bimonthly' ? 2 : 1, paid = paidThisCycle(i);
  const anchored = step === 2 && i.occurrences > 0;
  let y = anchored ? last.getFullYear() : t.getFullYear(), m = anchored ? last.getMonth() : t.getMonth(), d = dayIn(y, m, i.expectedDay);
  for (let k = 0; k < 40 && (d < t || ((paid || anchored) && monthIndex(d) <= monthIndex(last))); k++) { m += step; d = dayIn(y, m, i.expectedDay); }
  if (i.validUntil && d > new Date(i.validUntil)) return null;
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  return `הבא: ${fmtDayMonth(d.toISOString())}, ${days === 0 ? 'היום' : days === 1 ? 'מחר' : `בעוד ${days} ימים`}`;
}
function stateLabel(i: Recurring) { const s = i.forecastState ?? 'inactive'; return s === 'active' && paidThisCycle(i) ? `${i.direction === 'income' ? 'התקבל' : 'שולם'} במחזור הזה · ${fmtDayMonth(i.lastSeen)}` : labels[s]; }
async function load() { loading.value = true; try {
    const [list, accs, cats, settings] = await Promise.all([api.recurringStatus(), api.accounts(), api.categories(), api.settings()]);
    items.value = list; accounts.value = accs; categories.value = cats; anchorDay.value = settings.cycleAnchorDay;
    error.value = '';
}
catch (e) {
    error.value = msg(e);
}
finally {
    loading.value = false;
} }
onMounted(() => { load(); window.addEventListener('ledger:undone', load); });
onBeforeUnmount(() => window.removeEventListener('ledger:undone', load));
function edit(item?: Recurring) { editing.value = item?.id ?? null; Object.assign(form, { displayName: item?.displayName ?? '', direction: item?.direction ?? 'expense', amount: Math.abs(item?.expectedAmount ?? 0) / 100, expectedDay: item?.expectedDay ?? 1, frequency: item?.frequency ?? 'monthly', accountId: item?.accountId ?? '', categoryId: item?.categoryId ?? '', active: item?.active ?? true, validFrom: item?.validFrom?.slice(0, 10) ?? '', validUntil: item?.validUntil?.slice(0, 10) ?? '' }); error.value = ''; open.value = true; }
async function save() { busy.value = true; error.value = ''; try {
    await api.saveRecurring(editing.value, { ...form, expectedAmount: Math.round(form.amount * 100) * (form.direction === 'expense' ? -1 : 1), accountId: form.accountId || null, categoryId: form.categoryId || null, validFrom: form.validFrom || null, validUntil: form.validUntil || null });
    open.value = false;
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function toggle(i: Recurring) { busy.value = true; try {
    await api.setRecurringActive(i.id, !i.active);
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
/** Confirming marks the item as yours, so it no longer expires for lack of payments. */
async function confirmStill(i: Recurring) { busy.value = true; try {
    await api.setRecurringActive(i.id, true);
    message.value = `״${i.displayName}״ סומן כבתוקף ונכלל שוב בתחזית.`;
    await load();
}
catch (e) {
    error.value = msg(e);
}
finally {
    busy.value = false;
} }
async function detect() { busy.value = true; message.value = ''; const before = new Set(items.value.map(i => i.id)); try {
    const result = await api.detectRecurring();
    await load();
    const found = items.value.filter(i => !before.has(i.id)).length;
    message.value = (found === 0 ? 'לא נמצאו קבועות חדשות.' : found === 1 ? 'נמצאה קבועה חדשה אחת.' : `נמצאו ${found} קבועות חדשות.`) + (result.removed ? ` ${result.removed === 1 ? 'אחת הושהתה' : result.removed + ' הושהו'} כי לא נראו לאחרונה.` : '');
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
<p class="eyebrow">תכנון קדימה</p>
<h1>הכנסות והוצאות קבועות</h1>
<p>מה צפוי להיכנס ולצאת, ומדוע הוא נכלל בתחזית.</p>
</div>
<div class="flex gap-2">
<button class="btn btn-ghost" :disabled="busy" @click="detect">{{busy?'מחפש…':'זיהוי מההיסטוריה'}}</button>
<button class="btn btn-primary" @click="edit()">הוספה ידנית</button>
</div>
</header>
<p v-if="error&&!open" role="alert" class="error-box">{{error}}</p>
<p v-if="message" role="status" class="notice-panel">{{message}}</p>
<div class="metric-grid">
<div class="metric-card">
<h2>הכנסה חודשית מתוכננת</h2>
<strong class="value block">{{loading?'—':fmtILSRound(totals.income)}}</strong>
</div>
<div class="metric-card">
<h2>הוצאה חודשית מתוכננת</h2>
<strong class="value block">{{loading?'—':fmtILSRound(totals.expense)}}</strong>
</div>
</div>
<p class="section-hint">סכומים פעילים ובתוקף. דו־חודשי מחושב כמחצית; סכום זה שונה מהיתרה שעוד נותרה לתשלום במחזור.</p>
<p v-if="loading" class="empty-state">טוען הכנסות והוצאות קבועות…</p>
<div v-else class="space-y-3">
<article v-for="item in items" :key="item.id" class="card p-5 recurring-row">
<div>
<h2 class="font-bold">{{item.displayName}}</h2>
<p class="section-hint">{{item.account?.displayName??'כל החשבונות'}} · ביום {{item.expectedDay}} · {{item.frequency==='monthly'?'חודשי':'דו־חודשי'}}</p>
<p class="section-hint">{{item.source==='detected'?'זוהה מההיסטוריה · '+(item.occurrences===1?'תנועה אחת':item.occurrences+' תנועות'):'אושר ידנית'}}<span v-if="item.occurrences"> · אחרון {{fmtDate(item.lastSeen)}}</span>
</p>
<p class="mt-2 text-xs">{{stateLabel(item)}}<span v-if="item.forecastState==='active'&&nextDue(item)"> · {{nextDue(item)}}</span><span v-if="item.validUntil"> · עד {{fmtDate(item.validUntil)}}</span>
</p>
</div>
<strong class="tnum text-xl">{{fmtILSRound(item.expectedAmount)}}</strong>
<div class="flex flex-wrap gap-2">
<button v-if="item.forecastState==='stale'" class="btn btn-primary" :disabled="busy" @click="confirmStill(item)">עדיין בתוקף</button>
<button class="btn btn-ghost" @click="edit(item)">עריכה</button>
<button class="btn btn-ghost" :disabled="busy" @click="toggle(item)">{{item.active?'השהיה':'הפעלה'}}</button>
</div>
</article>
<p v-if="!items.length" class="empty-state">אין עדיין הכנסות או הוצאות קבועות. אפשר להוסיף ידנית או לזהות מההיסטוריה.</p>
</div>
<AppDialog :open="open" :title="editing?'עריכת קבועה':'הכנסה או הוצאה קבועה חדשה'" @close="!busy&&(open=false)">
<form class="space-y-4" @submit.prevent="save">
<p v-if="error" class="error-box" role="alert">{{error}}</p>
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
<input v-model="form.active" type="checkbox"/>נכלל בתחזית</label>
<p class="section-hint">נזהה את התשלום לפי השם והחשבון. אם לא יופיע, עדיין נכלול אותו בתחזית. תנועות קיימות לא משתנות, ואפשר לבטל בהיסטוריית השינויים.</p>
<div class="flex gap-2">
<button class="btn btn-primary" :disabled="busy">{{busy?'שומר…':'שמירה'}}</button>
<button type="button" class="btn btn-ghost" :disabled="busy" @click="open=false">ביטול</button>
</div>
</form>
</AppDialog>
</div>
</template>
<style scoped>.recurring-row{display:grid;grid-template-columns:1fr auto auto;gap:24px;align-items:center}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:700px){.recurring-row{grid-template-columns:1fr auto}.recurring-row>div:last-child{grid-column:1/-1}}</style>
