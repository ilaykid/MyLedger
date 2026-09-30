// Typed API client. All amounts are agorot (1 ILS = 100); UI divides by 100.

export interface Account {
  id: string;
  institution: string;
  displayName: string;
  type: 'bank' | 'credit_card';
  lastFour: string;
  balance: number | null;
  scrapedAt: string | null;
}

export interface CategoryRef {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

export type CategoryKind =
  | 'income_fixed'
  | 'income_variable'
  | 'fixed'
  | 'variable'
  | 'transfer'
  | 'excluded'
  | 'savings';

export interface Category extends CategoryRef {
  monthlyBudget: number | null;
  kind: CategoryKind;
  _count?: { transactions: number; rules: number };
}

// ---------------------------------------------------------------- cash flow

export interface CashflowEvent {
  date: string;
  label: string;
  amount: number;
  kind: 'income' | 'fixed' | 'card_settlement' | 'excluded';
  actual: boolean;
}

export interface TimelinePoint {
  date: string;
  dayOfMonth: number;
  balance: number;
  actual: boolean;
  variableSpend: number;
  events: CashflowEvent[];
}

export interface Cashflow {
  cycle: {
    offset: number;
    start: string;
    end: string;
    lastDay: string;
    anchorDay: number;
    daysTotal: number;
    daysElapsed: number;
    daysRemaining: number;
    timeProgress: number;
    isCurrent: boolean;
  };
  bankBalance: number;
  bankSnapshots: Array<{name:string;balance:number|null;asOf:string|null}>;
  forecastCoverage: {usableCycles:number;excludedCycles:number;detail:string};
  categoryTotals: Array<{categoryId:string|null;amount:number}>;
  income: {
    received: number;
    expected: number;
    total: number;
    fixedReceived: number;
    variableReceived: number;
  };
  fixed: { paid: number; upcoming: number; total: number };
  savings: { deposited: number; rateOfIncome: number };
  variable: {
    spent: number;
    projectedRest: number;
    projectedTotal: number;
    dailyBurn: number;
    forecastBasis: Array<{ start: string; end: string; total: number; daily: number }>;
  };
  cardFloat: {
    total: number;
    withinCycle: number;
    byAccount: Array<{ accountId: string; displayName: string; amount: number; chargeDate: string | null }>;
  };
  available: number;
  /** Where the cycle is expected to END - income minus fixed minus projected variable */
  projectedNet: number;
  dailyAllowance: number;
  spendProgress: number;
  status: 'ok' | 'tight' | 'over';
  projectedEndBalance: number;
  lowestPoint: { date: string; balance: number } | null;
  overdraftDate: string | null;
  pace: {
    currentSpend: number;
    previousSpendAtSameDay: number;
    delta: number;
    series: Array<{ day: number; current: number | null; previous: number | null }>;
  } | null;
  timeline: TimelinePoint[];
  upcoming: CashflowEvent[];
  variableByCategory: Array<{
    categoryId: string | null;
    name: string;
    color: string;
    icon: string;
    amount: number;
    budget: number | null;
    /** Typical full-cycle spend from this category's own history; null when the cycle is done */
    forecast: number | null;
  }>;
}

export interface Recurring {
  source: string;
  validFrom: string | null;
  validUntil: string | null;
  accountId: string | null;
  categoryId: string | null;
  forecastState?: string;
  id: string;
  signature: string;
  displayName: string;
  direction: 'expense' | 'income';
  expectedAmount: number;
  expectedDay: number;
  occurrences: number;
  amountSpread: number;
  lastSeen: string;
  frequency: 'monthly' | 'bimonthly';
  active: boolean;
  category: CategoryRef | null;
  account: { id: string; displayName: string; type: string } | null;
}

export interface SyncIssue {
  kind:
    | 'provider_not_connected'
    | 'settlement_mismatch'
    | 'settlement_unclassified'
    | 'no_bank_connected'
    | 'stale_account'
    | 'sync_stalled'
    | 'provider_stale'
    | 'new_account';
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  company?: string;
  amount?: number;
  lastSeen?: string;
  occurrences?: number;
  drilldown?: { type: 'settlement_mismatch'; accountId: string; date: string };
}

export interface SettlementMismatchDetail {
  account: { id: string; displayName: string; institution: string; lastFour: string };
  chargeDate: string;
  bankTotal: number;
  cardTotal: number;
  difference: number;
  chosenBankTransactionId: string;
  bankTransactions: Array<{ id: string; date: string; description: string; amount: number }>;
  cardTransactions: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    status: string;
    installmentNumber: number | null;
    installmentTotal: number | null;
  }>;
}

