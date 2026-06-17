import { useCallback, useEffect, useMemo } from 'react';
import { Trade as ApiTrade } from '../types/index.js';
import useFlyxaStore, { createEmptyJournalEntry, DEFAULT_ACCOUNT_ID } from '../store/flyxaStore.js';
import type { Trade as StoreTrade } from '../store/types.js';
import { tradesApi } from '../services/api.js';
import { persistDeletedTradeId } from '../utils/deletedTrades.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';

function normalizeEmotion(value: unknown): ApiTrade['emotional_state'] {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

type RichStoreTrade = StoreTrade & {
  behavioralFlags?: string[];
  thesis?: {
    setup?: string;
    invalidation?: string;
    asymmetry?: string;
    setupType?: string;
  };
  executionReview?: {
    enteredAtLevel?: boolean | null;
    waitedForConfirmation?: boolean | null;
    correctSize?: boolean | null;
    exitedAtPlan?: boolean | null;
    movedStopCorrectly?: boolean | null;
    resistedEarlyExit?: boolean | null;
  };
  preEntry?: {
    confidenceAtEntry?: number;
    emotionalState?: string;
    hesitated?: boolean | null;
    hesitationReason?: string;
  };
  psychologyRatings?: {
    setupQuality?: number;
    discipline?: number;
    execution?: number;
    patience?: number;
    riskManagement?: number;
    emotionalControl?: number;
    notes?: Record<string, string>;
  };
  stateOfMind?: Array<{ label: string; valence: 'positive' | 'caution' | 'negative' }>;
  processScore?: number;
};

function deriveEmotionalState(trade: StoreTrade): ApiTrade['emotional_state'] {
  const richTrade = trade as RichStoreTrade;
  return normalizeEmotion(richTrade.emotionalState) ?? normalizeEmotion(richTrade.preEntry?.emotionalState);
}

// Severity weights for behavioral flags (points deducted from 100).
// High = direct plan violations; Medium = execution deviations; Low = minor slippage.
const FLAG_SEVERITY: Record<string, number> = {
  'revenge':         35,
  'past-limit':      35,
  'off-playbook':    35,
  'added-losing':    35,
  'fomo':            20,
  'no-confirmation': 20,
  'sized-up':        20,
  'moved-stop':      20,
  'past-inval':      20,
  'chased-entry':    10,
  'exit-early':      10,
  'moved-target':    10,
};

export function computePlanAdherenceScore(trade: StoreTrade): number | null {
  // Explicit user override takes priority
  if (trade.reflection?.followedPlanLogged === true && typeof trade.reflection.followedPlan === 'boolean') {
    return trade.reflection.followedPlan ? 100 : 0;
  }

  const richTrade = trade as RichStoreTrade;
  const flags = Array.isArray(richTrade.behavioralFlags) ? richTrade.behavioralFlags : null;
  const review = richTrade.executionReview;

  // No behavioral data at all → excluded from calculation
  const hasFlagData = flags !== null;
  const hasReviewData = review && Object.values(review).some(v => typeof v === 'boolean');
  if (!hasFlagData && !hasReviewData) return null;

  let flagDeduction = 0;

  if (flags && flags.length > 0) {
    for (const flag of flags) {
      flagDeduction += FLAG_SEVERITY[flag] ?? 10;
    }
    // PnL modifier: flags hurt less on profitable trades, more on losing ones
    const pnl = typeof trade.pnl === 'number' ? trade.pnl : 0;
    if (pnl > 0)      flagDeduction = Math.round(flagDeduction * 0.70);
    else if (pnl < 0) flagDeduction = Math.round(flagDeduction * 1.30);
  }

  // Execution review: each "No" answer deducts 8 points (no PnL modifier)
  let reviewDeduction = 0;
  if (review) {
    const signals = [
      review.enteredAtLevel,
      review.waitedForConfirmation,
      review.correctSize,
      review.exitedAtPlan,
      review.movedStopCorrectly,
      review.resistedEarlyExit,
    ];
    for (const s of signals) {
      if (s === false) reviewDeduction += 8;
    }
  }

  return Math.max(0, Math.round(100 - flagDeduction - reviewDeduction));
}

function deriveFollowedPlan(trade: StoreTrade): boolean | null {
  // Explicit user override takes priority
  if (trade.reflection?.followedPlanLogged === true && typeof trade.reflection.followedPlan === 'boolean') {
    return trade.reflection.followedPlan;
  }

  const score = computePlanAdherenceScore(trade);
  if (score === null) return null;
  // Threshold: score >= 65 counts as "followed plan"
  return score >= 65;
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
    const cleaned = entry.trim().replace(/\s+/g, ' ');
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) return;
    deduped.add(key);
    normalized.push(cleaned);
  });

  return normalized;
}

