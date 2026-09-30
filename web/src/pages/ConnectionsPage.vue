<script setup lang="ts">
const {settingsOnly=false}=defineProps<{settingsOnly?:boolean}>();
/**
 * Connections — the whole system's control panel, so nothing here needs a terminal.
 *
 * Shows every configured provider, the accounts it produced, how fresh the data
 * is, and what is still floating on each card. Scrapes run from the browser with
 * live progress.
 *
 * Credentials are write-only: this page can set them, never read them back. The
 * API returns only whether each field is present and encrypted.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  api,
  type Connection,
  type ConnectionsResponse,
  type NotificationDetail,
  type ProviderInfo,
  type ScrapeJob,
  type Settings,
  type SyncIssue,
  type BackupStatus,
} from '../lib/api.js';
import { fmtILSRound } from '../lib/format.js';
import SyncAlerts from '../components/SyncAlerts.vue';

const route = useRoute();
const data = ref<ConnectionsResponse | null>(null);
const issues = ref<SyncIssue[]>([]);
const settings = ref<Settings | null>(null);
const savingSettings = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const backup = ref<BackupStatus | null>(null);
const backupDestination = ref('');
const backupSetup = ref<{ setupId: string; passphrase: string; sameDrive: boolean } | null>(null);
const backupBusy = ref(false);
const backupMessage = ref<string | null>(null);

const job = ref<ScrapeJob | null>(null);
let poll: ReturnType<typeof setInterval> | undefined;

// --- credential form state ---
const formOpen = ref(false);
const formCompany = ref('');
const formDisplayName = ref('');
const formValues = ref<Record<string, string>>({});
const formError = ref<string | null>(null);
const saving = ref(false);
const isEditing = ref(false);

/**
 * The scraper library names login fields for code ("userCode", "card6Digits").
 * Shown raw, the form asks people to guess which bank-site field each one is.
 */
const FIELD_LABELS: Record<string, { label: string; hint?: string }> = {
  userCode: { label: 'קוד משתמש', hint: 'כפי שמוזן באתר הבנק' },
  username: { label: 'שם משתמש' },
  password: { label: 'סיסמה' },
  id: { label: 'תעודת זהות', hint: '9 ספרות' },
  nationalID: { label: 'תעודת זהות', hint: '9 ספרות' },
  num: { label: 'קוד מזהה', hint: 'הקוד שמוזן באתר לצד הסיסמה' },
  card6Digits: { label: '6 הספרות האחרונות של הכרטיס' },
  email: { label: 'אימייל' },
  phoneNumber: { label: 'מספר טלפון' },
  otpLongTermToken: { label: 'טוקן OTP לטווח ארוך', hint: 'אופציונלי' },
};
const fieldLabel = (field: string) => FIELD_LABELS[field]?.label ?? field;
const fieldHint = (field: string) => FIELD_LABELS[field]?.hint;

const selectedProvider = computed<ProviderInfo | null>(
  () => data.value?.providers.find((p) => p.id === formCompany.value) ?? null,
);

const banks = computed(() => data.value?.connections.filter((c) => c.type === 'bank') ?? []);
const cards = computed(() => data.value?.connections.filter((c) => c.type === 'credit_card') ?? []);
const running = computed(() => job.value?.status === 'running');

