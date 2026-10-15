<script setup lang="ts">
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import type { CashflowEvent } from '../lib/api';
import { fmtILSRound, fmtRelativeDay, fmtSigned } from '../lib/format';
const props = defineProps<{events: CashflowEvent[]; compact?: boolean; allLink?: RouteLocationRaw}>();
const ordered = computed(() => [...props.events].sort((a,b) => a.date.localeCompare(b.date)));
const visible = computed(() => props.compact ? ordered.value.slice(0,3) : ordered.value);
const totalOut = computed(() => props.events.filter(e => e.amount < 0).reduce((sum,e) => sum-e.amount,0));
const totalIn = computed(() => props.events.filter(e => e.amount > 0).reduce((sum,e) => sum+e.amount,0));
</script>
<template>
  <section class="upcoming-list" :class="{'is-compact':compact}">
    <div class="upcoming-heading"><h2>{{compact?'חיובים והכנסות קרובים':'מה עוד צפוי במחזור'}}</h2><RouterLink v-if="compact&&allLink" :to="allLink" class="text-link tap-target">כל הצפוי במחזור ←</RouterLink></div>
    <p v-if="!compact" class="upcoming-hint">{{fmtILSRound(totalIn)}} צפויים להיכנס · {{fmtILSRound(totalOut)}} לצאת</p>
    <p v-if="!visible.length" class="upcoming-empty">אין תנועות קבועות צפויות עד סוף המחזור.</p>
    <ol v-else>
      <li v-for="(event,index) in visible" :key="event.date+'-'+event.label+'-'+index"><time :datetime="event.date">{{fmtRelativeDay(event.date)}}</time><span class="upcoming-name">{{event.label}}</span><span class="upcoming-amount" :class="{'is-income':event.amount>0}">{{fmtSigned(event.amount)}}</span></li>
    </ol>
    <p v-if="!compact&&visible.length" class="upcoming-hint mt-4">מועדים וסכומים משוערים לפי הנתונים הקיימים.</p>
  </section>
</template>
<style scoped>
.upcoming-list{min-width:0}.upcoming-list.is-compact{border-top:1px solid var(--border);padding-top:24px}.upcoming-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.upcoming-heading h2{font-size:17px;font-weight:600}.upcoming-hint{font-size:12px;color:var(--text-muted);line-height:1.8;margin-top:6px}.upcoming-list ol{margin-top:10px}.upcoming-list li{display:flex;align-items:center;gap:18px;padding:16px 0;border-bottom:1px solid var(--border);font-size:14px}.upcoming-list li:last-child{border-bottom:0}.upcoming-list time{font-size:12px;color:var(--text-muted);width:82px;flex-shrink:0}.upcoming-name{flex:1;min-width:0;overflow-wrap:anywhere}.upcoming-amount{font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0}.is-income{color:var(--delta-up)}.upcoming-empty{padding:30px 0;color:var(--text-muted);font-size:14px}@media(max-width:500px){.upcoming-list li{gap:10px;font-size:13px}.upcoming-list time{width:65px;font-size:11px}}
</style>

<style scoped>
.upcoming-list.is-compact{border:0;padding:26px 30px;background:var(--surface-1);border-radius:26px}.upcoming-heading h2{font-weight:750;font-size:19px}.upcoming-list time{background:var(--surface-2);border-radius:9px;padding:7px 4px;text-align:center;font-size:11px}.upcoming-list li{padding-block:17px}.upcoming-amount{font-weight:650}.upcoming-empty{padding-bottom:6px}@media(max-width:700px){.upcoming-list.is-compact{padding:22px 18px}.upcoming-heading h2{font-size:18px}}
</style>
