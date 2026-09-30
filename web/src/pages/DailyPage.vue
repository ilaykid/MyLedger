<script setup lang="ts">
/**
 * The five-minute daily pass, as a card stack.
 *
 * One card at a time on purpose. A list invites scanning and postponing; a
 * single card with two or three taps on it invites answering. Progress is shown
 * because a queue that visibly ends gets finished - and the last card says so
 * out loud rather than dropping you into an empty screen.
 *
 * Keyboard works throughout: this is a queue, and a queue you can hold Enter or
 * arrow through is a queue that actually gets cleared.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { api, type DailyReview, type ReviewCard } from '../lib/api.js';
import AppDialog from '../components/AppDialog.vue';
import { useLatest } from '../lib/useLatest.js';
import { type Preview } from '../lib/api.js';
import { fmtILSRound, fmtDate, fmtSigned } from '../lib/format.js';

const props = defineProps<{ embedded?: boolean }>();
const data = ref<DailyReview | null>(null);
const index = ref(0);
const error = ref<string | null>(null);
const busy = ref(false);
/** Cards answered in this session, so the count reflects what you just did. */
const handled = ref(0);
/** 'daily' is the short pass; 'expenses' sweeps everything never confirmed. */
const scope = ref<'daily' | 'expenses'>('daily');

const cards = computed(() => data.value?.cards ?? []);
const card = computed<ReviewCard | null>(() => cards.value[index.value] ?? null);
const progress = computed(() =>
  cards.value.length ? Math.round(((index.value + 1) / cards.value.length) * 100) : 0,
);

const latest=useLatest();
const sweep=ref<{categoryId:string;preview:Preview;transactionId:string}|null>(null);
async function load() {
  const current=latest();
  error.value = null;
  flash.value = null;
  try {
    const result=await api.dailyReview(scope.value);
    if(!current())return;
    if(props.embedded) result.cards=result.cards.filter(c=>c.transaction||c.kind==='done');
    data.value=result;
    index.value = 0;
  } catch (e) {
    if(current())error.value = e instanceof Error ? e.message : 'טעינה נכשלה';
  }
}

async function setScope(next: 'daily' | 'expenses') {
  if (scope.value === next) return;
  scope.value = next;
  data.value = null;
  handled.value = 0;
  await load();
}

function next() {
  flash.value = null;
  if (index.value < cards.value.length - 1) index.value++;
}
function back() {
  flash.value = null;
  if (index.value > 0) index.value--;
}

/**
 * Drop a card once it has been dealt with, rather than stepping past it.
 *
 * Advancing left the answered card in the queue: the counter still counted it,
 * "הקודם" walked back into a decision already made, and the total never shrank -
 * so the queue never visibly got shorter, which is the only thing that makes it
 * feel finishable.
 */
function remove(id: string) {
  if (!data.value) return;
  const at = data.value.cards.findIndex((c) => c.id === id);
  if (at === -1) return;
  data.value.cards.splice(at, 1);
  // Staying on the same index shows the next card; clamp at the end.
  if (index.value > data.value.cards.length - 1) {
    index.value = Math.max(0, data.value.cards.length - 1);
  }
}

/**
 * Answer once, for every charge from this merchant.
 *
 * The queue's worst failure mode is repetition: the same supermarket asked
 * eleven times in a row is what makes people close the tab. When this is on, the
 * tap writes a standing rule from the merchant's name instead of touching one
 * row - so the rest of the queue collapses with it, and next month's charges
 * arrive already classified.
 *
 * It is off by default and resets with every card, because it is the wider
 * claim of the two and should never be inherited by the next transaction.
 */
const applyToAll = ref(false);
/** What the last sweep actually did - a rule is invisible without this. */
const flash = ref<string | null>(null);

