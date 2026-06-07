import { create } from 'zustand';
import { normalizeConfluenceTag } from '../utils/confluenceTags.js';
import { persist, createJSONStorage } from 'zustand/middleware';
import { supabaseZustandStorage } from './supabaseStorage.js';
import { lookupContract } from '../constants/futuresContracts.js';
import { DEFAULT_ACHIEVEMENTS, mergeAchievementCatalog, refreshAchievements } from './achievements.js';
import { pushToast } from './toastStore.js';
import type {
  Account,
  Achievement,
  Payout,
  BacktestSession,
  BillingAccount,
  ChartHistoryRecord,
  ChecklistItem,
  Goal,
  JournalEntry,
  OnboardingState,
  PlanBlock,
  PreSessionData,
  PropFirm,
  RiskRule,
  ScannerColors,
  Setup,
  StoredRival,
  Trade,
  TradeResult,
} from './types.js';

export const DEFAULT_ACCOUNT_ID = 'default-account';

export const DEFAULT_SCANNER_COLORS: ScannerColors = {
  entry: '#E67E22',
  stopLoss: '#C0392B',
  takeProfit: '#1A6B5A',
};

export const DEFAULT_NEWS_SOURCES: Record<string, boolean> = {
  Bloomberg: true,
  Reuters: true,
  CNBC: true,
  Forexlive: true,
};

export const DEFAULT_RISK_RULES: RiskRule[] = [];

export const DEFAULT_CHECKLIST: ChecklistItem[] = [];

export const DEFAULT_PLAN_BLOCKS: PlanBlock[] = [
  { id: 'pb-1', name: 'Market Thesis', hint: 'How you frame session context', content: '', isOpen: true },
  { id: 'pb-2', name: 'Execution Rules', hint: 'Your if/then triggers', content: '', isOpen: true },
  { id: 'pb-3', name: 'Risk Protocol', hint: 'When to size down or stop', content: '', isOpen: true },
  { id: 'pb-4', name: 'Post-Trade Process', hint: 'Debrief checklist', content: '', isOpen: true },
];

const DEFAULT_SETUPS: Setup[] = [];

interface FlyxaStateData {
  entries: JournalEntry[];
  accounts: Account[];
  activeAccountId: string | null;
  achievements: Achievement[];
  goals: Goal[];
  setupPlaybook: Setup[];
  riskRules: RiskRule[];
  checklist: ChecklistItem[];
  planBlocks: PlanBlock[];
  propFirms: PropFirm[];
  billingAccounts: BillingAccount[];
  scannerColors: ScannerColors;
  newsSources: Record<string, boolean>;
  journalMoods: Record<string, string>;
  journalTitles: Record<string, string>;
  rivals: StoredRival[];
  deletedTradeIds: string[];
  backtestSessions: BacktestSession[];
  onboarding: OnboardingState | null;
  preSession: PreSessionData | null;
  preSessionHistory: Record<string, PreSessionData>;
  chartHistory: ChartHistoryRecord[];
  aiReflections: AiReflection[];
  oathItems: Array<{ id: string; label: string }> | null;
}

export interface AiReflection {
  id: string;
  question: string;
  answer: string;
  timeframe: string;
  periodLabel: string;
  createdAt: string;
}

export interface FlyxaStore extends FlyxaStateData {
  addEntry: (entry: JournalEntry) => void;
  updateEntry: (id: string, updates: Partial<JournalEntry>) => void;
  deleteEntry: (id: string) => void;
  addTrade: (entryId: string, trade: Trade) => void;
  updateTrade: (entryId: string, tradeId: string, updates: Partial<Trade>) => void;
  deleteTrade: (entryId: string, tradeId: string) => void;
  setActiveAccount: (id: string | null) => void;
  addAccount: (account: Account) => void;
  updateAccount: (id: string, updates: Partial<Account>) => void;
  addPayout: (accountId: string, payout: Payout) => void;
  deletePayout: (accountId: string, payoutId: string) => void;
  updateGoal: (id: string, updates: Partial<Goal>) => void;
  addGoal: (goal: Goal) => void;
  deleteGoal: (id: string) => void;
  updateSetup: (id: string, updates: Partial<Setup>) => void;
  updateRiskRules: (rules: RiskRule[]) => void;
  updateChecklist: (items: ChecklistItem[]) => void;
  updatePlanBlock: (id: string, content: string) => void;
  updateScannerColors: (colors: ScannerColors) => void;
  unlockAchievement: (id: string) => void;
  updateAchievementProgress: (id: string, progress: number) => void;
  updateBillingAccount: (id: string, updates: Partial<BillingAccount>) => void;
  addBillingAccount: (account: BillingAccount) => void;
  deleteBillingAccount: (id: string) => void;
  setEntries: (entries: JournalEntry[]) => void;
  hydrateSharedData: (payload: Partial<FlyxaStateData>) => void;
  setJournalMood: (entryId: string, mood: string) => void;
  setJournalTitle: (entryId: string, title: string) => void;
  setRivals: (rivals: StoredRival[]) => void;
  addDeletedTradeId: (id: string) => void;
  setBacktestSessions: (sessions: BacktestSession[]) => void;
  setOnboarding: (state: OnboardingState) => void;
  setPreSession: (data: PreSessionData | null) => void;
  setPreSessionForDate: (date: string, data: PreSessionData) => void;
  setChartHistory: (records: ChartHistoryRecord[]) => void;
  addAiReflection: (reflection: AiReflection) => void;
  setOathItems: (items: Array<{ id: string; label: string }> | null) => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultAccount(): Account {
  return {
    id: DEFAULT_ACCOUNT_ID,
    name: 'Default Account',
    firm: 'Flyxa',
    size: 50000,
    type: 'live',
    phase: 'funded',
    balance: 50000,
    dailyLossLimit: 2500,
    maxDrawdown: 3000,
    profitTarget: null,
    startingBalance: 50000,
    isActive: true,
    color: '#3b82f6',
  };
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pointValue(symbol: string): number {
  return lookupContract(symbol)?.point_value ?? 1;
}

function normalizeConfluences(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  const deduped = new Set<string>();
  const normalized: string[] = [];
  rawValues.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const cleaned = normalizeConfluenceTag(entry.trim().replace(/\s+/g, ' '));
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) return;
    deduped.add(key);
    normalized.push(cleaned);
  });

  return normalized;
}

