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
import { fmtILSRound, fmtSigned } from '../lib/format.js';

const categories = ref<Category[]>([]);
const cycleSpend = ref<Map<string, number>>(new Map());
const error = ref<string | null>(null);
const msg = (e: unknown) => (e instanceof Error ? e.message : 'הפעולה לא הושלמה. נסו שוב.');

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
  { value: 'fixed', label: 'הוצאה קבועה', hint: 'חוזרת כל חודש בסכום צפוי — נכנסת לתחזית' },
  { value: 'variable', label: 'הוצאה משתנה', hint: 'הוצאה שוטפת שבשליטתכם — ממנה נגזר כמה נשאר להוציא' },
  {
    value: 'excluded',
    label: 'לא נספר בתזרים',
    hint: 'כסף אמיתי שנכנס או יצא, אבל אירוע חריג — משנה את היתרה ולא נספר בתזרים או בתחזית',
  },
  {
    value: 'savings',
    label: 'הפקדה לחיסכון',
    hint: 'כסף שהעברתם הצידה — יורד ממה שנשאר להוציא, אבל נספר בנפרד כחיסכון ולא כהוצאה',
  },
  { value: 'transfer', label: 'העברה פנימית', hint: 'העברה בין חשבונות או סליקת כרטיס אשראי — מוצגת בנפרד כדי שאותו כסף לא ייספר פעמיים' },
];
/** A budget is a spending target; on income, transfers or excluded money it means nothing. */
const budgetable = (kind: CategoryKind) => kind === 'fixed' || kind === 'variable' || kind === 'savings';

const paletteChoices: Array<{ hex: string; name: string }> = [
  { hex: '#2a78d6', name: 'כחול' },
  { hex: '#eb6834', name: 'כתום' },
  { hex: '#1baf7a', name: 'ירוק בהיר' },
  { hex: '#eda100', name: 'צהוב' },
  { hex: '#e87ba4', name: 'ורוד' },
  { hex: '#008300', name: 'ירוק כהה' },
  { hex: '#4a3aa7', name: 'סגול' },
  { hex: '#e34948', name: 'אדום' },
  { hex: '#8a8a94', name: 'אפור' },
];

const newName = ref('');
const newColor = ref(paletteChoices[0].hex);
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

const refresh=()=>load().catch(e=>{error.value=msg(e)});
onMounted(()=>{refresh();window.addEventListener('ledger:undone',refresh)});onBeforeUnmount(()=>window.removeEventListener('ledger:undone',refresh));

const grouped = computed(() =>
  KINDS.map((k) => ({ ...k, items: categories.value.filter((c) => c.kind === k.value) })).filter(
    (g) => g.items.length > 0,
  ),
);
const countLabel = (n: number) => (n === 1 ? 'תנועה אחת' : `${n} תנועות`);

async function addCategory() {
  if (!newName.value.trim()) return;
  try {
    await api.createCategory({
      name: newName.value.trim(),
      color: newColor.value,
      icon: newIcon.value || null,
      kind: newKind.value,
      monthlyBudget: budgetable(newKind.value) && newBudget.value != null && newBudget.value > 0 ? Math.round(newBudget.value * 100) : null,
    });
    newName.value = '';
    newBudget.value = null;
    await load();
  } catch (e) {
    error.value = msg(e);
  }
}

const pending=ref<{cat:Category;kind:CategoryKind;preview:Preview}|null>(null);
const busy=ref(false), kindKey=ref(0);
async function updateKind(cat:Category,kind:CategoryKind){try{pending.value={cat,kind,preview:await api.previewCategory(cat.id)}}catch(e){error.value=msg(e);kindKey.value++}}
/** Closing without confirming puts every kind select back to what is actually saved. */
function cancelKind(){if(busy.value)return;pending.value=null;kindKey.value++}
async function confirmKind(){if(!pending.value)return;busy.value=true;try{await api.updateCategory(pending.value.cat.id,{kind:pending.value.kind});pending.value=null;await load()}catch(e){error.value=msg(e)}finally{busy.value=false}}

const savedId = ref<string | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(savedTimer));
async function updateBudget(cat: Category, shekelsStr: string) {
  const shekels = Number(shekelsStr);
  const monthlyBudget = Number.isFinite(shekels) && shekels > 0 ? Math.round(shekels * 100) : null;
  if (monthlyBudget === cat.monthlyBudget) return;
  try {
    await api.updateCategory(cat.id, { monthlyBudget });
    cat.monthlyBudget = monthlyBudget;
    savedId.value = cat.id;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedId.value = null), 2500);
  } catch (e) { error.value = msg(e); }
}

const editing = ref<{ cat: Category; name: string; icon: string; color: string } | null>(null);
function startEdit(cat: Category) { error.value = null; editing.value = { cat, name: cat.name, icon: cat.icon ?? '', color: cat.color ?? paletteChoices[8].hex }; }
async function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  busy.value = true;
  try { await api.updateCategory(e.cat.id, { name: e.name.trim(), icon: e.icon.trim() || null, color: e.color }); editing.value = null; await load(); }
  catch (err) { error.value = msg(err); }
  finally { busy.value = false; }
}

