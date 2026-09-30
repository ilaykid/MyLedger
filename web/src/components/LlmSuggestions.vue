<script setup lang="ts">
/**
 * Local-model help for the merchants no rule covers.
 *
 * The model runs on this machine and its output is a *proposal*: each row
 * becomes an ordinary category rule only if you tick it. That keeps every
 * decision visible in the Rules page and reproducible without the model - a
 * wrong guess costs one unticked checkbox, never a quietly mislabelled history.
 */
import { computed, onMounted, ref } from 'vue';
import { api, type LlmStatus, type MerchantSuggestion } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const status = ref<LlmStatus | null>(null);
const suggestions = ref<MerchantSuggestion[]>([]);
const skipped = ref<string[]>([]);
const chosen = ref(new Set<string>());
const busy = ref(false);
const message = ref<{ ok: boolean; text: string } | null>(null);

const emit = defineEmits<{ (e: 'applied'): void }>();

onMounted(async () => {
  status.value = await api.llmStatus().catch(() => null);
});

async function suggest() {
  busy.value = true;
  message.value = null;
  suggestions.value = [];
  try {
    const result = await api.llmSuggest(40);
    suggestions.value = result.suggestions;
    skipped.value = result.skipped;
    // Pre-tick everything; unticking a wrong guess is faster than ticking 30.
    chosen.value = new Set(result.suggestions.map((s) => s.merchant));
    if (!result.suggestions.length) {
      message.value = { ok: true, text: 'המודל לא הצליח לסווג אף ספק בביטחון.' };
    }
  } catch (e) {
    message.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

async function apply() {
  const accepted = suggestions.value
    .filter((s) => chosen.value.has(s.merchant))
    .map((s) => ({ pattern: s.pattern, categoryId: s.categoryId }));
  if (!accepted.length) return;

  busy.value = true;
  try {
    const result = await api.llmAccept(accepted);
    message.value = {
      ok: true,
      text: `נוצרו ${result.created} חוקים · ${result.categorized} תנועות קוטלגו`,
    };
    suggestions.value = [];
    emit('applied');
  } catch (e) {
    message.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

function toggle(merchant: string) {
  if (chosen.value.has(merchant)) chosen.value.delete(merchant);
  else chosen.value.add(merchant);
  chosen.value = new Set(chosen.value);
}

const chosenCount = computed(() => suggestions.value.filter((s) => chosen.value.has(s.merchant)).length);
</script>

<template>
  <section class="card p-5">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="section-title">קטלוג בעזרת מודל מקומי</h2>
      <span
        class="chip"
        :style="{
          background: status?.available
            ? 'color-mix(in srgb, var(--status-good) 14%, transparent)'
            : 'var(--surface-2)',
          color: status?.available ? 'var(--text-primary)' : 'var(--text-muted)',
        }"
      >
        {{ status?.available ? `✅ ${status.model}` : '⚫ לא זמין' }}
      </span>
    </div>

    <p class="section-hint mt-1">
      המודל רץ על המחשב הזה. <b>שום דבר לא יוצא לרשת</b> — ונשלחים אליו רק שמות בתי עסק,
      בלי סכומים, תאריכים או פרטי חשבון.
    </p>

    <p
      class="mt-2 rounded-lg p-2.5 text-xs"
      :style="{ background: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', color: 'var(--text-secondary)' }"
    >
      <b>⚠️ בדוק כל הצעה.</b> במדידה על 54 ספקים עם תשובה ידועה המודל קלע ל-43%.
      זה טוב להצעות על זנב ארוך שאחרת ממיינים ביד — ולא מספיק לסיווג אוטומטי.
      לכן שום דבר לא מוחל בלי סימון שלך. ההרצה אורכת כמה דקות.
    </p>

    <p v-if="!status?.available" class="mt-3 text-sm" :style="{ color: 'var(--text-muted)' }">
      לא נמצא מודל מקומי.
      <span v-if="status?.error" class="block text-xs">({{ status.error }})</span>
      <span class="mt-1 block">התקינו Ollama והריצו <code>ollama pull gemma2:9b</code>.</span>
    </p>

    <template v-else>
      <button v-if="!suggestions.length" class="btn btn-primary mt-3" :disabled="busy" @click="suggest">
        {{ busy ? 'המודל חושב…' : 'הצע סיווגים לספקים לא מוכרים' }}
      </button>

      <template v-else>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">
            {{ chosenCount }} מתוך {{ suggestions.length }} נבחרו
          </span>
          <span class="flex gap-1.5">
            <button class="btn btn-ghost !py-1 !text-xs" @click="chosen = new Set(suggestions.map((s) => s.merchant))">
              בחר הכל
            </button>
            <button class="btn btn-ghost !py-1 !text-xs" @click="chosen = new Set()">נקה</button>
          </span>
        </div>

        <div class="mt-2 max-h-96 overflow-y-auto rounded-xl border" :style="{ borderColor: 'var(--gridline)' }">
          <table class="w-full text-sm">
            <thead class="sticky top-0" :style="{ background: 'var(--surface-2)' }">
              <tr class="text-right" :style="{ color: 'var(--text-muted)' }">
                <th scope="col" class="px-3 py-2"></th>
                <th scope="col" class="px-3 py-2 font-medium">ספק</th>
                <th scope="col" class="px-3 py-2 font-medium">קטגוריה מוצעת</th>
                <th scope="col" class="px-3 py-2 font-medium">חוק שייווצר</th>
                <th scope="col" class="px-3 py-2 font-medium">סכום</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in suggestions"
                :key="s.merchant"
                class="border-t"
                :style="{ borderColor: 'var(--gridline)', opacity: chosen.has(s.merchant) ? 1 : 0.45 }"
              >
                <td class="px-3 py-2">
                  <input
                    type="checkbox"
                    :checked="chosen.has(s.merchant)"
                    :aria-label="`אשר סיווג ל${s.merchant}`"
                    @change="toggle(s.merchant)"
                  />
                </td>
                <td class="px-3 py-2">
                  {{ s.merchant }}
                  <span class="block text-xs" :style="{ color: 'var(--text-muted)' }">{{ s.count }} תנועות</span>
                </td>
                <td class="px-3 py-2 font-semibold">{{ s.category }}</td>
                <td class="px-3 py-2">
                  <code class="text-xs" :style="{ color: 'var(--text-secondary)' }">{{ s.pattern }}</code>
                </td>
                <td class="tnum px-3 py-2">{{ fmtILSRound(s.total) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mt-3 flex items-center gap-2">
          <button class="btn btn-primary" :disabled="busy || chosenCount === 0" @click="apply">
            {{ busy ? 'מחיל…' : `צור ${chosenCount} חוקים` }}
          </button>
          <button class="btn btn-ghost" :disabled="busy" @click="suggestions = []">ביטול</button>
        </div>

        <p v-if="skipped.length" class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
          {{ skipped.length }} ספקים נותרו בלי הצעה — המודל לא היה בטוח.
        </p>
      </template>
    </template>

    <p
      v-if="message"
      class="mt-3 text-sm"
      :style="{ color: message.ok ? 'var(--delta-up)' : 'var(--status-critical)' }"
    >
      {{ message.ok ? '✅' : '⚠️' }} {{ message.text }}
    </p>
  </section>
</template>
