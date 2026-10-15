<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Txn, type TxnPage, type Category, type Account, type Preview } from '../lib/api';
import { fmtILS, fmtILSRound, fmtDate, fmtMonth, fmtSigned, fmtSignedFull, lastMonthKeys, currentMonthKey } from '../lib/format';
import { useLatest } from '../lib/useLatest';
import AppDialog from '../components/AppDialog.vue';
import NoteEditor from '../components/NoteEditor.vue';
import SpreadEditor from '../components/SpreadEditor.vue';
const route = useRoute(), router = useRouter(), latest = useLatest();
const data = ref<TxnPage | null>(null), categories = ref<Category[]>([]), accounts = ref<Account[]>([]), loading = ref(true), error = ref(''), busy = ref(false), advanced = ref(false), selecting = ref(false), detail = ref<Txn | null>(null), selected = ref<string[]>([]), bulkCategory = ref(''), preview = ref<Preview | null>(null);
const sort = ref<'date' | 'date-asc' | 'amount'>('date');
// Drawer: "apply to every transaction from this merchant" turns one answer into a rule.
const applyAll = ref(false), sweep = ref<{ categoryId: string; pattern: string; count: number } | null>(null), categorySelectKey = ref(0);
const REMOVE = '__none__';
const f = reactive({ month: '', account: '', category: '', q: '', start: '', end: '', status: '', currency: '', flow: '', min: '', max: '' });
let syncing = false, timer: ReturnType<typeof setTimeout> | undefined;
const months = lastMonthKeys(36).reverse();
const page = computed(() => Math.max(1, Number(route.query.page) || 1));
const pages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / 50)));
const queryString = (key: string) => typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const hasRange = computed(() => !!f.start || !!f.end);
const accrual = computed(() => route.query.includeSpread === 'true');
function adoptQuery() { syncing = true; for (const key of Object.keys(f) as Array<keyof typeof f>)
    f[key] = queryString(key); if (!f.month && !f.start && !f.end && !route.query.transaction && !route.query.chargeDate)
    f.month = route.query.month === 'all' ? 'all' : currentMonthKey(); syncing = false; }
