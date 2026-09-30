<script setup lang="ts">
/**
 * Categories, and - more importantly - their `kind`. The fixed/variable split is
 * the axis the whole cash-flow forecast turns on, so it is editable right here
 * with an explanation of what each choice does.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { api, type Category, type CategoryKind } from '../lib/api.js';
import AppDialog from '../components/AppDialog.vue';
import { type Preview } from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';

const categories = ref<Category[]>([]);
const cycleSpend = ref<Map<string, number>>(new Map());
const error = ref<string | null>(null);

const KINDS: Array<{ value: CategoryKind; label: string; hint: string }> = [
  {
    value: 'income_fixed',
    label: 'הכנסה קבועה',
    hint: 'משכורת, קצבאות — כסף שאפשר לתכנן סביבו',
  },
  {
    value: 'income_variable',
    label: 'הכנסה משתנה',
    hint: 'פרילנס, מילואים, החזרי מס — נכנס, אבל לא מבטיח כלום על החודש הבא',
  },
  { value: 'fixed', label: 'הוצאה קבועה', hint: 'התחייבות חודשית צפויה — נכנסת לתחזית' },
  { value: 'variable', label: 'הוצאה משתנה', hint: 'הוצאה שוטפת בשליטתך — זה מה שנשאר להוציא' },
  {
    value: 'excluded',
    label: 'לא תזרימי',
    hint: 'כסף אמיתי שנכנס או יצא, אבל אירוע חריג — משנה את היתרה ולא נספר בתזרים או בתחזית',
  },
  {
    value: 'savings',
    label: 'הפקדה לחיסכון',
    hint: 'כסף שהעברת הצידה — יורד ממה שנשאר להוציא, אבל נספר בנפרד כחיסכון ולא כהוצאה',
  },
  { value: 'transfer', label: 'העברה', hint: 'תנועה פנימית או פירעון אשראי — מוצגת בנפרד כדי למנוע ספירה כפולה' },
];

const paletteChoices = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
  '#8a8a94',
];

const newName = ref('');
const newColor = ref(paletteChoices[0]);
const newIcon = ref('🏷️');
const newKind = ref<CategoryKind>('variable');
const newBudget = ref<number | null>(null);

async function load() {
  const [cats, cashflow] = await Promise.all([api.categories(), api.cashflow(0)]);
  categories.value = cats;
  cycleSpend.value = new Map(
    cashflow.categoryTotals.filter((r) => r.categoryId).map((r) => [r.categoryId as string, r.amount]),
  );
}

const refresh=()=>load().catch(e=>{error.value=String(e)});
onMounted(()=>{refresh();window.addEventListener('ledger:undone',refresh)});onBeforeUnmount(()=>window.removeEventListener('ledger:undone',refresh));

const grouped = computed(() =>
  KINDS.map((k) => ({ ...k, items: categories.value.filter((c) => c.kind === k.value) })).filter(
    (g) => g.items.length > 0,
  ),
);

async function addCategory() {
  if (!newName.value.trim()) return;
  try {
    await api.createCategory({
      name: newName.value.trim(),
      color: newColor.value,
      icon: newIcon.value || null,
      kind: newKind.value,
      monthlyBudget: newBudget.value != null && newBudget.value > 0 ? Math.round(newBudget.value * 100) : null,
    });
    newName.value = '';
    newBudget.value = null;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

const pending=ref<{cat:Category;kind:CategoryKind;preview:Preview}|null>(null);
const busy=ref(false);
async function updateKind(cat:Category,kind:CategoryKind){try{pending.value={cat,kind,preview:await api.previewCategory(cat.id)}}catch(e){error.value=String(e)}}
async function confirmKind(){if(!pending.value)return;busy.value=true;try{await api.updateCategory(pending.value.cat.id,{kind:pending.value.kind});pending.value=null;await load()}catch(e){error.value=String(e)}finally{busy.value=false}}

async function updateBudget(cat: Category, shekelsStr: string) {
  const shekels = Number(shekelsStr);
  const monthlyBudget = Number.isFinite(shekels) && shekels > 0 ? Math.round(shekels * 100) : null;
  try {await api.updateCategory(cat.id, { monthlyBudget }); cat.monthlyBudget = monthlyBudget;} catch(e){error.value=String(e)}
}

async function removeCategory(cat: Category) {
  const txnCount = cat._count?.transactions ?? 0;
  const warning = txnCount > 0 ? ` ${txnCount} תנועות יישארו ללא קטגוריה.` : '';
  if (!confirm(`למחוק את הקטגוריה "${cat.name}"?${warning}`)) return;
  try{await api.deleteCategory(cat.id);await load()}catch(e){error.value=String(e)}
}
</script>

<template>
  <div class="space-y-5">
    <div class="page-heading">
      <div>
        <h1>קטגוריות ותקציבים</h1>
        <p>הסיווג ל"קבועה" או "משתנה" הוא מה שקובע את התחזית — קבועות נחשבות כמחויבות, משתנות הן מה שנשאר לך להוציא.</p>
      </div>
    </div>

    <div v-if="error" class="card p-4 text-sm" :style="{ color: 'var(--status-critical)' }">{{ error }}</div>

    <!-- Add form -->
    <div class="card flex flex-wrap items-end gap-3 p-4">
      <label class="text-sm">
        <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">שם</span>
        <input v-model="newName" class="field" placeholder="קטגוריה חדשה" @keyup.enter="addCategory" />
      </label>
      <label class="text-sm">
        <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">אייקון</span>
        <input v-model="newIcon" class="field w-16 text-center" maxlength="4" />
      </label>
      <label class="text-sm">
        <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">סוג</span>
        <select v-model="newKind" class="field">
          <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </label>
      <div class="text-sm">
        <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">צבע</span>
        <div class="flex gap-1.5 pb-1.5">
          <button
            v-for="c in paletteChoices"
            :key="c"
            type="button"
            class="h-6 w-6 rounded-full transition-transform"
            :style="{
              background: c,
              outline: newColor === c ? '2px solid var(--text-primary)' : 'none',
              outlineOffset: '2px',
            }"
            :aria-label="`בחר צבע ${c}`"
            :aria-pressed="newColor === c"
            @click="newColor = c"
          ></button>
        </div>
      </div>
      <label class="text-sm">
        <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">תקציב חודשי (₪)</span>
        <input v-model.number="newBudget" type="number" min="0" class="field w-32" placeholder="ללא" />
      </label>
      <button class="btn btn-primary" @click="addCategory">הוספה</button>
    </div>

    <!-- Grouped by kind, so the classification is legible at a glance -->
    <section v-for="group in grouped" :key="group.value" class="card-flush">
      <div class="border-b px-4 py-3" :style="{ borderColor: 'var(--gridline)', background: 'var(--surface-2)' }">
        <h2 class="section-title">{{ group.label }}</h2>
        <p class="section-hint">{{ group.hint }}</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-right" :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }">
              <th scope="col" class="px-4 py-2 font-medium">קטגוריה</th>
              <th scope="col" class="px-4 py-2 font-medium">תנועות</th>
              <th scope="col" class="px-4 py-2 font-medium">חוקים</th>
              <th scope="col" class="px-4 py-2 font-medium">נטו במחזור הנוכחי</th>
              <th scope="col" class="px-4 py-2 font-medium">סוג</th>
              <th scope="col" class="px-4 py-2 font-medium">תקציב (₪)</th>
              <th scope="col" class="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in group.items"
              :key="c.id"
              class="border-b last:border-0"
              :style="{ borderColor: 'var(--gridline)' }"
            >
              <td class="px-4 py-2.5">
                <span class="inline-flex items-center gap-2">
                  <span class="inline-block h-2.5 w-2.5 rounded-full" :style="{ background: c.color ?? '#8a8a94' }"></span>
                  <span><span aria-hidden="true">{{ c.icon }}</span> {{ c.name }}</span>
                </span>
              </td>
              <td class="tnum px-4 py-2.5" :style="{ color: 'var(--text-muted)' }">{{ c._count?.transactions ?? 0 }}</td>
              <td class="tnum px-4 py-2.5" :style="{ color: 'var(--text-muted)' }">{{ c._count?.rules ?? 0 }}</td>
              <td class="tnum px-4 py-2.5">
                {{ cycleSpend.get(c.id) ? fmtILSRound(cycleSpend.get(c.id)!) : '—' }}
              </td>
              <td class="px-4 py-2.5">
                <select
                  class="field !py-1 text-xs"
                  :value="c.kind"
                  :aria-label="`סוג הקטגוריה ${c.name}`"
                  @change="updateKind(c, ($event.target as HTMLSelectElement).value as CategoryKind)"
                >
                  <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
                </select>
              </td>
              <td class="px-4 py-2.5">
                <input
                  type="number"
                  min="0"
                  class="field w-24"
                  :value="c.monthlyBudget != null ? c.monthlyBudget / 100 : ''"
                  placeholder="ללא"
                  :aria-label="`תקציב חודשי ל${c.name}`"
                  @change="updateBudget(c, ($event.target as HTMLInputElement).value)"
                />
              </td>
              <td class="px-4 py-2.5 text-left">
                <button class="btn btn-danger-ghost" @click="removeCategory(c)">מחיקה</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <AppDialog :open="!!pending" title="שינוי סוג קטגוריה" @close="!busy&&(pending=null)"><div v-if="pending" class="space-y-4"><p v-if="error" class="error-box">{{error}}</p><p>״{{pending.cat.name}}״ תעבור ל״{{KINDS.find(k=>k.value===pending!.kind)?.label}}״.</p><p>{{pending.preview.count}} תנועות משויכות · נטו {{fmtILSRound(pending.preview.amount)}} בכל ההיסטוריה.</p><p class="notice-panel">{{KINDS.find(k=>k.value===pending!.kind)?.hint}}. השינוי ישפיע גם על סיכומים היסטוריים ותחזיות.</p><button class="btn btn-primary" :disabled="busy" @click="confirmKind">אישור השינוי</button></div></AppDialog>
  </div>
</template>
