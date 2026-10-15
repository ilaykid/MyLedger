<script setup lang="ts">
/**
 * Note editor for a transaction. The interesting part is the scope, because
 * "ALIEXPRESS.COM ₪87" tells you nothing six months later and the right place to
 * write the explanation depends on what it explains:
 *
 *   transaction - this one charge          ("מתנה ליום הולדת של נועה")
 *   plan        - one instalment PURCHASE  → shows on all N of its payments
 *   merchant    - this merchant, forever   → shows on future charges too
 *
 * Resolution is most-specific-first: a transaction note beats a plan note, which
 * beats a merchant note. The plan option only appears when the charge is
 * actually part of an instalment plan.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { Txn } from '../lib/api.js';

const props = defineProps<{ txn: Txn }>();
const emit = defineEmits<{
  (e: 'save-transaction', note: string): void;
  (e: 'save-plan', note: string): void;
  (e: 'save-merchant', note: string): void;
}>();

type Scope = 'transaction' | 'plan' | 'merchant';

const open = ref(false);
const draft = ref('');
const scope = ref<Scope>('transaction');
const input = ref<HTMLTextAreaElement | null>(null);

const isInstallment = computed(() => props.txn.planKey != null);

const scopes = computed(() => {
  const options: Array<{ value: Scope; label: string }> = [{ value: 'transaction', label: 'התנועה הזו' }];
  if (isInstallment.value) {
    options.push({ value: 'plan', label: `כל ${props.txn.installmentTotal} התשלומים` });
  }
  options.push({ value: 'merchant', label: 'כל התנועות מבית העסק' });
  return options;
});

const noteFor = (s: Scope): string =>
  s === 'plan' ? (props.txn.planNote ?? '') : s === 'merchant' ? (props.txn.merchantNote ?? '') : (props.txn.note ?? '');

/** What is showing today, and which scope it came from. */
const effective = computed(() => {
  if (props.txn.note) return { text: props.txn.note, source: 'transaction' as const };
  if (props.txn.planNote) return { text: props.txn.planNote, source: 'plan' as const };
  if (props.txn.merchantNote) return { text: props.txn.merchantNote, source: 'merchant' as const };
  return null;
});

const sourceBadge: Record<'transaction' | 'plan' | 'merchant', string> = {
  transaction: '',
  plan: '📑',
  merchant: '🔁',
};

watch(open, async (isOpen) => {
  if (!isOpen) return;
  // Start editing in the scope whose note is actually in force.
  scope.value = effective.value?.source ?? 'transaction';
  draft.value = noteFor(scope.value);
  await nextTick();
  input.value?.focus();
});

// Switching scope shows that scope's own text rather than carrying the draft over.
watch(scope, (next) => {
  draft.value = noteFor(next);
});

function save() {
  if (scope.value === 'plan') emit('save-plan', draft.value);
  else if (scope.value === 'merchant') emit('save-merchant', draft.value);
  else emit('save-transaction', draft.value);
  open.value = false;
}
</script>

<template>
  <div class="relative">
    <button
      class="note-trigger"
      :title="effective ? effective.text : 'הוספת הערה'"
      :aria-label="effective ? `הערה: ${effective.text}` : 'הוספת הערה'"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span aria-hidden="true">{{ effective ? '📝' : '＋' }}</span>
    </button>

    <p
      v-if="effective && !open"
      class="mt-0.5 max-w-56 text-xs leading-snug"
      :style="{ color: 'var(--text-muted)' }"
    >
      {{ effective.text }}
      <span
        v-if="sourceBadge[effective.source]"
        :title="effective.source === 'plan' ? 'חלה על כל תשלומי הרכישה' : 'חלה על כל התנועות מבית העסק'"
        >{{ sourceBadge[effective.source] }}</span
      >
    </p>

    <div
      v-if="open"
      class="absolute z-20 mt-1 w-80 rounded-xl p-3"
      :style="{
        insetInlineStart: 0,
        background: 'var(--surface-1)',
        border: '1px solid var(--gridline)',
        boxShadow: 'var(--shadow-lift)',
      }"
    >
      <fieldset class="mb-2">
        <legend class="sr-only">היקף ההערה</legend>
        <div class="flex gap-1 text-xs">
          <label
            v-for="option in scopes"
            :key="option.value"
            class="flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-center transition-colors"
            :style="{
              background: scope === option.value ? 'var(--brand-soft)' : 'var(--surface-2)',
              color: scope === option.value ? 'var(--brand)' : 'var(--text-secondary)',
              fontWeight: scope === option.value ? 600 : 400,
            }"
          >
            <input v-model="scope" type="radio" :value="option.value" class="sr-only" />
            {{ option.label }}
          </label>
        </div>
      </fieldset>

      <p v-if="scope === 'plan'" class="mb-1.5 text-xs" :style="{ color: 'var(--text-muted)' }">
        תחול על כל {{ txn.installmentTotal }} התשלומים של הרכישה הזו — כולל אלה שעוד לא ירדו.
      </p>
      <p v-else-if="scope === 'merchant'" class="mb-1.5 text-xs" :style="{ color: 'var(--text-muted)' }">
        תחול על כל התנועות מ"{{ txn.description }}" — כולל עתידיות.
      </p>

      <textarea
        ref="input"
        v-model="draft"
        class="field w-full resize-none"
        rows="3"
        maxlength="500"
        placeholder="למשל: מקרר חדש למטבח"
        @keydown.esc="open = false"
        @keydown.enter.meta="save"
        @keydown.enter.ctrl="save"
      ></textarea>

      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="text-xs" :style="{ color: 'var(--text-muted)' }">
          {{ draft.trim() ? 'Ctrl+Enter לשמירה' : 'ריק = מחיקת ההערה' }}
        </span>
        <span class="flex gap-1.5">
          <button class="btn btn-ghost !py-1 !text-xs" @click="open = false">ביטול</button>
          <button class="btn btn-primary !py-1 !text-xs" @click="save">שמירה</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-trigger {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.875rem;
  transition: background-color 0.15s var(--ease);
}
.note-trigger:hover {
  background: var(--surface-2);
  border-color: var(--gridline);
}
.note-trigger:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
</style>