async function load() {
  try {
    const [conn, health, cfg, backupState] = await Promise.all([api.connections(), api.syncHealth(), api.settings(), api.backupStatus()]);
    data.value = conn;
    issues.value = health.issues;
    settings.value = cfg;
    backup.value = backupState;
    if (!backupDestination.value) backupDestination.value = backupState.destination ?? backupState.suggestedDestination ?? '';
    await loadRecipients();
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function prepareBackup() {
  backupBusy.value = true;
  backupMessage.value = null;
  try {
    backupSetup.value = await api.prepareBackup(backupDestination.value);
  } catch (err) {
    backupMessage.value = err instanceof Error ? err.message : String(err);
  } finally { backupBusy.value = false; }
}

async function confirmBackup() {
  if (!backupSetup.value) return;
  backupBusy.value = true;
  try {
    backup.value = await api.confirmBackup(backupSetup.value.setupId);
    backupSetup.value = null;
    backupMessage.value = 'הגיבוי הראשון נוצר ואומת בהצלחה.';
  } catch (err) {
    backupMessage.value = err instanceof Error ? err.message : String(err);
  } finally { backupBusy.value = false; }
}

async function runBackup() {
  backupBusy.value = true;
  try {
    backup.value = await api.runBackup();
    backupMessage.value = 'נוצר גיבוי מוצפן חדש ואומת.';
  } catch (err) {
    backupMessage.value = err instanceof Error ? err.message : String(err);
  } finally { backupBusy.value = false; }
}

// --- Telegram ---
const tgToken = ref('');
const tgChatId = ref('');
const tgDetecting = ref(false);
const tgCandidates = ref<Array<{ id: string; name: string }>>([]);
const tgDetectHint = ref('');

/**
 * Reads the chat id off the /start the user just sent their bot, instead of
 * asking them to open a raw API URL and find a number inside JSON - which is
 * what the instructions used to say, and is not a thing to ask of someone who
 * only wants a daily summary.
 */
async function detectChat() {
  tgDetecting.value = true;
  tgDetectHint.value = '';
  tgCandidates.value = [];
  try {
    // No token during setup means none is stored yet; afterwards the server
    // uses the stored one and this screen never handles the secret.
    const { chats } = await api.detectTelegramChat(tgToken.value.trim() || undefined);
    const fresh = chats.filter((c) => !tgRecipients.value.includes(c.id));
    if (chats.length === 0) {
      tgDetectHint.value = 'לא הגיעה עדיין הודעה. פתחו את הבוט בטלגרם, שלחו /start, ולחצו שוב.';
    } else if (fresh.length === 0) {
      tgDetectHint.value = 'כל מי שכתב לבוט כבר ברשימה.';
    } else if (fresh.length === 1 && !settings.value?.telegramConfigured) {
      tgChatId.value = fresh[0].id;
      tgDetectHint.value = `זוהה: ${fresh[0].name}`;
    } else {
      tgCandidates.value = fresh;
      tgDetectHint.value = 'בחרו מי מהם.';
    }
  } catch (err) {
    tgDetectHint.value = err instanceof Error ? err.message : 'הזיהוי נכשל.';
  } finally {
    tgDetecting.value = false;
  }
}
const tgBusy = ref(false);
const tgMessage = ref<{ ok: boolean; text: string } | null>(null);

/**
 * Recipients, once a bot is connected.
 *
 * Adding someone used to be impossible without disconnecting the bot and
 * pasting the token in again, because the entire Telegram form vanished the
 * moment it was configured - so the one change a household actually makes was
 * the one thing the screen would not do.
 *
 * It is a send list, not an access list: the channel is outbound only, so a
 * name here reads the digest and can do nothing else. The UI says so, because
 * "who else can see my bank account" is the question this control provokes.
 */
const tgRecipients = ref<string[]>([]);
const tgNewRecipient = ref('');

async function loadRecipients() {
  if (!settings.value?.telegramConfigured) return;
  tgRecipients.value = (await api.telegramRecipients()).chatIds;
}

/** Test first, add second: a chat that never sent /start rejects the message. */
async function addRecipient() {
  const id = tgNewRecipient.value.trim();
  if (!/^\d+$/.test(id)) {
    tgMessage.value = { ok: false, text: 'מזהה צ׳אט הוא מספר. לחצו "מי כתב לבוט" אחרי שהיא שולחת /start.' };
    return;
  }
  if (tgRecipients.value.includes(id)) {
    tgMessage.value = { ok: false, text: 'הנמען הזה כבר ברשימה.' };
    return;
  }
  tgBusy.value = true;
  tgMessage.value = null;
  try {
    const probe = await api.testTelegramRecipient(id);
    if (!probe.sent) {
      tgMessage.value = { ok: false, text: probe.error ?? 'ההודעה לא הגיעה, אז לא הוספתי.' };
      return;
    }
    tgRecipients.value = (await api.saveTelegramRecipients([...tgRecipients.value, id])).chatIds;
    tgNewRecipient.value = '';
    tgCandidates.value = [];
    tgMessage.value = { ok: true, text: 'נוסף, והודעת בדיקה כבר נשלחה לשם.' };
  } catch (e) {
    tgMessage.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    tgBusy.value = false;
  }
}

async function removeRecipient(id: string) {
  // The list cannot be emptied - a configured bot with nobody to send to is a
  // silent failure that looks exactly like everything working.
  if (tgRecipients.value.length <= 1) {
    tgMessage.value = { ok: false, text: 'זה הנמען האחרון. כדי להפסיק לגמרי, לחצו "ניתוק".' };
    return;
  }
  if (!confirm('להסיר את הנמען הזה? הוא יפסיק לקבל את הסיכומים.')) return;
  tgBusy.value = true;
  try {
    tgRecipients.value = (await api.saveTelegramRecipients(
      tgRecipients.value.filter((r) => r !== id),
    )).chatIds;
    tgMessage.value = { ok: true, text: 'הוסר.' };
  } finally {
    tgBusy.value = false;
  }
}

async function saveTelegram() {
  if (!tgToken.value.trim() || !tgChatId.value.trim()) {
    tgMessage.value = { ok: false, text: 'צריך גם טוקן וגם מזהה צ׳אט' };
    return;
  }
  tgBusy.value = true;
  tgMessage.value = null;
  try {
    await api.saveTelegram(tgToken.value, [tgChatId.value.trim()]);
    tgToken.value = '';
    tgChatId.value = '';
    const result = await api.testTelegram();
    tgMessage.value = result.sent
      ? { ok: true, text: 'נשמר ונשלחה הודעת בדיקה — בדוק בטלגרם.' }
      : { ok: false, text: `נשמר, אבל השליחה נכשלה: ${result.error ?? 'שגיאה לא ידועה'}` };
    await load();
  } catch (e) {
    tgMessage.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    tgBusy.value = false;
  }
}

async function testTelegram() {
  tgBusy.value = true;
  tgMessage.value = null;
  try {
    const result = await api.testTelegram();
    tgMessage.value = result.sent
      ? { ok: true, text: 'נשלחה הודעת בדיקה.' }
      : { ok: false, text: result.error ?? 'השליחה נכשלה' };
  } finally {
    tgBusy.value = false;
  }
}

const detailOptions: Array<{ value: NotificationDetail; label: string; hint: string; sample: string }> = [
  {
    value: 'full',
    label: 'מלא',
    hint: 'שמות ספקים וסכומים',
    sample: '🛒 שופרסל דיל — ₪287',
  },
  {
    value: 'amounts',
    label: 'בלי שמות ספקים',
    hint: 'קטגוריות וסכומים בלבד',
    sample: '🛒 סופר וקניות לבית — ₪287',
  },
  {
    value: 'minimal',
    label: 'מינימלי',
    hint: 'סכומים כוללים ופסק דין בלבד',
    sample: 'יצאו ₪1,240 ב-6 תנועות',
  },
];

async function saveDetail(value: NotificationDetail) {
  settings.value = await api.updateSettings({ notificationDetail: value });
}

async function sendSummaryNow(kind: 'daily' | 'weekly' | 'monthly') {
  tgBusy.value = true;
  tgMessage.value = null;
  try {
    const result = await api.sendTelegramSummary(kind);
    tgMessage.value = result.sent
      ? { ok: true, text: 'נשלח.' }
      : { ok: false, text: result.error ?? 'השליחה נכשלה' };
  } finally {
    tgBusy.value = false;
  }
}

async function clearTelegram() {
  if (!confirm('לנתק את הבוט? ההתראות יפסיקו להישלח.')) return;
  await api.clearTelegram();
  tgMessage.value = null;
  await load();
}

async function saveAnchorDay(value: string) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 28) return;
  savingSettings.value = true;
  try {
    settings.value = await api.updateSettings({ cycleAnchorDay: day });
  } finally {
    savingSettings.value = false;
  }
}