function normalizeAccountIds(value: unknown, fallback?: string): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const normalized = rawValues
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  const deduped = Array.from(new Set(normalized));
  if (deduped.length > 0) return deduped;
  return fallback ? [fallback] : [];
}

function toStoreTrade(data: Partial<ApiTrade>, entryId: string, accountId: string): StoreTrade {
  const direction = data.direction === 'Short' ? 'SHORT' : 'LONG';
  const entry = typeof data.entry_price === 'number' ? data.entry_price : 0;
  const sl = typeof data.sl_price === 'number' ? data.sl_price : entry;
  const tp = typeof data.tp_price === 'number' ? data.tp_price : entry;
  const exit = typeof data.exit_price === 'number' ? data.exit_price : null;
  const netPnl = (typeof data.pnl === 'number' ? data.pnl : 0) - (typeof data.commission === 'number' ? data.commission : 0);
  const result: StoreTrade['result'] =
    data.exit_reason === 'TP' ? 'win'
    : data.exit_reason === 'SL' ? 'loss'
    : netPnl > 0 ? 'win'
    : netPnl < 0 ? 'loss'
    : 'open';

  return {
    id: data.id ?? crypto.randomUUID(),
    entryId,
    date: data.trade_date ?? new Date().toISOString().slice(0, 10),
    symbol: data.symbol ?? 'NQ',
    direction,
    entry,
    sl,
    tp,
    exit,
    contracts: typeof data.contract_size === 'number' && data.contract_size > 0 ? data.contract_size : 1,
    rr: 0,
    pnl: typeof data.pnl === 'number' ? data.pnl : 0,
    pnlOverride: typeof data.pnlOverride === 'number' && Number.isFinite(data.pnlOverride) ? data.pnlOverride : undefined,
    result,
    time: (data.trade_time ?? '09:30').slice(0, 5),
    exitTime: typeof data.close_time === 'string' ? data.close_time.slice(0, 5) : (data.trade_time ?? '09:30').slice(0, 5),
    duration: typeof data.trade_length_seconds === 'number' ? Math.round(data.trade_length_seconds / 60) : null,
    screenshots: data.screenshot_url ? [data.screenshot_url] : [],
    scannedImageUrl: data.screenshot_url ?? null,
    reflection: {
      thesis: data.pre_trade_notes ?? '',
      execution: data.post_trade_notes ?? '',
      adjustment: '',
      processGrade: 0,
      followedPlan: typeof data.followed_plan === 'boolean' ? data.followed_plan : null,
      followedPlanLogged: typeof data.followed_plan === 'boolean',
    },
    emotionalState: normalizeEmotion(data.emotional_state),
    confidenceLevel: typeof data.confidence_level === 'number' && Number.isFinite(data.confidence_level) ? data.confidence_level : null,
    confluences: normalizeConfluences(data.confluences),
    account: data.accountId ?? data.account_id ?? data.accountIds?.[0] ?? accountId,
    accountIds: normalizeAccountIds(data.accountIds ?? data.account_ids, data.accountId ?? data.account_id ?? accountId),
    behavioralFlags: Array.isArray(data.behavioral_flags) ? data.behavioral_flags : [],
    createdAt: data.created_at ?? new Date().toISOString(),
  };
}

