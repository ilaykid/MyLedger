<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { BreakdownSideData, BreakdownLine } from '../lib/api';
import { fmtILSRound, fmtDayMonth, fmtCount } from '../lib/format';
const props = defineProps<{ expense: BreakdownSideData; month: string }>();
const detailPanel = ref<HTMLElement | null>(null);
const selected = ref<string | null>(null), search = ref('');
const key = (line: BreakdownLine) => line.categoryId ?? 'none';
const lines = computed(() => [...props.expense.lines].sort((a,b) => b.amount-a.amount));
const active = computed(() => lines.value.find(line => key(line) === selected.value));
const items = computed(() => (active.value?.items ?? active.value?.topItems ?? []).filter(item => item.description.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())));
watch(() => props.month, () => { selected.value=null; search.value=''; });
async function select(line: BreakdownLine) {
  selected.value=selected.value===key(line)?null:key(line); search.value='';
  await nextTick();
  if(selected.value && window.matchMedia('(max-width:900px)').matches) detailPanel.value?.scrollIntoView({behavior:'auto',block:'start'});
}
</script>
<template>
<section class="expense-review" aria-labelledby="expense-title">
  <header class="review-heading">
    <div><span class="eyebrow">החודש לפי קטגוריות</span><h2 id="expense-title">על מה הוצאנו?</h2><p>בחרו קטגוריה כדי לעבור על ההוצאות שלה, כאן במקום.</p></div>
    <div class="review-total"><strong class="tnum">{{fmtILSRound(expense.total)}}</strong><span>הוצאות נטו · אחרי זיכויים</span></div>
  </header>
  <p class="review-basis">לפי חודש ביצוע העסקה, כולל החלק החודשי של פריסות. העברות וחיסכון מוצגים בנפרד.</p>
  <p v-if="!lines.length" class="empty-state">אין הוצאות בחודש הזה.</p>
  <div v-else class="review-layout">
    <div class="category-cards" aria-label="קטגוריות הוצאה">
      <button v-for="line in lines" :key="key(line)" class="expense-card" :class="{active:selected===key(line)}" :aria-pressed="selected===key(line)" aria-controls="category-detail" @click="select(line)">
        <span class="category-top"><span class="category-icon" aria-hidden="true">{{line.icon || '◌'}}</span><span>{{line.name}}</span><span class="category-arrow" aria-hidden="true">{{selected===key(line)?'−':'+'}}</span></span>
        <strong class="tnum">{{fmtILSRound(line.amount)}}</strong>
        <span class="category-meta">{{fmtCount(line.count,'תנועה אחת','תנועות')}} · {{Math.round(line.share*100)}}% מההוצאות</span>
        <span class="category-track" aria-hidden="true"><span :style="{width:Math.min(100,Math.max(0,line.share*100))+'%'}"></span></span>
        <span v-if="line.budget && line.budget>0" class="category-budget" :class="{over:line.amount>line.budget}">{{line.amount>line.budget?'מעל התקציב ב־':'נותרו בתקציב '}}{{fmtILSRound(Math.abs(line.budget-line.amount))}}</span>
        <span v-else class="category-budget">{{line.categoryId?'לצפייה בהוצאות':'כדאי להתחיל מסיווג התנועות האלה'}}</span>
      </button>
    </div>
    <aside ref="detailPanel" id="category-detail" class="category-detail" aria-live="polite">
      <template v-if="active">
        <header class="detail-heading"><div><span class="eyebrow">{{fmtCount(active.count,'תנועה אחת','תנועות')}} בחודש</span><h3>{{active.icon}} {{active.name}}</h3></div><strong class="tnum">{{fmtILSRound(active.amount)}}</strong></header>
        <label class="sr-only" for="category-search">חיפוש בתוך הקטגוריה</label><input id="category-search" v-model="search" type="search" class="field w-full" placeholder="חיפוש בתוך הקטגוריה…"/>
        <p class="detail-hint">{{active.items?'מהחדש לישן':'התנועות הגדולות בקטגוריה'}} · זיכויים מקטינים את הסכום</p>
        <ul class="category-items">
          <li v-for="(item,index) in items" :key="index"><div><b>{{item.description}}</b><span>{{fmtDayMonth(item.date)}}<template v-if="item.fromSpread"> · חלק מפריסה</template><template v-if="item.amount<0"> · זיכוי</template></span></div><strong class="tnum">{{fmtILSRound(item.amount)}}</strong></li>
        </ul>
        <p v-if="!items.length" class="detail-hint">אין תנועות שתואמות לחיפוש.</p>
        <RouterLink :to="{path:'/transactions',query:{month,category:key(active),includeSpread:'true'}}" class="text-link detail-link">לסיווג, הערות ופרטי התנועות ←</RouterLink>
      </template>
      <div v-else class="category-placeholder"><span aria-hidden="true">◌</span><h3>קטגוריה אחת בכל פעם</h3><p>הסכומים נותנים את התמונה הגדולה.<br/>בחרו קטגוריה כדי לראות מה מרכיב אותה.</p></div>
    </aside>
  </div>