function computeResult(pnl: number, exit: number | null): TradeResult {
  if (exit === null || !Number.isFinite(exit)) return 'open';
  if (pnl > 0) return 'win';
  if (pnl < 0) return 'loss';
  return 'open';
}

const LEGACY_DEFAULT_RISK_RULE_IDS = new Set([
  'rr-1',
  'rr-2',
  'rr-3',
  'daily-loss',
  'max-trades',
  'max-contracts',
  'min-rr',
  'max-losses',
  'risk-per-trade',
]);

const LEGACY_DEFAULT_CHECKLIST_IDS = new Set([
  'cl-1',
  'cl-2',
  'cl-3',
  'cl-4',
  'news',
  'zones',
  'bias',
  'loss-limit',
  'gap',
  'state',
  'alerts',
]);

const LEGACY_DEFAULT_SETUP_IDS = new Set([
  'setup-a-plus',
  'setup-a',
  'setup-b',
]);

function removeLegacyDefaults<T extends { id: string }>(items: T[] | undefined, legacyIds: Set<string>): T[] {
  return (items ?? []).filter((item) => !legacyIds.has(item.id));
}

function recalcTrade(trade: Trade): Trade {
  const contracts = Math.max(1, asNumber(trade.contracts, 1));
  const entry = asNumber(trade.entry, 0);
  const sl = asNumber(trade.sl, 0);
  const tp = asNumber(trade.tp, 0);
  const exit = typeof trade.exit === 'number' && Number.isFinite(trade.exit) ? trade.exit : null;
  const pv = pointValue(trade.symbol);

  const pnl = typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride)
    ? trade.pnlOverride
    : exit === null
      ? 0
      : trade.direction === 'LONG'
        ? (exit - entry) * contracts * pv
        : (entry - exit) * contracts * pv;

  const risk = trade.direction === 'LONG' ? entry - sl : sl - entry;
  const reward = trade.direction === 'LONG' ? tp - entry : entry - tp;
  const rr = risk > 0 && reward > 0 ? reward / risk : 0;

  return {
    ...trade,
    contracts,
    entry,
    sl,
    tp,
    exit,
    pnl,
    rr,
    result: computeResult(pnl, exit),
  };
}

function computeEntryGrade(entry: JournalEntry): string {
  const ok = entry.rules.filter(rule => rule.state === 'ok').length;
  const fail = entry.rules.filter(rule => rule.state === 'fail').length;
  const evaluated = ok + fail;
  const rulePassPct = evaluated > 0 ? (ok / evaluated) * 100 : 0;
  const baseDiscipline = asNumber(entry.psychology.discipline, 0);

  const gradedTrades = entry.trades.filter(trade => (trade.reflection?.processGrade ?? 0) > 0);
  const avgProcessGrade = gradedTrades.length > 0
    ? gradedTrades.reduce((sum, trade) => sum + (trade.reflection?.processGrade ?? 0), 0) / gradedTrades.length
    : 0;

  const weightedDiscipline = gradedTrades.length > 0
    ? (baseDiscipline * 0.7) + (avgProcessGrade * 0.3)
    : baseDiscipline;

  if (weightedDiscipline >= 4 && rulePassPct >= 80) return 'A+';
  if (weightedDiscipline >= 3.5 && rulePassPct >= 70) return 'A';
  if (weightedDiscipline >= 3 && rulePassPct >= 60) return 'B+';
  if (weightedDiscipline >= 2.5 && rulePassPct >= 50) return 'B';
  if (weightedDiscipline >= 2) return 'C+';
  return 'C';
}

function withEntryDerived(entry: JournalEntry): JournalEntry {
  const trades = entry.trades.map(recalcTrade);
  return {
    ...entry,
    trades,
    grade: computeEntryGrade({ ...entry, trades }),
  };
}

