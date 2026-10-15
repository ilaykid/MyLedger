<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import { api, type Cashflow, type SyncHealth, type MonthlyNet, type InstallmentPlan, type InstallmentSummary, type SpreadPlan } from '../lib/api';
import { fmtILSRound, fmtDayMonth, fmtMonth, fmtSigned, fmtCount, fmtWhen, fmtUpdatedAt } from '../lib/format';
import { useLatest } from '../lib/useLatest';
import DataHealth from '../components/DataHealth.vue';
import BalanceTimeline from '../components/BalanceTimeline.vue';
import SpendPlanner from '../components/SpendPlanner.vue';
import UpcomingPanel from '../components/UpcomingPanel.vue';
import CardFloatPanel from '../components/CardFloatPanel.vue';
import InstallmentsPanel from '../components/InstallmentsPanel.vue';
import VariableBreakdown from '../components/VariableBreakdown.vue';
import PacePanel from '../components/PacePanel.vue';
import MonthlyVerdict from '../components/MonthlyVerdict.vue';
import CommitmentsPanel from '../components/CommitmentsPanel.vue';
import AppDialog from '../components/AppDialog.vue';
import GettingStarted from '../components/GettingStarted.vue';
const props = withDefaults(defineProps<{ view?: 'overview' | 'planning' | 'details' }>(), { view: 'overview' });
const route = useRoute(), router = useRouter();
const initial = Number(route.query.offset ?? 0);
const offset = ref(Number.isInteger(initial) ? Math.max(-36, Math.min(0, initial)) : 0);
const data = ref<Cashflow | null>(null), health = ref<SyncHealth | null>(null), monthly = ref<MonthlyNet[]>([]), plans = ref<{
    plans: InstallmentPlan[];
    summary: InstallmentSummary;
} | null>(null), spreads = ref<SpreadPlan[]>([]);
const loading = ref(true), error = ref(''), healthError = ref(''), secondaryErrors = ref<string[]>([]), explain = ref<'available' | 'projection' | 'balance' | null>(null), recording = ref(false), recordMessage = ref('');
const latest = useLatest(), latestContext = useLatest();
async function load() { const current = latest(); loading.value = true; error.value = ''; data.value = null; try {
    const snap = await api.cashflow(offset.value);
    if (current())
        data.value = snap;
}
catch {
    if (current())
        error.value = 'לא הצלחנו לטעון את נתוני המחזור. ייתכן שהשרת המקומי לא פועל.';
}
finally {
    if (current())
        loading.value = false;
} }
async function context() { const current = latestContext(); healthError.value = ''; secondaryErrors.value = []; const result = await Promise.allSettled([api.syncHealth(), props.view === 'details' ? api.monthly(12) : Promise.resolve([]), props.view === 'planning' ? api.installments() : Promise.resolve(null), props.view === 'planning' ? api.spreads() : Promise.resolve({plans: []})]); if (!current())
    return; const [h, m, p, s] = result; if (h.status === 'fulfilled')
    health.value = h.value;
else {
    health.value = null;
    healthError.value = 'מצב הנתונים לא נבדק';
} if (m.status === 'fulfilled')
    monthly.value = m.value;
else
    secondaryErrors.value.push('מגמות חודשיות'); if (p.status === 'fulfilled')
    plans.value = p.value;
else
    secondaryErrors.value.push('תוכניות תשלומים'); if (s.status === 'fulfilled')
    spreads.value = s.value.plans;
else
    secondaryErrors.value.push('פריסות'); }
async function refresh() { await Promise.all([load(), context()]); }
/** A fresh install has no accounts at all: show the welcome steps instead. */
const empty = ref(false);
onMounted(async () => { try { empty.value = (await api.accounts()).length === 0; } catch { /* the main load reports errors */ } if (!empty.value) refresh(); window.addEventListener('ledger:undone', refresh); });
onBeforeUnmount(() => window.removeEventListener('ledger:undone', refresh));
watch(() => route.query.offset, () => { const n = Number(route.query.offset ?? 0); if (Number.isInteger(n))
    offset.value = Math.max(-36, Math.min(0, n)); });
