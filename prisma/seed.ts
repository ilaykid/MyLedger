/**
 * Demo data seeder.
 *
 * Models a realistic Israeli household living close to the edge - which is
 * exactly the situation a cash-flow tool has to handle well. Income arrives on
 * the 9th (so the cash-flow cycle is the 9th to the 8th), fixed commitments eat
 * most of it, and credit-card purchases settle weeks after they are made.
 *
 * The card float is genuine: every card purchase carries the processedDate on
 * which it will actually be debited, and a matching bank settlement transaction
 * is created only once that date has passed. So "spent but not yet debited" is
 * real in the data rather than simulated.
 *
 * Deterministic (seeded PRNG) - re-runs produce identical data. Wipes first.
 * Run: npm run seed
 */
import { prisma } from '../src/db.js';
import { assignOccurrences, normalizeDescription, toDateISO } from '../src/dedup.js';
import { applyCategoryRules } from '../src/categorize.js';
import { detectRecurring } from '../src/recurring.js';
import { CATEGORY_KINDS } from '../src/cashflow.js';

// --- deterministic PRNG (mulberry32) ---
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260730);
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

/** shekels -> agorot */
const ILS = (shekels: number) => Math.round(shekels * 100);

const ANCHOR_DAY = 9; // main payday - defines the cash-flow cycle
const MONTHS_BACK = 8;
/**
 * The bank balance the demo should end up showing "today". The opening balance
 * is derived from it, so the dashboard's reconstructed timeline lands exactly on
 * this figure.
 */
const TARGET_CURRENT_BALANCE = ILS(7_400);

interface DemoTxn {
  date: Date;
  processedDate?: Date;
  description: string;
  amount: number;
  status?: 'pending' | 'completed';
  installments?: { number: number; total: number };
  memo?: string;
}

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

function dayOfMonth(monthStart: Date, day: number): Date {
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
  return new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(day, daysInMonth), 12);
}

/**
 * Israeli credit cards bill in arrears: purchases made in month M are all
 * debited together on the card's billing day of month M+1.
 */
function chargeDateFor(purchase: Date, billingDay: number): Date {
  const raw = purchase.getMonth() + 1;
  const year = purchase.getFullYear() + Math.floor(raw / 12);
  const monthIndex = ((raw % 12) + 12) % 12;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(billingDay, daysInMonth), 12);
}

/** The three accounts this seeder creates. Anything else in the DB is real. */
const DEMO_ACCOUNTS = new Set(['hapoalim:4471', 'max:5216', 'isracard:8830']);

/**
 * This seeder wipes the database. Once real accounts are connected that would
 * destroy actual financial history that cannot be re-scraped for closed
 * periods - so refuse unless the data is recognisably demo data.
 */
async function guardAgainstWipingRealData() {
  const accounts = await prisma.account.findMany({ select: { institution: true, lastFour: true, displayName: true } });
  const real = accounts.filter((a) => !DEMO_ACCOUNTS.has(`${a.institution}:${a.lastFour}`));
  if (real.length === 0) return;

  if (process.argv.includes('--force')) {
    console.warn(`WARNING: --force given; wiping ${real.length} real account(s) too.\n`);
    return;
  }

  const txnCount = await prisma.transaction.count();
  console.error(
    `\nRefusing to seed: the database holds real scraped accounts.\n\n` +
      real.map((a) => `  - ${a.displayName} (${a.institution} ****${a.lastFour})`).join('\n') +
      `\n\nSeeding deletes ALL ${txnCount} transactions, including these. If you really want to\n` +
      `replace everything with demo data, run:  npm run seed -- --force\n`,
  );
  process.exit(1);
}

