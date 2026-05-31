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
  executionReview?: {
    enteredAtLevel?: boolean | null;
    waitedForConfirmation?: boolean | null;
    correctSize?: boolean | null;
    exitedAtPlan?: boolean | null;
    movedStopCorrectly?: boolean | null;
    resistedEarlyExit?: boolean | null;
  };
  preEntry?: {
    emotionalState?: string;
  };
};

function deriveEmotionalState(trade: StoreTrade): ApiTrade['emotional_state'] {
  const richTrade = trade as RichStoreTrade;
  return normalizeEmotion(richTrade.emotionalState) ?? normalizeEmotion(richTrade.preEntry?.emotionalState);
}

function deriveFollowedPlan(trade: StoreTrade): boolean | null {
  if (trade.reflection?.followedPlanLogged === true && typeof trade.reflection.followedPlan === 'boolean') {
    return trade.reflection.followedPlan;
  }

  const richTrade = trade as RichStoreTrade;
  if (Array.isArray(richTrade.behavioralFlags) && richTrade.behavioralFlags.length > 0) {
    return false;
  }

  const review = richTrade.executionReview;
  if (!review) {
    return Array.isArray(richTrade.behavioralFlags) && richTrade.behavioralFlags.length === 0 ? true : null;
  }

  const planSignals = [
    review.enteredAtLevel,
    review.waitedForConfirmation,
    review.correctSize,
    review.exitedAtPlan,
    review.resistedEarlyExit,
  ];
  const answeredSignals = planSignals.filter((value): value is boolean => typeof value === 'boolean');
  if (answeredSignals.some(value => value === false)) return false;
  if (answeredSignals.length > 0 || (Array.isArray(richTrade.behavioralFlags) && richTrade.behavioralFlags.length === 0)) {
    return true;
  }

  return null;
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

function toStoreTrade(data: Partial<ApiTrade>, entryId: string, accountId: string): StoreTrade {
  const direction = data.direction === 'Short' ? 'SHORT' : 'LONG';
  const entry = typeof data.entry_price === 'number' ? data.entry_price : 0;
  const sl = typeof data.sl_price === 'number' ? data.sl_price : entry;
  const tp = typeof data.tp_price === 'number' ? data.tp_price : entry;
  const exit = typeof data.exit_price === 'number' ? data.exit_price : null;

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
    result: 'open',
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
    account: data.accountId ?? data.account_id ?? accountId,
    createdAt: data.created_at ?? new Date().toISOString(),
  };
}

function toApiTrade(trade: StoreTrade): ApiTrade {
  const session = getSession(trade.time);
  const tradeTime = trade.time || (trade as unknown as { entryTime?: string }).entryTime || '09:30';
  const emotionalState = deriveEmotionalState(trade);
  const confidenceLevelRaw = (trade as StoreTrade).confidenceLevel;
  const confidenceLevel = typeof confidenceLevelRaw === 'number' && Number.isFinite(confidenceLevelRaw) ? confidenceLevelRaw : null;
  const followedPlan = deriveFollowedPlan(trade);
  return {
    id: trade.id,
    user_id: 'local',
    symbol: trade.symbol,
    screenshot_url: trade.scannedImageUrl ?? (trade as unknown as { screenshotUrl?: string }).screenshotUrl ?? (Array.isArray(trade.screenshots) ? trade.screenshots[0] : undefined),
    accountId: trade.account,
    account_id: trade.account,
    direction: trade.direction === 'SHORT' ? 'Short' : 'Long',
    entry_price: trade.entry,
    exit_price: trade.exit ?? trade.entry,
    sl_price: trade.sl,
    tp_price: trade.tp,
    exit_reason: trade.result === 'win' ? 'TP' : trade.result === 'loss' ? 'SL' : 'BE',
    pnl: trade.pnl,
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
    pre_trade_notes: trade.reflection?.thesis,
    post_trade_notes: trade.reflection?.execution,
    confluences: normalizeConfluences((trade as StoreTrade).confluences),
    followed_plan: typeof followedPlan === 'boolean' ? followedPlan : null,
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
          const accountId = trade.accountId ?? trade.account_id ?? activeAccountId ?? DEFAULT_ACCOUNT_ID;
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
          setEntries(restoredEntries);
          await flushSupabaseStoreNow();
        }
      } catch {
        // Legacy table may not exist or backend may be offline; the journal store remains the source of truth.
      }
    })();
  }, [activeAccountId, entries.length, setEntries]);

  const createTrade = useCallback(async (data: Partial<ApiTrade>): Promise<ApiTrade> => {
    const tradeDate = data.trade_date ?? new Date().toISOString().slice(0, 10);
    const accountId = data.accountId ?? data.account_id ?? activeAccountId ?? DEFAULT_ACCOUNT_ID;
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
      account: data.accountId ?? data.account_id,
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