watch(offset, () => { router.replace({ query: { offset: offset.value || undefined } }); load(); });
const cycleLabel = computed(() => data.value ? (data.value.cycle.anchorDay === 1 ? fmtMonth(data.value.cycle.start.slice(0, 7)) : fmtDayMonth(data.value.cycle.start) + ' – ' + fmtDayMonth(data.value.cycle.lastDay)) : '');
const trusted = computed(() => health.value?.reliability.status === 'complete' && !!data.value?.forecastCoverage.usableCycles);
const unavailable = computed(() => !health.value || health.value.reliability.status === 'unavailable');
const cycleLink = (path: string) => ({path, query: {offset: offset.value || undefined}});
/**
 * Send people to the review queue only when there is something in it. A
 * partial-reliability status with zero open issues used to produce "0 critical
 * problems, 0 warnings" under a "fix the data" button - a to-do with nothing
 * to do, which teaches the button to be ignored.
 */
const needsReview = computed(() => !!healthError.value || unavailable.value || !!health.value?.issues.some(i => i.severity !== 'info'));
const reviewReason = computed(() => healthError.value || health.value?.issues.find(i => i.severity !== 'info')?.title || health.value?.reliability.detail || 'מצב הנתונים עדיין נבדק.');
const transactions = (flow?: string) => ({ path: '/transactions', query: { start: data.value?.cycle.start, end: data.value?.cycle.lastDay, includeSpread: 'true', flow } });
const today = new Date();
const todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
/** Why the estimate is partial, said on the label itself rather than behind it. */
const reliabilityText = computed(() => { if (unavailable.value) return 'הנתונים אינם זמינים'; if (!data.value?.cycle.isCurrent) return 'לפי הנתונים שנקלטו'; if (trusted.value) return 'כל החשבונות מעודכנים'; return health.value?.reliability.status === 'complete' ? 'הערכה חלקית — אין עדיין מחזורים קודמים להשוואה' : 'הערכה חלקית — חסרים נתונים'; });
const daysLeft = computed(() => Math.max(0, data.value?.cycle.daysRemaining ?? 0));
const daysLeftText = computed(() => daysLeft.value === 1 ? 'נשאר יום אחד' : `נשארו ${daysLeft.value} ימים`);
/**
 * Variable spending against the same day of the previous cycle - only variable,
 * because fixed charges are lumpy and would make any early-cycle day look alarming.
 * Said only when the gap is big enough (15%) to be a finding rather than noise.
 */