function normalizeTradeUnknown(input: unknown, entryId: string, date: string, accountId: string): Trade | null {
  if (!isRecord(input)) return null;
  const reflectionRaw = isRecord(input.reflection) ? input.reflection : {};
  const direction = input.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const emotionalState = typeof input.emotionalState === 'string'
    ? input.emotionalState.trim()
    : typeof input.emotional_state === 'string'
      ? input.emotional_state.trim()
      : '';
  const confidenceLevel = typeof input.confidenceLevel === 'number' && Number.isFinite(input.confidenceLevel)
    ? input.confidenceLevel
    : typeof input.confidence_level === 'number' && Number.isFinite(input.confidence_level)
      ? input.confidence_level
      : null;
  const primaryAccount = asString(input.account || input.accountId, accountId);
  const accountIds = Array.from(new Set([
    ...(Array.isArray(input.accountIds) ? input.accountIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) : []),
    primaryAccount,
  ]));
  const trade: Trade = {
    // Spread all input fields first so rich JournalTrade fields (preEntry, thesis,
    // executionReview, psychologyRatings, etc.) survive a page reload.
    ...(input as Record<string, unknown>),
    id: asString(input.id, crypto.randomUUID()),
    entryId,
    date: asString(input.date, date),
    symbol: asString(input.symbol, 'NQ'),
    direction,
    entry: asNumber(typeof input.entry === 'number' ? input.entry : input.entryPrice, 0),
    sl: asNumber(typeof input.sl === 'number' ? input.sl : input.sl_price, 0),
    tp: asNumber(typeof input.tp === 'number' ? input.tp : input.tp_price, 0),
    exit: (() => {
      if (typeof input.exit === 'number' && Number.isFinite(input.exit)) return input.exit;
      if (typeof input.exit_price === 'number' && Number.isFinite(input.exit_price) && input.exit_price > 0) return input.exit_price;
      if (typeof input.exitPrice === 'number' && Number.isFinite(input.exitPrice) && input.exitPrice > 0) return input.exitPrice;
      return null;
    })(),
    contracts: Math.max(1, asNumber(input.contracts, 1)),
    rr: asNumber(input.rr, 0),
    pnl: asNumber(input.pnl, 0),
    result: input.result === 'win' || input.result === 'loss' || input.result === 'open' ? input.result : 'open',
    time: asString(typeof input.time === 'string' ? input.time : input.entryTime, '09:30').slice(0, 5),
    exitTime: typeof input.exitTime === 'string' ? input.exitTime.slice(0, 5) : null,
    duration: (() => {
      if (typeof input.duration === 'number' && Number.isFinite(input.duration)) return input.duration;
      if (typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes)) return input.durationMinutes;
      if (typeof input.trade_length_seconds === 'number' && Number.isFinite(input.trade_length_seconds)) {
        return Math.max(1, Math.round(input.trade_length_seconds / 60));
      }
      return null;
    })(),
    durationMinutes: (() => {
      if (typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes)) return input.durationMinutes;
      if (typeof input.duration === 'number' && Number.isFinite(input.duration)) return input.duration;
      if (typeof input.trade_length_seconds === 'number' && Number.isFinite(input.trade_length_seconds)) {
        return Math.max(1, Math.round(input.trade_length_seconds / 60));
      }
      return null;
    })(),
    screenshots: Array.isArray(input.screenshots)
      ? input.screenshots.filter((shot): shot is string => typeof shot === 'string')
      : [],
    scannedImageUrl: typeof input.scannedImageUrl === 'string' ? input.scannedImageUrl : typeof input.screenshotUrl === 'string' ? input.screenshotUrl : null,
    emotionalState: emotionalState.length > 0 ? emotionalState : null,
    confidenceLevel,
    reflection: {
      thesis: asString(reflectionRaw.thesis, ''),
      execution: asString(reflectionRaw.execution, ''),
      adjustment: asString(reflectionRaw.adjustment, ''),
      processGrade: asNumber(reflectionRaw.processGrade, 0),
      followedPlan: reflectionRaw.followedPlan === true || reflectionRaw.followedPlan === false ? reflectionRaw.followedPlan : null,
      followedPlanLogged: reflectionRaw.followedPlanLogged === true,
    },
    confluences: normalizeConfluences(input.confluences),
    // `account` is the store field; `accountId` is the JournalTrade field.
    // Accept either so trades normalised from TradeJournal mutations keep their account.
    account: primaryAccount,
    accountIds,
    createdAt: asString(input.createdAt, new Date().toISOString()),
  };
  return trade;
}

