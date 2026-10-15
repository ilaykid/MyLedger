<script setup lang="ts">
/**
 * Coverage warnings, shown above everything else.
 *
 * These are not cosmetic: every issue here means a number further down the page
 * is wrong. A card company that debits the account but is not connected turns
 * real spending into an unexplained lump, so the fixed/variable split - and
 * therefore "how much is left to spend" - understates reality.
 */
import { computed, ref } from 'vue';
import { api, type SettlementMismatchDetail, type SyncIssue } from '../lib/api.js';
import { fmtDate, fmtILS, fmtSignedFull } from '../lib/format.js';

const props = defineProps<{ issues: SyncIssue[] }>();
const dismissed = ref(new Set<string>());
const expanded = ref<string | null>(null);
const detailByKey = ref<Record<string, SettlementMismatchDetail>>({});
const detailLoading = ref<string | null>(null);
const detailError = ref<Record<string, string>>({});

const key = (i: SyncIssue) =>
  `${i.kind}:${i.company ?? ''}:${i.drilldown?.accountId ?? ''}:${i.drilldown?.date ?? ''}`;
const visible = computed(() => props.issues.filter((i) => !dismissed.value.has(key(i))));

const tone = (severity: SyncIssue['severity']) =>
  severity === 'error'
    ? { color: 'var(--status-critical)', icon: '🔴' }
    : severity === 'warning'
      ? { color: 'var(--status-warning)', icon: '⚠️' }
      : { color: 'var(--brand)', icon: 'ℹ️' };

async function toggleDetail(issue: SyncIssue) {
  const issueKey = key(issue);
  if (expanded.value === issueKey) {
    expanded.value = null;
    return;
  }
  expanded.value = issueKey;
  if (!issue.drilldown || detailByKey.value[issueKey]) return;
  detailLoading.value = issueKey;
  delete detailError.value[issueKey];
  try {
    detailByKey.value[issueKey] = await api.settlementMismatchDetail(
      issue.drilldown.accountId,
      issue.drilldown.date,
    );
  } catch (e) {
    detailError.value[issueKey] = e instanceof Error ? e.message : String(e);
  } finally {
    detailLoading.value = null;
  }
}

function differenceText(detail: SettlementMismatchDetail): string {
  if (detail.difference > 0) return `הבנק חייב ${fmtILS(detail.difference)} יותר מסך העסקאות שנמצאו`;
  if (detail.difference < 0) return `בכרטיס נמצאו ${fmtILS(Math.abs(detail.difference))} יותר מהחיוב בבנק`;
  return 'הסכומים תואמים';
}

function mismatchGuidance(detail: SettlementMismatchDetail): string {
  const chosen = detail.bankTransactions.find((row) => row.id === detail.chosenBankTransactionId);
  const bankLabel = chosen?.description ?? 'חיוב הכרטיס בבנק';
  if (detail.difference > 0) {
    return `הבנק מציג רק חיוב מרוכז, ולכן אי אפשר לדעת ממנו איזו שורה חסרה. בדוח ${bankLabel} למחזור ${fmtDate(detail.chargeDate)} חפשו סך של ${fmtILS(detail.bankTotal)}. אם זה הסכום בדוח, חסרה בעדכון הנתונים עסקה או התאמה של ${fmtILS(detail.difference)}; אם בדוח מופיעים ${fmtILS(detail.cardTotal)}, החיוב בבנק כולל עמלה או התאמה נוספת.`;
  }
  if (detail.difference < 0) {
    return `בדוח הכרטיס למחזור ${fmtDate(detail.chargeDate)} בדקו אילו עסקאות אינן כלולות בחיוב ${bankLabel}. בדרך כלל מדובר בזיכוי, בעסקה שנדחתה למחזור הבא או בתאריך חיוב שגוי.`;
  }
  return 'הסכומים תואמים כעת; ייתכן שהמידע התעדכן מאז יצירת ההתראה.';
}

const signedExact = fmtSignedFull;
</script>