const paceGap = computed(() => { const p = data.value?.pace; if (!p || p.previousSpendAtSameDay <= 0) return null; const ratio = p.delta / p.previousSpendAtSameDay; return Math.abs(ratio) >= 0.15 ? Math.round(ratio * 100) : null; });
const paceSentence = computed(() => paceGap.value == null ? '' : `ההוצאות המשתנות ${paceGap.value > 0 ? 'גבוהות' : 'נמוכות'} ב-${Math.abs(paceGap.value)}% מבאותו שלב במחזור הקודם.`);
/** The accrual view: `available` leads, the projected result follows in words. */
const headlineSentence = computed(() => { const d = data.value; if (!d) return ''; const projection = `בקצב הזה צפוי ${d.projectedNet < 0 ? 'גירעון' : 'עודף'} של כ-${fmtILSRound(Math.abs(d.projectedNet))} בסוף המחזור.`; if (d.available < 0) return `ההוצאות כבר עברו את מה שתוכנן למחזור ב-${fmtILSRound(-d.available)}.` + (d.projectedNet < 0 ? ' ' + projection : ''); if (d.available === 0) return 'כל מה שתוכנן למחזור כבר הוצא.'; return projection; });
/** The cash view, in its own sentence: card charges already made that the bank has not seen yet. */
const floatLine = computed(() => { const f = data.value?.cardFloat; if (!f || f.total <= 0) return ''; const last = f.byAccount.map(a => a.chargeDate).filter((d): d is string => !!d).sort().pop(); return `${fmtILSRound(f.total)} באשראי עוד ירדו מהעו״ש${last ? ' עד ' + fmtDayMonth(last) : ''}.`; });
/** The next outgoing charge worth naming: big relative to what is still due, never trivial. */
const nextCharge = computed(() => { const d = data.value; if (!d) return null; const out = d.upcoming.filter(e => e.amount < 0 && !e.actual && e.date >= todayISO).sort((a, b) => a.date.localeCompare(b.date)); const total = out.reduce((s, e) => s - e.amount, 0); return out.find(e => -e.amount >= Math.max(500_00, total * 0.1)) ?? null; });
/** One data-driven next step: overdraft > data gaps > pace / projection > next big charge > fallback. */
const focus = computed<{ title: string; text: string; to: RouteLocationRaw; action: string; urgent?: boolean }>(() => {
  const d = data.value!;
  const planning = (hash: string) => ({ ...cycleLink('/planning'), hash });
  if (d.cycle.isCurrent && d.overdraftDate) return { title: `צפוי מינוס בעו״ש ב-${fmtDayMonth(d.overdraftDate)}`, text: (d.lowestPoint ? `היתרה צפויה לרדת עד ${fmtILSRound(d.lowestPoint.balance)}. ` : '') + 'כדאי להזיז חיוב או להעביר כסף לפני כן.', to: planning('#upcoming'), action: 'לתכנון', urgent: true };
  if (needsReview.value) return { title: 'כדי לדייק את התמונה', text: reviewReason.value, to: '/review', action: 'לבדיקת הנתונים' };
  if (!d.cycle.isCurrent) return { title: 'הצעד הבא', text: 'המחזור הזה הסתיים. בפירוט אפשר לראות לאן הלכו ההוצאות.', to: cycleLink('/month-details'), action: 'לפירוט המחזור' };
  if (d.available <= 0 || d.projectedNet < 0) return { title: 'הצעד הבא', text: d.available > 0 && d.dailyAllowance > 0 ? `כדי לסיים את המחזור בלי גירעון, כדאי להוציא עד ${fmtILSRound(d.dailyAllowance)} ליום.` : 'כדאי לבדוק בתכנון אילו הוצאות אפשר לדחות למחזור הבא.', to: planning('#scenario'), action: 'לבדיקת הוצאה' };
  if (paceGap.value != null && paceGap.value > 0) return { title: 'הצעד הבא', text: 'הקצב גבוה מהמחזור הקודם. כדאי לבדוק באילו קטגוריות הוא עלה.', to: cycleLink('/month-details'), action: 'לפירוט ההוצאות' };
  if (nextCharge.value) return { title: 'הצעד הבא', text: `החיוב הבא: ${nextCharge.value.label} ${fmtILSRound(-nextCharge.value.amount)} ${fmtWhen(nextCharge.value.date)}.`, to: planning('#upcoming'), action: 'כל הצפוי במחזור' };
  return { title: 'הצעד הבא', text: 'אין חיובים גדולים בדרך עד סוף המחזור. בתכנון אפשר לבדוק איך הוצאה נוספת תשפיע.', to: planning('#scenario'), action: 'לתכנון' };
});
/**
 * The calendar-month verdict below may only use the cycle projection when the
 * cycle IS the calendar month; otherwise the verdict hides itself for a month
 * still in progress instead of judging it on month-to-date.
 */