async function refreshJob() {
  try {
    const status = await api.scrapeStatus();
    job.value = status.status === 'idle' ? null : status;
    if (status.status !== 'running') {
      stopPolling();
      if (status.status === 'done' || status.status === 'failed') await load();
    }
  } catch(e) {
    error.value='לא ניתן לבדוק את התקדמות המשיכה. '+String(e);stopPolling();
  }
}

function startPolling() {
  stopPolling();
  poll = setInterval(refreshJob, 1500);
}
function stopPolling() {
  if (poll) clearInterval(poll);
  poll = undefined;
}

onMounted(async () => {
  await load();
  // Arriving from the welcome screen ("connect your bank") opens the form.
  if (!settingsOnly && route.query.add) openAdd();
  await refreshJob();
  if (job.value?.status === 'running') startPolling();
});
onBeforeUnmount(stopPolling);

async function runScrape(companies: string[] = []) {
  try{job.value = await api.startScrape(companies);startPolling()}catch(e){error.value=String(e)}
}

// --- credential form ---
function openAdd() {
  isEditing.value = false;
  formCompany.value = '';
  formDisplayName.value = '';
  formValues.value = {};
  formError.value = null;
  formOpen.value = true;
}

function openEdit(connection: Connection) {
  isEditing.value = true;
  formCompany.value = connection.company;
  formDisplayName.value = connection.displayName;
  formValues.value = {};
  formError.value = null;
  formOpen.value = true;
}

function onProviderChange() {
  formValues.value = {};
  const provider = selectedProvider.value;
  if (provider && !formDisplayName.value) formDisplayName.value = provider.name;
}