export interface SyncFreshness {
  lastSyncAt: string | null;
  hoursSince: number | null;
  state: 'fresh' | 'aging' | 'stalled' | 'never';
  perAccount: Array<{ displayName: string; institution: string; scrapedAt: string | null }>;
}

export interface SyncHealth {
  issues: SyncIssue[];
  freshness: SyncFreshness;
  reliability: {
    status: 'complete' | 'partial' | 'stale' | 'unavailable';
    label: string;
    state: 'high' | 'medium' | 'low';
    uncategorizedShare: number;
    detail: string;
  };
  checkedAt: string;
}

export interface Insight {
  key: string;
  kind: string;
  rank: number;
  title: string;
  detail: string;
  amount?: number;
  merchant?: string;
  feedback?: 'useful' | null;
}

export interface InstallmentPlan {
  id: string;
  accountId: string;
  accountName: string;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  perPayment: number;
  totalPayments: number;
  paidPayments: number;
  remainingPayments: number;
  totalAmount: number;
  remainingAmount: number;
  firstSeen: string;
  lastSeen: string;
  dayOfMonth: number;
  nextDue: string | null;
  endsOn: string | null;
  status: 'active' | 'finished' | 'stale';
}

export interface InstallmentSummary {
  activePlans: number;
  monthlyLoad: number;
  totalRemaining: number;
  freeingUp: Array<{ month: string; amount: number; plans: string[] }>;
  nextToFinish: { description: string; endsOn: string; perPayment: number } | null;
}

export interface MonthlyNet {
  month: string;
  /** incomeFixed + incomeVariable */
  income: number;
  /** Salary and allowances - plannable */
  incomeFixed: number;
  /** Freelance, reserve duty, refunds - arrived, but promises nothing */
  incomeVariable: number;
  expense: number;
  /** Real money in/out kept out of `net` on purpose - see Flow.excluded */
  excludedIn: number;
  excludedOut: number;
  /** Put aside, positive magnitude, deliberately NOT part of `expense` */
  savings: number;
  net: number;
  complete: boolean;
}

// ------------------------------------------------------------- connections

export interface ProviderInfo {
  id: string;
  name: string;
  loginFields: string[];
  type: 'bank' | 'credit_card';
}

export interface ConnectionAccount {
  lifecycle: 'active' | 'dormant' | 'closed';
  balanceAt: string | null;
  id: string;
  displayName: string;
  lastFour: string;
  type: string;
  balance: number | null;
  billingDay: number | null;
  scrapedAt: string | null;
  transactions: number;
  firstTransaction: string | null;
  lastTransaction: string | null;
  float: number;
}

export interface Connection {
  company: string;
  providerName: string;
  displayName: string;
  type: 'bank' | 'credit_card';
  known: boolean;
  expectedFields: string[];
  credentialFields: Array<{ field: string; encrypted: boolean }>;
  allEncrypted: boolean;
  hasBrowserProfile: boolean;
  accounts: ConnectionAccount[];
}

export interface ConnectionsResponse {
  connections: Connection[];
  orphanAccounts: Array<{ id: string; institution: string; displayName: string; lastFour: string }>;
  providers: ProviderInfo[];
}

export interface BackupStatus {
  configured: boolean;
  destination: string | null;
  keep: number;
  count: number;
  newest: string | null;
  suggestedDestination: string | null;
}

export interface ScrapeJob {
  id?: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  companies?: string[];
  startedAt?: string;
  finishedAt?: string | null;
  log?: string[];
  failures?: number;
  error?: string | null;
}

export interface LlmStatus {
  available: boolean;
  model: string | null;
  installedModels: string[];
  error?: string;
}

export interface MerchantSuggestion {
  merchant: string;
  count: number;
  total: number;
  category: string;
  categoryId: string;
  pattern: string;
}

export type NotificationDetail = 'full' | 'amounts' | 'minimal';

export interface Settings {
  id: number;
  cycleAnchorDay: number;
  forecastLookbackCycles: number;
  notificationDetail: NotificationDetail;
  telegramConfigured: boolean;
}