const verdictProjection = computed(() => { const d = data.value; if (!d || !d.cycle.isCurrent || d.cycle.anchorDay !== 1) return null; return { net: d.projectedNet, incomeExpected: d.income.expected, stillToSpend: d.fixed.upcoming + d.variable.projectedRest, soFarIn: d.income.received, soFarOut: d.fixed.paid + d.variable.spent, daysElapsed: d.cycle.daysElapsed, daysTotal: d.cycle.daysTotal }; });
async function saveNote(id: string, note: string | null) { const p = spreads.value.find(p => p.transactionId === id); if (!p)
    return; try {
    await api.saveSpread(id, p.months, p.offsetMonths, note);
    await context();
}
catch {
    error.value = 'לא הצלחנו לשמור את ההערה. נסו שוב בעוד רגע.';
} }
async function record() { recording.value = true; try {
    await api.recordForecast();
    recordMessage.value = 'התחזית של היום נשמרה. בהמשך אפשר יהיה לראות כמה דייקה.';
}
catch {
    recordMessage.value = 'לא הצלחנו לשמור את התחזית. נסו שוב בעוד רגע.';
}
finally {
    recording.value = false;
} }
</script>
<template>
<GettingStarted v-if="empty"/>
<div v-else class="dashboard-page" :class="{'dashboard-home':view==='overview'}">
  <div class="page-heading">
    <div><RouterLink v-if="view==='details'" :to="cycleLink('/')" class="text-link back-link">חזרה למבט על המחזור →</RouterLink><h1>{{view==='planning'?'מתכננים את ההמשך':view==='details'?'המספרים מאחורי המחזור':'מבט על המחזור'}}</h1><p>{{cycleLabel}}<span v-if="data?.cycle.isCurrent"> · {{daysLeftText}}</span></p></div>
    <div class="period-picker" role="group" aria-label="בחירת מחזור">
      <button class="icon-btn" :disabled="offset<=-36||loading" aria-label="המחזור הקודם" @click="offset--">›</button>
      <button class="btn" :disabled="offset===0||loading" @click="offset=0">{{offset===0?'המחזור הנוכחי':'חזרה למחזור הנוכחי'}}</button>
      <button class="icon-btn" :disabled="offset>=0||loading" aria-label="המחזור הבא" @click="offset++">‹</button>
    </div>
  </div>
  <p v-if="error" class="error-banner" role="alert">{{error}} <button class="text-link" @click="refresh">ניסיון חוזר</button></p>
  <div v-if="loading&&!data" class="loading-line" role="status">טוען את תמונת המחזור…</div>
  <template v-if="data">
    <div :aria-busy="loading" :class="{'opacity-60':loading}">
      <template v-if="view==='overview'">
        <section class="month-focus" aria-label="תמונת המחזור">
          <div class="focus-label"><span>{{data.cycle.isCurrent?'נשאר להוציא עד '+fmtDayMonth(data.cycle.lastDay):data.projectedNet<0?'גירעון במחזור':'עודף במחזור'}}</span><RouterLink to="/review" class="reliability-label" :class="{'is-limited':!trusted}">{{reliabilityText}}</RouterLink></div>
          <p class="focus-figure">{{unavailable?'—':data.cycle.isCurrent?fmtILSRound(data.available):fmtILSRound(Math.abs(data.projectedNet))}}</p>
          <p v-if="!unavailable&&data.cycle.isCurrent&&data.available>0&&daysLeft>0" class="focus-daily"><b>{{fmtILSRound(data.dailyAllowance)}}</b> ליום · {{daysLeftText}}</p>
          <p class="focus-sentence">{{unavailable?'נבדוק את מקורות הנתונים לפני שמסיקים מסקנות.':data.cycle.isCurrent?headlineSentence:(data.projectedNet<0?'ההוצאות שנקלטו גבוהות מהכנסות המחזור.':'ההכנסות שנקלטו כיסו את הוצאות המחזור.')}}<template v-if="!unavailable&&data.cycle.isCurrent&&paceSentence">{{' '+paceSentence}}</template></p>
          <p v-if="!unavailable&&data.cycle.isCurrent&&floatLine" class="focus-float">{{floatLine}}</p>
          <button class="text-link focus-explain" @click="explain=data.cycle.isCurrent?'available':'projection'">מה עומד מאחורי {{data.cycle.isCurrent?'הסכום הזה':'התוצאה'}}? ←</button>
          <div class="focus-action" :class="{'is-urgent':focus.urgent}">
            <div><h2>{{focus.title}}</h2><p>{{focus.text}}</p></div>
            <RouterLink :to="focus.to" class="btn btn-primary">{{focus.action}} ←</RouterLink>
          </div>
        </section>
        <UpcomingPanel v-if="data.cycle.isCurrent" :events="data.upcoming" compact :all-link="{...cycleLink('/planning'),hash:'#upcoming'}"/>
        <div class="home-deeper"><RouterLink :to="cycleLink('/month-details')" class="text-link">יתרה בעו״ש ופירוט החישוב ←</RouterLink><RouterLink :to="transactions()" class="text-link">תנועות המחזור ←</RouterLink></div>
      </template>
      <template v-else>
        <DataHealth :health="health" :error="healthError" compact/>
        <p v-if="secondaryErrors.length" class="notice notice-warning mt-5">לא ניתן לטעון: {{secondaryErrors.join(' · ')}}. <button class="text-link" @click="context">ניסיון חוזר</button></p>
        <template v-if="view==='planning'">
          <nav class="section-tabs planning-links" aria-label="כלי תכנון"><a href="#upcoming">חיובים והכנסות קרובים</a><a href="#scenario">בדיקת הוצאה</a><a href="#commitments">הוצאות קבועות</a><RouterLink to="/recurring">ניהול קבועות ←</RouterLink></nav>
          <div class="planning-grid">
            <div id="upcoming"><UpcomingPanel v-if="data.cycle.isCurrent" :events="data.upcoming"/><p v-else class="notice">זהו מחזור שהסתיים. אפשר לעיין בהוצאותיו או לחזור למחזור הנוכחי כדי לתכנן.</p></div>
            <div id="scenario" class="space-y-5"><SpendPlanner v-if="data.cycle.isCurrent&&!unavailable" :data="data" :limited="!trusted"/><PacePanel v-if="data.pace" :pace="data.pace" :days-elapsed="data.cycle.daysElapsed"/></div>
          </div>
          <details id="commitments" class="fold mt-6"><summary>הוצאות קבועות, פריסות ותשלומים</summary><div class="space-y-5"><CommitmentsPanel :data="data" :spreads="spreads" :month="data.cycle.start.slice(0,7)" @save-note="saveNote"/><div v-if="data.cycle.isCurrent" class="grid gap-5 lg:grid-cols-2"><CardFloatPanel :data="data"/><InstallmentsPanel v-if="plans" :plans="plans.plans" :summary="plans.summary"/></div></div></details>
        </template>
        <template v-else>
          <div class="month-ledger">
            <section><div><h2>{{data.cycle.isCurrent?'נשאר להוציא עד '+fmtDayMonth(data.cycle.lastDay):'נשאר בסוף המחזור'}}</h2><p>אחרי הוצאות קבועות, הוצאות משתנות והפקדות לחיסכון. זו לא היתרה בעו״ש.</p></div><button @click="explain='available'" :disabled="unavailable"><strong>{{unavailable?'—':fmtILSRound(data.available)}}</strong><span>איך זה מחושב ←</span></button></section>
            <section><div><h2>{{data.cycle.isCurrent?'יתרה בעו״ש בפועל':'יתרה בעו״ש בסוף המחזור'}}</h2><p>{{data.cycle.isCurrent?'לפי העדכון האחרון של כל חשבון.':'שחזור מהיתרות ומהתנועות הזמינות.'}}</p></div><button @click="explain='balance'"><strong>{{unavailable?'—':fmtILSRound(data.cycle.isCurrent?data.bankBalance:data.projectedEndBalance)}}</strong><span>מקורות ומועדי עדכון ←</span></button></section>
            <section><div><h2>הוצאות שנכללו במחזור</h2><p>הוצאות קבועות ומשתנות, כולל פריסות וחיובים ידועים.</p></div><RouterLink :to="transactions()"><strong>{{fmtILSRound(data.fixed.paid+data.variable.spent)}}</strong><span>לכל התנועות ←</span></RouterLink></section>
          </div>
          <section class="quiet-section"><h2 class="section-title">יתרה בעו״ש לאורך המחזור</h2><BalanceTimeline :points="data.timeline" :today-i-s-o="todayISO" :overdraft-date="data.overdraftDate" :lowest-point="data.lowestPoint"/></section>
          <details class="fold mt-6"><summary>לאן הלכו ההוצאות המשתנות</summary><VariableBreakdown :rows="data.variableByCategory" :total="data.variable.spent"/></details>
          <details class="fold mt-4"><summary>מגמות לאורך זמן · חודשים קלנדריים</summary><MonthlyVerdict v-if="monthly.length" :months="monthly" :selected-month="data.cycle.start.slice(0,7)" :projection="verdictProjection"/><RouterLink to="/breakdown" class="text-link block mt-5">לניתוח לפי קטגוריות ←</RouterLink></details>
          <div v-if="data.cycle.isCurrent" class="forecast-footer"><span>{{data.forecastCoverage.usableCycles?'התחזית מבוססת על '+fmtCount(data.forecastCoverage.usableCycles,'מחזור קודם אחד','מחזורים קודמים')+' עם נתונים מלאים':'אין עדיין מחזורים קודמים עם נתונים מלאים, ולכן התחזית חלקית'}}</span><button class="text-link" :disabled="recording" @click="record">שמירת התחזית של היום, כדי לבדוק בהמשך כמה דייקה</button><span v-if="recordMessage" role="status">{{recordMessage}}</span></div>
        </template>
      </template>
    </div>
  </template>