async function saveConnection() {
  const provider = selectedProvider.value;
  if (!provider) {
    formError.value = 'בחרו ספק';
    return;
  }
  const missing = provider.loginFields.filter((f) => !formValues.value[f]?.trim());
  if (missing.length) {
    formError.value = `חסר: ${missing.join(', ')}`;
    return;
  }

  saving.value = true;
  formError.value = null;
  try {
    await api.saveConnection({
      company: provider.id,
      displayName: formDisplayName.value,
      credentials: formValues.value,
    });
    // Clear the typed secrets from memory as soon as they are sealed server-side.
    formValues.value = {};
    formOpen.value = false;
    await load();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function removeConnection(connection: Connection) {
  if (!confirm(`להסיר את החיבור ל${connection.displayName}?\nפרטי ההתחברות וה-session/cookies של הבנק יימחקו מהמחשב. התנועות שכבר נמשכו יישארו.`)) return;
  try{await api.removeConnection(connection.company);await load()}catch(e){error.value=String(e)}
}

async function setLifecycle(id:string,lifecycle:string){try{await api.updateAccount(id,{lifecycle:lifecycle as 'active'|'dormant'|'closed'});await load()}catch(e){error.value=String(e)}}

async function saveBillingDay(accountId: string, value: string) {
  const day = value === '' ? null : Number(value);
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) return;
  await api.updateAccount(accountId, { billingDay: day });
  await load();
}

async function renameAccount(accountId: string, current: string) {
  const name = prompt('שם החשבון:', current);
  if (!name || name === current) return;
  try{await api.updateAccount(accountId,{displayName:name});await load()}catch(e){error.value=String(e)}
}

async function deleteAccount(accountId: string, name: string, transactions: number) {
  if (!confirm(`למחוק את "${name}"?\n${transactions} תנועות יימחקו לצמיתות.`)) return;
  try{await api.deleteAccount(accountId);await load()}catch(e){error.value=String(e)}
}

/** Freshness of the last successful sync, in plain words. */
function freshness(scrapedAt: string | null): { label: string; color: string } {
  if (!scrapedAt) return { label: 'לא נמשך מעולם', color: 'var(--text-muted)' };
  const days = Math.floor((Date.now() - new Date(scrapedAt).getTime()) / 86_400_000);
  if (days === 0) return { label: 'עודכן היום', color: 'var(--status-good)' };
  if (days === 1) return { label: 'עודכן אתמול', color: 'var(--status-good)' };
  if (days <= 7) return { label: `עודכן לפני ${days} ימים`, color: 'var(--text-secondary)' };
  return { label: `עודכן לפני ${days} ימים`, color: 'var(--status-warning)' };
}
</script>

<template>
  <div class="space-y-5">
    <div class="page-heading">
      <div>
        <h1>{{settingsOnly?'הגדרות':'חשבונות וחיבורים'}}</h1>
        <p>{{settingsOnly?'מחזור תכנון, התראות וגיבוי.':'הבנקים וכרטיסי האשראי שמזינים את המערכת.'}}</p>
      </div>
      <div v-if="!settingsOnly" class="flex items-center gap-2">
        <button class="btn btn-ghost" :disabled="running || !data?.connections.length" @click="runScrape()">
          {{ running ? 'מושך…' : 'משיכה מכולם' }}
        </button>
        <button class="btn btn-primary" @click="openAdd">הוספת חיבור</button>
      </div>
    </div>

    <!-- With nothing connected, "no bank connected" in red is a scolding, not news. -->
    <SyncAlerts v-if="!settingsOnly && data?.connections.length" :issues="issues" />

    <div v-if="error" class="card p-4 text-sm" :style="{ color: 'var(--status-critical)' }">{{ error }}</div>

    <template v-if="!settingsOnly">
    <p v-if="loading" role="status" class="loading-line">טוען חשבונות…</p>
    <p v-if="data?.connections.length" class="section-hint">חשבון רדום אינו מייצר אזהרות על סנכרון חסר. חשבון סגור נשאר בהיסטוריה, אך יתרתו והתחייבויותיו אינן נכללות בתחזית היתרה.</p>
    <!-- live scrape progress -->
    <section v-if="job" class="card p-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="section-title">
          <span v-if="running" class="inline-block animate-pulse">●</span>
          {{ running ? 'משיכה רצה' : job.status === 'done' ? 'המשיכה הסתיימה' : 'המשיכה נכשלה' }}
        </h2>
        <button v-if="!running" class="btn btn-ghost !py-1 !text-xs" @click="job = null">סגור</button>
      </div>
      <details class="mt-3"><summary>פרטי המשיכה</summary><pre
        class="mt-2 max-h-48 overflow-y-auto rounded-lg p-3 text-xs leading-relaxed"
        :style="{ background: 'var(--surface-sunken)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }"
        dir="rtl"
        >{{ (job.log ?? []).join('\n') || 'ממתין…' }}</pre></details>
    </section>

    <!-- credential form -->
    <section v-if="formOpen" class="card p-5">
      <h2 class="section-title">{{ isEditing ? 'עדכון פרטי התחברות' : 'חיבור חדש' }}</h2>
      <p class="section-hint mt-1">
        הפרטים מוצפנים ב-DPAPI בשרת לפני שנשמרים, ולעולם לא נשלחים חזרה לדפדפן.
      </p>

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="text-sm">
          <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">ספק</span>
          <select v-model="formCompany" class="field w-full" :disabled="isEditing" @change="onProviderChange">
            <option value="">בחרו ספק…</option>
            <optgroup label="בנקים">
              <option v-for="p in data?.providers.filter((x) => x.type === 'bank')" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </optgroup>
            <optgroup label="כרטיסי אשראי">
              <option v-for="p in data?.providers.filter((x) => x.type === 'credit_card')" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </optgroup>
          </select>
        </label>

        <label class="text-sm">
          <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">שם לתצוגה</span>
          <input v-model="formDisplayName" class="field w-full" placeholder="למשל: עו״ש הפועלים" />
        </label>
      </div>

      <div v-if="selectedProvider" class="mt-3 grid gap-3 sm:grid-cols-2">
        <label v-for="field in selectedProvider.loginFields" :key="field" class="text-sm">
          <span class="mb-1 flex items-baseline justify-between gap-2" :style="{ color: 'var(--text-muted)' }"><span :style="{ color: 'var(--text-secondary)' }">{{ fieldLabel(field) }}</span><small v-if="fieldHint(field)">{{ fieldHint(field) }}</small></span>
          <input
            v-model="formValues[field]"
            class="field w-full"
            dir="ltr"
            :type="field.toLowerCase().includes('password') || field.includes('Token') ? 'password' : 'text'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </label>
      </div>

      <p v-if="formError" class="mt-3 text-sm" :style="{ color: 'var(--status-critical)' }">{{ formError }}</p>

      <div class="mt-4 flex items-center gap-2">
        <button class="btn btn-primary" :disabled="saving" @click="saveConnection">
          {{ saving ? 'מצפין ושומר…' : 'שמירה' }}
        </button>
        <button class="btn btn-ghost" :disabled="saving" @click="formOpen = false">ביטול</button>
      </div>
    </section>

    <p v-if="loading" class="py-10 text-center text-sm" :style="{ color: 'var(--text-muted)' }">טוען…</p>

    <section v-else-if="!data?.connections.length && !formOpen" class="empty-state connections-empty">
      <p class="empty-mark" aria-hidden="true">🏦 💳</p>
      <h2>עוד לא חיברתם אף חשבון</h2>
      <p>מומלץ להתחיל מחשבון הבנק — ממנו מגיעות היתרה, המשכורת והוראות הקבע — ואז להוסיף את כרטיסי האשראי לפירוט הקניות.</p>
      <button class="btn btn-primary mt-5" @click="openAdd">חיבור החשבון הראשון</button>
      <p class="empty-footnote">הסיסמאות מוצפנות במחשב הזה ולעולם לא נשלחות חזרה לדפדפן או לשרת חיצוני.</p>
    </section>

    <!-- provider cards -->
    <template v-for="group in [{ title: 'בנקים', items: banks }, { title: 'כרטיסי אשראי', items: cards }]" :key="group.title">
      <section v-if="group.items.length" class="space-y-3">
        <h2 class="section-title">{{ group.title }}</h2>

        <article v-for="c in group.items" :key="c.company" :id="c.company" class="card p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="font-semibold">
                <span class="me-1" aria-hidden="true">{{ c.type === 'bank' ? '🏦' : '💳' }}</span>
                {{ c.displayName }}
                <span class="text-sm font-normal" :style="{ color: 'var(--text-muted)' }">({{ c.company }})</span>
              </h3>
              <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                <span
                  class="chip"
                  :style="{
                    background: c.allEncrypted
                      ? 'color-mix(in srgb, var(--status-good) 14%, transparent)'
                      : 'color-mix(in srgb, var(--status-critical) 14%, transparent)',
                  }"
                >
                  {{ c.allEncrypted ? '🔒 סיסמאות מוצפנות' : '⚠️ סיסמאות בטקסט גלוי' }}
                </span>
                <span class="chip" :style="{ background: 'var(--surface-2)', color: 'var(--text-muted)' }">
                  {{ c.hasBrowserProfile ? '🖥️ פרופיל דפדפן שמור' : 'אין פרופיל — ייתכן אתגור OTP' }}
                </span>
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-1.5">
              <button class="btn btn-ghost" :disabled="running" @click="runScrape([c.company])">משיכה</button>
              <button class="btn btn-ghost" @click="openEdit(c)">עדכון סיסמה</button>
              <button class="btn btn-danger-ghost" @click="removeConnection(c)">הסרה</button>
            </div>
          </div>

          <!-- accounts produced by this provider -->
          <div v-if="c.accounts.length" class="mt-4 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-right" :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }">
                  <th scope="col" class="px-2 py-2 font-medium">חשבון</th>
                  <th scope="col" class="px-2 py-2 font-medium">תנועות</th>
                  <th scope="col" class="px-2 py-2 font-medium">טווח</th>
                  <th scope="col" class="px-2 py-2 font-medium">יתרה</th>
                  <th scope="col" class="px-2 py-2 font-medium">ממתין לחיוב</th>
                  <th scope="col" class="px-2 py-2 font-medium">מצב חשבון</th>
                  <th scope="col" class="px-2 py-2 font-medium">עדכון</th>
                  <th scope="col" class="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in c.accounts" :key="a.id" class="border-b last:border-0" :style="{ borderColor: 'var(--gridline)' }">
                  <td class="px-2 py-2">
                    <button class="text-start hover:underline" @click="renameAccount(a.id, a.displayName)">
                      {{ a.displayName }}
                    </button>
                    <span class="block text-xs" :style="{ color: 'var(--text-muted)' }">•••• {{ a.lastFour }}</span>
                  </td>
                  <td class="tnum px-2 py-2">{{ a.transactions }}</td>
                  <td class="px-2 py-2 text-xs" :style="{ color: 'var(--text-muted)' }">
                    <template v-if="a.firstTransaction">{{ a.firstTransaction }} → {{ a.lastTransaction }}</template>
                    <template v-else>—</template>
                  </td>
                  <td class="tnum px-2 py-2">{{ a.balance != null ? fmtILSRound(a.balance) : '—' }}<span class="block text-xs">{{a.balanceAt?new Date(a.balanceAt).toLocaleDateString('he-IL'):'ללא מועד יתרה'}}</span></td>
                  <td class="tnum px-2 py-2">{{ a.float > 0 ? fmtILSRound(a.float) : '—' }}</td>
                  <td class="px-2 py-2">
                    <select class="field !py-1 text-xs" :value="a.lifecycle" :aria-label="'מצב '+a.displayName" @change="setLifecycle(a.id,($event.target as HTMLSelectElement).value)"><option value="active">פעיל</option><option value="dormant">רדום</option><option value="closed">סגור</option></select>
                  </td>
                  <td class="px-2 py-2 text-xs" :style="{ color: freshness(a.scrapedAt).color }">
                    {{ freshness(a.scrapedAt).label }}
                  </td>
                  <td class="px-2 py-2 text-left">
                    <button
                      class="btn btn-danger-ghost !px-2 !text-xs"
                      @click="deleteAccount(a.id, a.displayName, a.transactions)"
                    >
                      מחיקה
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p v-else class="mt-3 text-sm" :style="{ color: 'var(--text-muted)' }">
            עוד לא נמשכו נתונים מהחיבור הזה. לחצו "משיכה".
          </p>
        </article>
      </section>
    </template>

    </template>
    <!-- cycle setting -->
    <section v-if="settingsOnly && settings" class="card p-5">
      <h2 class="section-title">מחזור התזרים</h2>
      <p class="section-hint mt-1">
        מאיזה יום בחודש נספר מחזור. ברירת המחדל היא חודש קלנדרי רגיל.
      </p>

      <div class="mt-3 flex flex-wrap items-end gap-3">
        <label class="text-sm">
          <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">יום פתיחת המחזור</span>
          <select
            class="field"
            :value="settings.cycleAnchorDay"
            :disabled="savingSettings"
            @change="saveAnchorDay(($event.target as HTMLSelectElement).value)"
          >
            <option :value="1">1 — חודש קלנדרי</option>
            <option v-for="d in 27" :key="d + 1" :value="d + 1">{{ d + 1 }} בחודש</option>
          </select>
        </label>
        <p class="pb-2 text-xs" :style="{ color: 'var(--text-muted)' }">
          <template v-if="settings.cycleAnchorDay === 1">
            כל חודש נמדד מה-1 עד סופו.
          </template>
          <template v-else>
            מחזור נפתח ב-{{ settings.cycleAnchorDay }} בחודש — שימושי אם המשכורת נכנסת אז.
          </template>
        </p>
      </div>
    </section>

    <!-- Telegram -->
    <section v-if="settingsOnly && settings" class="card p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="section-title">התראות בטלגרם</h2>
        <span
          class="chip"
          :style="{
            background: settings.telegramConfigured
              ? 'color-mix(in srgb, var(--status-good) 14%, transparent)'
              : 'var(--surface-2)',
            color: settings.telegramConfigured ? 'var(--text-primary)' : 'var(--text-muted)',
          }"
        >
          {{ settings.telegramConfigured ? '✅ מחובר' : 'לא מחובר' }}
        </span>
      </div>
      <p class="section-hint mt-1">
        סיכום יומי של ההוצאות, התראות תקציב, והודעה כשמשיכה נכשלת או שחסר חיבור.
      </p>

      <template v-if="settings.telegramConfigured">
        <!--
          Who gets it. Stated as a send list rather than as access, because
          that is exactly what it is and it is the first thing anyone wonders
          when they see another name next to their bank summary.
        -->
        <div class="mt-4 rounded-xl p-3.5" :style="{ background: 'var(--surface-sunken)' }">
          <h3 class="text-sm font-semibold">מי מקבל את ההודעות</h3>
          <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
            רשימת שליחה, לא רשימת גישה. הערוץ יוצא בלבד — אף אחד מהנמענים לא יכול לשלוח לכאן פקודה,
            לראות את הדשבורד או לשנות משהו. כולם מקבלים את אותה רמת פירוט שנבחרה למטה.
          </p>

          <ul class="mt-2.5 space-y-1.5">
            <li
              v-for="id in tgRecipients"
              :key="id"
              class="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
              :style="{ background: 'var(--surface-1)' }"
            >
              <span class="text-sm">
                <span aria-hidden="true">💬</span>
                <span class="tnum ms-1">{{ id }}</span>
              </span>
              <button
                class="btn btn-ghost !py-0.5 !text-xs"
                :disabled="tgBusy || tgRecipients.length <= 1"
                :title="tgRecipients.length <= 1 ? 'הנמען האחרון — השתמשו בניתוק' : 'הסרה'"
                @click="removeRecipient(id)"
              >
                הסרה
              </button>
            </li>
          </ul>

          <div class="mt-2.5 flex flex-wrap gap-2">
            <input
              v-model="tgNewRecipient"
              class="field min-w-40 grow"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              placeholder="מזהה צ׳אט של נמען נוסף"
            />
            <button class="btn btn-ghost shrink-0" :disabled="tgDetecting" @click="detectChat">
              {{ tgDetecting ? 'מחפש…' : 'מי כתב לבוט' }}
            </button>
            <button class="btn btn-primary shrink-0" :disabled="tgBusy || !tgNewRecipient.trim()" @click="addRecipient">
              הוספה
            </button>
          </div>

          <div v-if="tgCandidates.length > 0" class="mt-2 flex flex-wrap gap-2">
            <button
              v-for="c in tgCandidates"
              :key="c.id"
              class="btn btn-ghost !py-1 !text-xs"
              @click="tgNewRecipient = c.id"
            >
              {{ c.name }} ({{ c.id }})
            </button>
          </div>
          <p v-if="tgDetectHint" class="mt-2 text-xs" :style="{ color: 'var(--text-secondary)' }">
            {{ tgDetectHint }}
          </p>
          <p class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
            כדי להוסיף מישהו: שהוא יפתח את הבוט בטלגרם וישלח <span class="font-mono">/start</span>,
            ואז “מי כתב לבוט”. ההוספה נבדקת בשליחה אמיתית — אם היא לא מגיעה, הנמען לא נשמר.
          </p>
        </div>

        <!-- what actually leaves the machine -->
        <div class="mt-3 rounded-xl p-3.5" :style="{ background: 'var(--surface-sunken)' }">
          <h3 class="text-sm font-semibold">כמה מידע יוצא בהודעה</h3>
          <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">
            צ׳אטים רגילים בטלגרם <b>אינם</b> מוצפנים מקצה לקצה — ההודעות יושבות על שרתי טלגרם.
            זו הבחירה כמה מהחיים שלך נמצא שם.
          </p>
          <div class="mt-2.5 space-y-1.5">
            <label
              v-for="option in detailOptions"
              :key="option.value"
              class="flex cursor-pointer items-start gap-2.5 rounded-lg p-2 transition-colors"
              :style="{
                background: settings.notificationDetail === option.value ? 'var(--brand-soft)' : 'transparent',
              }"
            >
              <input
                type="radio"
                class="mt-1"
                :value="option.value"
                :checked="settings.notificationDetail === option.value"
                @change="saveDetail(option.value)"
              />
              <span class="min-w-0">
                <span class="block text-sm font-semibold">{{ option.label }}</span>
                <span class="block text-xs" :style="{ color: 'var(--text-muted)' }">{{ option.hint }}</span>
                <code class="mt-0.5 block text-xs" :style="{ color: 'var(--text-secondary)' }">{{ option.sample }}</code>
              </span>
            </label>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button class="btn btn-ghost" :disabled="tgBusy" @click="testTelegram">שליחת בדיקה</button>
          <button class="btn btn-ghost" :disabled="tgBusy" @click="sendSummaryNow('daily')">סיכום יומי</button>
          <button class="btn btn-ghost" :disabled="tgBusy" @click="sendSummaryNow('weekly')">שבועי</button>
          <button class="btn btn-ghost" :disabled="tgBusy" @click="sendSummaryNow('monthly')">חודשי</button>
          <button class="btn btn-danger-ghost" :disabled="tgBusy" @click="clearTelegram">ניתוק</button>
        </div>

        <p class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
          אוטומטית: חודשי ב-1 בחודש, שבועי בימי ראשון, יומי בשאר הימים.
        </p>
      </template>

      <template v-else>
        <ol class="mt-3 space-y-1 text-sm" :style="{ color: 'var(--text-secondary)' }">
          <li>
            1. פתחו צ׳אט עם
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" class="font-mono underline">@BotFather</a>
            ושלחו <span class="font-mono">/newbot</span>. הוא ישאל שם, וייתן טוקן.
          </li>
          <li>2. הדביקו את הטוקן כאן למטה.</li>
          <li>3. פתחו את הבוט החדש שלכם בטלגרם ושלחו לו <span class="font-mono">/start</span>.</li>
          <li>4. לחצו “זהה אותי” — המספר יתמלא לבד.</li>
        </ol>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <label class="text-sm">
            <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">Bot token</span>
            <input
              v-model="tgToken"
              class="field w-full"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="123456:ABC-DEF…"
            />
          </label>
          <label class="text-sm">
            <span class="mb-1 block" :style="{ color: 'var(--text-muted)' }">
              Chat ID
              <span :style="{ color: 'var(--text-muted)' }">— אין צורך לחפש אותו</span>
            </span>
            <div class="flex gap-2">
              <input v-model="tgChatId" class="field w-full" autocomplete="off" spellcheck="false" placeholder="ייתמלא אוטומטית" />
              <button class="btn btn-ghost shrink-0" :disabled="tgDetecting || !tgToken.trim()" @click="detectChat">
                {{ tgDetecting ? 'מחפש…' : 'זהה אותי' }}
              </button>
            </div>
          </label>
        </div>

        <!-- More than one person messaged the bot; picking is safer than guessing. -->
        <div v-if="tgCandidates.length > 1" class="mt-2 flex flex-wrap gap-2">
          <button
            v-for="c in tgCandidates"
            :key="c.id"
            class="btn btn-ghost !py-1 !text-xs"
            @click="tgChatId = c.id"
          >
            {{ c.name }} ({{ c.id }})
          </button>
        </div>
        <p v-if="tgDetectHint" class="mt-2 text-xs" :style="{ color: 'var(--text-secondary)' }">
          {{ tgDetectHint }}
        </p>

        <button class="btn btn-primary mt-3" :disabled="tgBusy" @click="saveTelegram">
          {{ tgBusy ? 'שומר…' : 'שמירה ובדיקה' }}
        </button>
      </template>

      <p
        v-if="tgMessage"
        class="mt-3 text-sm"
        :style="{ color: tgMessage.ok ? 'var(--delta-up)' : 'var(--status-critical)' }"
      >
        {{ tgMessage.ok ? '✅' : '⚠️' }} {{ tgMessage.text }}
      </p>

      <p class="mt-3 border-t pt-3 text-xs" :style="{ borderColor: 'var(--gridline)', color: 'var(--text-muted)' }">
        הטוקן מוצפן ב-DPAPI כמו שאר הסיסמאות ולא נשלח חזרה לדפדפן. ההודעות עוברות דרך שרתי טלגרם —
        הסיכומים חושפים דפוסי הוצאות, וזה tradeoff מודע.
      </p>
    </section>

    <!-- Encrypted off-machine backup -->
    <section v-if="settingsOnly && backup" class="card p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="section-title">גיבוי מוצפן</h2>
        <span class="chip">{{ backup.configured ? `✅ פעיל · ${backup.count} עותקים` : '⚠️ לא מוגדר' }}</span>
      </div>
      <p class="section-hint mt-1">
        שומר עותק מוצפן של המידע, שניתן לשחזר בעת הצורך. עדיף לבחור OneDrive, כונן חיצוני או תיקיית רשת — לא תיקייה בתוך MyLedger.
      </p>

      <template v-if="!backup.configured">
        <div class="mt-3 flex flex-wrap gap-2">
          <input v-model="backupDestination" class="field min-w-72 grow" placeholder="C:\Users\...\OneDrive\MyLedger Backups" />
          <button class="btn btn-primary" :disabled="backupBusy || !backupDestination" @click="prepareBackup">הגדרת גיבוי</button>
        </div>
        <div v-if="backupSetup" class="mt-3 rounded-xl border p-4" :style="{ borderColor: 'var(--status-warning)' }">
          <p class="text-sm font-semibold">שמור עכשיו את משפט השחזור במנהל סיסמאות:</p>
          <code class="mt-2 block select-all rounded-lg p-3 text-sm" dir="ltr" :style="{ background: 'var(--surface-sunken)' }">{{ backupSetup.passphrase }}</code>
          <p class="mt-2 text-xs" :style="{ color: 'var(--text-muted)' }">
            הוא מוצג פעם אחת. בלעדיו אי אפשר לפתוח גיבוי אחרי אובדן המחשב.
            <template v-if="backupSetup.sameDrive"> התיקייה באותו כונן — היא מגינה ממחיקה, אך לא מתקלה פיזית בדיסק.</template>
          </p>
          <button class="btn btn-primary mt-3" :disabled="backupBusy" @click="confirmBackup">שמרתי — צור ואמת גיבוי ראשון</button>
        </div>
      </template>
      <template v-else>
        <p class="mt-3 text-sm"><span class="font-semibold">יעד:</span> <span dir="ltr">{{ backup.destination }}</span></p>
        <p class="mt-1 text-xs" :style="{ color: 'var(--text-muted)' }">החדש ביותר: {{ backup.newest ?? 'טרם נוצר' }}</p>
        <button class="btn btn-ghost mt-3" :disabled="backupBusy" @click="runBackup">גיבוי עכשיו</button>
      </template>
      <p v-if="backupMessage" class="mt-2 text-sm">{{ backupMessage }}</p>
    </section>

    <!-- accounts whose provider was removed from the config -->
    <section v-if="!settingsOnly && data?.orphanAccounts.length" class="card p-5">
      <h2 class="section-title">חשבונות בלי חיבור פעיל</h2>
      <p class="section-hint mt-1">
        הנתונים שלהם נשארו במערכת, אבל אין להם ספק מוגדר — הם לא יתעדכנו יותר.
      </p>
      <ul class="mt-3 space-y-2">
        <li
          v-for="a in data.orphanAccounts"
          :key="a.id"
          class="flex items-center justify-between gap-3 text-sm"
        >
          <span>{{ a.displayName }} <span :style="{ color: 'var(--text-muted)' }">({{ a.institution }} •••• {{ a.lastFour }})</span></span>
          <button class="btn btn-danger-ghost" @click="deleteAccount(a.id, a.displayName, 0)">מחיקה</button>
        </li>
      </ul>
    </section>
  </div>
</template>
