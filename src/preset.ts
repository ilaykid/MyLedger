/**
 * Israeli merchant rule preset. Applied automatically on the first start of a
 * fresh install; `npm run rules:preset` re-applies it.
 *
 * A starting taxonomy: a dozen categories and the national chains and generic
 * keywords that land in each. It is meant to cover the obvious majority on day
 * one; the long tail (your local bakery, your kids' after-school club) is what
 * the review queue, "classify every charge from this merchant" and the optional
 * local model are for.
 *
 * Idempotent: adds any missing category or rule and leaves existing ones alone,
 * so it is safe to re-run. Finishes by applying the rules and re-running
 * recurring detection.
 *
 * Patterns use "contains" wherever possible - it is easier to read and safer
 * than regex against provider descriptions, which are inconsistently spaced and
 * often carry a branch name.
 */
import { prisma } from './db.js';
import { applyCategoryRules } from './categorize.js';
import { detectRecurring } from './recurring.js';

type Kind =
  | 'fixed'
  | 'variable'
  | 'income_fixed'
  | 'income_variable'
  | 'transfer'
  | 'excluded'
  | 'savings';

/**
 * Kinds written by earlier versions, and what they become. Applied to every
 * category, not just the ones this preset owns, so a category created by hand
 * is migrated too.
 *
 * `income` becomes `income_variable` rather than `income_fixed`: for a category
 * we know nothing about, the class that promises less is the safe one. The
 * preset then upgrades the ones it does know about (salary, allowances).
 */
const KIND_MIGRATIONS: Record<string, Kind> = {
  income: 'income_variable',
  oneoff: 'excluded',
};

interface CategorySpec {
  name: string;
  color: string;
  icon: string;
  kind: Kind;
  budget?: number; // shekels
  patterns: Array<string | RegExp>;
  priority?: number;
}

// Colours are the validated 8-slot categorical palette; repeats are fine because
// every row in the UI is labelled with its name, never colour alone.
const B = '#2a78d6';
const O = '#eb6834';
const A = '#1baf7a';
const Y = '#eda100';
const M = '#e87ba4';
const G = '#008300';
const V = '#4a3aa7';
const N = '#8a8a94';

