<script setup lang="ts">
/**
 * One side of the month - income or expenses - as a ranked bar list.
 *
 * FORM: magnitude + identity across ~15 labelled rows, so horizontal ranked bars,
 * not a pie. Bar length is relative to the LARGEST row rather than to the side
 * total: with one category at 92% every other bar would be an invisible sliver.
 * The true share travels as text beside it, so nothing is lost.
 *
 * COLOR: one series, one hue - blue for money in, red for money out (the same
 * validated diverging pair the monthly verdict uses; ΔE 21.6 protan / 19.2 dark).
 * Colouring each bar by its category would be a value-ramp on nominal data: it
 * double-encodes length as hue and burns the only free channel. Identity is
 * carried by the category's own icon and name, which is shape and text, never
 * colour alone.
 *
 * BUDGET: progress against a target is a different job from magnitude, so it gets
 * its own compact meter rather than being crammed into the same bar. Its state is
 * always icon + words ("חריגה"), because --status-warning is 1.79:1 on the
 * surface and cannot be trusted to carry meaning by itself.
 */
import { computed, ref, watch } from 'vue';
import type { BreakdownLine } from '../lib/api.js';
import { fmtDayMonth, fmtILSRound } from '../lib/format.js';

const props = defineProps<{
  title: string;
  lines: BreakdownLine[];
  total: number;
  /** 'in' = money in (blue), 'out' = money out (red) */
  direction: 'in' | 'out';
  fixedLabel: string;
  fixedAmount: number;
  variableLabel: string;
  variableAmount: number;
  month: string;
}>();

const showTable = ref(false), showAll = ref(false);
const visibleLines = computed(() => showAll.value ? props.lines : props.lines.slice(0,5));
watch(() => props.month, () => {showAll.value=false;expanded.value=null;});
const expanded = ref<string | null>(null);

const hue = computed(() => (props.direction === 'in' ? 'var(--series-1)' : 'var(--series-8)'));
const max = computed(() => Math.max(1, ...props.lines.map((l) => Math.abs(l.amount))));
const barWidth = (amount: number) => `${(Math.abs(amount) / max.value) * 100}%`;

const keyOf = (l: BreakdownLine) => l.categoryId ?? '__none__';

/**
 * Over budget, close to it, or comfortable - said in shekels, not percent.
 *
 * "147%" is a grade; "חריגה של ₪412" and "נשארו ₪380" are instructions. The
 * remaining amount is the one number that changes what you do in the shop
 * today, so it is the one the row leads with. Words and icon stay because
 * --status-warning alone cannot be trusted to carry meaning.
 */
function budgetState(l: BreakdownLine) {
  if (l.amount < 0 || l.budget == null || l.budget <= 0) return null;
  const ratio = l.amount / l.budget;
  const gap = Math.abs(l.budget - l.amount);
  if (ratio > 1)
    return { icon: '🔴', label: `חריגה של ${fmtILSRound(gap)}`, tint: 'var(--status-critical)', ratio };
  if (ratio >= 0.85)
    return { icon: '⚠️', label: `נשארו ${fmtILSRound(gap)}`, tint: 'var(--status-warning)', ratio };
  return { icon: '✅', label: `נשארו ${fmtILSRound(gap)}`, tint: 'var(--status-good)', ratio };
}

function toggle(l: BreakdownLine) {
  const k = keyOf(l);
  expanded.value = expanded.value === k ? null : k;
}