function normalizeEntryUnknown(input: unknown, accountId: string): JournalEntry | null {
  if (!isRecord(input)) return null;
  const entryId = asString(input.id, crypto.randomUUID());
  const date = asString(input.date, todayIso());
  const reflectionRaw = isRecord(input.reflection) ? input.reflection : {};
  const psychologyRaw = isRecord(input.psychology) ? input.psychology : {};
  const rulesRaw = Array.isArray(input.rules) ? input.rules : [];
  const emotionsRaw = Array.isArray(input.emotions) ? input.emotions : [];
  const tradesRaw = Array.isArray(input.trades) ? input.trades : [];

  const normalizedRules = rulesRaw
    .filter(isRecord)
    .map((rule) => ({
      text: asString(rule.text, ''),
      state: (rule.state === 'ok' || rule.state === 'fail' || rule.state === 'unchecked' ? rule.state : 'unchecked') as 'ok' | 'fail' | 'unchecked',
    }))
    .filter((rule) => rule.text.trim().length > 0);

  const normalizedEmotions = emotionsRaw
    .filter(isRecord)
    .map((emotion) => ({
      label: asString(emotion.label, ''),
      state: (emotion.state === 'neutral' || emotion.state === 'green' || emotion.state === 'amber' || emotion.state === 'red'
        ? emotion.state
        : 'neutral') as 'neutral' | 'green' | 'amber' | 'red',
    }))
    .filter((emotion) => emotion.label.trim().length > 0);

  const normalizedTrades = tradesRaw
    .map((trade) => normalizeTradeUnknown(trade, entryId, date, accountId))
    .filter((trade): trade is Trade => Boolean(trade));

  const screenshots = Array.isArray(input.screenshots)
    ? input.screenshots.filter((shot): shot is string => typeof shot === 'string').slice(0, 3)
    : [];
  while (screenshots.length < 3) screenshots.push('');

  return {
    // Spread all input fields first so rich JournalEntry fields (dailyReflection,
    // physicalState, etc.) survive a page reload — mirrors normalizeTradeUnknown.
    ...(input as Record<string, unknown>),
    id: entryId,
    date,
    trades: normalizedTrades,
    screenshots,
    reflection: {
      pre: asString(reflectionRaw.pre, ''),
      post: asString(reflectionRaw.post, ''),
      lessons: asString(reflectionRaw.lessons, ''),
    },
    rules: normalizedRules,
    psychology: {
      setupQuality: asNumber(psychologyRaw.setupQuality, 0),
      discipline: asNumber(psychologyRaw.discipline, 0),
      execution: asNumber(psychologyRaw.execution, 0),
    },
    emotions: normalizedEmotions,
    grade: asString(input.grade, 'C'),
    account: asString(input.account, accountId),
    scannedImageUrl: typeof input.scannedImageUrl === 'string' ? input.scannedImageUrl : undefined,
  } as unknown as JournalEntry;
}

function ensureAccount(entries: unknown[], accountId: string): JournalEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => normalizeEntryUnknown(entry, accountId))
    .filter((entry): entry is JournalEntry => Boolean(entry))
    .map((entry) => ({
      ...entry,
      account: entry.account || accountId,
      trades: entry.trades.map((trade) => {
        const primaryAccount = trade.account || entry.account || accountId;
        const accountIds = Array.from(new Set([...(trade.accountIds ?? []), primaryAccount]));
        return { ...trade, account: primaryAccount, accountIds };
      }),
    }));
}

export function getInitialState(): FlyxaStateData {
  const baseAccount = defaultAccount();
  return {
    entries: [],
    accounts: [baseAccount],
    activeAccountId: baseAccount.id,
    achievements: DEFAULT_ACHIEVEMENTS,
    goals: [],
    setupPlaybook: DEFAULT_SETUPS,
    riskRules: DEFAULT_RISK_RULES,
    checklist: DEFAULT_CHECKLIST,
    planBlocks: DEFAULT_PLAN_BLOCKS,
    propFirms: [],
    billingAccounts: [],
    scannerColors: DEFAULT_SCANNER_COLORS,
    newsSources: DEFAULT_NEWS_SOURCES,
    journalMoods: {},
    journalTitles: {},
    rivals: [],
    deletedTradeIds: [],
    backtestSessions: [],
    onboarding: null,
    preSession: null,
    preSessionHistory: {},
    chartHistory: [],
    aiReflections: [],
    oathItems: null,
  };
}

function syncAchievements(data: FlyxaStateData): FlyxaStateData {
  const trades = data.entries.flatMap((entry) => entry.trades);
  const refreshed = refreshAchievements(data.achievements, trades, data.entries, data.billingAccounts);

  if (refreshed.newlyUnlocked.length > 0) {
    refreshed.newlyUnlocked.forEach((achievement) => {
      pushToast({
        tone: 'amber',
        durationMs: 4000,
        message: `Achievement unlocked: ${achievement.title}`,
      });
    });
  }

  return {
    ...data,
    achievements: refreshed.next,
  };
}

function withDerivedEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.map(withEntryDerived).sort((a, b) => b.date.localeCompare(a.date));
}