export interface Txn {
  contribution: number;
  flow: string;
  explanation: string;
  categorizedAt: string | null;
  matchingRules: Array<{id:string;pattern:string;priority:number}>;
  id: string;
  date: string;
  processedDate: string | null;
  description: string;
  memo: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'completed';
  installmentNumber: number | null;
  installmentTotal: number | null;
  categoryLocked: boolean;
  /** The user's note on this specific transaction - wins over the others */
  note: string | null;
  /** Identifies the instalment purchase this payment belongs to, if any */
  planKey: string | null;
  /** A note covering every payment of this instalment purchase */
  planNote: string | null;
  /** A note covering every transaction from this merchant */
  merchantNote: string | null;
  category: CategoryRef | null;
  account: { id: string; displayName: string; type: string };
  /** Set when this lump sum is recognised across several months */
  spread: { months: number; offsetMonths: number; note: string | null } | null;
}

export interface SpreadPlan {
  id: string;
  transactionId: string;
  description: string;
  /** The original single amount, signed agorot */
  amount: number;
  months: number;
  offsetMonths: number;
  note: string | null;
  perMonth: number;
  firstMonth: string;
  lastMonth: string;
  slices: Array<{ month: string; amount: number }>;
}

export interface BreakdownLine {
  categoryId: string | null;
  name: string;
  color: string;
  icon: string;
  kind: CategoryKind;
  /** positive magnitude */
  amount: number;
  /** 0..1 of its own side's total */
  share: number;
  count: number;
  /** Part of `amount` that is spread recognition, not money that moved this month */
  fromSpread: number;
  budget: number | null;
  /** The individual transactions, biggest first - not merged by description */
  topItems: Array<{ date: string; description: string; amount: number; fromSpread: boolean }>;
  items?: Array<{ date: string; description: string; amount: number; fromSpread: boolean }>;
  /** How many more sit behind the drill-through link */
  moreItems: number;
}

export interface BreakdownSideData {
  total: number;
  fixed: number;
  variable: number;
  lines: BreakdownLine[];
}

export interface Breakdown {
  month: string;
  income: BreakdownSideData;
  expense: BreakdownSideData;
  excluded: { in: number; out: number; lines: BreakdownLine[] };
  /** Kept out of `expense` entirely - money put aside is not money spent */
  savings: { total: number; rateOfIncome: number; lines: BreakdownLine[] };
  /** Money that has actually moved. True, but not a headline mid-month. */
  net: number;
  /**
   * Where the month is heading. Null once the month is finished, or when the
   * salary cycle does not line up with the calendar month.
   */
  projection: {
    income: number;
    incomeExpected: number;
    expense: number;
    fixedUpcoming: number;
    variableProjectedRest: number;
    net: number;
    daysElapsed: number;
    daysTotal: number;
  } | null;
  budget: {
    tracked: number;
    totalBudget: number;
    totalSpent: number;
    over: number;
    unbudgeted: number;
  };
}

export interface ReviewCard {
  kind: 'sync' | 'confirm' | 'categorise' | 'late_fixed' | 'insight' | 'done';
  id: string;
  title: string;
  body: string;
  amount?: number;
  transaction?: {
    id: string;
    description: string;
    amount: number;
    date: string;
    accountName: string;
    /** Provisional at the provider - name and amount may still change */
    pending: boolean;
    currentCategoryId: string | null;
    note: string | null;
    spread: { months: number; note: string | null } | null;
    merchant: { pattern: string; others: number } | null;
    suggestions: Array<{ id: string; name: string; icon: string | null }>;
  };
}

export interface DailyReview {
  date: string;
  cards: ReviewCard[];
  remaining: { count: number; amount: number };
}

export type NoteScope = 'plan' | 'merchant';

export interface StandingNote {
  id: string;
  scope: NoteScope;
  key: string;
  displayName: string;
  note: string;
  updatedAt: string;
}