/** Drill-through: the same month, filtered to this category. */
function txnLink(l: BreakdownLine) {
  const params = new URLSearchParams({ month: props.month });
  params.set('category', l.categoryId ?? 'none');
  if (l.fromSpread !== 0) params.set('includeSpread', 'true');
  return `/transactions?${params.toString()}`;
}
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 class="section-title">
          {{ title }}
          <span class="tnum ms-1 font-bold" :style="{ color: hue }">{{ fmtILSRound(total) }}</span>
        </h2>
        <p class="section-hint mt-0.5">
          {{ fixedLabel }} <span class="tnum">{{ fmtILSRound(fixedAmount) }}</span>
          · {{ variableLabel }} <span class="tnum">{{ fmtILSRound(variableAmount) }}</span>
        </p>
      </div>
      <button class="btn btn-ghost !py-1 !text-xs" :aria-pressed="showTable" @click="showTable = !showTable">
        {{ showTable ? 'תצוגת גרף' : 'תצוגת טבלה' }}
      </button>
    </div>

    <p v-if="lines.length === 0" class="mt-4 text-sm" :style="{ color: 'var(--text-muted)' }">
      אין תנועות בחודש הזה.
    </p>

    <!-- table twin: every value, no hovering -->
    <div v-else-if="showTable" class="mt-4 overflow-x-auto rounded-xl border" :style="{ borderColor: 'var(--gridline)' }">
      <table class="w-full text-sm">
        <caption class="sr-only">{{ title }} לפי קטגוריה</caption>
        <thead :style="{ background: 'var(--surface-2)' }">
          <tr class="text-right" :style="{ color: 'var(--text-muted)' }">
            <th scope="col" class="px-3 py-2 font-medium">קטגוריה</th>
            <th scope="col" class="px-3 py-2 font-medium">סכום</th>
            <th scope="col" class="px-3 py-2 font-medium">חלק</th>
            <th scope="col" class="px-3 py-2 font-medium">תנועות</th>
            <th scope="col" class="px-3 py-2 font-medium">תקציב</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in lines" :key="keyOf(l)" class="border-t" :style="{ borderColor: 'var(--gridline)' }">
            <td class="px-3 py-1.5">{{ l.icon }} {{ l.name }}</td>
            <td class="tnum px-3 py-1.5 font-semibold">{{ fmtILSRound(l.amount) }}</td>
            <td class="tnum px-3 py-1.5">{{ (l.share * 100).toFixed(0) }}%</td>
            <td class="tnum px-3 py-1.5" :style="{ color: 'var(--text-muted)' }">{{ l.count }}</td>
            <td class="tnum px-3 py-1.5">
              <template v-if="l.budget">
                {{ fmtILSRound(l.budget) }}
                <span class="ms-1 text-xs">{{ budgetState(l)?.icon }} {{ budgetState(l)?.label }}</span>
              </template>
              <span v-else :style="{ color: 'var(--text-muted)' }">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ranked bars -->
    <ul v-else class="stagger mt-4 space-y-1">
      <li v-for="l in visibleLines" :key="keyOf(l)">
        <button
          type="button"
          class="w-full rounded-lg px-1 py-1.5 text-start transition-colors"
          :style="{ background: expanded === keyOf(l) ? 'var(--surface-2)' : 'transparent' }"
          :aria-expanded="expanded === keyOf(l)"
          :aria-label="`${l.name}: ${fmtILSRound(l.amount)}, ${(l.share * 100).toFixed(0)} אחוז${l.budget ? `, תקציב ${fmtILSRound(l.budget)}, ${budgetState(l)?.label}` : ''}`"
          @click="toggle(l)"
        >
          <div class="flex items-baseline gap-2">
            <span class="shrink-0" aria-hidden="true">{{ l.icon }}</span>
            <span class="min-w-0 grow truncate text-sm">
              {{ l.name }}
              <span v-if="l.fromSpread !== 0" class="text-xs" :style="{ color: 'var(--text-muted)' }">
                · 🗓️ {{ fmtILSRound(l.fromSpread) }} מפריסה
              </span>
            </span>
            <span class="tnum shrink-0 text-sm font-semibold">{{ fmtILSRound(l.amount) }}</span>
            <span class="tnum shrink-0 text-xs" :style="{ color: 'var(--text-muted)' }">
              {{ (l.share * 100).toFixed(0) }}%
            </span>
          </div>

          <div class="mt-1 flex items-center gap-2">
            <!-- magnitude: thin mark, rounded data-end, recessive track -->
            <div class="h-1.5 grow overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
              <div
                class="fill-in h-full rounded-full"
                :style="{ width: barWidth(l.amount), background: l.amount < 0 ? 'var(--series-1)' : hue }"
              ></div>
            </div>

            <!-- progress against a target: its own mark, its own job -->
            <span v-if="budgetState(l)" class="flex shrink-0 items-center gap-1 text-xs">
              <span
                class="relative inline-block h-1.5 w-16 overflow-hidden rounded-full"
                :style="{ background: 'var(--surface-sunken)' }"
                :title="`${fmtILSRound(l.amount)} מתוך תקציב ${fmtILSRound(l.budget!)}`"
              >
                <span
                  class="absolute inset-y-0 end-0 rounded-full"
                  :style="{
                    width: `${Math.min(100, budgetState(l)!.ratio * 100)}%`,
                    background: budgetState(l)!.tint,
                  }"
                ></span>
              </span>
              <span class="whitespace-nowrap" :style="{ color: 'var(--text-secondary)' }">
                {{ budgetState(l)!.icon }} {{ budgetState(l)!.label }}
              </span>
            </span>
          </div>
        </button>

        <!--
          What is actually inside this category: the individual charges, dated.
          They used to be merged by description with an "×6" beside them, which
          is precisely the information you opened the category to get rid of.
        -->
        <div v-if="expanded === keyOf(l)" class="mb-2 ms-6 mt-1 space-y-0.5">
          <div
            v-for="(item, i) in l.topItems"
            :key="`${item.date}-${item.description}-${i}`"
            class="flex items-baseline gap-2 text-xs"
            :style="{ color: 'var(--text-secondary)' }"
          >
            <span class="tnum shrink-0" :style="{ color: 'var(--text-muted)' }">{{ fmtDayMonth(item.date) }}</span>
            <span class="min-w-0 grow truncate">
              {{ item.description }}
              <span v-if="item.fromSpread" aria-label="מפריסה" title="חלק מפריסה על פני חודשים">🗓️</span>
            </span>
            <span class="tnum shrink-0">{{ fmtILSRound(item.amount) }}</span>
          </div>
          <p v-if="l.moreItems > 0" class="text-xs" :style="{ color: 'var(--text-muted)' }">
            ועוד {{ l.moreItems }} תנועות
          </p>
          <RouterLink :to="txnLink(l)" class="inline-block text-xs font-semibold underline">
            כל התנועות בקטגוריה →
          </RouterLink>
        </div>
      </li>
    </ul>
    <button v-if="!showTable&&lines.length>5" class="text-link mt-4" :aria-expanded="showAll" @click="showAll=!showAll">{{showAll?'הצגת חמש קטגוריות':'לכל '+lines.length+' הקטגוריות ←'}}</button>
  </section>
</template>
