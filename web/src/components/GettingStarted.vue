<script setup lang="ts">
/**
 * First run: what a fresh install shows instead of a dashboard of dashes.
 *
 * Every number in this system is derived from connected accounts, so before
 * the first sync there is nothing true to show - and a hero figure of "—" with
 * "we'll check the data sources" reads as broken rather than as new. This is
 * the one screen where the right content is instructions, in order, each step
 * ticking itself off from real state rather than from a "done" button.
 */
import { computed, onMounted, ref } from 'vue';
import { api, type ConnectionsResponse, type Meta } from '../lib/api';

const connections = ref<ConnectionsResponse | null>(null);
const meta = ref<Meta | null>(null);
onMounted(async () => {
  const [c, m] = await Promise.allSettled([api.connections(), api.meta()]);
  if (c.status === 'fulfilled') connections.value = c.value;
  if (m.status === 'fulfilled') meta.value = m.value;
});

const list = computed(() => connections.value?.connections ?? []);
const steps = computed(() => [
  {
    title: 'חברו את חשבון הבנק',
    body: 'היתרה, המשכורת והוראות הקבע מגיעות מהבנק. בלעדיו אין תזרים — רק רשימת קניות.',
    done: list.value.some((c) => c.type === 'bank'),
    to: { path: '/connections', query: { add: 'bank' } },
    action: 'חיבור בנק',
  },
  {
    title: 'הוסיפו את כרטיסי האשראי',
    body: 'הבנק רואה רק שורת חיוב אחת בחודש. הכרטיסים מוסיפים את הפירוט — על מה הלך הכסף.',
    done: list.value.some((c) => c.type === 'credit_card'),
    to: { path: '/connections', query: { add: 'card' } },
    action: 'חיבור כרטיס',
  },
  {
    title: 'הריצו משיכה ראשונה',
    body: 'המשיכה הראשונה עמוקה ולוקחת כמה דקות. אם האתר מבקש קוד SMS, התחברו פעם אחת ידנית עם הפקודה הזו, והמכשיר ייזכר מאז:',
    code: 'npm run login -- <ספק>',
    done: list.value.some((c) => c.accounts.some((a) => a.transactions > 0)),
    to: '/connections',
    action: 'למשיכה',
  },
  {
    title: 'סווגו את מה שנשאר',
    body: 'קטגוריות וחוקים לרשתות המוכרות כבר מוכנים. בתור "לטיפול" מסווגים את השאר — החלטה אחת לכל בית עסק.',
    done: false,
    to: '/review',
    action: 'לתור הטיפול',
  },
]);
const next = computed(() => steps.value.findIndex((s) => !s.done));
</script>

<template>
  <section class="welcome" aria-labelledby="welcome-title">
    <div class="welcome-hero">
      <p class="eyebrow">התחלה</p>
      <h1 id="welcome-title">ברוכים הבאים ל-MyLedger</h1>
      <p>התזרים שלכם — כמה נשאר להוציא עד סוף החודש, מה עוד צפוי לרדת ומה כבר הוצא באשראי — מחושב על המחשב שלכם, מהבנק ומהכרטיסים שלכם.</p>
    </div>

    <p v-if="meta && !meta.canStoreCredentials" class="notice notice-warning">
      הצפנת הסיסמאות נשענת כרגע על Windows (DPAPI). במערכת הפעלה אחרת אפשר לעיין בנתוני הדגמה, אבל לא לחבר חשבון אמיתי.
    </p>

    <ol class="welcome-steps">
      <li v-for="(step, i) in steps" :key="step.title" :class="{ done: step.done, current: i === next }">
        <span class="step-mark" aria-hidden="true">{{ step.done ? '✓' : i + 1 }}</span>
        <div>
          <h2>{{ step.title }} <span v-if="step.done" class="sr-only">(בוצע)</span></h2>
          <p>{{ step.body }} <code v-if="step.code" class="inline-code">{{ step.code }}</code></p>
        </div>
        <RouterLink v-if="!step.done" :to="step.to" class="btn" :class="i === next ? 'btn-primary' : 'btn-ghost'">{{ step.action }} ←</RouterLink>
      </li>
    </ol>

    <div class="welcome-privacy">
      <h2>מה קורה עם המידע</h2>
      <ul>
        <li><b>נשאר במחשב.</b> אין שרת ענן ואין חשבון משתמש — הנתונים יושבים בקובץ מקומי.</li>
        <li><b>סיסמאות מוצפנות.</b> הן נאטמות בהצפנת Windows של המשתמש שלכם, ולא נשלחות חזרה לדפדפן.</li>
        <li><b>רק אתם ניגשים.</b> הממשק זמין רק מהמחשב הזה (127.0.0.1), לא מהרשת.</li>
      </ul>
      <p class="welcome-demo">רוצים רק להסתכל קודם? <code>npm run seed</code> טוען משק בית לדוגמה.</p>
    </div>
  </section>
</template>

<style scoped>
.welcome { max-width: 820px; margin: auto; display: grid; gap: 24px; }
.welcome-hero { background: var(--hero); color: var(--hero-ink); border-radius: 32px; padding: 38px; }
.welcome-hero h1 { font-size: clamp(30px, 4.4vw, 44px); font-weight: 750; letter-spacing: -1px; line-height: 1.2; }
.welcome-hero p:not(.eyebrow) { font-size: 17px; line-height: 1.8; margin-top: 14px; max-width: 620px; color: var(--hero-muted); }
.welcome-hero .eyebrow { color: var(--hero-muted); }
.welcome-steps { background: var(--surface-1); border-radius: 26px; padding: 8px 30px; }
.welcome-steps li { display: flex; align-items: center; gap: 18px; padding: 22px 0; border-bottom: 1px solid var(--border); }
.welcome-steps li:last-child { border-bottom: 0; }
.welcome-steps li > div { flex: 1; min-width: 0; }
.welcome-steps h2 { font-size: 16px; font-weight: 700; }
.welcome-steps p { font-size: 13px; line-height: 1.8; color: var(--text-muted); margin-top: 4px; }
.welcome-steps .btn { flex-shrink: 0; }
.inline-code { background: var(--surface-2) !important; font-size: 12px; white-space: nowrap; }
.step-mark { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; font-weight: 700; font-size: 14px; border: 1px solid var(--border); color: var(--text-muted); }
.current .step-mark { background: var(--text-primary); color: var(--page); border-color: transparent; }
.done .step-mark { background: var(--mint); color: var(--status-good); border-color: transparent; }
.done h2 { color: var(--text-muted); text-decoration: line-through; text-decoration-thickness: 1px; }
.welcome-privacy { background: var(--mint); border-radius: 26px; padding: 26px 30px; }
.welcome-privacy h2 { font-size: 15px; font-weight: 700; }
.welcome-privacy ul { margin-top: 12px; display: grid; gap: 8px; font-size: 13px; line-height: 1.7; color: var(--text-secondary); }
.welcome-privacy b { color: var(--text-primary); }
.welcome-demo { margin-top: 16px; font-size: 12px; color: var(--text-muted); }
.inline-code, .welcome-demo code { direction: ltr; unicode-bidi: isolate; background: var(--surface-1); padding: 2px 7px; border-radius: 6px; }
@media (max-width: 700px) {
  .welcome-hero { padding: 26px 22px; border-radius: 26px; }
  .welcome-steps { padding: 4px 18px; }
  .welcome-steps li { flex-wrap: wrap; align-items: flex-start; }
  .welcome-steps .btn { width: 100%; }
  .welcome-privacy { padding: 22px 20px; }
}
</style>