async function main() {
  await guardAgainstWipingRealData();

  console.log('Wiping existing data...');
  await prisma.recurringExpense.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.categoryRule.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();

  await prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, cycleAnchorDay: ANCHOR_DAY, forecastLookbackCycles: 3 },
    update: { cycleAnchorDay: ANCHOR_DAY, forecastLookbackCycles: 3 },
  });

  // ---------------------------------------------------------------- categories
  // `kind` is the axis the whole dashboard turns on: fixed commitments are
  // forecast, variable spending is what the user actually steers.
  console.log('Creating categories...');
  const cat = (
    name: string,
    color: string,
    icon: string,
    kind: (typeof CATEGORY_KINDS)[number],
    monthlyBudget: number | null = null,
  ) => prisma.category.create({ data: { name, color, icon, kind, monthlyBudget } });

  // Colors come from the validated 8-slot categorical palette.
  const cRent = await cat('שכר דירה', '#2a78d6', '🏠', 'fixed');
  const cUtilities = await cat('חשבונות ותשתיות', '#eda100', '⚡', 'fixed');
  const cTelecom = await cat('תקשורת', '#4a3aa7', '📡', 'fixed');
  const cCar = await cat('רכב וביטוח', '#1baf7a', '🚗', 'fixed');
  const cKids = await cat('חינוך וילדים', '#e87ba4', '🎒', 'fixed');
  const cSubs = await cat('מנויים ומועדונים', '#008300', '🎫', 'fixed');
  // A committed monthly saving is not "free money", and it is not spending
  // either - its own kind lets the dashboard subtract it and still call it a win.
  const cSavings = await cat('הפקדה לחיסכון', '#4a3aa7', '🐷', 'savings');

  const cGroceries = await cat('סופר וקניות לבית', '#2a78d6', '🛒', 'variable', ILS(2600));
  const cDining = await cat('מסעדות ובתי קפה', '#eb6834', '🍽️', 'variable', ILS(800));
  const cFuel = await cat('דלק ותחבורה', '#1baf7a', '⛽', 'variable', ILS(700));
  const cPharm = await cat('בריאות ופארם', '#e87ba4', '💊', 'variable', ILS(300));
  const cClothing = await cat('ביגוד והנעלה', '#eda100', '👕', 'variable', ILS(400));
  const cLeisure = await cat('פנאי ובידור', '#008300', '🎬', 'variable', ILS(300));
  const cElectronics = await cat('חשמל ואלקטרוניקה', '#e34948', '📱', 'variable');

  const cCash = await cat('מזומן ושונות', '#4a3aa7', '💵', 'variable', ILS(700));

  const cIncome = await cat('משכורת וקצבאות', '#0ca30c', '💰', 'income_fixed');
  const cIncomeVar = await cat('הכנסות משתנות', '#5aa02c', '📈', 'income_variable');
  const cTransfer = await cat('העברות וחיובי אשראי', '#898781', '🔁', 'transfer');

  // ---------------------------------------------------------------------- rules
  console.log('Creating category rules...');
  const rules: Array<[string, 'contains' | 'regex', string, number]> = [
    ['משכורת', 'contains', cIncome.id, 30],
    ['החזר מס', 'contains', cIncomeVar.id, 30],
    ['חיוב כרטיס אשראי', 'contains', cTransfer.id, 30],
    ['שכר דירה', 'contains', cRent.id, 20],
    ['ארנונה', 'contains', cUtilities.id, 20],
    ['חברת החשמל', 'contains', cUtilities.id, 20],
    ['תאגיד המים', 'contains', cUtilities.id, 20],
    ['(פרטנר|הוט|סלקום|בזק)', 'regex', cTelecom.id, 20],
    ['ביטוח רכב', 'contains', cCar.id, 20],
    ['הלוואה לרכב', 'contains', cCar.id, 20],
    ['(גן |צהרון|חוג )', 'regex', cKids.id, 20],
    ['הולמס פלייס', 'contains', cSubs.id, 20],
    ['נטפליקס', 'contains', cSubs.id, 20],
    ['ספוטיפיי', 'contains', cSubs.id, 20],
    ['הפקדה לחיסכון', 'contains', cSavings.id, 20],
    ['(שופרסל|רמי לוי|ויקטורי|יוחננוף|אושר עד)', 'regex', cGroceries.id, 10],
    ['(וולט|ארומה|קפה גרג|מקדונלדס|לנדוור)', 'regex', cDining.id, 10],
    ["ג'פניקה", 'contains', cDining.id, 10],
    ['(פז |סונול|דור אלון)', 'regex', cFuel.id, 10],
    ['(רב קו|פנגו|סלופארק)', 'regex', cFuel.id, 10],
    ['סופר-פארם', 'contains', cPharm.id, 10],
    ['(זארה|קסטרו|H&M|טרמינל|פוקס)', 'regex', cClothing.id, 10],
    ['(סינמה סיטי|יס פלנט|אסקייפ)', 'regex', cLeisure.id, 10],
    ['(KSP|באג|iDigital)', 'regex', cElectronics.id, 10],
    ['משיכת מזומן', 'contains', cCash.id, 10],
    ['ביט', 'contains', cCash.id, 10],
  ];
  for (const [pattern, matchType, categoryId, priority] of rules) {
    await prisma.categoryRule.create({ data: { pattern, matchType, categoryId, priority } });
  }

  // ------------------------------------------------------------------- accounts
  console.log('Creating accounts...');
  const bank = await prisma.account.create({
    data: {
      institution: 'hapoalim',
      displayName: 'עו"ש בנק הפועלים',
      type: 'bank',
      lastFour: '4471',
      scrapedAt: now,
    },
  });
  const maxCard = await prisma.account.create({
    data: {
      institution: 'max',
      displayName: 'Max ויזה',
      type: 'credit_card',
      lastFour: '5216',
      billingDay: 2,
      scrapedAt: now,
    },
  });
  const isracard = await prisma.account.create({
    data: {
      institution: 'isracard',
      displayName: 'ישראכרט מאסטרקארד',
      type: 'credit_card',
      lastFour: '8830',
      billingDay: 10,
      scrapedAt: now,
    },
  });

  // --------------------------------------------------------------- transactions
  console.log('Generating transactions...');
  const bankTxns: DemoTxn[] = [];
  const maxTxns: DemoTxn[] = [];
  const isracardTxns: DemoTxn[] = [];

  const groceryShops = [
    'שופרסל דיל תל אביב',
    'רמי לוי שיווק השקמה',
    'ויקטורי סניף דיזנגוף',
    'יוחננוף טריידינג',
    'אושר עד ראשל"צ',
  ];
  const restaurants = [
    'וולט - WOLT',
    'ארומה תל אביב',
    'קפה גרג רוטשילד',
    'מקדונלדס עזריאלי',
    "ג'פניקה אבן גבירול",
    'קפה לנדוור',
  ];
  const fuelStations = ['פז אפליקציית yellow', 'סונול סנטר', 'דור אלון בזק'];
  const pharmacies = ['סופר-פארם דיזנגוף סנטר', 'סופר-פארם רמת אביב'];
  const clothingShops = ['זארה TLV FASHION MALL', 'קסטרו אונליין', 'H&M ISRAEL', 'טרמינל X', 'פוקס הום'];

  for (let m = MONTHS_BACK; m >= 0; m--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - m, 1, 12);
    const lastDayInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    // Only emit days that have actually happened.
    const emittable = (day: number) => dayOfMonth(monthStart, day) <= today;

    // ===== Bank: income =====
    // Two earners paid on different days - so a cycle always has one salary at
    // its start and the other still expected near its end. That exercises the
    // "income I have not received yet" half of the forecast.
    if (emittable(ANCHOR_DAY)) {
      bankTxns.push({
        date: dayOfMonth(monthStart, ANCHOR_DAY),
        description: 'משכורת - אקמה טכנולוגיות בע"מ',
        amount: ILS(13_400) + ILS(randInt(-200, 200)),
      });
    }
    if (emittable(1)) {
      bankTxns.push({
        date: dayOfMonth(monthStart, 1),
        description: 'משכורת - רשת מרפאות הדר בע"מ',
        amount: ILS(7_300) + ILS(randInt(-150, 150)),
      });
    }

    // ===== Bank: fixed commitments =====
    // Deliberately clustered just after the main payday, the way standing
    // orders actually are.
    const fixedCharges: Array<[number, string, number]> = [
      [10, 'הו"ק שכר דירה - א. ישראלי', -ILS(6_300)],
      [10, 'גן ילדים "הצבעוני" - צהרון', -ILS(1_850)],
      [12, 'הלוואה לרכב - בנק הפועלים', -ILS(1_450)],
      [14, 'ביטוח ישיר - ביטוח רכב', -ILS(384)],
      [20, 'הפקדה לחיסכון - פיקדון חודשי', -ILS(1_200)],
      [2, 'עיריית תל אביב - ארנונה', -ILS(682)],
    ];
    for (const [day, description, amount] of fixedCharges) {
      if (emittable(day)) bankTxns.push({ date: dayOfMonth(monthStart, day), description, amount });
    }

    // Utilities bill bimonthly in Israel - the detector must NOT forecast these
    // as monthly, which is exactly why they are here.
    if (m % 2 === 0 && emittable(15)) {
      bankTxns.push({
        date: dayOfMonth(monthStart, 15),
        description: 'חברת החשמל לישראל',
        amount: -ILS(randInt(340, 620)),
      });
    }
    if (m % 2 === 1 && emittable(16)) {
      bankTxns.push({
        date: dayOfMonth(monthStart, 16),
        description: 'תאגיד המים העירוני',
        amount: -ILS(randInt(95, 165)),
      });
    }

    // ===== Bank: variable spending that leaves the account directly =====
    // Cash and peer transfers are the slice of variable spending that moves the
    // balance immediately, unlike card purchases which settle weeks later.
    for (let i = 0; i < randInt(2, 4); i++) {
      const day = randInt(1, Math.min(lastDayInMonth, 28));
      if (!emittable(day)) continue;
      const isCash = rand() < 0.5;
      bankTxns.push({
        date: dayOfMonth(monthStart, day),
        description: isCash ? 'משיכת מזומן כספומט' : 'העברה בביט',
        amount: -ILS(isCash ? randInt(200, 500) : randInt(60, 280)),
      });
    }

    // An occasional one-off so the data is not perfectly regular
    if (m === 4 && emittable(18)) {
      bankTxns.push({
        date: dayOfMonth(monthStart, 18),
        description: 'החזר מס הכנסה',
        amount: ILS(2_340),
      });
    }

    // ===== Max card: everyday variable spending =====
    const spendDay = () => randInt(1, Math.min(lastDayInMonth, 28));
    for (let i = 0; i < randInt(7, 10); i++) {
      const day = spendDay();
      if (emittable(day)) {
        maxTxns.push({
          date: dayOfMonth(monthStart, day),
          description: pick(groceryShops),
          amount: -ILS(randInt(140, 590)),
        });
      }
    }
    for (let i = 0; i < randInt(4, 7); i++) {
      const day = spendDay();
      if (emittable(day)) {
        maxTxns.push({
          date: dayOfMonth(monthStart, day),
          description: pick(restaurants),
          amount: -ILS(randInt(42, 235)),
        });
      }
    }
    for (let i = 0; i < randInt(2, 3); i++) {
      const day = spendDay();
      if (emittable(day)) {
        maxTxns.push({
          date: dayOfMonth(monthStart, day),
          description: pick(fuelStations),
          amount: -ILS(randInt(210, 360)),
        });
      }
    }
    if (emittable(11)) {
      maxTxns.push({
        date: dayOfMonth(monthStart, 11),
        description: 'הולמס פלייס בע"מ',
        amount: -ILS(249),
      });
    }
    if (emittable(7)) {
      maxTxns.push({ date: dayOfMonth(monthStart, 7), description: 'נטפליקס', amount: -ILS(69.9) });
    }

    // ===== Isracard: the rest =====
    if (emittable(22)) {
      isracardTxns.push({
        date: dayOfMonth(monthStart, 22),
        description: 'פרטנר תקשורת',
        amount: -ILS(129),
      });
    }
    if (emittable(23)) {
      isracardTxns.push({ date: dayOfMonth(monthStart, 23), description: 'הוט טלקום', amount: -ILS(219) });
    }
    if (emittable(8)) {
      isracardTxns.push({ date: dayOfMonth(monthStart, 8), description: 'ספוטיפיי פרימיום', amount: -ILS(21.9) });
    }
    for (let i = 0; i < randInt(1, 2); i++) {
      const day = spendDay();
      if (emittable(day)) {
        isracardTxns.push({
          date: dayOfMonth(monthStart, day),
          description: pick(pharmacies),
          amount: -ILS(randInt(48, 205)),
        });
      }
    }
    if (rand() < 0.7) {
      const day = spendDay();
      if (emittable(day)) {
        isracardTxns.push({
          date: dayOfMonth(monthStart, day),
          description: pick(clothingShops),
          amount: -ILS(randInt(110, 430)),
        });
      }
    }
    if (rand() < 0.5) {
      const day = spendDay();
      if (emittable(day)) {
        isracardTxns.push({
          date: dayOfMonth(monthStart, day),
          description: 'סינמה סיטי גלילות',
          amount: -ILS(randInt(88, 175)),
        });
      }
    }
    // A phone bought in 12 instalments - still being paid off
    const installmentNo = MONTHS_BACK - m - 1;
    if (installmentNo >= 1 && installmentNo <= 12 && emittable(6)) {
      isracardTxns.push({
        date: dayOfMonth(monthStart, 6),
        description: 'iDigital מאוחדים',
        amount: -ILS(458),
        installments: { number: installmentNo, total: 12 },
        memo: `תשלום ${installmentNo} מתוך 12`,
      });
    }
    if (m === 3 && emittable(19)) {
      isracardTxns.push({ date: dayOfMonth(monthStart, 19), description: 'KSP מחשבים', amount: -ILS(1_890) });
    }
  }

  // Recent unsettled activity, including a couple still pending at the merchant
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    d.setHours(12, 0, 0, 0);
    return d;
  };
  maxTxns.push(
    { date: daysAgo(1), description: 'וולט - WOLT', amount: -ILS(94.5), status: 'pending' },
    { date: daysAgo(0), description: 'שופרסל אונליין', amount: -ILS(387.2), status: 'pending' },
  );
  isracardTxns.push({ date: daysAgo(2), description: 'סופר-פארם אונליין', amount: -ILS(156.8), status: 'pending' });

  // Deliberately unmatched by any rule, so manual categorization has something
  // to demo and the "uncategorized" filter is not empty.
  maxTxns.push({ date: daysAgo(6), description: 'PAYPAL *STEAM GAMES', amount: -ILS(129.9) });
  isracardTxns.push({ date: daysAgo(9), description: 'ALIEXPRESS.COM', amount: -ILS(87.4) });

  // ---- Card settlement: attach real charge dates, then debit the bank ----
  const attachChargeDates = (txns: DemoTxn[], billingDay: number) => {
    for (const t of txns) t.processedDate = chargeDateFor(t.date, billingDay);
  };
  attachChargeDates(maxTxns, 2);
  attachChargeDates(isracardTxns, 10);

  /**
   * One bank debit per charge date, for exactly the sum of the purchases it
   * settles - but only if that date has already arrived. Anything later is the
   * card float: real money already spent that has not left the account yet.
   */
  const settleCard = (txns: DemoTxn[], cardLabel: string) => {
    const byChargeDate = new Map<number, number>();
    for (const t of txns) {
      const key = t.processedDate!.getTime();
      byChargeDate.set(key, (byChargeDate.get(key) ?? 0) + t.amount);
    }
    for (const [time, amount] of byChargeDate) {
      const chargeDate = new Date(time);
      if (chargeDate > today) continue; // still floating
      bankTxns.push({
        date: chargeDate,
        description: `חיוב כרטיס אשראי ${cardLabel}`,
        amount,
      });
    }
  };
  settleCard(maxTxns, 'MAX 5216');
  settleCard(isracardTxns, 'ישראכרט 8830');

  // ------------------------------------------------------------------- persist
  const insertAll = async (accountId: string, institution: string, lastFour: string, txns: DemoTxn[]) => {
    const prepared = assignOccurrences(
      institution,
      lastFour,
      txns.map((t) => ({
        raw: t,
        dateISO: toDateISO(t.date),
        amountAgorot: t.amount,
        normalizedDescription: normalizeDescription(t.description),
        providerIdentifier: null,
      })),
    );
    await prisma.transaction.createMany({
      data: prepared.map((p) => ({
        accountId,
        date: p.raw.date,
        processedDate: p.raw.processedDate ?? null,
        descriptionRaw: p.raw.description,
        description: p.normalizedDescription,
        memo: p.raw.memo ?? null,
        amount: p.raw.amount,
        currency: 'ILS',
        status: p.raw.status ?? 'completed',
        installmentNumber: p.raw.installments?.number ?? null,
        installmentTotal: p.raw.installments?.total ?? null,
        dedupHash: p.dedupHash,
      })),
    });
  };

  await insertAll(bank.id, 'hapoalim', '4471', bankTxns);
  await insertAll(maxCard.id, 'max', '5216', maxTxns);
  await insertAll(isracard.id, 'isracard', '8830', isracardTxns);

  // The balance is set to the target directly (the implied opening balance is
  // target - net), so the timeline the dashboard reconstructs by walking these
  // transactions backwards lands exactly on it.
  await prisma.account.update({
    where: { id: bank.id },
    data: { balance: TARGET_CURRENT_BALANCE },
  });

  console.log('Applying category rules...');
  const catStats = await applyCategoryRules();
  console.log(`  categorized ${catStats.categorized}/${catStats.scanned}`);

  console.log('Detecting recurring charges...');
  const recStats = await detectRecurring();
  console.log(`  ${recStats.detected} recurring items from ${recStats.groupsConsidered} merchant groups`);

  const counts = {
    accounts: await prisma.account.count(),
    categories: await prisma.category.count(),
    rules: await prisma.categoryRule.count(),
    transactions: await prisma.transaction.count(),
    recurring: await prisma.recurringExpense.count(),
  };
  console.log('Seed complete:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