async function assign(categoryId: string, confirmed=false) {
  const c = card.value;
  if (!c?.transaction || busy.value) return;
  const merchant = c.transaction.merchant;
  if(applyToAll.value&&merchant&&!confirmed){busy.value=true;try{sweep.value={categoryId,transactionId:c.transaction.id,preview:await api.previewMerchant(c.transaction.id,categoryId)}}catch(e){error.value=String(e)}finally{busy.value=false}return;}
  busy.value = true;
  flash.value = null;
  try {
    if (applyToAll.value && merchant) {
      const res = await api.ruleFromTransaction(c.transaction.id, categoryId);
      sweep.value=null;
      handled.value += res.applied;
      flash.value =
        res.applied > 1
          ? `${res.applied} תנועות בשם «${res.pattern}» סווגו, וגם הבאות יסווגו אוטומטית.`
          : `נוצר חוק: כל תנועה בשם «${res.pattern}» תסווג כך מעכשיו.`;
      // Everything the sweep just answered is still sitting in the queue.
      // Leaving it there would ask again for rows that already have an answer.
      dropMatching(res.pattern);
    } else {
      await api.setTxnCategory(c.transaction.id, categoryId);
      handled.value++;
    }
    remove(c.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'השמירה נכשלה';
  } finally {
    busy.value = false;
  }
}

/** Case-insensitive like the server's `contains` matcher. */
function dropMatching(pattern: string) {
  if (!data.value) return;
  const needle = pattern.toLowerCase();
  for (const c of [...data.value.cards]) {
    if (c.transaction && c.transaction.description.toLowerCase().includes(needle)) remove(c.id);
  }
}

/**
 * Notes and splitting, on the card.
 *
 * Categorising was the only thing you could do here, so the moment a
 * transaction needed anything else - a line explaining what it was, or
 * recognising a lump sum across the months it covers - you had to leave the
 * queue, find the row in the table, and lose your place. These are the two
 * things that come up while you are already looking at the transaction.
 *
 * Both are folded away by default: the categories are the common case and must
 * not be pushed off the card by controls most transactions never need.
 */
const otherCategory = ref('');
const panel = ref<'none' | 'note' | 'split'>('none');
const noteDraft = ref('');
const splitMonths = ref(6);

function openPanel(which: 'note' | 'split') {
  const t = card.value?.transaction;
  if (!t) return;
  panel.value = panel.value === which ? 'none' : which;
  noteDraft.value = t.note ?? '';
  splitMonths.value = t.spread?.months ?? 6;
}

/** Saving a note must NOT answer the card - the transaction still needs a category. */
async function saveNote() {
  const t = card.value?.transaction;
  if (!t || busy.value) return;
  busy.value = true;
  try {
    await api.setTxnNote(t.id, noteDraft.value.trim() || null);
    t.note = noteDraft.value.trim() || null;
    panel.value = 'none';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'שמירת ההערה נכשלה';
  } finally {
    busy.value = false;
  }
}

async function saveSplit() {
  const t = card.value?.transaction;
  if (!t || busy.value) return;
  busy.value = true;
  try {
    const plan = await api.saveSpread(t.id, splitMonths.value, 0, t.note ?? null);
    t.spread = { months: plan.months, note: plan.note };
    panel.value = 'none';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'הפריסה נכשלה';
  } finally {
    busy.value = false;
  }
}

/** Per-month figure, mirroring slicesFor() in src/spread.ts. */
const perMonth = computed(() => {
  const t = card.value?.transaction;
  if (!t || splitMonths.value < 2) return 0;
  return Math.abs(Math.trunc(t.amount / splitMonths.value));
});

/**
 * Every card starts from a clean state: no open panel, no standing claim.
 *
 * `flash` deliberately survives this. Answering a card *is* what advances the
 * queue, so clearing the confirmation on card change would erase it in the same
 * tick it was written and the sweep would look like nothing happened.
 */
watch(
  () => card.value?.id,
  () => {
    applyToAll.value = false;
    otherCategory.value = '';
    panel.value = 'none';
  },
);

/** Advice cards have no natural end, so "understood" has to be remembered. */
async function acknowledge() {
  const c = card.value;
  if (!c || busy.value) return;
  busy.value = true;
  try {
    await api.dismissReviewCard(c.id, c.kind);
    remove(c.id);
  } catch(e) {error.value=String(e)} finally {busy.value=false}
}

/** RTL: ArrowLeft advances, ArrowRight goes back - same as the timeline chart. */
function onKey(e: KeyboardEvent) {
  if(busy.value||sweep.value||(e.target instanceof HTMLElement && e.target.closest('input,textarea,select,button,a,[contenteditable=true],[role=dialog]')))return;
  if (e.key === 'ArrowLeft') next();
  else if (e.key === 'ArrowRight') back();
}

onMounted(() => {
  load();
  window.addEventListener('keydown', onKey);
  window.addEventListener('ledger:undone',load);
});
onBeforeUnmount(()=>{window.removeEventListener('keydown',onKey);window.removeEventListener('ledger:undone',load)});

const kindStyle: Record<string, { icon: string; tone: string }> = {
  sync: { icon: '⚠️', tone: 'var(--status-warning)' },
  confirm: { icon: '⚡', tone: 'var(--series-1)' },
  categorise: { icon: '🏷️', tone: 'var(--brand)' },
  late_fixed: { icon: '⏰', tone: 'var(--status-warning)' },
  insight: { icon: '💡', tone: 'var(--series-1)' },
  done: { icon: '✅', tone: 'var(--status-good)' },
};
</script>

<template>
  <div class="mx-auto max-w-xl space-y-4">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <component :is="embedded?'h2':'h1'" class="text-xl font-bold">{{ scope === 'daily' ? 'סיווג קצר' : 'מעבר על ההוצאות' }}</component>
        <p class="section-hint mt-0.5">
          {{
            scope === 'daily'
              ? 'כמה החלטות קצרות, ואפשר להמשיך הלאה'
              : 'כל ההוצאות שעוד לא סווגו, הגדולות קודם'
          }}
        </p>
      </div>
      <span v-if="cards.length" class="tnum text-sm" :style="{ color: 'var(--text-muted)' }">
        {{ index + 1 }} / {{ cards.length }}
      </span>
    </div>

    <!-- Two queues, same mechanic: the short daily pass, and the full sweep. -->
    <div class="flex gap-1.5" role="tablist">
      <button
        class="btn"
        :class="scope === 'daily' ? 'btn-primary' : 'btn-ghost'"
        role="tab"
        :aria-selected="scope === 'daily'"
        @click="setScope('daily')"
      >
        מנה קצרה
      </button>
      <button
        class="btn"
        :class="scope === 'expenses' ? 'btn-primary' : 'btn-ghost'"
        role="tab"
        :aria-selected="scope === 'expenses'"
        @click="setScope('expenses')"
      >
        כל ההוצאות
      </button>
    </div>

    <div v-if="error" class="error-banner" role="alert">{{ error }} <button class="text-link" @click="load">ניסיון חוזר</button></div>

    <!-- A rule that fires silently is indistinguishable from a card that vanished. -->
    <div
      v-if="flash"
      class="fill-in rounded-lg p-3 text-sm"
      :style="{ background: 'color-mix(in srgb, var(--status-good) 14%, transparent)', color: 'var(--text-primary)' }"
    >
      ✅ {{ flash }}
    </div>

    <!-- progress: the reason the queue gets finished -->
    <div v-if="cards.length" class="h-1.5 overflow-hidden rounded-full" :style="{ background: 'var(--surface-sunken)' }">
      <div
        class="h-full rounded-full transition-[width] duration-500"
        :style="{ width: `${progress}%`, background: 'var(--brand)', transitionTimingFunction: 'var(--ease)' }"
      ></div>
    </div>

    <div v-if="!data&&!error" class="card p-6">
      <div class="skeleton h-4 w-32"></div>
      <div class="skeleton mt-3 h-8 w-64"></div>
      <div class="skeleton mt-4 h-20 w-full"></div>
    </div>

    <!--
      A keyed element with a CSS *animation* rather than <Transition mode="out-in">.
      A transition-based swap cannot complete in a tab that is not compositing:
      no transitionend fires, so Vue holds the card at `card-enter-from`
      (opacity 0) and the component stays wedged even after you return to it.
      An animation defers only the fade - the content is correct immediately.
    -->
      <section
        v-if="card"
        :key="card.id"
        class="card rise p-6"
        :style="{ '--aura': `color-mix(in srgb, ${kindStyle[card.kind]?.tone ?? 'var(--brand)'} 12%, transparent)` }"
      >
        <p class="text-sm" :style="{ color: 'var(--text-muted)' }">
          <span aria-hidden="true">{{ kindStyle[card.kind]?.icon }}</span> {{ card.title }}
        </p>

        <!-- The amount is the headline on a card that is about a sum -->
        <p
          v-if="card.amount != null && card.kind === 'categorise'"
          class="hero-figure mt-2"
          :style="{ color: card.amount > 0 ? 'var(--delta-up)' : 'var(--text-primary)' }"
        >
          {{ fmtSigned(card.amount) }}
        </p>

        <p class="mt-2 text-lg font-semibold">{{ card.body }}</p>

        <p v-if="card.transaction" class="mt-1 text-sm" :style="{ color: 'var(--text-muted)' }">
          {{ card.transaction.accountName }} · {{ fmtDate(card.transaction.date) }}
        </p>

        <!--
          A provisional row: the provider may still rename it or reprice it -
          the rent ghost changed its description entirely on settling. Saying so
          here stops the careful user from burning a decision on a name that is
          about to change.
        -->
        <p
          v-if="card.transaction?.pending"
          class="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
          :style="{
            background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
            color: 'var(--text-secondary)',
          }"
        >
          ⏳ עסקה זמנית — השם והסכום עוד עשויים להשתנות. אפשר לדלג ולחזור אליה בעוד יום-יומיים.
        </p>

        <!--
          The scope of the next tap, stated before it is taken. Sitting directly
          above the categories rather than below them, because it changes what
          pressing one of them means and would be a nasty surprise underneath.
        -->
        <label
          v-if="card.transaction?.merchant"
          class="mt-4 flex cursor-pointer items-start gap-2 rounded-lg p-2.5 text-sm transition-colors"
          :style="{
            background: applyToAll ? 'var(--brand-soft)' : 'var(--surface-2)',
            color: applyToAll ? 'var(--brand)' : 'var(--text-secondary)',
          }"
        >
          <input v-model="applyToAll" type="checkbox" class="mt-0.5" />
          <span>
            להחיל על כל תנועה בשם «<span class="font-semibold">{{ card.transaction.merchant.pattern }}</span
            >»
            <span v-if="card.transaction.merchant.others > 0" :style="{ color: 'var(--text-muted)' }">
              — עוד {{ card.transaction.merchant.others }} ממתינות בתור
            </span>
            <span v-else :style="{ color: 'var(--text-muted)' }">— וגם על תנועות עתידיות</span>
          </span>
        </label>

        <!-- one tap per answer -->
        <div v-if="card.transaction" class="mt-4 flex flex-wrap gap-2">
          <!--
            When the rules already got it right, confirming has to be the easiest
            thing on the card. Without this the sweep offered only *other*
            categories, so a correct classification was unanswerable - which is
            most of them, and exactly the ones that should cost one tap.
          -->
          <button
            v-if="card.transaction.currentCategoryId"
            class="btn btn-primary"
            :disabled="busy"
            @click="assign(card.transaction.currentCategoryId)"
          >
            {{ card.kind === 'confirm' ? '✓ נכון, השאירו מוחרג' : '✓ נכון, אשר' }}
          </button>
          <button
            v-for="s in card.transaction.suggestions.slice(0,3)"
            :key="s.id"
            class="btn btn-ghost"
            :disabled="busy"
            @click="assign(s.id)"
          >
            <span v-if="s.icon" class="me-1" aria-hidden="true">{{ s.icon }}</span>{{ s.name }}
          </button>
          <button class="btn btn-ghost" :disabled="busy" @click="next">דלג</button>
        </div>

        <details v-if="card.transaction" class="mt-4 text-sm">
          <summary class="text-link">בחירת קטגוריה אחרת</summary>
          <div class="mt-3 flex gap-2 flex-wrap"><label class="grow"><span class="sr-only">כל הקטגוריות המתאימות</span><select v-model="otherCategory" class="field w-full" :disabled="busy"><option value="">בחירת קטגוריה…</option><option v-for="suggestion in card.transaction.suggestions" :key="suggestion.id" :value="suggestion.id">{{suggestion.name}}</option></select></label><button class="btn btn-primary" :disabled="busy||!otherCategory" @click="assign(otherCategory)">אישור הסיווג</button></div>
        </details>

        <!-- Secondary, folded away: needed sometimes, never the common case. -->
        <div v-if="card.transaction" class="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <button class="underline" :aria-expanded="panel === 'note'" @click="openPanel('note')">
            📝 {{ card.transaction.note ? 'עריכת ההערה' : 'הוספת הערה' }}
          </button>
          <button class="underline" :aria-expanded="panel === 'split'" @click="openPanel('split')">
            🗓️ {{ card.transaction.spread ? `פרוס על ${card.transaction.spread.months} חודשים` : 'חלוקה על פני חודשים' }}
          </button>
          <span v-if="card.transaction.note && panel !== 'note'" class="truncate" :style="{ color: 'var(--text-muted)' }">
            {{ card.transaction.note }}
          </span>
        </div>

        <div
          v-if="panel === 'note' && card.transaction"
          class="mt-2 rounded-lg p-3"
          :style="{ background: 'var(--surface-2)' }"
        >
          <label class="block text-xs" :style="{ color: 'var(--text-secondary)' }">
            מה זו ההוצאה הזאת, מעבר לכותרת
            <input
              v-model="noteDraft"
              type="text"
              maxlength="500"
              class="field mt-1 w-full !py-1 text-sm"
              @keyup.enter="saveNote"
              @keyup.esc="panel = 'none'"
            />
          </label>
          <div class="mt-2 flex gap-2">
            <button class="btn btn-primary !py-1 !text-xs" :disabled="busy" @click="saveNote">שמירה</button>
            <button class="btn btn-ghost !py-1 !text-xs" :disabled="busy" @click="panel = 'none'">ביטול</button>
          </div>
        </div>

        <div
          v-if="panel === 'split' && card.transaction"
          class="mt-2 rounded-lg p-3"
          :style="{ background: 'var(--surface-2)' }"
        >
          <label class="block text-xs" :style="{ color: 'var(--text-secondary)' }">
            על פני כמה חודשים לפרוס
            <input
              v-model.number="splitMonths"
              type="number"
              min="2"
              max="60"
              class="field mt-1 w-24 !py-1 text-sm"
            />
          </label>
          <!-- See the result before committing to it. -->
          <p v-if="splitMonths >= 2 && splitMonths <= 60" class="mt-2 text-xs" :style="{ color: 'var(--text-secondary)' }">
            <span class="tnum font-semibold">{{ fmtILSRound(perMonth) }}</span> לחודש ·
            היתרה בבנק לא משתנה, רק האופן שבו זה נספר בתזרים.
          </p>
          <div class="mt-2 flex gap-2">
            <button
              class="btn btn-primary !py-1 !text-xs"
              :disabled="busy || splitMonths < 2 || splitMonths > 60"
              @click="saveSplit"
            >
              {{ card.transaction.spread ? 'עדכון' : 'חלוקה' }}
            </button>
            <button class="btn btn-ghost !py-1 !text-xs" :disabled="busy" @click="panel = 'none'">ביטול</button>
          </div>
        </div>

        <!-- Not chained to the panels above: they are conditional *within* a
             transaction card, and a v-else against them would swallow this. -->
        <div v-if="!card.transaction && card.kind === 'done'" class="mt-5 flex flex-wrap gap-2">
          <RouterLink to="/" class="btn btn-primary">לדשבורד</RouterLink>
          <button class="btn btn-ghost" @click="load">רענון</button>
        </div>

        <div v-else-if="!card.transaction" class="mt-5 flex flex-wrap gap-2">
          <button class="btn btn-primary" :disabled="busy" @click="acknowledge">הבנתי</button>
          <RouterLink v-if="card.kind === 'sync'" to="/connections" class="btn btn-ghost">
            לעמוד החיבורים
          </RouterLink>
        </div>

        <p v-if="handled > 0 && card.kind === 'done'" class="mt-4 text-sm" :style="{ color: 'var(--status-good)' }">
          סווגת {{ handled }} תנועות היום.
        </p>
      </section>

    <div v-if="cards.length" class="flex items-center justify-between">
      <button class="btn btn-ghost" :disabled="index === 0" @click="back">הקודם</button>
      <span class="text-xs" :style="{ color: 'var(--text-muted)' }">← → למעבר</span>
      <button class="btn btn-ghost" :disabled="index >= cards.length - 1" @click="next">הבא</button>
    </div>
    <AppDialog :open="!!sweep" title="סיווג בית העסק ותנועות נוספות" @close="!busy&&(sweep=null)"><div v-if="sweep" class="space-y-4"><p v-if="error" class="error-box">{{error}}</p><p>{{sweep.preview.count}} תנועות יושפעו · {{fmtILSRound(sweep.preview.amount)}}.</p><ul><li v-for="t in sweep.preview.samples" :key="t.id" class="py-2">{{t.description}} · {{fmtILSRound(t.amount)}}</li></ul><p class="notice-panel">ייווצר גם חוק לתנועות עתידיות. בחירות ידניות אחרות נשמרות.</p><button class="btn btn-primary" :disabled="busy" @click="assign(sweep.categoryId,true)">אישור הסיווג והחוק</button></div></AppDialog>
  </div>
</template>

<style scoped>
/* The card arrival uses the shared `.rise` animation; nothing extra needed. */
</style>