export interface TxnPage {
  summary: {income:number;expense:number;net:number;basis:string};
  items: Txn[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Rule {
  id: string;
  pattern: string;
  matchType: 'contains' | 'regex';
  priority: number;
  categoryId: string;
  category: CategoryRef;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // Forces a CORS preflight on mutating requests, so another site cannot fire
    // them at our localhost API. The server rejects writes without it.
    'x-myledger': '1',
    ...(init?.headers as Record<string, string> | undefined),
  };

  // Only declare a JSON body when there actually is one. Fastify rejects a
  // request that announces application/json and then sends nothing
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which silently broke every no-body POST -
  // "detect recurring", "send test message", and so on.
  if (init?.body != null) headers['content-type'] = 'application/json';

  const res = await fetch(url, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(45_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = 'הפעולה לא הושלמה. נסו שוב.';
    try { const parsed = JSON.parse(body); message = parsed.message ?? (parsed.error === 'validation' ? 'בדקו את השדות שסומנו ונסו שוב.' : parsed.error) ?? message; } catch { /* non-JSON error */ }
    throw new Error(message === 'internal error' ? 'אירעה שגיאה בשרת. הנתונים לא נשמרו.' : message);
  }
  if (res.status === 204) return undefined as T;
  const value = await res.json();
  if (init?.method && init.method !== 'GET') {
    window.dispatchEvent(new CustomEvent('ledger:changed'));
    if (url.endsWith('/undo')) window.dispatchEvent(new CustomEvent('ledger:undone'));
    if (value?.changeId) window.dispatchEvent(new CustomEvent('ledger:undo', { detail: value.changeId }));
  }
  return value as T;
}

export interface Preview { count:number; amount:number; locked?:number; conflicts?:number; samples:Array<{id:string;description:string;amount:number}> }
export interface QualityItem { key:string;kind:string;title:string;detail:string;amount:number;count:number;href:string;canResolve:boolean;evidence:Array<{id:string;description:string;amount:number;date:string}> }
export interface Settlement {id:string;account:string;date:string;currency:string;count:number;cardAmount:number;bankAmount:number|null;difference:number|null;bankId:string|null;bankDate:string|null;href:string;status:'matched'|'review'|'balanced';reason:string}
export interface QualityResponse {items:QualityItem[];settlements:Settlement[];since:string;decisions:Array<{key:string;note:string;createdAt:string}>}
export interface ForecastRecord {id:string;asOf:string;cycleStart:string;predictedNet:number;actualNet:number|null;error:number|null;quality:string;basisCycles:number}
export interface Meta { demo: boolean; platform: string; canStoreCredentials: boolean }
export const api = {
  meta: () => request<Meta>('/api/meta'),
  quality: () => request<QualityResponse>('/api/quality'),
  resolveQuality: (key:string,note:string) => request('/api/quality/resolve',{method:'POST',body:JSON.stringify({key,note})}),
  reopenQuality: (key:string) => request('/api/quality/'+key,{method:'DELETE'}),
  changes: () => request<Array<{id:string;title:string;createdAt:string;undoneAt:string|null}>>('/api/changes'),
  undo: (id:string) => request('/api/changes/'+id+'/undo',{method:'POST'}),
  bulk: (ids:string[], categoryId:string|null, preview=false) => request<Preview>('/api/transactions/bulk',{method:'POST',body:JSON.stringify({ids,categoryId,preview})}),
  previewRule: (data: {id?:string;pattern:string;matchType:string;priority:number;categoryId:string}) => request<Preview>('/api/rules/preview',{method:'POST',body:JSON.stringify(data)}),
  editRule: (id:string,data: {pattern:string;matchType:string;priority:number;categoryId:string}) => request('/api/rules/'+id,{method:'PATCH',body:JSON.stringify(data)}),
  previewMerchant: (transactionId:string,categoryId:string) => request<Preview>('/api/rules/from-transaction',{method:'POST',body:JSON.stringify({transactionId,categoryId,preview:true})}),
  previewCategory: (id:string) => request<Preview>('/api/categories/'+id+'/preview',{method:'POST'}),
  saveRecurring: (id:string|null,data:Record<string,unknown>) => request('/api/recurring'+(id?'/'+id:''),{method:id?'PATCH':'POST',body:JSON.stringify(data)}),
  recurringStatus: () => request<Recurring[]>('/api/recurring/status'),
  forecasts: () => request<ForecastRecord[]>('/api/forecast-history'),
  recordForecast: () => request('/api/forecast-history',{method:'POST'}),

  accounts: () => request<Account[]>('/api/accounts'),

  transactions: (params: {
    month?: string;
    start?:string;end?:string;chargeDate?:string;min?:number;max?:number;status?:string;currency?:string;flow?:string;transaction?:string;
    accountId?: string;
    categoryId?: string;
    uncategorized?: boolean;
    includeSpread?: boolean;
    q?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const key of ['start','end','chargeDate','min','max','status','currency','flow','transaction'] as const) if(params[key] !== undefined && params[key] !== '') qs.set(key,String(params[key]));
    if (params.month) qs.set('month', params.month);
    if (params.accountId) qs.set('accountId', params.accountId);
    if (params.uncategorized) qs.set('uncategorized', 'true');
    else if (params.categoryId) qs.set('categoryId', params.categoryId);
    if (params.includeSpread) qs.set('includeSpread', 'true');
    if (params.q) qs.set('q', params.q);
    qs.set('page', String(params.page ?? 1));
    qs.set('pageSize', String(params.pageSize ?? 50));
    return request<TxnPage>(`/api/transactions?${qs}`);
  },

  setTxnCategory: (id: string, categoryId: string | null) =>
    request<Txn>(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId }),
    }),

  setTxnNote: (id: string, note: string | null) =>
    request<Txn>(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ note }) }),

  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  llmSuggest: (limit = 40) =>
    request<{ suggestions: MerchantSuggestion[]; skipped: string[]; model: string }>('/api/llm/suggest', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  llmAccept: (accepted: Array<{ pattern: string; categoryId: string }>) =>
    request<{ created: number; skipped: number; categorized: number }>('/api/llm/accept', {
      method: 'POST',
      body: JSON.stringify({ accepted }),
    }),

  notes: () => request<StandingNote[]>('/api/notes'),
  saveNote: (scope: NoteScope, transactionId: string, note: string) =>
    request<{ ok: true; removed?: boolean }>('/api/notes', {
      method: 'PUT',
      body: JSON.stringify({ scope, transactionId, note }),
    }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),

  breakdown: (month: string) => request<Breakdown>(`/api/breakdown?month=${month}`),

  dailyReview: (scope: 'daily' | 'expenses' = 'daily') =>
    request<DailyReview>(`/api/daily-review?scope=${scope}`),
  dismissReviewCard: (id: string, kind: string) =>
    request<void>('/api/daily-review/dismiss', { method: 'POST', body: JSON.stringify({ id, kind }) }),

  spreads: () => request<{ plans: SpreadPlan[] }>('/api/spreads'),
  saveSpread: (transactionId: string, months: number, offsetMonths = 0, note?: string | null) =>
    request<SpreadPlan>('/api/spreads', {
      method: 'POST',
      body: JSON.stringify({ transactionId, months, offsetMonths, note }),
    }),
  deleteSpread: (transactionId: string) =>
    request<void>(`/api/spreads/${transactionId}`, { method: 'DELETE' }),

  categories: () => request<Category[]>('/api/categories'),
  createCategory: (data: Partial<Category> & { name: string }) =>
    request<Category>('/api/categories', { method: 'POST', body: JSON.stringify(data) }),
  updateCategory: (id: string, data: Partial<Category>) =>
    request<Category>(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCategory: (id: string) => request<void>(`/api/categories/${id}`, { method: 'DELETE' }),

  rules: () => request<Rule[]>('/api/rules'),
  createRule: (data: { pattern: string; matchType: string; priority: number; categoryId: string }) =>
    request<Rule>('/api/rules', { method: 'POST', body: JSON.stringify(data) }),
  deleteRule: (id: string) => request<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  /** One answer becomes a standing rule plus a sweep of everything uncategorised. */
  ruleFromTransaction: (transactionId: string, categoryId: string, preview = false) =>
    request<{ rule: Rule; pattern: string; applied: number }>('/api/rules/from-transaction', {
      method: 'POST',
      body: JSON.stringify({ transactionId, categoryId, preview }),
    }),
  applyRules: (recategorize: boolean, preview = false) =>
    request<{ scanned: number; categorized: number; samples?: Array<{id:string;description:string;amount:number}> }>('/api/rules/apply', {
      method: 'POST',
      body: JSON.stringify({ recategorize, preview }),
    }),

  cashflow: (offset = 0) => request<Cashflow>(`/api/cashflow?offset=${offset}`),

  monthly: (months = 12) => request<MonthlyNet[]>(`/api/monthly?months=${months}`),

  installments: () =>
    request<{ plans: InstallmentPlan[]; summary: InstallmentSummary }>('/api/installments'),

  syncHealth: () => request<SyncHealth>('/api/sync-health'),
  settlementMismatchDetail: (accountId: string, date: string) => {
    const query = new URLSearchParams({ accountId, date });
    return request<SettlementMismatchDetail>(`/api/sync-health/settlement-mismatch?${query}`);
  },

  insights: (days = 30) => request<Insight[]>(`/api/insights?days=${days}`),
  setInsightFeedback: (insight: Pick<Insight, 'key' | 'kind'>, verdict: 'useful' | 'not_relevant' | 'resolved' | 'snoozed') =>
    request(`/api/insights/${insight.key}/feedback`, {
      method: 'PUT',
      body: JSON.stringify({ kind: insight.kind, verdict }),
    }),

  connections: () => request<ConnectionsResponse>('/api/connections'),
  backupStatus: () => request<BackupStatus>('/api/backup'),
  prepareBackup: (destination: string, keep = 14) =>
    request<{ setupId: string; passphrase: string; destination: string; sameDrive: boolean }>('/api/backup/prepare', {
      method: 'POST', body: JSON.stringify({ destination, keep }),
    }),
  confirmBackup: (setupId: string) => request<BackupStatus & { ok: true; name: string }>('/api/backup/confirm', {
    method: 'POST', body: JSON.stringify({ setupId }),
  }),
  runBackup: () => request<BackupStatus & { ok: true; name: string }>('/api/backup/run', { method: 'POST' }),
  saveConnection: (data: { company: string; displayName?: string; credentials: Record<string, string> }) =>
    request<{ ok: true; created: boolean }>('/api/connections', { method: 'POST', body: JSON.stringify(data) }),
  removeConnection: (company: string) =>
    request<{ ok: true }>(`/api/connections/${encodeURIComponent(company)}`, { method: 'DELETE' }),
  updateAccount: (id: string, data: { displayName?: string; billingDay?: number | null; lifecycle?: string }) =>
    request<ConnectionAccount>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAccount: (id: string) => request<void>(`/api/accounts/${id}`, { method: 'DELETE' }),

  startScrape: (companies: string[] = []) =>
    request<ScrapeJob>('/api/scrape', { method: 'POST', body: JSON.stringify({ companies }) }),
  scrapeStatus: () => request<ScrapeJob>('/api/scrape/status'),

  recurring: () => request<Recurring[]>('/api/recurring'),
  setRecurringActive: (id: string, active: boolean) =>
    request<Recurring>(`/api/recurring/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  detectRecurring: () =>
    request<{ groupsConsidered: number; detected: number; removed: number }>('/api/recurring/detect', {
      method: 'POST',
    }),

  settings: () => request<Settings>('/api/settings'),
  updateSettings: (
    data: Partial<Pick<Settings, 'cycleAnchorDay' | 'forecastLookbackCycles' | 'notificationDetail'>>,
  ) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  /**
   * Reads the chat id off the message someone just sent the bot. The token is
   * optional once a bot is connected - the server falls back to the stored one,
   * so adding a recipient later never asks for the secret again.
   */
  detectTelegramChat: (token?: string) =>
    request<{ chats: Array<{ id: string; name: string }> }>('/api/telegram/detect-chat', {
      method: 'POST',
      body: JSON.stringify(token ? { token } : {}),
    }),
  saveTelegram: (token: string, chatIds: string[]) =>
    request<{ ok: true }>('/api/telegram', { method: 'PUT', body: JSON.stringify({ token, chatIds }) }),
  clearTelegram: () => request<{ ok: true }>('/api/telegram', { method: 'DELETE' }),
  testTelegram: () =>
    request<{ sent: boolean; error?: string; delivered?: number; failures?: Array<{ chatId: string; error: string }> }>(
      '/api/telegram/test',
      { method: 'POST' },
    ),

  /** Who the digests go to. Editable without touching the token. */
  telegramRecipients: () => request<{ chatIds: string[] }>('/api/telegram/recipients'),
  saveTelegramRecipients: (chatIds: string[]) =>
    request<{ chatIds: string[] }>('/api/telegram/recipients', {
      method: 'PUT',
      body: JSON.stringify({ chatIds }),
    }),
  testTelegramRecipient: (chatId: string) =>
    request<{ sent: boolean; error?: string }>('/api/telegram/recipients/test', {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  sendTelegramSummary: (kind?: 'daily' | 'weekly' | 'monthly') =>
    request<{ sent: boolean; error?: string; kind: string; preview: string }>('/api/telegram/summary', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }),
};