const deleting = ref<Category | null>(null);
async function removeCategory() {
  if (!deleting.value) return;
  busy.value = true;
  try { await api.deleteCategory(deleting.value.id); deleting.value = null; await load(); }
  catch (e) { error.value = msg(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="space-y-5">
    <div class="page-heading">
      <div>
        <h1>קטגוריות ותקציבים</h1>
        <p>הסיווג ל"קבועה" או "משתנה" הוא מה שקובע את התחזית — הוצאות קבועות נשמרות מראש בתחזית, ומההוצאות המשתנות נגזר כמה נשאר להוציא.</p>
      </div>
    </div>

    <div v-if="error && !pending && !editing && !deleting" class="card p-4 text-sm" role="alert" :style="{ color: 'var(--status-critical)' }">{{ error }}</div>

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
      <fieldset class="text-sm">
        <legend class="mb-1 block" :style="{ color: 'var(--text-muted)' }">צבע</legend>
        <div class="flex gap-1.5 pb-1.5">
          <button
            v-for="c in paletteChoices"
            :key="c.hex"
            type="button"
            class="h-6 w-6 rounded-full transition-transform"
            :style="{
              background: c.hex,
              outline: newColor === c.hex ? '2px solid var(--text-primary)' : 'none',
              outlineOffset: '2px',
            }"
            :aria-label="`צבע ${c.name}`"
            :title="c.name"
            :aria-pressed="newColor === c.hex"
            @click="newColor = c.hex"
          ></button>
        </div>
      </fieldset>
      <label v-if="budgetable(newKind)" class="text-sm">
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
        <table class="cat-table w-full text-sm">
          <thead>
            <tr class="border-b text-right" :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }">
              <th scope="col" class="px-4 py-2 font-medium">קטגוריה</th>
              <th scope="col" class="px-4 py-2 font-medium">תנועות</th>
              <th scope="col" class="px-4 py-2 font-medium">חוקים</th>
              <th scope="col" class="px-4 py-2 font-medium">מאזן במחזור הנוכחי</th>
              <th scope="col" class="px-4 py-2 font-medium">סוג</th>
              <th scope="col" class="px-4 py-2 font-medium">{{ budgetable(group.value) ? 'תקציב (₪)' : '' }}</th>
              <th scope="col" class="px-4 py-2"><span class="sr-only">פעולות</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in group.items"
              :key="c.id"
              class="border-b last:border-0"
              :style="{ borderColor: 'var(--gridline)' }"
            >
              <td class="cat-name px-4 py-2.5">
                <span class="inline-flex items-center gap-2">
                  <span class="inline-block h-2.5 w-2.5 rounded-full" :style="{ background: c.color ?? '#8a8a94' }"></span>
                  <span><span aria-hidden="true">{{ c.icon }}</span> {{ c.name }}</span>
                </span>
              </td>
              <td class="tnum px-4 py-2.5" data-label="תנועות" :style="{ color: 'var(--text-muted)' }">{{ c._count?.transactions ?? 0 }}</td>
              <td class="tnum px-4 py-2.5" data-label="חוקים" :style="{ color: 'var(--text-muted)' }">{{ c._count?.rules ?? 0 }}</td>
              <td class="tnum px-4 py-2.5" data-label="מאזן במחזור הנוכחי">
                {{ cycleSpend.get(c.id) ? fmtSigned(cycleSpend.get(c.id)!) : '—' }}
              </td>
              <td class="px-4 py-2.5" data-label="סוג">
                <select
                  :key="`${c.id}-${kindKey}`"
                  class="field !py-1 text-xs"
                  :value="c.kind"
                  :aria-label="`סוג הקטגוריה ${c.name}`"
                  @change="updateKind(c, ($event.target as HTMLSelectElement).value as CategoryKind)"
                >
                  <option v-for="k in KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
                </select>
              </td>
              <td class="px-4 py-2.5" :data-label="budgetable(c.kind) ? 'תקציב (₪)' : undefined">
                <span v-if="budgetable(c.kind)" class="inline-flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    class="field w-24"
                    :value="c.monthlyBudget != null ? c.monthlyBudget / 100 : ''"
                    placeholder="ללא"
                    :aria-label="`תקציב חודשי ל${c.name}`"
                    @change="updateBudget(c, ($event.target as HTMLInputElement).value)"
                  />
                  <span v-if="savedId === c.id" class="saved-flash" role="status">✓ נשמר</span>
                </span>
              </td>
              <td class="cat-actions px-4 py-2.5 text-left whitespace-nowrap">
                <button class="btn btn-ghost !px-3" @click="startEdit(c)">עריכה</button>
                <button class="btn btn-danger-ghost !px-3" @click="error = null; deleting = c">מחיקה</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <AppDialog :open="!!pending" title="שינוי סוג קטגוריה" @close="cancelKind"><div v-if="pending" class="space-y-4"><p v-if="error" class="error-box" role="alert">{{error}}</p><p>״{{pending.cat.name}}״ תעבור ל״{{KINDS.find(k=>k.value===pending!.kind)?.label}}״.</p><p>{{pending.preview.count===1?'תנועה אחת משויכת':`${pending.preview.count} תנועות משויכות`}} אליה, בסך {{fmtILSRound(pending.preview.amount)}} בכל ההיסטוריה.</p><p class="notice-panel">{{KINDS.find(k=>k.value===pending!.kind)?.hint}}. השינוי ישפיע גם על סיכומים היסטוריים ותחזיות.</p><div class="flex gap-2"><button class="btn btn-primary" :disabled="busy" @click="confirmKind">אישור השינוי</button><button class="btn btn-ghost" :disabled="busy" @click="cancelKind">ביטול</button></div></div></AppDialog>
    <AppDialog :open="!!editing" title="עריכת קטגוריה" @close="!busy&&(editing=null)">
      <form v-if="editing" class="space-y-4" @submit.prevent="saveEdit">
        <p v-if="error" class="error-box" role="alert">{{ error }}</p>
        <label class="block text-sm">שם<input v-model="editing.name" class="field mt-1 w-full" required /></label>
        <label class="block text-sm">אייקון<input v-model="editing.icon" class="field mt-1 w-16 text-center" maxlength="4" /></label>
        <fieldset class="text-sm">
          <legend class="mb-1">צבע</legend>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="c in paletteChoices"
              :key="c.hex"
              type="button"
              class="h-7 w-7 rounded-full"
              :style="{ background: c.hex, outline: editing.color === c.hex ? '2px solid var(--text-primary)' : 'none', outlineOffset: '2px' }"
              :aria-label="`צבע ${c.name}`"
              :title="c.name"
              :aria-pressed="editing.color === c.hex"
              @click="editing!.color = c.hex"
            ></button>
          </div>
        </fieldset>
        <div class="flex gap-2"><button class="btn btn-primary" :disabled="busy || !editing.name.trim()">{{ busy ? 'שומר…' : 'שמירה' }}</button><button type="button" class="btn btn-ghost" :disabled="busy" @click="editing = null">ביטול</button></div>
      </form>
    </AppDialog>
    <AppDialog :open="!!deleting" title="מחיקת קטגוריה" @close="!busy&&(deleting=null)">
      <div v-if="deleting" class="space-y-4">
        <p v-if="error" class="error-box" role="alert">{{ error }}</p>
        <p>למחוק את הקטגוריה ״{{ deleting.name }}״?</p>
        <p v-if="(deleting._count?.transactions ?? 0) > 0">
          {{ countLabel(deleting._count!.transactions) }} {{ deleting._count!.transactions === 1 ? 'מסווגת' : 'מסווגות' }} בה כרגע. אחרי המחיקה {{ deleting._count!.transactions === 1 ? 'היא תחזור' : 'הן יחזרו' }} לממתינות לסיווג.
        </p>
        <p v-else>אין תנועות שמסווגות בה.</p>
        <p v-if="(deleting._count?.rules ?? 0) > 0">{{ deleting._count!.rules === 1 ? 'החוק שמפנה אליה יימחק' : `${deleting._count!.rules} החוקים שמפנים אליה יימחקו` }}.</p>
        <p class="section-hint">אפשר לבטל את המחיקה בהיסטוריית השינויים.</p>
        <div class="flex gap-2"><button class="btn btn-danger" :disabled="busy" @click="removeCategory">{{ busy ? 'מוחק…' : 'מחיקת הקטגוריה' }}</button><button class="btn btn-ghost" :disabled="busy" @click="deleting = null">ביטול</button></div>
      </div>
    </AppDialog>
  </div>
</template>

<style scoped>
.btn-danger{background:var(--status-critical);color:#fff}.btn-danger:not(:disabled):hover{filter:brightness(1.08)}
.saved-flash{font-size:12px;color:var(--status-good);white-space:nowrap}
@media(max-width:640px){
  .cat-table thead{display:none}
  .cat-table,.cat-table tbody,.cat-table tr,.cat-table td{display:block;width:100%}
  .cat-table tr{padding:12px 16px}
  .cat-table td{padding:4px 0!important;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:start}
  .cat-table td[data-label]::before{content:attr(data-label);font-size:12px;color:var(--text-muted)}
  .cat-table td:not([data-label]):empty{display:none}
  .cat-table td.cat-name{font-weight:600;padding-bottom:8px!important}
  .cat-table td.cat-actions{justify-content:flex-start;gap:8px;padding-top:8px!important}
}
</style>