<AppDialog :open="!!explain" :title="explain==='available'?'איך מחושב ״נשאר להוציא״?':explain==='projection'?(data?.cycle.isCurrent?'איך מחושבת התחזית לסוף המחזור?':'איך מחושבת תוצאת המחזור?'):'יתרה בעו״ש ומקורות הנתונים'" @close="explain=null">
<template v-if="data">
<div v-if="explain==='available'||explain==='projection'" class="equation">
<div>
<RouterLink :to="transactions('income')" class="text-link">הכנסות שכבר נכנסו</RouterLink>
<span>{{fmtILSRound(data.income.received)}}</span>
</div>
<div>
<RouterLink to="/recurring" class="text-link">הכנסות שעוד צפויות</RouterLink>
<span>{{fmtSigned(data.income.expected)}}</span>
</div>
<div>
<RouterLink :to="transactions('fixed')" class="text-link">הוצאות קבועות ששולמו</RouterLink>
<span>{{fmtSigned(-data.fixed.paid)}}</span>
</div>
<div>
<RouterLink to="/recurring" class="text-link">הוצאות קבועות שעוד ירדו</RouterLink>
<span>{{fmtSigned(-data.fixed.upcoming)}}</span>
</div>
<div>
<RouterLink :to="transactions('variable')" class="text-link">הוצאות משתנות עד היום</RouterLink>
<span>{{fmtSigned(-data.variable.spent)}}</span>
</div>
<div v-if="explain==='available'">
<RouterLink :to="transactions('savings')" class="text-link">הופקד לחיסכון</RouterLink>
<span>{{fmtSigned(-data.savings.deposited)}}</span>
</div>
<div v-else>
<span>הוצאות משתנות צפויות עד סוף המחזור (לפי הקצב הרגיל)</span>
<span>{{fmtSigned(-data.variable.projectedRest)}}</span>
</div>
<div>
<span>{{explain==='available'?'נשאר להוציא':(data.projectedNet<0?'גירעון':'עודף')+(data.cycle.isCurrent?' צפוי בסוף המחזור':' במחזור')}}</span>
<span>{{fmtILSRound(explain==='available'?data.available:Math.abs(data.projectedNet))}}</span>
</div>
</div>
<div v-else class="space-y-4">
<div v-for="bank in data.bankSnapshots" :key="bank.name" class="flex justify-between gap-4">
<div>
<b class="text-sm">{{bank.name}}</b>
<p class="text-xs muted mt-1">{{bank.asOf?fmtUpdatedAt(bank.asOf):'מועד העדכון לא ידוע'}}</p>
</div>
<span>{{bank.balance==null?'יתרה חסרה':fmtILSRound(bank.balance)}}</span>
</div>
<RouterLink to="/connections" class="text-link">עדכון נתונים ←</RouterLink>
</div>
<p class="text-sm muted mt-5">{{explain==='available'?'בשונה מהעודף הצפוי, כאן עוד לא מנוכות ההוצאות המשתנות של המשך המחזור — זה הסכום שנשאר להן. זו לא היתרה בעו״ש.':explain==='projection'?'בשונה מ״נשאר להוציא״, כאן כבר מנוכות ההוצאות המשתנות הצפויות לפי הקצב הרגיל, והפקדות לחיסכון לא מנוכות. זו לא היתרה הצפויה בעו״ש.':'בשונה מ״נשאר להוציא״, זה הכסף שנמצא עכשיו בעו״ש — חיובי אשראי שעוד לא ירדו עדיין לא מנוכים ממנו.'}}</p>
<p class="notice notice-warning mt-5">{{explain==='balance'?'יתרות ממועדים שונים אינן מדידה בו־זמנית. תנועות שעדיין לא נמשכו אינן נכללות.':data.forecastCoverage.detail}}</p>
</template>
</AppDialog>
</div>
</template>
<style scoped>
.dashboard-home{max-width:820px;margin:auto}.dashboard-page>.page-heading{margin-bottom:32px}.period-picker{display:flex;gap:2px;align-items:center}.period-picker .icon-btn{border:0;background:transparent}.period-picker .btn{font-size:12px;background:transparent;padding-inline:8px}.month-focus{padding:16px 0 32px}.focus-label{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:14px;color:var(--text-secondary)}.reliability-label{font-size:12px;display:inline-flex;align-items:center;gap:6px;color:var(--text-muted)}.reliability-label:before{content:'';height:6px;width:6px;border-radius:50%;background:var(--status-good)}.reliability-label.is-limited{color:var(--status-warning)}.reliability-label.is-limited:before{background:currentColor}.focus-figure{font-size:clamp(52px,7vw,78px);font-weight:550;letter-spacing:-3px;line-height:1.3;margin:12px 0 8px;font-variant-numeric:tabular-nums}.focus-sentence{font-size:18px;line-height:1.7}.focus-explain{display:inline-block;margin-top:14px}.focus-action{display:flex;align-items:center;justify-content:space-between;gap:20px;background:var(--brand-soft);padding:19px 22px;border-radius:12px;margin-top:30px}.focus-action h2{font-size:14px;font-weight:600}.focus-action p{font-size:13px;line-height:1.7;color:var(--text-secondary);margin-top:3px}.focus-action .btn{flex-shrink:0}.home-deeper{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:24px;padding-top:20px;border-top:1px solid var(--border)}.home-deeper .text-link{font-size:14px;display:inline-flex;align-items:center;min-height:44px}.focus-daily{font-size:15px;margin-top:-2px;position:relative;z-index:1}.focus-daily b{font-weight:700}.focus-float{font-size:14px;line-height:1.7;margin-top:8px;opacity:.85;position:relative;z-index:1}.focus-action.is-urgent{border-inline-start:4px solid var(--status-critical)}.focus-action.is-urgent h2{color:var(--status-critical)}.planning-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:start}.planning-links{margin-top:24px}.planning-grid>div{min-width:0}.month-ledger{margin:22px 0}.month-ledger>section{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:25px 0;border-bottom:1px solid var(--border)}.month-ledger h2{font-size:16px;font-weight:550}.month-ledger p{font-size:13px;color:var(--text-muted);margin-top:5px}.month-ledger button,.month-ledger section>a{text-align:end;flex-shrink:0;cursor:pointer}.month-ledger strong{display:block;font-size:27px;font-weight:550;white-space:nowrap}.month-ledger span{font-size:12px;color:var(--brand)}.quiet-section{padding:24px 0}.forecast-footer{display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-top:24px}.back-link{display:block;margin-bottom:15px}#upcoming,#scenario,#commitments{scroll-margin-top:24px}@media(max-width:700px){.planning-grid{grid-template-columns:1fr}.focus-action{align-items:start;flex-direction:column;gap:14px}.focus-sentence{font-size:16px}.month-ledger>section{align-items:start;flex-direction:column;gap:10px}.month-ledger button,.month-ledger section>a{text-align:start}.dashboard-page>.page-heading{margin-bottom:18px}.focus-figure{font-size:54px}.home-deeper{gap:18px}}
</style>