function maybeCreateFundedAccount(accounts: Account[], billingAccount: BillingAccount): Account[] {
  if (billingAccount.status !== 'Passed' && billingAccount.status !== 'Funded') return accounts;
  const existing = accounts.find((account) => account.firm === billingAccount.firm && account.name === `${billingAccount.firm} Funded`);
  if (existing) return accounts;

  const sizeValue = Number.parseFloat(String(billingAccount.size).replace(/[^\d.]/g, ''));
  const size = Number.isFinite(sizeValue) ? sizeValue : 50000;
  const funded: Account = {
    id: crypto.randomUUID(),
    name: `${billingAccount.firm} Funded`,
    firm: billingAccount.firm,
    size,
    type: 'live',
    phase: 'funded',
    balance: size,
    dailyLossLimit: Math.max(500, size * 0.05),
    maxDrawdown: Math.max(1000, size * 0.06),
    profitTarget: null,
    startingBalance: size,
    isActive: false,
    color: '#22c55e',
  };
  return [...accounts, funded];
}

const useFlyxaStore = create<FlyxaStore>()(
  persist(
    (set) => ({
      ...getInitialState(),

      addEntry: (entry) => {
        set((state) => syncAchievements({
          ...state,
          entries: withDerivedEntries([withEntryDerived(entry), ...state.entries]),
        }));
      },

      updateEntry: (id, updates) => {
        set((state) => {
          const entries = withDerivedEntries(
            state.entries.map((entry) => (entry.id === id ? withEntryDerived({ ...entry, ...updates }) : entry))
          );
          return syncAchievements({ ...state, entries });
        });
      },

      deleteEntry: (id) => {
        set((state) => {
          const removedTradeIds = state.entries
            .find((entry) => entry.id === id)
            ?.trades.map((trade) => trade.id) ?? [];
          const deletedTradeIds = Array.from(new Set([...state.deletedTradeIds, ...removedTradeIds]));
          return syncAchievements({
            ...state,
            entries: state.entries.filter((entry) => entry.id !== id),
            deletedTradeIds,
          });
        });
      },

      addTrade: (entryId, trade) => {
        set((state) => {
          const entries = withDerivedEntries(
            state.entries.map((entry) => {
              if (entry.id !== entryId) return entry;
              const nextTrade = recalcTrade({ ...trade, entryId, account: trade.account || entry.account });
              return withEntryDerived({ ...entry, trades: [nextTrade, ...entry.trades] });
            })
          );
          pushToast({ tone: 'green', durationMs: 3000, message: 'Trade scanned and saved' });
          return syncAchievements({ ...state, entries });
        });
      },

      updateTrade: (entryId, tradeId, updates) => {
        set((state) => {
          const entries = withDerivedEntries(
            state.entries.map((entry) => {
              if (entry.id !== entryId) return entry;
              const trades = entry.trades.map((trade) => {
                if (trade.id !== tradeId) return trade;
                return recalcTrade({ ...trade, ...updates });
              });
              return withEntryDerived({ ...entry, trades });
            })
          );
          return syncAchievements({ ...state, entries });
        });
      },

      deleteTrade: (entryId, tradeId) => {
        set((state) => {
          const entries = withDerivedEntries(
            state.entries.map((entry) => {
              if (entry.id !== entryId) return entry;
              return withEntryDerived({ ...entry, trades: entry.trades.filter((trade) => trade.id !== tradeId) });
            })
          );
          const deletedTradeIds = state.deletedTradeIds.includes(tradeId)
            ? state.deletedTradeIds
            : [...state.deletedTradeIds, tradeId];
          return syncAchievements({ ...state, entries, deletedTradeIds });
        });
      },

      setActiveAccount: (id) => set(() => ({ activeAccountId: id })),

      addAccount: (account) => set((state) => ({
        accounts: [...state.accounts.filter((item) => item.id !== account.id), account],
      })),

      updateAccount: (id, updates) => set((state) => ({
        accounts: state.accounts.map((account) => (account.id === id ? { ...account, ...updates } : account)),
      })),

      addPayout: (accountId, payout) => set((state) => ({
        accounts: state.accounts.map((a) =>
          a.id === accountId ? { ...a, payouts: [...(a.payouts ?? []), payout] } : a
        ),
      })),

      deletePayout: (accountId, payoutId) => set((state) => ({
        accounts: state.accounts.map((a) =>
          a.id === accountId ? { ...a, payouts: (a.payouts ?? []).filter((p) => p.id !== payoutId) } : a
        ),
      })),

      updateGoal: (id, updates) => set((state) => ({
        goals: state.goals.map((goal) => (goal.id === id ? { ...goal, ...updates } : goal)),
      })),

      addGoal: (goal) => set((state) => ({ goals: [goal, ...state.goals] })),

      deleteGoal: (id) => set((state) => ({ goals: state.goals.filter((goal) => goal.id !== id) })),

      updateSetup: (id, updates) => set((state) => ({
        setupPlaybook: state.setupPlaybook.map((setup) => (setup.id === id ? { ...setup, ...updates } : setup)),
      })),

      updateRiskRules: (rules) => set(() => ({ riskRules: rules })),

      updateChecklist: (items) => set(() => ({ checklist: items })),

      updatePlanBlock: (id, content) => set((state) => ({
        planBlocks: state.planBlocks.map((block) => (block.id === id ? { ...block, content } : block)),
      })),

      updateScannerColors: (colors) => set((state) => ({
        scannerColors: { ...state.scannerColors, ...colors },
      })),

      unlockAchievement: (id) => set((state) => ({
        achievements: state.achievements.map((achievement) => (
          achievement.id === id
            ? { ...achievement, unlockedAt: achievement.unlockedAt ?? new Date().toISOString(), progress: 100 }
            : achievement
        )),
      })),

      updateAchievementProgress: (id, progress) => set((state) => ({
        achievements: state.achievements.map((achievement) => (
          achievement.id === id ? { ...achievement, progress } : achievement
        )),
      })),

      updateBillingAccount: (id, updates) => set((state) => {
        const billingAccounts = state.billingAccounts.map((account) => {
          if (account.id !== id) return account;
          const next = { ...account, ...updates };
          return {
            ...next,
            roi: asNumber(next.payoutReceived, 0) - asNumber(next.actualPrice, 0),
          };
        });
        const updated = billingAccounts.find((account) => account.id === id);
        const accounts = updated ? maybeCreateFundedAccount(state.accounts, updated) : state.accounts;
        return syncAchievements({ ...state, billingAccounts, accounts });
      }),

      addBillingAccount: (account) => set((state) => {
        const normalized = {
          ...account,
          roi: asNumber(account.payoutReceived, 0) - asNumber(account.actualPrice, 0),
        };
        const billingAccounts = [normalized, ...state.billingAccounts.filter((item) => item.id !== account.id)];
        const accounts = maybeCreateFundedAccount(state.accounts, normalized);
        return syncAchievements({ ...state, billingAccounts, accounts });
      }),

      deleteBillingAccount: (id) => set((state) => ({
        billingAccounts: state.billingAccounts.filter((account) => account.id !== id),
      })),

      setJournalMood: (entryId, mood) => set((state) => ({
        journalMoods: { ...state.journalMoods, [entryId]: mood },
      })),

      setJournalTitle: (entryId, title) => set((state) => ({
        journalTitles: { ...state.journalTitles, [entryId]: title },
      })),

      setRivals: (rivals) => set(() => ({ rivals })),

      addDeletedTradeId: (id) => set((state) => ({
        deletedTradeIds: state.deletedTradeIds.includes(id) ? state.deletedTradeIds : [...state.deletedTradeIds, id],
      })),

      setBacktestSessions: (sessions) => set(() => ({ backtestSessions: sessions })),

      setOnboarding: (state) => set(() => ({ onboarding: state })),

      setPreSession: (data) => set(() => ({ preSession: data })),

      setPreSessionForDate: (date, data) => set((state) => ({
        preSessionHistory: { ...state.preSessionHistory, [date]: data },
      })),

      setOathItems: (items) => set(() => ({ oathItems: items })),

      setChartHistory: (records) => set(() => ({ chartHistory: records })),

      addAiReflection: (reflection) => set((state) => ({
        aiReflections: [reflection, ...state.aiReflections].slice(0, 50),
      })),

      setEntries: (entries) => {
        set((state) => {
          const accountId = state.activeAccountId || DEFAULT_ACCOUNT_ID;
          // Build a fast lookup of existing entries so we can preserve their account
          // when the incoming entry (e.g. from TradeJournal) doesn't carry an `account`
          // field (TradeJournal's local JournalEntry type omits it).
          const existingEntryMap = new Map(state.entries.map(e => [e.id, e]));
          // Preserve all fields (including rich journal fields like dailyReflection,
          // preEntry, thesis, executionReview, etc.) — only ensure account, date,
          // entryId, and time are set (JournalTrade uses entryTime, not time).
          const safeEntries = (entries as unknown[])
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .map(e => {
              const entryId = typeof e.id === 'string' ? e.id : crypto.randomUUID();
              const entryDate = typeof e.date === 'string' ? e.date : todayIso();
              // Prefer the explicit `account` on the incoming entry; if absent, fall back to
              // the existing stored entry's account so that mutations from TradeJournal
              // (whose local type omits `account`) never clobber the stored account.
              const existingEntry = existingEntryMap.get(entryId);
              const entryAccount = (typeof e.account === 'string' && e.account) ? e.account
                : existingEntry?.account || accountId;
              return {
                ...e,
                id: entryId,
                account: entryAccount,
                trades: Array.isArray(e.trades)
                  ? (e.trades as unknown[]).map(t => {
                      if (!t || typeof t !== 'object') return t;
                      const tr = t as Record<string, unknown>;
                      // `account` is the store field; `accountId` is the JournalTrade field.
                      // Check both so that mutations from TradeJournal (which uses `accountId`)
                      // never lose the account — fall back to the existing stored trade's
                      // account before using the entry account.
                      const existingTrade = existingEntry?.trades.find(et => et.id === tr.id);
                      const tradeAccount = (typeof tr.account === 'string' && tr.account) ? tr.account
                        : (typeof tr.accountId === 'string' && tr.accountId) ? tr.accountId
                        : existingTrade?.account || entryAccount;
                      // Ensure Trade-required fields that JournalTrade lacks are populated
                      const tradeTime = typeof tr.time === 'string' ? tr.time
                        : typeof tr.entryTime === 'string' ? tr.entryTime : '09:30';
                      const tradeDate = typeof tr.date === 'string' ? tr.date : entryDate;
                      const tradeEntryId = typeof tr.entryId === 'string' ? tr.entryId : entryId;
                      const createdAt = typeof tr.createdAt === 'string' ? tr.createdAt : new Date().toISOString();
                      return {
                        ...tr,
                        account: tradeAccount,
                        time: tradeTime,
                        date: tradeDate,
                        entryId: tradeEntryId,
                        createdAt,
                      };
                    })
                  : [],
              };
            }) as JournalEntry[];
          return syncAchievements({ ...state, entries: withDerivedEntries(safeEntries) });
        });
      },

      hydrateSharedData: (payload) => {
        set((state) => {
          // Use `!== undefined` so that an explicit `null` (= All Accounts) in either
          // the payload or the current state is preserved and not overwritten by the
          // DEFAULT_ACCOUNT_ID fallback.
          const accountId = payload.activeAccountId !== undefined
            ? payload.activeAccountId
            : (state.activeAccountId !== undefined ? state.activeAccountId : DEFAULT_ACCOUNT_ID);
          const entryAccountFallback = accountId ?? DEFAULT_ACCOUNT_ID;
          const incomingBilling = payload.billingAccounts ?? state.billingAccounts;
          const billingAccounts = incomingBilling.map((account) => ({
            ...account,
            roi: asNumber(account.payoutReceived, 0) - asNumber(account.actualPrice, 0),
          }));
          let nextAccounts = payload.accounts && payload.accounts.length
            ? payload.accounts.map(incoming => {
                const existing = state.accounts.find(a => a.id === incoming.id);
                return existing?.payouts?.length ? { ...incoming, payouts: existing.payouts } : incoming;
              })
            : state.accounts;
          billingAccounts.forEach((account) => {
            nextAccounts = maybeCreateFundedAccount(nextAccounts, account);
          });
          const merged: FlyxaStateData = {
            entries: payload.entries ? withDerivedEntries(ensureAccount(payload.entries, entryAccountFallback)) : state.entries,
            accounts: nextAccounts,
            activeAccountId: accountId,
            achievements: payload.achievements && payload.achievements.length
              ? mergeAchievementCatalog(payload.achievements)
              : mergeAchievementCatalog(state.achievements),
            goals: payload.goals ?? state.goals,
            setupPlaybook: removeLegacyDefaults(payload.setupPlaybook ?? state.setupPlaybook, LEGACY_DEFAULT_SETUP_IDS),
            riskRules: removeLegacyDefaults(payload.riskRules ?? state.riskRules, LEGACY_DEFAULT_RISK_RULE_IDS),
            checklist: removeLegacyDefaults(payload.checklist ?? state.checklist, LEGACY_DEFAULT_CHECKLIST_IDS),
            planBlocks: payload.planBlocks ?? state.planBlocks,
            propFirms: payload.propFirms ?? state.propFirms,
            billingAccounts,
            scannerColors: payload.scannerColors ?? state.scannerColors,
            newsSources: payload.newsSources ?? state.newsSources,
            journalMoods: payload.journalMoods ?? state.journalMoods,
            journalTitles: payload.journalTitles ?? state.journalTitles,
            rivals: payload.rivals ?? state.rivals,
            deletedTradeIds: payload.deletedTradeIds ?? state.deletedTradeIds,
            backtestSessions: payload.backtestSessions ?? state.backtestSessions,
            onboarding: payload.onboarding ?? state.onboarding,
            preSession: payload.preSession ?? state.preSession,
            preSessionHistory: payload.preSessionHistory ?? state.preSessionHistory,
            chartHistory: payload.chartHistory ?? state.chartHistory,
            aiReflections: payload.aiReflections ?? state.aiReflections,
            oathItems: payload.oathItems ?? state.oathItems,
          };
          return syncAchievements(merged);
        });
      },
    }),
    {
      name: 'flyxa-store',
      storage: createJSONStorage(() => supabaseZustandStorage),
      version: 1,
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as Partial<FlyxaStore> | undefined) ?? {};
        const base = currentState as FlyxaStore;
        const activeAccountId = persisted.activeAccountId !== undefined
          ? persisted.activeAccountId
          : (base.activeAccountId !== undefined ? base.activeAccountId : DEFAULT_ACCOUNT_ID);
        const entryAccountFallback = activeAccountId ?? DEFAULT_ACCOUNT_ID;
        const incomingEntries = withDerivedEntries(ensureAccount(persisted.entries ?? [], entryAccountFallback));
        // Never replace existing entries with fewer — protects against rehydrate wiping data
        const sanitizedEntries = incomingEntries.length >= base.entries.length ? incomingEntries : base.entries;
        const sanitizedBilling = (persisted.billingAccounts ?? base.billingAccounts).map((account) => ({
          ...account,
          roi: asNumber(account.payoutReceived, 0) - asNumber(account.actualPrice, 0),
        }));
        let accounts = persisted.accounts && persisted.accounts.length ? persisted.accounts : base.accounts;
        sanitizedBilling.forEach((account) => {
          accounts = maybeCreateFundedAccount(accounts, account);
        });
        return {
          ...base,
          ...persisted,
          entries: sanitizedEntries,
          accounts,
          activeAccountId,
          achievements: mergeAchievementCatalog(
            persisted.achievements && persisted.achievements.length ? persisted.achievements : base.achievements
          ),
          billingAccounts: sanitizedBilling,
          setupPlaybook: removeLegacyDefaults(persisted.setupPlaybook ?? base.setupPlaybook, LEGACY_DEFAULT_SETUP_IDS),
          riskRules: removeLegacyDefaults(persisted.riskRules ?? base.riskRules, LEGACY_DEFAULT_RISK_RULE_IDS),
          checklist: removeLegacyDefaults(persisted.checklist ?? base.checklist, LEGACY_DEFAULT_CHECKLIST_IDS),
          aiReflections: persisted.aiReflections ?? base.aiReflections,
          // Prefer non-empty moods/titles: if Supabase blob has none (e.g. older save that predates
          // the field) keep whatever is already in base (may have been hydrated from localStorage).
          journalMoods: (persisted.journalMoods && Object.keys(persisted.journalMoods).length > 0)
            ? persisted.journalMoods
            : base.journalMoods,
          journalTitles: (persisted.journalTitles && Object.keys(persisted.journalTitles).length > 0)
            ? persisted.journalTitles
            : base.journalTitles,
        };
      },
      migrate: (persistedState) => {
        const state = (persistedState as Partial<FlyxaStore> | undefined) ?? undefined;
        if (!state) return getInitialState();
        const initial = getInitialState();
        const activeAccountId = state.activeAccountId !== undefined
          ? state.activeAccountId
          : (initial.activeAccountId !== undefined ? initial.activeAccountId : DEFAULT_ACCOUNT_ID);
        const entryAccountFallback = activeAccountId ?? DEFAULT_ACCOUNT_ID;
        return {
          ...initial,
          ...state,
          entries: withDerivedEntries(ensureAccount(state.entries ?? [], entryAccountFallback)),
          setupPlaybook: removeLegacyDefaults(state.setupPlaybook ?? initial.setupPlaybook, LEGACY_DEFAULT_SETUP_IDS),
          riskRules: removeLegacyDefaults(state.riskRules ?? initial.riskRules, LEGACY_DEFAULT_RISK_RULE_IDS),
          checklist: removeLegacyDefaults(state.checklist ?? initial.checklist, LEGACY_DEFAULT_CHECKLIST_IDS),
          aiReflections: state.aiReflections ?? initial.aiReflections,
          billingAccounts: (state.billingAccounts ?? []).map((account) => ({
            ...account,
            roi: asNumber(account.payoutReceived, 0) - asNumber(account.actualPrice, 0),
          })),
          achievements: mergeAchievementCatalog(
            state.achievements && state.achievements.length ? state.achievements : DEFAULT_ACHIEVEMENTS
          ),
        };
      },
      partialize: (state) => ({
        entries: state.entries,
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        achievements: state.achievements,
        goals: state.goals,
        setupPlaybook: removeLegacyDefaults(state.setupPlaybook, LEGACY_DEFAULT_SETUP_IDS),
        riskRules: removeLegacyDefaults(state.riskRules, LEGACY_DEFAULT_RISK_RULE_IDS),
        checklist: removeLegacyDefaults(state.checklist, LEGACY_DEFAULT_CHECKLIST_IDS),
        planBlocks: state.planBlocks,
        propFirms: state.propFirms,
        billingAccounts: state.billingAccounts,
        scannerColors: state.scannerColors,
        newsSources: state.newsSources,
        journalMoods: state.journalMoods,
        journalTitles: state.journalTitles,
        rivals: state.rivals,
        deletedTradeIds: state.deletedTradeIds,
        backtestSessions: state.backtestSessions,
        onboarding: state.onboarding,
        preSession: state.preSession,
        preSessionHistory: state.preSessionHistory,
        chartHistory: state.chartHistory,
        aiReflections: state.aiReflections,
        oathItems: state.oathItems,
      }),
    }
  )
);

export function getActiveAccount(state: FlyxaStateData): Account | undefined {
  return state.accounts.find((account) => account.id === state.activeAccountId) ?? state.accounts[0];
}

export function createEmptyJournalEntry(date?: string, accountId?: string): JournalEntry {
  const today = date ?? todayIso();
  return {
    id: crypto.randomUUID(),
    date: today,
    trades: [],
    screenshots: ['', '', ''],
    reflection: { pre: '', post: '', lessons: '' },
    rules: [],
    psychology: { setupQuality: 0, discipline: 0, execution: 0 },
    emotions: [
      'Focused',
      'Calm',
      'Patient',
      'Slightly rushed',
      'Confident',
      'Hesitant',
      'Overconfident',
      'Revenge trading',
      'FOMO',
      'In the zone',
      'Distracted',
      'Anxious',
    ].map((label) => ({ label, state: 'neutral' as const })),
    grade: 'C',
    account: accountId ?? DEFAULT_ACCOUNT_ID,
  };
}

export default useFlyxaStore;