const PRESET: CategorySpec[] = [
  // --------------------------------------------------------------- one-off
  {
    // The single home for anything real that should not touch the cash flow:
    // a mortgage prepayment, an investment withdrawal, a loan drawdown, a large
    // gift. No patterns - these are rare, large and personal, so they are
    // decided by hand (the review queue asks about them).
    name: 'לא תזרימי',
    color: V,
    icon: '⚡',
    kind: 'excluded',
    priority: 40,
    patterns: [],
  },

  // --------------------------------------------------------------- savings
  {
    // An outgoing that leaves you better off. Its own kind so the dashboard can
    // subtract it from "left to spend" and still report it as the win it is.
    name: 'הפקדה לחיסכון',
    color: A,
    icon: '🐷',
    kind: 'savings',
    priority: 35,
    patterns: ['הפקדה לחסכון', 'הפקדה לחיסכון', 'חיסכון', 'חסכון', 'קרן השתלמות', 'גמל להשקעה', 'פיקדון'],
  },

  // ---------------------------------------------------------------- fixed
  {
    name: 'דיור וחשבונות',
    color: Y,
    icon: '🏠',
    kind: 'fixed',
    priority: 20,
    patterns: [
      'עיריית', 'ארנונה', 'מפעל מים', 'תאגיד המים', 'חברת החשמל', 'חשמל לישראל',
      'פזגז', 'סופרגז', 'אמישראגז',
      'פרטנר', 'סלקום', 'בזק', 'הוט', 'גולן טלקום', 'רמי לוי תקשורת', 'yes ', '019',
      'אגרת', 'רשות המסים',
    ],
  },
  {
    name: 'ביטוחים',
    color: V,
    icon: '🛡️',
    kind: 'fixed',
    priority: 20,
    patterns: ['מגדל', 'הראל', 'כלל ביטוח', 'מנורה', 'איילון', 'הפניקס', 'שלמה ביטוח', 'ביטוח ישיר', 'ביטוח', 'AIG'],
  },
  {
    name: 'חינוך וילדים',
    color: M,
    icon: '🎒',
    kind: 'fixed',
    priority: 20,
    patterns: ['מעונות', 'מעון', 'גן ילדים', 'צהרון', 'חוגים', 'בית ספר', 'שילב', 'צעצועים'],
  },
  {
    name: 'פנאי ונסיעות',
    color: G,
    icon: '🎬',
    kind: 'fixed',
    priority: 20,
    patterns: [
      'NETFLIX', 'נטפליקס', 'SPOTIFY', 'ספוטיפיי', 'Disney Plus', 'YOUTUBE', 'APPLE.COM', 'GOOGLE', 'גוגל',
      'הולמס פלייס', 'סינמה סיטי', 'יס פלנט',
      'BOOKING.COM', 'BOOKING BV', 'AIRBNB', 'AIRPORT', 'נתב"ג', 'דיוטי פרי',
      'אל על', 'ISRAIR', 'ישראייר', 'ARKIA', 'ארקיע', 'טיסה', 'מלון',
    ],
  },
  {
    // Insurance lives in "ביטוחים"; this is the car itself plus getting around.
    name: 'רכב ותחבורה',
    color: A,
    icon: '🚗',
    kind: 'variable',
    budget: 800,
    priority: 15,
    // NOT a bare 'ביטוח' pattern: it would swallow home and life insurance into
    // the car category. Anything insurance-shaped belongs in "ביטוחים".
    patterns: [
      'רשיונות רכב', 'מוסך', 'צמיגים', 'טסט', 'חניון', 'הלוואה לרכב',
      'פז ', 'סונול', 'דור אלון', 'דלק', 'TEN ',
      'רב-פס', 'רב קו', 'פנגו', 'סלופארק', 'מ.תחבורה', 'כביש 6', 'כביש אגרה',
    ],
  },

  // ------------------------------------------------------------- variable
  {
    name: 'סופר וקניות לבית',
    color: B,
    icon: '🛒',
    kind: 'variable',
    budget: 3000,
    priority: 10,
    patterns: [
      'שופרסל', 'רמי לוי', 'ויקטורי', 'יוחננוף', 'אושר עד', 'טיב טעם', 'מחסני השוק', 'חצי חינם',
      'יינות ביתן', 'קרפור', 'CARREFOUR', 'מגה בעיר', 'יוניברס', 'פרש מרקט', 'AM:PM', 'מינימרקט',
      'ירקות', 'פירות',
    ],
  },
  {
    name: 'בריאות ופארם',
    color: M,
    icon: '💊',
    kind: 'variable',
    budget: 600,
    priority: 10,
    patterns: [
      // Providers spell the same chain several ways; each spelling is a rule.
      'סופר פארם', 'סופר-פארם', 'סופרפארם', 'גוד פארם', 'ניו פארם', 'דראגסטורס',
      'בית מרקחת', 'כללית', 'מכבי', 'מאוחדת', 'לאומית', 'קופ"ח', 'רופא', 'מרפאת', 'אופטיק',
      'נקודת טבע', 'חנויות טבע',
    ],
  },
  {
    name: 'מסעדות ואוכל בחוץ',
    color: O,
    icon: '🍽️',
    kind: 'variable',
    budget: 1500,
    priority: 10,
    patterns: [
      'WOLT', 'וולט', 'תן ביס', '10BIS',
      'פיצה', 'דומינוס', 'מקדונלדס', 'בורגר', 'סושי', 'מסעדת', 'שווארמה', 'פלאפל',
      'ארומה', 'קפה קפה', 'לנדוור', 'קפה גרג', 'רולדין', 'בייקרי', 'מאפיית', 'קונדיטוריה', 'גלידה',
    ],
  },
  {
    name: 'ביגוד וביוטי',
    color: Y,
    icon: '🛍️',
    kind: 'variable',
    budget: 1000,
    priority: 10,
    patterns: [
      'זארה', 'ZARA', 'קסטרו', 'H&M', 'טרמינל X', 'פוקס', 'רנואר', 'אמריקן איגל', 'גולף', 'עדיקה',
      'אורבניקה', 'דלתא', 'מקס סטוק', 'דקטלון', 'BBW', 'סקארה', 'MAKEUP', 'הנעלה',
    ],
  },
  {
    name: 'בית וחשמל',
    color: N,
    icon: '🏡',
    kind: 'variable',
    budget: 700,
    priority: 10,
    patterns: [
      'מחסני חשמל', 'KSP', 'קיי.אס.פי', 'באג', 'iDigital', 'אלקטרו', 'שקם אלקטריק', 'מחשבים',
      'איקאה', 'IKEA', 'ACE ', 'הום סנטר', 'פליינג טייגר', 'ורדינון', 'כלי בית',
    ],
  },
  {
    name: 'צדקה ותרומות',
    color: M,
    icon: '🤲',
    kind: 'variable',
    priority: 15,
    patterns: ['עמותת', 'תרומה', 'תרומות'],
  },
  {
    name: 'מזומן ושונות',
    color: V,
    icon: '💵',
    kind: 'variable',
    budget: 700,
    priority: 10,
    patterns: ['משיכת מזומן', 'כספומט', 'העברה ב BIT', 'ביט ', 'PAYBOX', 'פייבוקס'],
  },
  {
    name: 'עמלות ודמי כרטיס',
    color: N,
    icon: '🧮',
    kind: 'fixed',
    priority: 25,
    patterns: ['דמי כרטיס', 'עמלת', 'דמי ניהול', 'ריבית'],
  },

  // ---------------------------------------------------------------- income
  // Split because "did money arrive" and "can I plan on it arriving again" are
  // different questions. A month carried by a bonus and a tax refund is not the
  // same month as one carried by salary, even at the same total.
  {
    name: 'משכורת וקצבאות',
    color: '#0ca30c',
    icon: '💰',
    kind: 'income_fixed',
    priority: 30,
    patterns: ['משכורת', 'קצבת ילדים', 'קצבת זקנה'],
  },
  {
    name: 'הכנסות משתנות',
    color: '#5aa02c',
    icon: '📈',
    kind: 'income_variable',
    priority: 30,
    patterns: ['החזר מס הכנסה', 'מס-הכנסה החזרים', 'מילואים'],
  },

  // -------------------------------------------------------------- transfer
  {
    name: 'העברות וחיובי אשראי',
    color: N,
    icon: '🔁',
    kind: 'transfer',
    priority: 30,
    patterns: [
      // Every wording a real Israeli bank statement uses for "your card was
      // settled". Each bank words it differently and several use the issuer's
      // corporate name with no hint that it is a card at all - "מקס איט
      // פיננסים" is Max. Missing one means those purchases are counted twice:
      // once on the card, once here.
      'חיוב כרטיס אשראי',
      'כ.אשראי',
      'לאומי קארד',
      'מסב-כ.אשראי',
      'ישראכרט',
      'מקס איט',
      'הרשאה כאל',
      'כאל בע"מ',
      'דיינרס',
      'אמריקן אקספרס',
      'ויזה כ.א.ל',
      // Loading a prepaid card moves money, it does not spend it. The spending
      // shows up separately when that card's own provider is connected - counting
      // both would double it.
      'כרטיס נטען',
      'טעינת כרטיס',
      // Explicitly account-to-account; the counterparty is another account of
      // yours, so nothing was consumed.
      'העברה לח.נוסף',
      'העברה מחשבון לחשבון',
    ],
  },
  {
    // Loan principal and pension contributions are committed monthly outflows.
    // They are not discretionary, so leaving them as "variable" inflates what
    // the dashboard says you are free to spend.
    name: 'הלוואות וחיסכון',
    color: V,
    icon: '🏦',
    kind: 'fixed',
    priority: 22,
    patterns: [
      'הלוואה - תשלום', 'הלואה-תשלום', 'תשלום קרן',
      'אלטשולר שחם', 'מיטב', 'פסגות', 'ילין לפידות', 'אנליסט', 'כלל פנסיה', 'הראל פנסיה',
      'גמל', 'השתלמות',
    ],
  },
];