<style scoped>
.dashboard-home{max-width:900px}.month-focus{position:relative;background:var(--hero);color:var(--hero-ink);border-radius:32px;padding:34px 38px 0;overflow:hidden;margin-bottom:28px}.focus-label{color:var(--hero-muted);position:relative;z-index:1}.focus-figure{font-weight:750;font-size:clamp(54px,7vw,84px);margin-top:18px;letter-spacing:-3px;position:relative;z-index:1}.focus-sentence{max-width:580px;font-weight:500;position:relative;z-index:1}.focus-explain{color:var(--hero-ink);text-decoration:underline;text-underline-offset:5px}.focus-action{margin:30px -38px 0;border-radius:0;background:var(--surface-1);padding:24px 38px;position:relative;z-index:1}.focus-action h2{font-size:16px;font-weight:750;color:var(--text-primary)}.focus-action p{max-width:500px}.month-focus:after{content:'';position:absolute;width:180px;height:180px;inset-inline-end:-60px;top:45px;border:2px solid currentColor;border-radius:45% 55% 48% 52%;opacity:.09;transform:rotate(30deg)}.reliability-label{color:var(--hero-muted);background:color-mix(in srgb,var(--hero) 80%,var(--surface-1));padding:4px 10px;border-radius:999px}.reliability-label.is-limited{color:var(--hero-ink)}.period-picker{background:var(--surface-1);padding:3px 6px;border-radius:999px;border:1px solid var(--border)}.period-picker .icon-btn{color:var(--text-primary);font-size:20px;cursor:pointer}.period-picker .icon-btn:hover:not(:disabled){background:var(--surface-2)}.period-picker .icon-btn:disabled{opacity:.3;cursor:default}.period-picker .btn:disabled{color:var(--text-secondary);opacity:1}.home-deeper{border:0;padding-top:6px}.month-ledger{background:var(--surface-1);border-radius:26px;padding:0 26px}.month-ledger>section:last-child{border:0}.month-ledger h2{font-weight:700}.month-ledger strong{font-weight:700}.quiet-section{padding:28px;background:var(--surface-1);border-radius:26px}
@media(max-width:700px){.month-focus{padding:25px 22px 0;border-radius:26px}.focus-figure{font-size:54px;letter-spacing:-2px}.focus-label{gap:10px;font-size:13px}.focus-action{margin:24px -22px 0;padding:22px}.focus-action .btn{width:100%}.month-ledger{padding-inline:20px}.quiet-section{padding:20px}.period-picker .btn{padding-inline:8px;min-height:44px}.period-picker .icon-btn{width:44px;height:44px}}
</style>