export function toApiTrade(trade: StoreTrade): ApiTrade {
  const session = getSession(trade.time);
  const tradeTime = trade.time || (trade as unknown as { entryTime?: string }).entryTime || '09:30';
  const emotionalState = deriveEmotionalState(trade);
  const confidenceLevelRaw = (trade as StoreTrade).confidenceLevel;
  const confidenceLevel = typeof confidenceLevelRaw === 'number' && Number.isFinite(confidenceLevelRaw) ? confidenceLevelRaw : null;
  const followedPlan = deriveFollowedPlan(trade);
  const planScore = computePlanAdherenceScore(trade);
  return {
    id: trade.id,
    user_id: 'local',
    symbol: trade.symbol,
    screenshot_url: trade.scannedImageUrl ?? (trade as unknown as { screenshotUrl?: string }).screenshotUrl ?? (Array.isArray(trade.screenshots) ? trade.screenshots[0] : undefined),
    accountId: trade.account,
    account_id: trade.account,
    accountIds: normalizeAccountIds(trade.accountIds, trade.account),
    account_ids: normalizeAccountIds(trade.accountIds, trade.account),
    direction: trade.direction === 'SHORT' ? 'Short' : 'Long',
    entry_price: trade.entry,
    exit_price: trade.exit ?? trade.entry,
    sl_price: trade.sl,
    tp_price: trade.tp,
    exit_reason: trade.result === 'win' ? 'TP' : trade.result === 'loss' ? 'SL' : 'BE',
    pnl: trade.pnl,
    pnlOverride: typeof trade.pnlOverride === 'number' ? trade.pnlOverride : undefined,
    commission: typeof trade.commission === 'number' ? trade.commission : undefined,
    contract_size: trade.contracts,
    point_value: 1,
    trade_date: trade.date,
    trade_time: tradeTime,
    close_time: trade.exitTime,
    trade_length_seconds: trade.duration ? trade.duration * 60 : ((trade as unknown as { durationMinutes?: number | null }).durationMinutes ?? 0) * 60,
    candle_count: 0,
    timeframe_minutes: (() => {
      const tf = (trade as StoreTrade & { timeframe?: string }).timeframe;
      if (!tf) return 0;
      const m = tf.match(/^(\d+)m$/i);
      const h = tf.match(/^(\d+)h$/i);
      if (m) return parseInt(m[1], 10);
      if (h) return parseInt(h[1], 10) * 60;
      return 0;
    })(),
    emotional_state: emotionalState,
    confidence_level: confidenceLevel,
    preEntry: (trade as RichStoreTrade).preEntry,
    thesis: (trade as RichStoreTrade).thesis,
    executionReview: (trade as RichStoreTrade).executionReview,
    psychologyRatings: (trade as RichStoreTrade).psychologyRatings,
    stateOfMind: (trade as RichStoreTrade).stateOfMind,
    processScore: typeof (trade as RichStoreTrade).processScore === 'number' ? (trade as RichStoreTrade).processScore : undefined,
    pre_trade_notes: trade.reflection?.thesis,
    post_trade_notes: trade.reflection?.execution,
    confluences: normalizeConfluences((trade as StoreTrade).confluences),
    followed_plan: typeof followedPlan === 'boolean' ? followedPlan : null,
    plan_score: typeof planScore === 'number' ? planScore : null,
    behavioral_flags: Array.isArray((trade as RichStoreTrade).behavioralFlags) ? (trade as RichStoreTrade).behavioralFlags : [],
    session,
    created_at: trade.createdAt,
  };
}

function getSession(time: string | undefined | null): ApiTrade['session'] {
  if (!time) return 'Other';
  const [hoursText] = time.split(':');
  const hours = Number(hoursText);
  if (!Number.isFinite(hours)) return 'Other';
  if (hours >= 0 && hours < 8) return 'Asia';
  if (hours >= 8 && hours < 13) return 'London';
  if (hours >= 13 && hours < 21) return 'New York';
  return 'Other';
}

export function evictTradeFromCache(_userId: string, _tradeId: string) {
  // Cache layer removed in favor of unified flyxa-store.
}

let legacyTradesRestorePromise: Promise<void> | null = null;