async function load() { const current = latest(); loading.value = true; error.value = ''; try {
    const params = { month: hasRange.value || f.month === 'all' ? undefined : f.month || undefined, accountId: f.account || undefined, categoryId: f.category === 'none' ? undefined : f.category || undefined, uncategorized: f.category === 'none', q: f.q || undefined, start: f.start || undefined, end: f.end || undefined, status: f.status || undefined, currency: f.currency || undefined, flow: f.flow || undefined, min: f.min !== '' ? Math.round(Number(f.min) * 100) : undefined, max: f.max !== '' ? Math.round(Number(f.max) * 100) : undefined, includeSpread: accrual.value, transaction: queryString('transaction') || undefined, chargeDate: queryString('chargeDate') || undefined, page: page.value };
    // Internal transfers and card settlements are the same money as the purchases
    // they pay for, so the server leaves them out of the totals unless a flow is filtered.
    const value = await api.transactions({ ...params, summaryTransfers: 'exclude' });
    if (current()) {
        data.value = value;
        selected.value = [];
        if (route.query.transaction)
            detail.value = value.items[0] ?? null;
        else if (detail.value) {
            const id = detail.value.id;
            const refreshed = await api.transactions({ transaction: id });
            if (current() && detail.value?.id === id)
                detail.value = refreshed.items[0] ?? null;
        }
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
function filtersChanged() { if (syncing)
    return; clearTimeout(timer); timer = setTimeout(() => { const q: Record<string, string> = {}; for (const [k, v] of Object.entries(f))
    if (v)
        q[k] = v; if (accrual.value)
    q.includeSpread = 'true'; router.replace({ query: q }); }, 250); }
watch(f, filtersChanged, { flush: 'sync' });
watch(() => route.query, () => { adoptQuery(); load(); });
async function init() { try {
    [categories.value, accounts.value] = await Promise.all([api.categories(), api.accounts()]);
    adoptQuery();
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
    loading.value = false;
} }
onMounted(() => { init(); window.addEventListener('ledger:undone', load); });
onBeforeUnmount(() => { clearTimeout(timer); window.removeEventListener('ledger:undone', load); });
function setPage(n: number) { router.replace({ query: { ...route.query, page: n } }); }
const pageIds = computed(() => data.value?.items.map(t => t.id) ?? []);
const allSelected = computed(() => !!pageIds.value.length && pageIds.value.every(id => selected.value.includes(id)));
const someSelected = computed(() => !allSelected.value && pageIds.value.some(id => selected.value.includes(id)));
function togglePage() { selected.value = allSelected.value ? [] : [...pageIds.value]; }
const countLabel = (n: number) => n === 1 ? 'תנועה אחת' : n + ' תנועות';
/** Exact amounts on every screen size; incoming money carries its sign. */
const fmtAmount = (n: number) => n > 0 ? fmtSignedFull(n) : fmtILS(n);
/** Headline totals; the server already left internal transfers out unless a flow is filtered. */
const totals = computed(() => data.value?.summary ?? null);
watch(() => detail.value?.id, () => { applyAll.value = false; sweep.value = null; });
async function assign(txn: Txn, id: string) { busy.value = true; error.value = ''; try {
    if (applyAll.value && id) {
        const p = await api.ruleFromTransaction(txn.id, id, true);
        sweep.value = { categoryId: id, pattern: p.pattern, count: p.applied };
        return;
    }
    await api.setTxnCategory(txn.id, id || null);
    await load();
}
catch (e) {
    error.value = e instanceof Error ? e.message : 'הסיווג לא נשמר. נסו שוב.';
    categorySelectKey.value++;
}
finally {
    busy.value = false;
} }
function cancelSweep() { sweep.value = null; categorySelectKey.value++; }
async function confirmSweep(txn: Txn) { if (!sweep.value) return; busy.value = true; error.value = ''; try {
    await api.ruleFromTransaction(txn.id, sweep.value.categoryId);
    sweep.value = null;
    applyAll.value = false;
    await load();
}
catch (e) {
    error.value = e instanceof Error ? e.message : 'החוק לא נשמר. נסו שוב.';
}
finally {
    busy.value = false;
} }
const bulkTarget = computed(() => bulkCategory.value === REMOVE ? null : bulkCategory.value);
async function previewBulk() { if (!bulkCategory.value) return; error.value = ''; try {
    preview.value = await api.bulk(selected.value, bulkTarget.value, true);
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
} }
async function applyBulk() { busy.value = true; try {
    await api.bulk(selected.value, bulkTarget.value);
    bulkCategory.value = '';
    preview.value = null;
    selected.value = [];
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
}
finally {
    busy.value = false;
} }
async function note(txn: Txn, value: string, scope: 'transaction' | 'merchant' | 'plan') { try {
    if (scope === 'transaction')
        await api.setTxnNote(txn.id, value.trim() || null);
    else
        await api.saveNote(scope, txn.id, value);
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
} }
async function spread(txn: Txn, months: number, value: string | null) { try {
    await api.saveSpread(txn.id, months, 0, value);
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
} }
async function removeSpread(txn: Txn) { try {
    await api.deleteSpread(txn.id);
    await load();
}
catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
} }
const filterLabels = computed(() => [
  {key:'account',label:accounts.value.find(a=>a.id===f.account)?.displayName||f.account},
  {key:'category',label:f.category==='none'?'ללא קטגוריה':categories.value.find(c=>c.id===f.category)?.name||f.category},
  {key:'currency',label:f.currency},
  {key:'status',label:f.status==='pending'?'בהמתנה':f.status==='completed'?'הושלם':f.status},
  {key:'start',label:f.start?'מ־'+fmtDate(f.start):''},
  {key:'end',label:f.end?'עד '+fmtDate(f.end):''},
  {key:'min',label:f.min?'מעל '+f.min+' ₪':''},
  {key:'max',label:f.max?'עד '+f.max+' ₪':''},
  {key:'flow',label:f.flow?flowName(f.flow):''},
].filter(item=>item.label));
function clearFilter(key: string) { f[key as keyof typeof f]=''; }
function toggleSelection() { selecting.value=!selecting.value; if(!selecting.value)selected.value=[]; }
/**
 * Rows grouped by day, newest first - the way a statement is read. The date
 * moves into the group heading, so each row keeps only what differs: who,
 * what for, how much. The day's net sits beside the heading because "what did
 * Tuesday cost" is the question a feed answers and a flat table does not.
 */
const dayFmt = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const days = computed(() => {
  const groups: Array<{ key: string; label: string; net: number; items: Txn[] }> = [];
  const items = [...(data.value?.items ?? [])];
  // The API has no sort order, so sorting covers the page that is loaded.
  if (sort.value === 'amount') {
    items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return items.length ? [{ key: 'by-amount', label: 'מהסכום הגבוה לנמוך', net: items.reduce((s, t) => s + (t.flow === 'transfer' ? 0 : t.contribution), 0), items }] : [];
  }
  if (sort.value === 'date-asc') items.reverse();
  for (const t of items) {
    const key = dayKey(t.date);
    let group = groups.at(-1);
    if (group?.key !== key) { group = { key, label: dayFmt.format(new Date(t.date)), net: 0, items: [] }; groups.push(group); }
    group.items.push(t);
    // A card settlement is the same money as that card's purchases; counting
    // both in a day's total would charge the day twice.
    if (t.flow !== 'transfer') group.net += t.contribution;
  }
  return groups;
});
const flowName = (flow: string) => ({ income: 'הכנסות', income_fixed: 'הכנסה קבועה', income_variable: 'הכנסה משתנה', fixed: 'הוצאה קבועה', variable: 'הוצאה משתנה', savings: 'הפקדה לחיסכון', transfer: 'העברה פנימית / סליקה', excluded: 'לא נספר בתזרים' }[flow] ?? flow);
</script>
<template>
<div class="space-y-5">
<div class="page-heading">
<div>
<h1>תנועות</h1>
<p>חיפוש, בדיקה וסיווג של הכסף שנכנס ויצא.</p>
</div>
<RouterLink to="/breakdown" class="text-link">לאן הכסף הולך ←</RouterLink>
</div>
<p v-if="error" class="error-banner" role="alert">{{error}} <button class="text-link" @click="load">ניסיון חוזר</button>
</p>
<div class="transaction-filters card">
<label class="search-field">
<span class="sr-only">חיפוש בתיאור</span>
<input v-model="f.q" type="search" class="field w-full" placeholder="חיפוש בית עסק או תיאור…"/>
</label>
<label>
<span class="sr-only">תקופה</span>
<select v-model="f.month" class="field w-full" :disabled="hasRange">
<option v-if="f.start||f.end" value="">טווח תאריכים מותאם</option>
<option value="all">כל התקופה</option>
<option v-for="m in months" :key="m" :value="m">{{fmtMonth(m)}}</option>
</select>
</label>
<button class="btn btn-ghost" :aria-expanded="advanced" @click="advanced=!advanced">מסננים<span v-if="filterLabels.length"> · {{filterLabels.length}}</span> {{advanced?'−':'+'}}</button>
</div>
<div v-if="advanced" class="expanded-filters grid gap-4 sm:grid-cols-3">
<label>
<span class="block text-xs muted mb-1">חשבון</span>
<select v-model="f.account" class="field w-full">
<option value="">כל החשבונות</option>
<option v-for="a in accounts" :key="a.id" :value="a.id">{{a.displayName}}</option>
</select>
</label>
<label>
<span class="block text-xs muted mb-1">קטגוריה</span>
<select v-model="f.category" class="field w-full">
<option value="">כל הקטגוריות</option>
<option value="none">ללא קטגוריה</option>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
</select>
</label>

<label class="text-xs muted">מתאריך<input v-model="f.start" type="date" class="field block w-full mt-1"/>
</label>
<label class="text-xs muted">עד תאריך<input v-model="f.end" type="date" class="field block w-full mt-1"/>
</label>
<label class="text-xs muted">מצב<select v-model="f.status" class="field block w-full mt-1">
<option value="">כל המצבים</option>
<option value="completed">הושלם</option>
<option value="pending">בהמתנה</option>
</select>
</label>
<label class="text-xs muted">סכום מינימלי ₪<input v-model="f.min" type="number" min="0" class="field block w-full mt-1"/>
</label>
<label class="text-xs muted">סכום מקסימלי ₪<input v-model="f.max" type="number" min="0" class="field block w-full mt-1"/>
</label>
<label class="text-xs muted">השפעה על התזרים<select v-model="f.flow" class="field block w-full mt-1">
<option value="">הכול</option>
<option value="income">הכנסות</option>
<option value="fixed">הוצאות קבועות</option>
<option value="variable">הוצאות משתנות</option>
<option value="transfer">העברות פנימיות</option>
<option value="excluded">לא נספר בתזרים</option>
<option value="savings">חיסכון</option>
</select>
</label>
</div>
<div v-if="filterLabels.length" class="active-filters" aria-label="מסננים פעילים"><button v-for="item in filterLabels" :key="item.key" :aria-label="'הסרת מסנן '+item.label" @click="clearFilter(item.key)">{{item.label}} <span aria-hidden="true">×</span></button></div>
<div class="flex flex-wrap items-center justify-between gap-2 text-xs muted">
<span>{{route.query.chargeDate?'מועד חיוב '+fmtDate(String(route.query.chargeDate)):route.query.transaction?'תנועה נבחרת':hasRange?(f.start?fmtDate(f.start):'ההתחלה')+' – '+(f.end?fmtDate(f.end):'היום'):f.month==='all'?'כל התקופה':fmtMonth(f.month||currentMonthKey())}} · {{accrual?'לפי המחזור שאליו התנועה שייכת (כולל פריסות)':'הסכום כפי שירד בפועל'}}<span v-if="f.flow"> · {{flowName(f.flow)}}</span><span v-else> · בלי העברות פנימיות</span>
</span>
<button class="text-link" @click="router.replace({query:{month:'all'}});detail=null">איפוס הסינון</button>
</div>
<div v-if="data&&totals" class="transaction-summary">
  <span class="result-count">{{loading?'מעדכן…':countLabel(data.total)}}</span>
  <span>נכנס <b>{{fmtILSRound(totals.income)}}</b></span><span>יצא <b>{{fmtILSRound(totals.expense)}}</b></span>
  <details><summary>סיכום הרשימה</summary><div class="summary-explanation"><p>מאזן: <b>{{fmtSigned(totals.net)}}</b></p><p>הסיכום כולל את כל תוצאות הסינון, בכל העמודים. {{f.flow?'':'העברות פנימיות וסליקות כרטיס לא נספרות כאן, כי אותו כסף כבר נספר ברכישות עצמן.'}} {{accrual?'בתנועה פרוסה נספר רק החלק ששייך לתקופה.':''}}</p></div></details>
  <label class="sort-field"><span class="sr-only">מיון</span><select v-model="sort" class="field">
  <option value="date">חדשות קודם</option>
  <option value="date-asc">ישנות קודם</option>
  <option value="amount">סכום גבוה קודם</option>
  </select></label>
  <span v-if="sort!=='date'&&pages>1" class="text-xs">המיון חל על העמוד הנוכחי</span>
  <button class="text-link selection-toggle" :aria-pressed="selecting" @click="toggleSelection">{{selecting?'סיום בחירה':'בחירה מרובה'}}</button>
</div>
<div v-if="selected.length" class="selection-bar">
<span>{{selected.length===1?'תנועה אחת נבחרה':selected.length+' נבחרו'}}</span>
<select v-model="bulkCategory" class="field" aria-label="קטגוריה לבחירה המרוכזת">
<option value="" disabled>בחירת קטגוריה…</option>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
<option :value="REMOVE">הסרת סיווג</option>
</select>
<button class="btn btn-primary" :disabled="busy||!bulkCategory" @click="previewBulk">המשך לאישור</button>
<button class="btn btn-ghost" @click="selected=[]">ביטול הבחירה</button>
</div>
<p v-if="loading&&!data" class="loading-line" role="status">טוען תנועות…</p>
<div v-if="data" class="card-flush" :aria-busy="loading" :class="{'opacity-60':loading}">
<div class="desktop-transactions overflow-x-auto">
<table class="w-full text-sm">
<thead>
<tr>
<th v-if="selecting">
<input type="checkbox" aria-label="בחירת כל התנועות בעמוד הזה" title="כל התנועות בעמוד הזה" :checked="allSelected" :indeterminate="someSelected" @change="togglePage"/>
</th>
<th>תנועה</th>
<th>קטגוריה</th>
<th class="amount-col">סכום{{accrual?' בתקופה':''}}</th>
</tr>
</thead>
<tbody v-for="day in days" :key="day.key">
<tr class="day-row">
<th :colspan="selecting?4:3" scope="rowgroup"><span>{{day.label}}</span><span class="day-net" :class="{'is-income':day.net>0}">{{fmtSigned(day.net)}}</span></th>
</tr>
<tr v-for="t in day.items" :key="t.id">
<td v-if="selecting">
<input v-model="selected" :value="t.id" type="checkbox" :aria-label="'בחירת '+t.description"/>
</td>
<td>
<button class="merchant-button" :aria-label="'פרטי תנועה: '+t.description" @click="detail=t">
<span class="merchant-avatar" :style="t.category?.color?{background:`color-mix(in srgb, ${t.category.color} 16%, transparent)`}:undefined" aria-hidden="true">{{t.category?.icon||t.description.slice(0,1)}}</span>
<span>
<b>{{t.description}}</b>
<small>{{t.account.displayName}}<span v-if="sort==='amount'"> · {{fmtDate(t.date)}}</span><span v-if="t.status==='pending'" class="pending-tag"> · בהמתנה</span>
<span v-if="t.installmentTotal"> · תשלום {{t.installmentNumber}}/{{t.installmentTotal}}</span>
<span v-if="t.note||t.merchantNote||t.planNote" title="יש הערה"> · <span role="img" aria-label="יש הערה">📝</span></span>
</small>
</span>
</button>
</td>
<td>
<span class="category-pill" :class="{'needs-category':!t.category}"><i v-if="t.category?.color" :style="{background:t.category.color}" aria-hidden="true"></i>{{t.category?.name||'ממתין לסיווג'}}</span>
</td>
<td class="amount-col tnum whitespace-nowrap font-semibold" :class="{'is-income':t.contribution>0}">{{fmtAmount(t.contribution)}}</td>
</tr>
</tbody>
</table>
</div>
<div class="mobile-transactions">
<label v-if="selecting&&data.items.length" class="mobile-select-all"><input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="togglePage"/>בחירת כל התנועות בעמוד הזה</label>
<section v-for="day in days" :key="day.key">
<h3 class="mobile-day"><span>{{day.label}}</span><span class="day-net" :class="{'is-income':day.net>0}">{{fmtSigned(day.net)}}</span></h3>
<article v-for="t in day.items" :key="t.id" class="mobile-txn">
<input v-if="selecting" v-model="selected" type="checkbox" :value="t.id" :aria-label="'בחירת '+t.description"/>
<button @click="detail=t">
<div class="flex items-start justify-between gap-3">
<strong class="min-w-0">{{t.description}}</strong>
<span class="tnum shrink-0 font-bold" :class="{'is-income':t.contribution>0}">{{fmtAmount(t.contribution)}}</span>
</div>
<p>{{t.account.displayName}}<span v-if="sort==='amount'"> · {{fmtDate(t.date)}}</span><span v-if="t.note||t.merchantNote||t.planNote"> · <span role="img" aria-label="יש הערה">📝</span></span></p>
<div class="mt-2 flex gap-2 flex-wrap">
<span class="category-pill" :class="{'needs-category':!t.category}">{{t.category?.name||'ממתין לסיווג'}}</span>
<span v-if="t.status==='pending'" class="chip">בהמתנה</span>
<span v-if="t.installmentTotal" class="text-xs muted">תשלום {{t.installmentNumber}}/{{t.installmentTotal}}</span>
</div>
</button>
</article>
</section>
</div>
<div v-if="!data.items.length" class="empty-state">
<h2>אין תנועות בסינון הזה</h2>
<p>אפשר להרחיב את טווח התאריכים או לבחור קטגוריה אחרת.</p>
</div>
</div>
<div v-if="pages>1" class="flex justify-center gap-3 items-center text-sm">
<button class="btn btn-ghost" :disabled="page<=1||loading" @click="setPage(page-1)">הקודם</button>
<span>עמוד {{page}} מתוך {{pages}}</span>
<button class="btn btn-ghost" :disabled="page>=pages||loading" @click="setPage(page+1)">הבא</button>
</div>
<AppDialog :open="!!detail" title="פרטי התנועה" drawer @close="detail=null">
<div v-if="detail" class="space-y-5">
<div>
<span class="eyebrow">{{detail.account.displayName}}</span>
<h3 class="text-xl font-bold">{{detail.description}}</h3>
<p class="text-3xl font-bold mt-3 tnum">{{fmtILS(detail.amount)}}</p>
<p v-if="detail.contribution!==detail.amount" class="text-sm muted mt-2">מתוכם {{fmtILS(detail.contribution)}} נכללים בתקופה שנבחרה</p>
</div>
<div class="grid grid-cols-2 gap-4 text-sm">
<div>
<p class="muted text-xs">תאריך ביצוע</p>{{fmtDate(detail.date)}}</div>
<div>
<p class="muted text-xs">תאריך חיוב</p>{{detail.processedDate?fmtDate(detail.processedDate):'לא נמסר'}}</div>
<div>
<p class="muted text-xs">מצב</p>{{detail.status==='pending'?'בהמתנה לאישור הבנק / חברת האשראי':'הושלם'}}</div>
<div>
<p class="muted text-xs">השפעה על התזרים</p>{{flowName(detail.flow)}}</div>
</div>
<label class="block text-sm">קטגוריה<select :key="categorySelectKey" class="field w-full mt-2" :value="detail.category?.id??''" :disabled="busy||!!sweep" @change="assign(detail,($event.target as HTMLSelectElement).value)">
<option value="">ללא קטגוריה</option>
<option v-for="c in categories" :key="c.id" :value="c.id">{{c.name}}</option>
</select>
</label>
<label class="flex items-start gap-2 text-sm">
<input v-model="applyAll" type="checkbox" class="mt-1" :disabled="busy||!!sweep" @change="applyAll&&detail.category&&assign(detail,detail.category.id)"/>
<span>להחיל על כל תנועה מ«<b dir="auto">{{detail.description}}</b>»<span class="block text-xs muted">ייווצר חוק סיווג, ותנועות קיימות מבית העסק שעדיין ללא קטגוריה יסווגו גם הן.</span></span>
</label>
<div v-if="sweep" class="notice space-y-2" role="status">
<p>ייווצר חוק: כל תנועה שמכילה «<b dir="auto">{{sweep.pattern}}</b>» תסווג ל־{{categories.find(c=>c.id===sweep!.categoryId)?.name}}.</p>
<p>{{sweep.count===1?'תנועה אחת תסווג':sweep.count+' תנועות יסווגו'}} עכשיו. תנועות שכבר סווגו לא ישתנו, ואפשר לבטל בהיסטוריית השינויים.</p>
<div class="flex gap-2"><button class="btn btn-primary" :disabled="busy" @click="confirmSweep(detail)">{{busy?'שומר…':'אישור ויצירת החוק'}}</button><button class="btn btn-ghost" :disabled="busy" @click="cancelSweep">ביטול</button></div>
</div>
<div class="notice">
<b>למה התנועה סווגה כך?</b>
<p class="mt-1">{{detail.explanation}}</p>
<p v-if="detail.categorizedAt" class="text-xs muted mt-2">עודכן {{new Date(detail.categorizedAt).toLocaleString('he-IL')}}</p>
</div>
<div class="flex items-center gap-4">
<span class="text-sm">הערה לתנועה או לבית העסק</span>
<NoteEditor :txn="detail" @save-transaction="v=>note(detail!,v,'transaction')" @save-plan="v=>note(detail!,v,'plan')" @save-merchant="v=>note(detail!,v,'merchant')"/>
</div>
<div v-if="!detail.installmentTotal" class="flex items-center gap-4">
<span class="text-sm">פריסה על פני חודשים</span>
<SpreadEditor :txn="detail" @save="(m,n)=>spread(detail!,m,n)" @remove="removeSpread(detail!)"/>
</div>
<p v-if="detail.note||detail.planNote||detail.merchantNote" class="notice">{{detail.note||detail.planNote||detail.merchantNote}}</p>
<details v-if="detail.matchingRules.length" class="fold">
<summary>חוקים שמתאימים לתיאור</summary>
<p v-for="r in detail.matchingRules" :key="r.id" class="text-sm mb-2"><RouterLink :to="{path:'/rules',query:{pattern:r.pattern}}" class="text-link" dir="auto">{{r.pattern}}</RouterLink> · עדיפות {{r.priority}}</p>
<RouterLink to="/rules" class="text-link">לכל החוקים ←</RouterLink>
</details>
<p v-if="error" class="error-banner" role="alert">{{error}}</p>
</div>
</AppDialog>
<AppDialog :open="!!preview" title="לפני שינוי הסיווג" @close="preview=null">
<template v-if="preview">
<p v-if="bulkTarget" class="text-sm">{{countLabel(preview.count)}} בסכום כולל של {{fmtILSRound(preview.amount)}} {{preview.count===1?'תשויך':'ישויכו'}} ל־{{categories.find(c=>c.id===bulkTarget)?.name}}.</p>
<p v-else class="text-sm">הסיווג יוסר מ־{{countLabel(preview.count)}} בסכום כולל של {{fmtILSRound(preview.amount)}}, והן יוצגו כממתינות לסיווג.</p>
<p class="text-xs muted mt-2">השינוי חל על השורות שבחרתם בלבד. אפשר לבטל אותו בהיסטוריית השינויים.</p>
<ul class="my-4 text-sm">
<li v-for="t in preview.samples" :key="t.id" class="flex justify-between gap-3 py-2">
<span>{{t.description}}</span>
<b>{{fmtILSRound(t.amount)}}</b>
</li>
</ul>
<p v-if="error" class="error-banner mb-3">{{error}}</p>
<button class="btn btn-primary" :disabled="busy" @click="applyBulk">{{busy?'שומר…':bulkTarget?'אישור הסיווג':'הסרת הסיווג'}}</button>
</template>
</AppDialog>
</div>
</template>
<style scoped>.transaction-filters{display:grid;grid-template-columns:minmax(0,1fr) 210px auto;gap:12px;padding:0;background:transparent;border:0;border-radius:0}.filtered-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:4px 2px}.filtered-summary>div{display:flex;flex-direction:column;gap:5px}.filtered-summary span{font-size:12px;color:var(--text-muted)}.filtered-summary strong{font-size:20px;font-weight:650}.filtered-summary>div:first-child strong{font-size:12px;font-weight:400;color:var(--text-muted)}.selection-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:14px;background:var(--brand-soft);border-radius:12px;font-size:13px}table th{text-align:start;font-weight:500;font-size:11px;color:var(--text-muted);padding:14px 16px;background:var(--surface-2)}table td{padding:15px 16px;border-top:1px solid var(--border)}table th:has(input),table td:has(>input){width:34px;padding-inline-end:0}table tr:hover td{background:var(--surface-2)}.merchant-button{display:flex;align-items:center;gap:12px;text-align:start;cursor:pointer}.merchant-button b{font-weight:550;font-size:13px}.merchant-button small{display:block;color:var(--text-muted);font-size:11px;margin-top:5px}.merchant-avatar{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);font-weight:600;color:var(--brand);flex-shrink:0}.category-pill{display:inline-block;padding:3px 0;border-radius:6px;font-size:12px;background:transparent;color:var(--text-secondary)}.mobile-transactions{display:none}.mobile-txn{display:flex;align-items:start;gap:12px;padding:18px 16px;border-bottom:1px solid var(--border)}.mobile-txn>input{margin-top:5px}.mobile-txn>button{flex:1;min-width:0;text-align:start}.mobile-txn strong{font-size:13px;font-weight:600}.mobile-txn p{font-size:11px;color:var(--text-muted);margin-top:8px}@media(max-width:600px){.transaction-filters{grid-template-columns:1fr auto}.search-field{grid-column:1/-1}}@media(max-width:800px){.desktop-transactions{display:none}.mobile-transactions{display:block}.filtered-summary{grid-template-columns:repeat(3,1fr)}.filtered-summary>div:first-child{grid-column:1/-1;flex-direction:row;align-items:center}.filtered-summary strong{font-size:19px}.transaction-filters{padding:0}.selection-bar select{max-width:100%}}
.expanded-filters{padding:20px 0;border-bottom:1px solid var(--border)}.active-filters{display:flex;gap:8px;flex-wrap:wrap}.active-filters button{padding:5px 10px;border-radius:7px;background:var(--brand-soft);font-size:12px;color:var(--brand);display:flex;gap:12px;align-items:center;cursor:pointer}.transaction-summary{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;font-size:13px;color:var(--text-muted);padding:12px 0}.transaction-summary b{font-weight:550;color:var(--text-primary);font-variant-numeric:tabular-nums;margin-inline-start:5px}.result-count{color:var(--text-primary)}.transaction-summary details{position:relative}.transaction-summary summary{cursor:pointer}.summary-explanation{position:absolute;z-index:5;top:30px;inset-inline-end:0;width:260px;max-width:calc(100vw - 40px);padding:16px;background:var(--surface-1);border:1px solid var(--border);border-radius:10px;line-height:1.8;box-shadow:var(--shadow-lift)}.selection-toggle{margin-inline-start:auto}.category-pill.needs-category{color:var(--status-warning)}
.category-pill{display:inline-flex;align-items:center;gap:7px}.sort-field select{min-height:34px;padding-block:4px;font-size:13px}.mobile-select-all{display:flex;align-items:center;gap:10px;padding:14px 16px;font-size:13px;border-bottom:1px solid var(--border)}.category-pill i{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.day-row th{background:var(--page);padding:18px 16px 8px;font-size:12px;font-weight:650;color:var(--text-secondary)}.day-row th{text-align:start}.day-row th>span:first-child{margin-inline-end:auto}.day-row th{display:table-cell}.day-row th .day-net{float:inline-end;font-weight:600;color:var(--text-muted);font-variant-numeric:tabular-nums}
tbody:first-of-type .day-row th{padding-top:12px}.amount-col{text-align:end}.is-income{color:var(--delta-up)}.day-net.is-income{color:var(--delta-up)}.pending-tag{color:var(--status-warning)}
.mobile-day{display:flex;justify-content:space-between;gap:12px;padding:16px 16px 6px;font-size:12px;font-weight:650;color:var(--text-secondary);background:var(--page)}
.merchant-avatar{font-size:16px}@media(max-width:600px){.transaction-summary{gap:12px 18px}.summary-explanation{position:static;margin-top:12px}.transaction-summary details[open]{flex-basis:100%}.merchant-avatar{width:30px;height:30px}}
</style>