/**
 * Bring category kinds onto the current vocabulary, so that everything
 * downstream reasons about one set of names.
 */
async function migrateKinds(): Promise<number> {
  let migrated = 0;
  for (const [from, to] of Object.entries(KIND_MIGRATIONS)) {
    const { count } = await prisma.category.updateMany({
      where: { kind: from },
      data: { kind: to },
    });
    if (count) {
      console.log(`  ${from} → ${to}  (${count} categories)`);
      migrated += count;
    }
  }
  return migrated;
}

export interface PresetResult {
  categoriesCreated: number;
  categoriesUpdated: number;
  rulesCreated: number;
  rulesSkipped: number;
}

/**
 * Create or refresh the preset categories and rules. Existing categories get
 * the preset's kind, colour and icon; rules are only ever added.
 */
export async function applyPreset(log: (line: string) => void = () => {}): Promise<PresetResult> {
  const migratedKinds = await migrateKinds();
  log(migratedKinds === 0 ? 'Category kinds already current' : `${migratedKinds} categories migrated`);

  let categoriesCreated = 0;
  let categoriesUpdated = 0;
  let rulesCreated = 0;
  let rulesSkipped = 0;

  for (const spec of PRESET) {
    const existing = await prisma.category.findUnique({ where: { name: spec.name } });
    const data = {
      color: spec.color,
      icon: spec.icon,
      kind: spec.kind,
      monthlyBudget: spec.budget != null ? Math.round(spec.budget * 100) : undefined,
    };

    const category = existing
      ? await prisma.category.update({ where: { id: existing.id }, data })
      : await prisma.category.create({ data: { name: spec.name, ...data } });

    if (existing) categoriesUpdated++;
    else categoriesCreated++;

    for (const pattern of spec.patterns) {
      const isRegex = pattern instanceof RegExp;
      const patternText = isRegex ? pattern.source : pattern;
      const already = await prisma.categoryRule.findFirst({ where: { pattern: patternText } });
      if (already) {
        rulesSkipped++;
        continue;
      }
      await prisma.categoryRule.create({
        data: {
          pattern: patternText,
          matchType: isRegex ? 'regex' : 'contains',
          priority: spec.priority ?? 10,
          categoryId: category.id,
        },
      });
      rulesCreated++;
    }
  }

  log(`Categories: ${categoriesCreated} created, ${categoriesUpdated} updated`);
  log(`Rules: ${rulesCreated} created, ${rulesSkipped} already present`);

  if (await prisma.transaction.count()) {
    const stats = await applyCategoryRules({ recategorize: true });
    log(`Rules applied: scanned ${stats.scanned}, categorized ${stats.categorized}`);
    const rec = await detectRecurring();
    log(`${rec.detected} recurring items from ${rec.groupsConsidered} merchant groups`);
  }
  return { categoriesCreated, categoriesUpdated, rulesCreated, rulesSkipped };
}

/**
 * First start of a fresh install: an empty category list makes every screen
 * useless (nothing can be classified, the review queue has nothing to offer),
 * and the fix used to be a terminal command nobody knew about. Only runs when
 * there are no categories at all, so it never touches a curated setup.
 */
export async function ensureStarterCategories(): Promise<boolean> {
  if ((await prisma.category.count()) > 0) return false;
  await applyPreset();
  return true;
}