export function useTrades() {
  const entries = useFlyxaStore((state) => state.entries);
  const activeAccountId = useFlyxaStore((state) => state.activeAccountId);
  const deletedTradeIds = useFlyxaStore((state) => state.deletedTradeIds);
  const addEntry = useFlyxaStore((state) => state.addEntry);
  const addTrade = useFlyxaStore((state) => state.addTrade);
  const setEntries = useFlyxaStore((state) => state.setEntries);
  const updateTradeInStore = useFlyxaStore((state) => state.updateTrade);
  const deleteTradeInStore = useFlyxaStore((state) => state.deleteTrade);

  const trades = useMemo(() => {
    const deleted = new Set(deletedTradeIds);
    // No account pre-filter here. Account filtering is handled exclusively by
    // filterTradesBySelectedAccount (AppSettingsContext) which reads from
    // selectedAccountId — the UI source of truth. Pre-filtering here caused a
    // race condition where the Zustand store could rehydrate activeAccountId
    // from Supabase AFTER the context effect had already set it to null,
    // making the dashboard show zero trades on load even with "All Accounts" selected.
    return entries
      .flatMap((entry) => entry.trades.map(toApiTrade))
      .filter((trade) => !deleted.has(trade.id));
  }, [deletedTradeIds, entries]);

  const fetchTrades = useCallback(async () => {
    return;
  }, []);

  useEffect(() => {
    if (entries.length > 0 || legacyTradesRestorePromise) return;

    legacyTradesRestorePromise = (async () => {
      try {
        const legacyTrades = await tradesApi.getAll();
        if (!Array.isArray(legacyTrades) || legacyTrades.length === 0) return;
        if (useFlyxaStore.getState().entries.length > 0) return;

        const grouped = new Map<string, ReturnType<typeof createEmptyJournalEntry>>();

        legacyTrades.forEach((trade) => {
          const date = trade.trade_date ?? new Date().toISOString().slice(0, 10);
          const accountId = trade.accountIds?.[0] ?? trade.accountId ?? trade.account_id ?? activeAccountId ?? DEFAULT_ACCOUNT_ID;
          const key = `${date}::${accountId}`;
          let entry = grouped.get(key);

          if (!entry) {
            entry = createEmptyJournalEntry(date, accountId);
            grouped.set(key, entry);
          }

          entry.trades.push(toStoreTrade(trade, entry.id, accountId));
        });

        const restoredEntries = Array.from(grouped.values()).filter(entry => entry.trades.length > 0);
        if (restoredEntries.length > 0) {
          setEntries(restoredEntries, { notifyAchievements: false });
          await flushSupabaseStoreNow();
        }
      } catch {
        // Legacy table may not exist or backend may be offline; the journal store remains the source of truth.
      }
    })();
  }, [activeAccountId, entries.length, setEntries]);

  const createTrade = useCallback(async (data: Partial<ApiTrade>): Promise<ApiTrade> => {
    const tradeDate = data.trade_date ?? new Date().toISOString().slice(0, 10);
    const accountId = data.accountIds?.[0] ?? data.accountId ?? data.account_id ?? activeAccountId ?? DEFAULT_ACCOUNT_ID;
    let entry = entries.find((candidate) => candidate.date === tradeDate && candidate.account === accountId);

    if (!entry) {
      entry = createEmptyJournalEntry(tradeDate, accountId);
      addEntry(entry);
    }

    const trade = toStoreTrade(data, entry.id, accountId);
    addTrade(entry.id, trade);
    return toApiTrade(trade);
  }, [activeAccountId, addEntry, addTrade, entries]);

  const updateTrade = useCallback(async (id: string, data: Partial<ApiTrade>): Promise<ApiTrade> => {
    const entry = entries.find((candidate) => candidate.trades.some((trade) => trade.id === id));
    if (!entry) {
      throw new Error('Trade not found');
    }

    const patch: Partial<StoreTrade> = {
      symbol: data.symbol,
      direction: data.direction === 'Short' ? 'SHORT' : data.direction === 'Long' ? 'LONG' : undefined,
      entry: data.entry_price,
      sl: data.sl_price,
      tp: data.tp_price,
      exit: data.exit_price,
      contracts: data.contract_size,
      time: data.trade_time,
      exitTime: typeof data.close_time === 'string' ? data.close_time : undefined,
      duration: typeof data.trade_length_seconds === 'number' ? Math.round(data.trade_length_seconds / 60) : undefined,
      account: data.accountIds?.[0] ?? data.accountId ?? data.account_id,
      accountIds: data.accountIds,
      scannedImageUrl: data.screenshot_url,
      reflection: {
        thesis: data.pre_trade_notes ?? '',
        execution: data.post_trade_notes ?? '',
        adjustment: '',
        processGrade: 0,
        followedPlan: typeof data.followed_plan === 'boolean' ? data.followed_plan : null,
        followedPlanLogged: typeof data.followed_plan === 'boolean',
      },
      emotionalState: data.emotional_state === null ? null : (typeof data.emotional_state === 'string' ? normalizeEmotion(data.emotional_state) : undefined),
      confidenceLevel: data.confidence_level === null
        ? null
        : (typeof data.confidence_level === 'number' && Number.isFinite(data.confidence_level) ? data.confidence_level : undefined),
      confluences: normalizeConfluences(data.confluences),
      pnlOverride: typeof data.pnlOverride === 'number' && Number.isFinite(data.pnlOverride) ? data.pnlOverride : undefined,
    };

    updateTradeInStore(entry.id, id, patch);
    const updatedEntry = useFlyxaStore.getState().entries.find((candidate) => candidate.id === entry.id);
    const updatedTrade = updatedEntry?.trades.find((trade) => trade.id === id);
    if (!updatedTrade) {
      throw new Error('Trade update failed');
    }
    return toApiTrade(updatedTrade);
  }, [entries, updateTradeInStore]);

  const deleteTrade = useCallback(async (id: string): Promise<void> => {
    const entry = entries.find((candidate) => candidate.trades.some((trade) => trade.id === id));
    if (!entry) return;

    persistDeletedTradeId(id);
    deleteTradeInStore(entry.id, id);
    await flushSupabaseStoreNow();

    try {
      await tradesApi.delete(id);
    } catch {
      // Best effort cleanup for legacy backend rows.
    }
  }, [deleteTradeInStore, entries]);

  return {
    trades,
    loading: false,
    error: null,
    fetchTrades,
    createTrade,
    updateTrade,
    deleteTrade,
  };
}
