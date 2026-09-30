<script setup lang="ts">
/**
 * Spread a lump sum across months - the income twin of credit-card instalments.
 *
 * The design goal is that you never have to trust the maths: the popover shows
 * the resulting per-month figure and the exact first and last month BEFORE you
 * save. A ₪30,000 payment turning into "₪5,000 a month, יוני – נובמבר"
 * is verifiable at a glance, which is the difference between a control people
 * use and one they poke once and avoid.
 *
 * It is also explicit about what does NOT change: the balance already moved on
 * the real date, and saying so here prevents the reasonable fear that editing
 * this rewrites history.
 */
import { computed, ref, watch } from 'vue';
import type { Txn } from '../lib/api.js';
import { fmtDate, fmtILSRound, fmtMonth } from '../lib/format.js';

const props = defineProps<{ txn: Txn }>();
const emit = defineEmits<{ save: [months: number, note: string | null]; remove: [] }>();

const open = ref(false);
const months = ref(props.txn.spread?.months ?? 6);
const note = ref(props.txn.spread?.note ?? '');
const busy = ref(false);

watch(
  () => props.txn.spread,
  (s) => {
    months.value = s?.months ?? 6;
    note.value = s?.note ?? '';
  },
);

const active = computed(() => props.txn.spread != null);

/** Mirrors slicesFor() in src/spread.ts: equal slices, remainder on the last. */
const perMonth = computed(() => Math.trunc(props.txn.amount / months.value));

/** yyyy-MM of the first and last recognised month, day-of-month clamped away. */
const range = computed(() => {
  const d = new Date(props.txn.date);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + months.value - 1, 1);
  const key = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
  return { first: key(first), last: key(last) };
});

const incoming = computed(() => props.txn.amount > 0);

async function save() {
  busy.value = true;
  try {
    emit('save', months.value, note.value.trim() || null);
    open.value = false;
  } finally {
    busy.value = false;
  }
}

async function remove() {
  busy.value = true;
  try {
    emit('remove');
    open.value = false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="rounded px-1 text-xs leading-none"
      :style="{ opacity: active ? 1 : 0.4 }"
      :title="
        active
          ? `נפרס על ${props.txn.spread!.months} חודשים`
          : 'פריסה על כמה חודשים'
      "
      :aria-label="active ? 'עריכת הפריסה' : 'פריסה על כמה חודשים'"
      :aria-expanded="open"
      @click="open = !open"
    >
      🗓️
    </button>

    <div
      v-if="open"
      class="absolute end-0 z-20 mt-1 w-72 rounded-xl border p-3 text-start shadow-lg"
      :style="{ background: 'var(--surface-1)', borderColor: 'var(--gridline)' }"
    >
      <p class="text-xs font-semibold">
        {{ incoming ? 'פריסת הכנסה על כמה חודשים' : 'פריסת הוצאה על כמה חודשים' }}
      </p>
      <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
        {{ fmtILSRound(Math.abs(props.txn.amount)) }} שנכנסו בפעם אחת, נספרים בתזרים לאורך התקופה.
      </p>

      <label class="mt-3 block text-xs" :style="{ color: 'var(--text-secondary)' }">
        מספר חודשים
        <input
          v-model.number="months"
          type="number"
          min="2"
          max="60"
          class="field mt-1 w-full !py-1 text-sm"
        />
      </label>

      <!-- The whole point: see the result before committing to it. -->
      <p
        v-if="months >= 2 && months <= 60"
        class="mt-2 rounded-lg p-2 text-xs"
        :style="{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }"
      >
        <span class="tnum font-semibold">{{ fmtILSRound(Math.abs(perMonth)) }}</span>
        לחודש · {{ fmtMonth(range.first) }} – {{ fmtMonth(range.last) }}
      </p>

      <label class="mt-2 block text-xs" :style="{ color: 'var(--text-secondary)' }">
        הערה (למה נפרס)
        <input
          v-model="note"
          type="text"
          maxlength="500"
          placeholder="למשל: בונוס שנתי — פרוס על השנה"
          class="field mt-1 w-full !py-1 text-sm"
        />
      </label>

      <p class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
        היתרה בבנק לא משתנה — הכסף באמת נכנס ב{{ fmtDate(props.txn.date) }}.
      </p>

      <div class="mt-3 flex items-center gap-2">
        <button
          class="btn btn-primary !py-1 !text-xs"
          :disabled="busy || months < 2 || months > 60"
          @click="save"
        >
          {{ active ? 'עדכון' : 'פריסה' }}
        </button>
        <button v-if="active" class="btn btn-ghost !py-1 !text-xs" :disabled="busy" @click="remove">
          ביטול פריסה
        </button>
        <button class="btn btn-ghost !py-1 !text-xs" :disabled="busy" @click="open = false">סגירה</button>
      </div>
    </div>
  </div>
</template>