</section>
</template>
<style scoped>
.expense-review{padding:24px 0}.review-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}.review-heading h2{font-size:25px;font-weight:650;margin:6px 0}.review-heading p,.review-basis{font-size:13px;color:var(--text-muted);line-height:1.7}.review-total{display:flex;flex-direction:column;gap:5px;text-align:end}.review-total strong{font-size:30px;font-weight:650}.review-total span{font-size:12px;color:var(--text-muted)}.review-basis{margin:16px 0 22px}.review-layout{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px;align-items:start}.category-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.expense-card{padding:18px;border:1px solid var(--border);border-radius:14px;background:var(--surface-1);text-align:start;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:border-color .15s,background .15s}.expense-card:hover,.expense-card.active{border-color:var(--brand);background:var(--brand-soft)}.expense-card:focus-visible{outline:2px solid var(--brand);outline-offset:3px}.category-top{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:550}.category-icon{font-size:18px}.category-arrow{margin-inline-start:auto;color:var(--text-muted)}.expense-card>strong{font-size:24px;font-weight:600}.category-meta,.category-budget{font-size:11px;color:var(--text-muted)}.category-track{height:4px;background:var(--surface-sunken);border-radius:3px;overflow:hidden}.category-track>span{display:block;height:100%;background:var(--brand);border-radius:3px}.category-budget.over{color:var(--status-warning)}.category-detail{scroll-margin-top:85px;position:sticky;top:24px;border:1px solid var(--border);border-radius:16px;background:var(--surface-1);padding:22px;min-width:0}.detail-heading{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:20px}.detail-heading h3{font-size:20px;font-weight:600;margin-top:6px}.detail-heading>strong{font-size:21px}.detail-hint{font-size:11px;color:var(--text-muted);margin:12px 0;line-height:1.7}.category-items{max-height:520px;overflow-y:auto;list-style:none;padding:0}.category-items li{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:15px 0;border-bottom:1px solid var(--border)}.category-items li div{min-width:0}.category-items b{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}.category-items li span{display:block;font-size:11px;color:var(--text-muted);margin-top:6px}.category-items strong{font-size:13px;white-space:nowrap;font-weight:550}.detail-link{display:inline-block;margin-top:20px;font-size:12px}.category-placeholder{text-align:center;padding:60px 0;color:var(--text-muted)}.category-placeholder>span{font-size:40px;color:var(--brand)}.category-placeholder h3{font-size:18px;color:var(--text-primary);margin:16px 0 8px}.category-placeholder p{font-size:13px;line-height:1.8}@media(max-width:900px){.review-layout{grid-template-columns:1fr}.category-detail{position:static;grid-row:1}.category-placeholder{padding:14px 0}.category-placeholder>span{display:none}.category-placeholder h3{margin-top:0}.category-items{max-height:360px}}@media(max-width:500px){.review-heading{align-items:start;flex-direction:column;gap:12px}.review-total{text-align:start}.expense-card{padding:14px}.expense-card>strong{font-size:21px}.category-detail{padding:16px}}
</style>