<template>
  <section v-if="visible.length" class="space-y-2.5" aria-label="התראות על עדכון הנתונים">
    <article
      v-for="issue in visible"
      :key="key(issue)"
      class="card rise p-4"
      :style="{ borderInlineStartWidth: '3px', borderInlineStartColor: tone(issue.severity).color }"
    >
      <div class="flex gap-3">
        <span class="shrink-0 text-lg" aria-hidden="true">{{ tone(issue.severity).icon }}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold">{{ issue.title }}</h3>
          <p class="mt-1 text-sm" :style="{ color: 'var(--text-secondary)' }">{{ issue.detail }}</p>
          <RouterLink v-if="issue.company" class="btn btn-ghost mt-2" :to="'/connections#'+issue.company">בדיקת החיבור</RouterLink>
          <button
            v-if="issue.drilldown?.type === 'settlement_mismatch'"
            class="btn btn-ghost mt-2 !px-2.5 !py-1 !text-xs"
            :aria-expanded="expanded === key(issue)"
            @click="toggleDetail(issue)"
          >
            {{ expanded === key(issue) ? 'הסתרת הפירוט' : 'הצגת הפער' }}
          </button>
        </div>
        <button
          class="icon-btn shrink-0 self-start"
          :aria-label="`הסתרת ההתראה: ${issue.title}`"
          title="הסתרה עד לרענון"
          @click="dismissed.add(key(issue))"
        >
          ✕
        </button>
      </div>

      <div
        v-if="expanded === key(issue)"
        class="mt-4 border-t pt-4"
        :style="{ borderColor: 'var(--gridline)' }"
      >
        <p v-if="detailLoading === key(issue)" class="py-5 text-center text-sm" :style="{ color: 'var(--text-muted)' }">
          טוען את העסקאות שמאחורי החיוב…
        </p>
        <p v-else-if="detailError[key(issue)]" class="text-sm" :style="{ color: 'var(--status-critical)' }">
          לא הצלחתי לטעון את הפירוט: {{ detailError[key(issue)] }}
        </p>
        <template v-else-if="detailByKey[key(issue)]">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h4 class="text-sm font-bold">מחזור חיוב {{ fmtDate(detailByKey[key(issue)].chargeDate) }}</h4>
              <p class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ detailByKey[key(issue)].account.displayName }}</p>
            </div>
            <p class="text-xs font-semibold" :style="{ color: 'var(--status-warning)' }">
              {{ differenceText(detailByKey[key(issue)]) }}
            </p>
          </div>

          <dl class="mt-3 grid grid-cols-3 gap-2">
            <div class="rounded-xl p-3" :style="{ background: 'var(--surface-2)' }">
              <dt class="text-xs" :style="{ color: 'var(--text-muted)' }">הבנק חייב</dt>
              <dd class="tnum mt-1 font-bold">{{ fmtILS(detailByKey[key(issue)].bankTotal) }}</dd>
            </div>
            <div class="rounded-xl p-3" :style="{ background: 'var(--surface-2)' }">
              <dt class="text-xs" :style="{ color: 'var(--text-muted)' }">עסקאות בכרטיס</dt>
              <dd class="tnum mt-1 font-bold">{{ fmtILS(detailByKey[key(issue)].cardTotal) }}</dd>
            </div>
            <div class="rounded-xl p-3" :style="{ background: 'var(--surface-2)' }">
              <dt class="text-xs" :style="{ color: 'var(--text-muted)' }">הפער</dt>
              <dd class="tnum mt-1 font-bold" :style="{ color: 'var(--status-warning)' }">
                {{ fmtILS(Math.abs(detailByKey[key(issue)].difference)) }}
              </dd>
            </div>
          </dl>

          <div class="mt-4 grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <section>
              <h5 class="text-xs font-bold">החיוב שנמצא בבנק</h5>
              <ul class="mt-2 space-y-2">
                <li
                  v-for="row in detailByKey[key(issue)].bankTransactions"
                  :key="row.id"
                  class="rounded-xl border p-3 text-sm"
                  :style="{
                    borderColor: row.id === detailByKey[key(issue)].chosenBankTransactionId ? 'var(--brand)' : 'var(--gridline)',
                    background: row.id === detailByKey[key(issue)].chosenBankTransactionId ? 'var(--brand-soft)' : undefined,
                  }"
                >
                  <div class="flex items-start justify-between gap-2">
                    <span>
                      {{ row.description }}
                      <span
                        v-if="row.id === detailByKey[key(issue)].chosenBankTransactionId"
                        class="ms-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
                        :style="{ background: 'var(--brand)', color: 'white' }"
                      >החיוב שהושווה</span>
                    </span>
                    <span class="tnum shrink-0 font-bold">{{ fmtILS(Math.abs(row.amount)) }}</span>
                  </div>
                  <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">{{ fmtDate(row.date) }}</p>
                </li>
              </ul>
            </section>

            <section>
              <div class="flex items-baseline justify-between gap-2">
                <h5 class="text-xs font-bold">העסקאות ש{{ detailByKey[key(issue)].account.displayName ? `שויכו למחזור ב${detailByKey[key(issue)].account.displayName}` : 'חברת האשראי שייכה למחזור' }}</h5>
                <span class="text-xs" :style="{ color: 'var(--text-muted)' }">
                  {{ detailByKey[key(issue)].cardTransactions.length }} עסקאות
                </span>
              </div>
              <ul class="mt-2 max-h-72 divide-y overflow-y-auto rounded-xl border px-3" :style="{ borderColor: 'var(--gridline)' }">
                <li
                  v-for="row in detailByKey[key(issue)].cardTransactions"
                  :key="row.id"
                  class="flex items-start justify-between gap-3 py-2.5 text-sm"
                  :style="{ borderColor: 'var(--gridline)' }"
                >
                  <div class="min-w-0">
                    <p class="truncate" :title="row.description">{{ row.description }}</p>
                    <p class="mt-0.5 text-xs" :style="{ color: 'var(--text-muted)' }">
                      {{ fmtDate(row.date) }}
                      <template v-if="row.installmentTotal"> · תשלום {{ row.installmentNumber }}/{{ row.installmentTotal }}</template>
                      <template v-if="row.status === 'pending'"> · ממתינה</template>
                    </p>
                  </div>
                  <span class="tnum shrink-0 font-semibold" :style="{ color: row.amount > 0 ? 'var(--delta-up)' : undefined }">
                    {{ signedExact(row.amount) }}
                  </span>
                </li>
              </ul>
            </section>
          </div>

          <p class="mt-3 rounded-xl p-3 text-xs leading-5" :style="{ background: 'var(--surface-sunken)', color: 'var(--text-secondary)' }">
            {{ mismatchGuidance(detailByKey[key(issue)]) }}
          </p>
        </template>
      </div>
    </article>
  </section>
</template>
