import type { StateStorage } from 'zustand/middleware';
import { supabase } from '../services/api.js';
import { shouldPreferLocalStore } from '../utils/storeFreshness.js';
import { DEFAULT_STRUCTURED_RULES, normalizeRiskRule } from '../utils/tradingRules.js';
import type { RiskRule } from './types.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const SAVE_DEBOUNCE_MS = 500;

// Per-user localStorage keys — each auth account gets its own slot so accounts
// on the same device never share or contaminate each other's cached data.
function localStoreKey(userId: string)       { return `flyxa-store-${userId}`; }
function localSavedAtKey(userId: string)     { return `flyxa-store-saved-at-${userId}`; }
function localEntriesSafeKey(userId: string) { return `flyxa-entries-safe-${userId}`; }

// Legacy shared keys — read-only, used only for one-time migration of existing users.
const LEGACY_STORE_KEY            = 'flyxa-store';
const LEGACY_STORE_UID_KEY        = 'flyxa-store-uid';
const LEGACY_ENTRIES_SAFE_KEY     = 'flyxa-entries-safe';
const LEGACY_ENTRIES_SAFE_UID_KEY = 'flyxa-entries-safe-uid';
const LEGACY_SAVED_AT_KEY         = 'flyxa-store-saved-at';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeRiskRuleForSignature(rule: unknown): Record<string, unknown> | null {
  if (!rule || typeof rule !== 'object') return null;
  const normalized = normalizeRiskRule(rule as RiskRule);
  return {
    id: normalized.id,
    label: normalized.label,
    value: normalized.value,
    unit: normalized.unit,
    color: normalized.color ?? 'neutral',
    kind: normalized.kind ?? 'manual',
    enabled: normalized.enabled !== false,
    startTime: normalized.startTime ?? '',
    endTime: normalized.endTime ?? '',
    contractLimits: normalized.contractLimits ?? {},
  };
}

const DEFAULT_RISK_RULE_SIGNATURE = stableStringify(
  DEFAULT_STRUCTURED_RULES.map(normalizeRiskRuleForSignature)
);

function hasMeaningfulRiskRules(state: Record<string, unknown>): boolean {
  if (!Array.isArray(state.riskRules)) return false;
  const normalized = state.riskRules
    .map(normalizeRiskRuleForSignature)
    .filter((rule): rule is Record<string, unknown> => Boolean(rule));
  if (normalized.length === 0) return false;
  return stableStringify(normalized) !== DEFAULT_RISK_RULE_SIGNATURE;
}

function hasMeaningfulPlanBlocks(state: Record<string, unknown>): boolean {
  if (!Array.isArray(state.planBlocks)) return false;
  return state.planBlocks.some(block => (
    block != null &&
    typeof block === 'object' &&
    typeof (block as Record<string, unknown>).content === 'string' &&
    ((block as Record<string, unknown>).content as string).trim().length > 0
  ));
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: string | null = null;
// latestValue is set synchronously at the start of setItem (before any awaits)
// so flushSupabaseStoreNow always has the freshest state even when setItem's
// async getUserId() call hasn't completed yet — fixing the race condition where
// flushSupabaseStoreNow could read stale localStorage and save the wrong state.
let latestValue: string | null = null;
let cachedUserId: string | null = null;
let cachedToken: string | null = null;
let setItemRevision = 0;
let saveQueue: Promise<void> = Promise.resolve();

function stripBase64Images(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('data:image') || value.startsWith('data:application') ? '' : value;
  }
  if (Array.isArray(value)) return value.map(stripBase64Images);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripBase64Images(v)])
    );
  }
  return value;
}

async function getUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  cachedUserId = session?.user?.id ?? null;
  cachedToken = session?.access_token ?? null;
  return cachedUserId;
}

function extractEntries(value: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(value) as { state?: { entries?: unknown[] } };
    const entries = parsed?.state?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (e): e is Record<string, unknown> =>
        e != null && typeof e === 'object' &&
        typeof (e as Record<string, unknown>).id === 'string' &&
        typeof (e as Record<string, unknown>).date === 'string'
    );
  } catch {
    return [];
  }
}

function extractPreSessionHistory(value: string): Array<{ id: string; data: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(value) as { state?: { preSessionHistory?: Record<string, unknown> } };
    const history = parsed?.state?.preSessionHistory;
    if (!history || typeof history !== 'object') return [];
    return Object.entries(history)
      .filter(([id, data]) => typeof id === 'string' && data != null && typeof data === 'object')
      .map(([id, data]) => ({ id, data: data as Record<string, unknown> }));
  } catch {
    return [];
  }
}

function deletedTradeIdsFromBlob(blob: unknown): Set<string> {
  const ids = (blob as { state?: { deletedTradeIds?: unknown[] } } | null)?.state?.deletedTradeIds;
  const restoredDates = restoredEntryDatesFromBlob(blob);
  const restoredTradeIds = tradeIdsForDates(blob, restoredDates);
  return new Set(
    (Array.isArray(ids) ? ids : [])
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => !restoredTradeIds.has(id))
  );
}

function deletedEntryDatesFromBlob(blob: unknown): Set<string> {
  const dates = (blob as { state?: { deletedEntryDates?: unknown[] } } | null)?.state?.deletedEntryDates;
  const restoredDates = restoredEntryDatesFromBlob(blob);
  return new Set(
    (Array.isArray(dates) ? dates : [])
      .filter((date): date is string => typeof date === 'string')
      .filter((date) => !restoredDates.has(date))
  );
}

function restoredEntryDatesFromBlob(blob: unknown): Set<string> {
  const dates = (blob as { state?: { restoredEntryDates?: unknown[] } } | null)?.state?.restoredEntryDates;
  return new Set((Array.isArray(dates) ? dates : []).filter((date): date is string => typeof date === 'string'));
}

function tradeIdsForDates(blob: unknown, dates: Set<string>): Set<string> {
  const entries = (blob as { state?: { entries?: unknown[] } } | null)?.state?.entries;
  const ids = new Set<string>();
  if (!Array.isArray(entries) || dates.size === 0) return ids;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.date !== 'string' || !dates.has(record.date) || !Array.isArray(record.trades)) continue;
    for (const trade of record.trades) {
      if (!trade || typeof trade !== 'object') continue;
      const id = (trade as Record<string, unknown>).id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

function removeDeletedTradesFromEntry(entry: Record<string, unknown>, deletedTradeIds: Set<string>): Record<string, unknown> {
  if (deletedTradeIds.size === 0 || !Array.isArray(entry.trades)) return entry;
  return {
    ...entry,
    trades: entry.trades.filter((trade) => {
      if (!trade || typeof trade !== 'object') return true;
      const id = (trade as Record<string, unknown>).id;
      return typeof id !== 'string' || !deletedTradeIds.has(id);
    }),
  };
}

function sanitizeStoreBlob(parsed: unknown): unknown {
  const deletedTradeIds = deletedTradeIdsFromBlob(parsed);
  const deletedEntryDates = deletedEntryDatesFromBlob(parsed);
  if (deletedTradeIds.size === 0 && deletedEntryDates.size === 0) return parsed;

  const base = parsed as { state?: { entries?: unknown[] } };
  const entries = base?.state?.entries;
  if (!Array.isArray(entries)) return parsed;

  return {
    ...(parsed as Record<string, unknown>),
    state: {
      ...(base.state ?? {}),
      entries: entries.map((entry) => (
        entry && typeof entry === 'object'
          ? removeDeletedTradesFromEntry(entry as Record<string, unknown>, deletedTradeIds)
          : entry
      )).filter(entry => (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).date !== 'string' ||
        !deletedEntryDates.has((entry as Record<string, unknown>).date as string)
      )),
      deletedTradeIds: Array.from(deletedTradeIds),
      deletedEntryDates: Array.from(deletedEntryDates),
    },
  };
}

function sanitizeStoreValue(value: string): string {
  try {
    return JSON.stringify(sanitizeStoreBlob(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
}

function entryRecordsFromBlob(blob: unknown): Record<string, unknown>[] {
  const entries = (blob as { state?: { entries?: unknown[] } } | null)?.state?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is Record<string, unknown> =>
      entry != null && typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).id === 'string'
  );
}

function entryMergeKey(entry: Record<string, unknown>): string | null {
  if (typeof entry.date === 'string' && entry.date.trim()) return `date:${entry.date}`;
  if (typeof entry.id === 'string' && entry.id.trim()) return `id:${entry.id}`;
  return null;
}

function tradeRecordsFromEntry(entry: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(entry.trades)
    ? entry.trades.filter((trade): trade is Record<string, unknown> => trade != null && typeof trade === 'object')
    : [];
}

function tradeMergeKey(trade: Record<string, unknown>): string | null {
  if (typeof trade.id === 'string' && trade.id.trim()) return `id:${trade.id}`;
  const date = typeof trade.date === 'string' ? trade.date : '';
  const symbol = typeof trade.symbol === 'string' ? trade.symbol : '';
  const entryTime = typeof trade.entryTime === 'string' ? trade.entryTime : '';
  const entryPrice = typeof trade.entryPrice === 'number' || typeof trade.entryPrice === 'string'
    ? String(trade.entryPrice)
    : '';
  return date || symbol || entryTime || entryPrice
    ? `sig:${date}|${symbol}|${entryTime}|${entryPrice}`
    : null;
}

function mergeScreenshots(localValue: unknown, remoteValue: unknown): unknown {
  if (Array.isArray(localValue) && localValue.length > 0) return localValue;
  if (Array.isArray(remoteValue) && remoteValue.length > 0) return remoteValue;
  return localValue ?? remoteValue;
}

function mergeRemoteEntryIntoLocal(
  localEntry: Record<string, unknown>,
  remoteEntry: Record<string, unknown>,
  deletedTradeIds: Set<string>
): Record<string, unknown> {
  const localTrades = tradeRecordsFromEntry(localEntry)
    .filter((trade) => typeof trade.id !== 'string' || !deletedTradeIds.has(trade.id));
  const localTradeKeys = new Set(
    localTrades
      .map(tradeMergeKey)
      .filter((key): key is string => typeof key === 'string')
  );
  const remoteTradesToAdd = tradeRecordsFromEntry(remoteEntry)
    .filter((trade) => typeof trade.id !== 'string' || !deletedTradeIds.has(trade.id))
    .filter((trade) => {
      const key = tradeMergeKey(trade);
      return !key || !localTradeKeys.has(key);
    });

  return {
    ...remoteEntry,
    ...localEntry,
    screenshots: mergeScreenshots(localEntry.screenshots, remoteEntry.screenshots),
    scannedImageUrl: localEntry.scannedImageUrl || remoteEntry.scannedImageUrl,
    trades: [...localTrades, ...remoteTradesToAdd],
  };
}

/**
 * If the merged blob is missing important user state (accounts, tradingPlan,
 * rivals, etc.) but the remote blob has it, copy it back in. This prevents
 * blank initial Zustand state from silently wiping user data even when the
 * entry-merge guard or the setItem guard misfires.
 */
function recoverMissingStateFromRemote(
  mergedBlob: Record<string, unknown>,
  remoteBlob: Record<string, unknown> | null
): Record<string, unknown> {
  if (!remoteBlob) return mergedBlob;

  const mergedState = (mergedBlob.state ?? {}) as Record<string, unknown>;
  const remoteState = ((remoteBlob as Record<string, unknown>).state ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  // Accounts: only recover when merged has no non-default accounts but remote does
  const mAccounts = mergedState.accounts as Array<Record<string, unknown>> | undefined;
  const rAccounts = remoteState.accounts as Array<Record<string, unknown>> | undefined;
  if (
    Array.isArray(rAccounts) && rAccounts.some(a => a.id !== 'default-account') &&
    !(Array.isArray(mAccounts) && mAccounts.some(a => a.id !== 'default-account'))
  ) {
    patch.accounts = rAccounts;
  }

  // Arrays: recover when local is empty but remote is not
  for (const key of ['tradingPlanRules', 'rivals', 'goals']) {
    const mArr = mergedState[key];
    const rArr = remoteState[key];
    if (Array.isArray(rArr) && rArr.length > 0 && !(Array.isArray(mArr) && mArr.length > 0)) {
      patch[key] = rArr;
    }
  }

  // Trading plan rules are first-class user data. Recover remote rules when:
  //   1. merged has no rules array at all, OR
  //   2. remote rules are strictly newer (by riskRulesUpdatedAt timestamp), OR
  //   3. remote has meaningful custom rules but merged only has defaults — UNLESS
  //      merged carries a strictly newer timestamp (i.e. the user intentionally
  //      reset to defaults after the remote version was saved).
  const mRiskRules = mergedState.riskRules;
  const rRiskRules = remoteState.riskRules;
  const mergedRulesAt = timestampMs(mergedState.riskRulesUpdatedAt);
  const remoteRulesAt = timestampMs(remoteState.riskRulesUpdatedAt);
  const remoteRulesAreNewer = remoteRulesAt !== null && (mergedRulesAt === null || remoteRulesAt > mergedRulesAt);
  // merged is "strictly newer" only when it has a timestamp AND that timestamp
  // beats the remote timestamp (or remote has none).
  const mergedIsStrictlyNewer = mergedRulesAt !== null && (remoteRulesAt === null || mergedRulesAt > remoteRulesAt);
  // Remote has intentional custom rules; merged has only defaults (or no rules)
  // and is NOT from a more-recent intentional change → recover remote.
  const remoteHasCustomMergedHasDefault =
    hasMeaningfulRiskRules(remoteState) &&
    !hasMeaningfulRiskRules(mergedState) &&
    !mergedIsStrictlyNewer;
  if (
    Array.isArray(rRiskRules) &&
    rRiskRules.length > 0 &&
    (
      !Array.isArray(mRiskRules) ||
      remoteRulesAreNewer ||
      remoteHasCustomMergedHasDefault
    )
  ) {
    patch.riskRules = rRiskRules;
    if (typeof remoteState.riskRulesUpdatedAt === 'string') {
      patch.riskRulesUpdatedAt = remoteState.riskRulesUpdatedAt;
    }
  }

  const mPlanBlocks = mergedState.planBlocks;
  const rPlanBlocks = remoteState.planBlocks;
  if (
    Array.isArray(rPlanBlocks) &&
    rPlanBlocks.length > 0 &&
    (
      !Array.isArray(mPlanBlocks) ||
      (hasMeaningfulPlanBlocks(remoteState) && !hasMeaningfulPlanBlocks(mergedState))
    )
  ) {
    patch.planBlocks = rPlanBlocks;
  }

  // Objects (moods, titles): recover when local has no keys but remote does
  for (const key of ['journalMoods', 'journalTitles']) {
    const mObj = mergedState[key];
    const rObj = remoteState[key];
    if (rObj && typeof rObj === 'object' && Object.keys(rObj as object).length > 0 &&
        !(mObj && typeof mObj === 'object' && Object.keys(mObj as object).length > 0)) {
      patch[key] = rObj;
    }
  }

  // tradingPlan: recover if local is null/undefined
  if (remoteState.tradingPlan != null && mergedState.tradingPlan == null) {
    patch.tradingPlan = remoteState.tradingPlan;
  }

  if (Object.keys(patch).length === 0) return mergedBlob;
  return { ...mergedBlob, state: { ...mergedState, ...patch } };
}

function mergeRemoteEntriesIntoStoreBlob(
  localBlob: unknown,
  remoteBlob: unknown,
  deletedTradeIds = new Set([
    ...deletedTradeIdsFromBlob(remoteBlob),
    ...deletedTradeIdsFromBlob(localBlob),
  ]),
  deletedEntryDates = new Set([
    ...deletedEntryDatesFromBlob(remoteBlob),
    ...deletedEntryDatesFromBlob(localBlob),
  ])
): Record<string, unknown> {
  const localRecord = (localBlob && typeof localBlob === 'object')
    ? (localBlob as Record<string, unknown>)
    : { state: {}, version: 1 };
  const localState = (localRecord.state && typeof localRecord.state === 'object')
    ? (localRecord.state as Record<string, unknown>)
    : {};
  const localEntries = entryRecordsFromBlob(localRecord)
    .filter((entry) => typeof entry.date !== 'string' || !deletedEntryDates.has(entry.date))
    .map((entry) => removeDeletedTradesFromEntry(entry, deletedTradeIds));
  const remoteEntries = entryRecordsFromBlob(remoteBlob)
    .filter((entry) => typeof entry.date !== 'string' || !deletedEntryDates.has(entry.date))
    .map((entry) => removeDeletedTradesFromEntry(entry, deletedTradeIds));

  if (remoteEntries.length === 0) {
    return {
      ...localRecord,
      state: {
        ...localState,
        entries: localEntries,
      },
    };
  }

  const mergedByKey = new Map<string, Record<string, unknown>>();
  const looseEntries: Record<string, unknown>[] = [];

  for (const entry of localEntries) {
    const key = entryMergeKey(entry);
    if (key) {
      mergedByKey.set(key, entry);
    } else {
      looseEntries.push(entry);
    }
  }

  for (const remoteEntry of remoteEntries) {
    const key = entryMergeKey(remoteEntry);
    if (!key) {
      looseEntries.push(remoteEntry);
      continue;
    }

    const existing = mergedByKey.get(key);
    mergedByKey.set(
      key,
      existing
        ? mergeRemoteEntryIntoLocal(existing, remoteEntry, deletedTradeIds)
        : remoteEntry
    );
  }

  const entries = [...mergedByKey.values(), ...looseEntries]
    .filter((entry) => {
      const trades = tradeRecordsFromEntry(entry);
      return trades.length > 0 || Object.keys(entry).some((key) => !['id', 'date', 'trades'].includes(key));
    })
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  return {
    ...localRecord,
    state: {
      ...localState,
      entries,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-user safe-entry backup
// ---------------------------------------------------------------------------

function mirrorLocalEntriesSafe(
  entries: Record<string, unknown>[],
  userId: string,
  deletedTradeIds: Set<string> = new Set(),
  deletedEntryDates: Set<string> = new Set()
): void {
  try {
    // Build a set of entry IDs that are in the current (authoritative) state.
    const incomingIds = new Set(
      entries.map(e => e.id as string).filter(id => typeof id === 'string' && id.length > 0)
    );
    const existing = readLocalEntriesSafe(userId);
    const next: Record<string, unknown> = {};

    // An entry is worth keeping in the local backup if it has trades OR if it
    // has meaningful content beyond the bare id/date/trades skeleton (e.g. a
    // blank trading day created by createEmptyJournalEntry always has
    // reflection, rules, psychology, emotions, account, etc.).
    const isWorthKeeping = (e: Record<string, unknown>) => {
      const trades = Array.isArray(e.trades) ? e.trades : [];
      if (trades.length > 0) return true;
      return Object.keys(e).some(k => !['id', 'date', 'trades'].includes(k));
    };

    // Seed from existing safe backup — but ONLY for entries that are NOT in the
    // current state (e.g. an entry synced from another device that this device
    // hasn't loaded yet). Entries that ARE in the current state will be written
    // below with the authoritative version, so seeding them here would only risk
    // preserving stale/phantom trades.
    for (const entry of existing) {
      const id = entry.id as string;
      if (incomingIds.has(id)) continue; // Handled by authoritative write below
      if (typeof entry.date === 'string' && deletedEntryDates.has(entry.date)) continue;
      const cleaned = removeDeletedTradesFromEntry(entry, deletedTradeIds);
      if (isWorthKeeping(cleaned)) next[id] = cleaned;
    }

    // Write all incoming entries directly — always prefer the current state over
    // whatever was previously cached. This ensures deletions and cleanups (e.g.
    // removing phantom blank trades) are immediately reflected in the safe backup
    // rather than being overwritten by a stale higher-count version.
    for (const entry of entries) {
      if (typeof entry.date === 'string' && deletedEntryDates.has(entry.date)) continue;
      const id = entry.id as string;
      if (!id) continue;
      const stripped = stripBase64Images(
        removeDeletedTradesFromEntry(entry, deletedTradeIds)
      ) as Record<string, unknown>;
      if (isWorthKeeping(stripped)) next[id] = stripped;
    }

    localStorage.setItem(localEntriesSafeKey(userId), JSON.stringify(next));
  } catch { /* quota */ }
}

function readLocalEntriesSafe(userId: string): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem(localEntriesSafeKey(userId));
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(map).filter(
      (e): e is Record<string, unknown> => e != null && typeof e === 'object'
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Legacy migration helpers (read-only — never write to legacy keys)
// ---------------------------------------------------------------------------

/** Read from the old shared `flyxa-store` key only if it is tagged with this userId. */
function readLegacyLocalStore(userId: string): string | null {
  try {
    const localUid = localStorage.getItem(LEGACY_STORE_UID_KEY);
    if (localUid !== userId) return null;
    return localStorage.getItem(LEGACY_STORE_KEY);
  } catch {
    return null;
  }
}

/** Read entries from the old shared `flyxa-entries-safe` key only if tagged for this user. */
function readLegacyEntriesSafe(userId: string): Record<string, unknown>[] {
  try {
    const storedUid = localStorage.getItem(LEGACY_ENTRIES_SAFE_UID_KEY);
    if (storedUid !== userId) return [];
    const raw = localStorage.getItem(LEGACY_ENTRIES_SAFE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(map).filter(
      (e): e is Record<string, unknown> => e != null && typeof e === 'object'
    );
  } catch {
    return [];
  }
}

/** Remove all legacy shared keys — called once during removeItem to clean up. */
function clearLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_STORE_KEY);
    localStorage.removeItem(LEGACY_STORE_UID_KEY);
    localStorage.removeItem(LEGACY_ENTRIES_SAFE_KEY);
    localStorage.removeItem(LEGACY_ENTRIES_SAFE_UID_KEY);
    localStorage.removeItem(LEGACY_SAVED_AT_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function syncPreSessionsToTable(userId: string, sessions: Array<{ id: string; data: Record<string, unknown> }>): Promise<void> {
  if (sessions.length === 0) return;
  const rows = sessions.map(s => ({
    id: s.id,
    user_id: userId,
    data: s.data,
    updated_at: new Date().toISOString(),
  }));
  await supabase.from('pre_sessions').upsert(rows, { onConflict: 'user_id,id' });
}

async function syncEntriesToTable(
  userId: string,
  entries: Record<string, unknown>[],
  deletedTradeIds: Set<string>,
  deletedEntryDates: Set<string>
): Promise<void> {
  const protectedEntries = entries
    .filter((entry) => typeof entry.date !== 'string' || !deletedEntryDates.has(entry.date))
    .map((entry) => removeDeletedTradesFromEntry(entry, deletedTradeIds));
  const rows = protectedEntries.map(e => ({
    id: e.id as string,
    user_id: userId,
    date: e.date as string,
    data: stripBase64Images(e) as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('store_entries_backup')
      .upsert(rows, { onConflict: 'id' });
    if (upsertError) throw upsertError;
  }

  // Never delete backup rows merely because this client does not currently see
  // them. Another browser/friend may have logged that trade moments ago. Only
  // explicit date tombstones are allowed to remove backup rows.
  if (deletedEntryDates.size > 0) {
    const { error: deleteError } = await supabase
      .from('store_entries_backup')
      .delete()
      .eq('user_id', userId)
      .in('date', Array.from(deletedEntryDates));
    if (deleteError) throw deleteError;
  }
}

async function readBackupEntries(userId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('store_entries_backup')
    .select('data')
    .eq('user_id', userId)
    .order('date', { ascending: false });

  if (error || !data) return [];
  return data
    .map((row: { data: unknown }) => row.data)
    .filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object');
}


async function recoverFromJournalEntries(
  userId: string,
  baseBlob: unknown
): Promise<string | null> {
  try {
    const entries = await readBackupEntries(userId);
    if (entries.length === 0) return null;
    const base = (baseBlob ?? { state: {}, version: 1 }) as Record<string, unknown>;
    const rebuilt = {
      ...base,
      state: {
        ...(base.state as Record<string, unknown> ?? {}),
        entries,
      },
    };
    return JSON.stringify(sanitizeStoreBlob(rebuilt));
  } catch {
    return null;
  }
}

async function flushSave(userId: string, value: string): Promise<void> {
  let sanitizedValue = sanitizeStoreValue(value);
  let parsed = JSON.parse(sanitizedValue) as Record<string, unknown>;
  const { data: existingStore, error: existingStoreError } = await supabase
    .from('user_store')
    .select('flyxa_data')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingStoreError) throw existingStoreError;

  const remoteBlob = existingStore?.flyxa_data as Record<string, unknown> | null;
  const restoredEntryDates = restoredEntryDatesFromBlob(parsed);
  const restoredTradeIds = tradeIdsForDates(parsed, restoredEntryDates);
  const deletedTradeIds = new Set([
    ...deletedTradeIdsFromBlob(remoteBlob),
    ...deletedTradeIdsFromBlob(parsed),
  ].filter((id) => !restoredTradeIds.has(id)));
  const deletedEntryDates = new Set([
    ...deletedEntryDatesFromBlob(remoteBlob),
    ...deletedEntryDatesFromBlob(parsed),
  ].filter((date) => !restoredEntryDates.has(date)));
  parsed = mergeRemoteEntriesIntoStoreBlob(parsed, remoteBlob, deletedTradeIds, deletedEntryDates);
  // Ensure accounts, tradingPlan, etc. are never wiped by a blank incoming snapshot
  parsed = recoverMissingStateFromRemote(parsed, remoteBlob);
  parsed = {
    ...parsed,
    state: {
      ...((parsed.state as Record<string, unknown>) ?? {}),
      deletedTradeIds: Array.from(deletedTradeIds),
      deletedEntryDates: Array.from(deletedEntryDates),
      restoredEntryDates: Array.from(restoredEntryDates),
    },
  };
  sanitizedValue = sanitizeStoreValue(JSON.stringify(parsed));
  parsed = JSON.parse(sanitizedValue) as Record<string, unknown>;
  const sanitized = stripBase64Images(parsed);
  const now = new Date().toISOString();

  const { error } = await supabase.from('user_store').upsert(
    { user_id: userId, flyxa_data: sanitized, updated_at: now },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  try { localStorage.setItem(localSavedAtKey(userId), Date.now().toString()); } catch { /* quota */ }

  const entries = extractEntries(sanitizedValue);
  await syncEntriesToTable(userId, entries, deletedTradeIds, deletedEntryDates);
  mirrorLocalEntriesSafe(entries, userId, deletedTradeIds, deletedEntryDates);

  const preSessions = extractPreSessionHistory(sanitizedValue);
  await syncPreSessionsToTable(userId, preSessions);
}

async function flushSaveWithRetry(userId: string, value: string, attempt = 0): Promise<boolean> {
  try {
    await flushSave(userId, value);
    return true;
  } catch {
    if (attempt < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      return flushSaveWithRetry(userId, value, attempt + 1);
    }
    return false;
  }
}

function enqueueStoreSave(userId: string, value: string): Promise<boolean> {
  const task = saveQueue.then(() => flushSaveWithRetry(userId, value));
  saveQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function saveStoreStatePatchNow(
  patch: Record<string, unknown>,
): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const userId = await getUserId();
  if (!userId) throw new Error('You must be signed in to save Flyxa data');

  const source = latestValue ?? pendingValue
    ?? localStorage.getItem(localStoreKey(userId))
    ?? localStorage.getItem(LEGACY_STORE_KEY)
    ?? JSON.stringify({ state: {}, version: 1 });
  const parsed = JSON.parse(sanitizeStoreValue(source)) as {
    state?: Record<string, unknown>;
    version?: number;
  };
  const value = sanitizeStoreValue(JSON.stringify({
    ...parsed,
    state: {
      ...(parsed.state ?? {}),
      ...patch,
    },
    version: parsed.version ?? 1,
  }));

  ++setItemRevision;
  latestValue = value;
  pendingValue = value;
  try {
    localStorage.setItem(localStoreKey(userId), value);
    localStorage.setItem(localSavedAtKey(userId), Date.now().toString());
  } catch {
    // The queued cloud save remains authoritative if browser storage is full.
  }

  const saved = await enqueueStoreSave(userId, value);
  if (!saved) throw new Error('Could not save Flyxa data to Supabase');

  if (latestValue === value) latestValue = null;
  if (pendingValue === value) pendingValue = null;
}

export async function flushSupabaseStoreNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const userId = await getUserId();
  if (!userId) return;

  // Prefer latestValue (set synchronously at the start of setItem before any
  // awaits) so we always flush the freshest state, even when setItem's async
  // getUserId() hasn't completed yet and localStorage is still stale.
  const value = latestValue ?? pendingValue ?? (
    typeof window !== 'undefined'
      ? (localStorage.getItem(localStoreKey(userId)) ?? localStorage.getItem(LEGACY_STORE_KEY))
      : null
  );
  if (!value) return;

  const saved = await enqueueStoreSave(userId, value);
  if (!saved) {
    // Keep the newest snapshot available for the next write/flush attempt.
    latestValue = value;
    pendingValue = value;
    throw new Error('Could not save Flyxa data to Supabase');
  }
  if (latestValue === value) latestValue = null;
  if (pendingValue === value) pendingValue = null;
}

// ---------------------------------------------------------------------------
// Dedicated risk_rules table — atomic read/write independent of the main blob
// ---------------------------------------------------------------------------

export async function saveRiskRulesNow(rules: unknown[], updatedAt: string): Promise<void> {
  const userId = cachedUserId ?? await getUserId();
  if (!userId) return;
  await supabase.from('risk_rules').upsert(
    { user_id: userId, rules, updated_at: updatedAt },
    { onConflict: 'user_id' }
  );
}

export async function loadRiskRulesFromSupabase(): Promise<{ rules: unknown[]; updatedAt: string } | null> {
  const userId = cachedUserId ?? await getUserId();
  if (!userId) return null;
  const { data } = await supabase
    .from('risk_rules')
    .select('rules, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data?.rules || !Array.isArray(data.rules) || data.rules.length === 0) return null;
  return { rules: data.rules as unknown[], updatedAt: data.updated_at as string };
}

/**
 * Patches dedicated risk_rules table data into a store blob if the dedicated
 * table has a newer timestamp than what's already in the blob.
 */
function applyDedicatedRules(
  blob: Record<string, unknown>,
  dedicated: { rules: unknown[]; updatedAt: string } | null
): Record<string, unknown> {
  if (!dedicated || !Array.isArray(dedicated.rules) || dedicated.rules.length === 0) return blob;
  const blobState = (blob.state ?? {}) as Record<string, unknown>;
  const blobRulesAt = timestampMs(blobState.riskRulesUpdatedAt);
  const dedicatedAt = timestampMs(dedicated.updatedAt);
  if (dedicatedAt === null) return blob;
  // Only override if dedicated table is strictly newer than what's in the blob.
  if (blobRulesAt !== null && blobRulesAt >= dedicatedAt) return blob;
  return {
    ...blob,
    state: {
      ...blobState,
      riskRules: dedicated.rules,
      riskRulesUpdatedAt: dedicated.updatedAt,
    },
  };
}

/**
 * Returns entries stored in the per-user safe-entry localStorage backup.
 * This backup is written on every save, even before Supabase sync completes,
 * so it can contain recently-logged trades that didn't make it to the cloud.
 */
export function readLocalSafeBackupEntries(userId: string): Record<string, unknown>[] {
  return readLocalEntriesSafe(userId);
}

/**
 * Hard-deletes a journal entry row from store_entries_backup so the recovery
 * logic in mergeEntriesWithRecovery cannot resurrect it after a user delete.
 */
export async function deleteTradingDayEverywhere(
  date: string,
  deletedTradeIds: string[],
  localStateSnapshot?: Record<string, unknown>
): Promise<void> {
  const userId = await getUserId();
  if (!userId) return;

  const { data: existing, error: readError } = await supabase
    .from('user_store')
    .select('flyxa_data')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw readError;

  const currentBlob = (existing?.flyxa_data ?? { state: {}, version: 1 }) as Record<string, unknown>;
  const cloudState = (currentBlob.state ?? {}) as Record<string, unknown>;
  const currentState = localStateSnapshot ?? cloudState;
  const currentEntries = Array.isArray(currentState.entries)
    ? currentState.entries.filter(
        (entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object'
      )
    : [];
  const existingDeletedIds = Array.isArray(currentState.deletedTradeIds)
    ? currentState.deletedTradeIds.filter((id): id is string => typeof id === 'string')
    : [];
  const nextDeletedIds = Array.from(new Set([...existingDeletedIds, ...deletedTradeIds]));
  const existingDeletedDates = new Set([
    ...deletedEntryDatesFromBlob(currentBlob),
    ...deletedEntryDatesFromBlob({ state: currentState }),
  ]);
  existingDeletedDates.add(date);
  const nextBlob = {
    ...currentBlob,
    state: {
      ...cloudState,
      ...currentState,
      entries: currentEntries.filter(entry => entry.date !== date),
      deletedTradeIds: nextDeletedIds,
      deletedEntryDates: Array.from(existingDeletedDates),
      restoredEntryDates: Array.from(
        restoredEntryDatesFromBlob({ state: currentState })
      ).filter((restoredDate) => restoredDate !== date),
    },
  };
  const sanitizedValue = sanitizeStoreValue(JSON.stringify(nextBlob));
  const sanitizedBlob = JSON.parse(sanitizedValue) as Record<string, unknown>;
  const now = new Date().toISOString();

  const { error: storeError } = await supabase
    .from('user_store')
    .upsert(
      { user_id: userId, flyxa_data: sanitizedBlob, updated_at: now },
      { onConflict: 'user_id' }
    );
  if (storeError) throw storeError;

  const { error: backupError } = await supabase
    .from('store_entries_backup')
    .delete()
    .eq('user_id', userId)
    .eq('date', date);
  if (backupError) throw backupError;

  try {
    const safeEntries = readLocalEntriesSafe(userId)
      .filter(entry => entry.date !== date);
    const safeMap = Object.fromEntries(
      safeEntries
        .filter(entry => typeof entry.id === 'string')
        .map(entry => [entry.id as string, entry])
    );
    localStorage.setItem(localEntriesSafeKey(userId), JSON.stringify(safeMap));
    localStorage.setItem(localStoreKey(userId), sanitizedValue);
    localStorage.setItem(localSavedAtKey(userId), Date.now().toString());
  } catch {
    // Cloud deletion is authoritative; local cache will reconcile on reload.
  }

  latestValue = sanitizedValue;
  pendingValue = sanitizedValue;
}

export async function clearCurrentUserStoreCache(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingValue = null;

  const userId = await getUserId();
  if (!userId) return;

  try {
    localStorage.removeItem(localStoreKey(userId));
    localStorage.removeItem(localSavedAtKey(userId));
    localStorage.removeItem(localEntriesSafeKey(userId));
  } catch { /* ignore */ }

  clearLegacyKeys();
}

// On page close/refresh fire a keepalive fetch so the save completes even if
// the tab is being destroyed.
if (typeof window !== 'undefined') {
  const flushLatestOnExit = () => {
    const exitValue = latestValue ?? pendingValue;
    if (!exitValue || !cachedUserId || !cachedToken) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    const value = sanitizeStoreValue(exitValue);
    const userId = cachedUserId;
    const token = cachedToken;
    latestValue = null;
    pendingValue = null;

    try {
      localStorage.setItem(localStoreKey(userId), value);
      localStorage.setItem(localSavedAtKey(userId), Date.now().toString());

      const parsed = JSON.parse(value) as unknown;
      const sanitized = stripBase64Images(parsed);
      const body = JSON.stringify([{
        user_id: userId,
        flyxa_data: sanitized,
        updated_at: new Date().toISOString(),
      }]);

      void fetch(`${SUPABASE_URL}/rest/v1/user_store?on_conflict=user_id`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body,
      });
    } catch { /* ignore — localStorage still has the data */ }
  };

  window.addEventListener('beforeunload', flushLatestOnExit);
  window.addEventListener('pagehide', flushLatestOnExit);
}

// ---------------------------------------------------------------------------
// Zustand storage adapter
// ---------------------------------------------------------------------------

export const supabaseZustandStorage: StateStorage = {
  getItem: async (_key: string): Promise<string | null> => {
    const userId = await getUserId();
    if (!userId) return null;

    const storeKey = localStoreKey(userId);

    try {
      // Fetch main blob and dedicated risk_rules table concurrently.
      const [{ data, error }, dedicatedRules] = await Promise.all([
        supabase.from('user_store').select('flyxa_data, updated_at').eq('user_id', userId).maybeSingle(),
        loadRiskRulesFromSupabase(),
      ]);

      if (!error && data?.flyxa_data) {
        const local = localStorage.getItem(storeKey);
        const sanitizedLocal = local ? sanitizeStoreValue(local) : null;
        const localSavedAt = localStorage.getItem(localSavedAtKey(userId));
        if (local && shouldPreferLocalStore(localSavedAt, data.updated_at)) {
          const localEntries = extractEntries(sanitizedLocal!);
          const remoteEntries = (data.flyxa_data as { state?: { entries?: unknown[] } })?.state?.entries;
          const remoteHasEntries = Array.isArray(remoteEntries) && remoteEntries.length > 0;
          // Never let a blank local snapshot (e.g. from HMR) override Supabase entries.
          if (localEntries.length > 0 || !remoteHasEntries) {
            const localBlob = JSON.parse(sanitizedLocal!) as Record<string, unknown>;
            // Merge remote entries in, then recover any non-entry state that may
            // have been wiped by a blank initial snapshot (accounts, tradingPlan, etc.)
            const entryMerged = mergeRemoteEntriesIntoStoreBlob(localBlob, data.flyxa_data);
            const recovered = applyDedicatedRules(
              recoverMissingStateFromRemote(entryMerged, data.flyxa_data as Record<string, unknown>),
              dedicatedRules
            );
            const mergedLocal = sanitizeStoreValue(JSON.stringify(recovered));
            // The browser has a newer accepted edit than Supabase. Hydrate from
            // that snapshot immediately, but first merge in any remote trades
            // that this browser had not loaded yet.
            void enqueueStoreSave(userId, mergedLocal);
            return mergedLocal;
          }
        }

        // Supabase is the source of truth across all devices.
        // Also recover preSessionHistory from the pre_sessions table if the main blob is missing it.
        let flyxaData = data.flyxa_data as Record<string, unknown>;
        if (sanitizedLocal) {
          try {
            const localBlob = JSON.parse(sanitizedLocal) as Record<string, unknown>;
            flyxaData = recoverMissingStateFromRemote(flyxaData, localBlob);
          } catch { /* local cache is non-critical */ }
        }
        // Apply dedicated risk_rules table — wins if it has a newer timestamp.
        flyxaData = applyDedicatedRules(flyxaData, dedicatedRules);
        const blobState = flyxaData.state as Record<string, unknown> | undefined;
        const blobPreSessionHistory = blobState?.preSessionHistory as Record<string, unknown> | undefined;
        if (!blobPreSessionHistory || Object.keys(blobPreSessionHistory).length === 0) {
          try {
            const { data: psRows } = await supabase
              .from('pre_sessions')
              .select('id, data')
              .eq('user_id', userId);
            if (psRows && psRows.length > 0) {
              const recovered: Record<string, unknown> = {};
              for (const row of psRows as Array<{ id: string; data: unknown }>) {
                if (typeof row.id === 'string' && row.data) recovered[row.id] = row.data;
              }
              if (Object.keys(recovered).length > 0) {
                flyxaData = {
                  ...flyxaData,
                  state: { ...(blobState ?? {}), preSessionHistory: recovered },
                };
              }
            }
          } catch { /* non-fatal — continue with existing blob */ }
        }

        const remoteEntries = (flyxaData as { state?: { entries?: unknown[] } })?.state?.entries;
        if (Array.isArray(remoteEntries) && remoteEntries.length > 0) {
          // user_store has entries — it is the authority. However, individual
          // dates can go missing if a write race or merge dropped them. Check
          // store_entries_backup for any dates not present in the main store
          // and merge them back in. Intentionally-deleted dates are still
          // excluded because mergeRemoteEntriesIntoStoreBlob respects
          // deletedEntryDates.
          try {
            const existingDates = new Set(
              (remoteEntries as Record<string, unknown>[])
                .filter(e => typeof (e as Record<string, unknown>).date === 'string')
                .map(e => (e as Record<string, unknown>).date as string)
            );
            const backupEntries = await readBackupEntries(userId);
            const missingEntries = backupEntries.filter(
              e => typeof e.date === 'string' && !existingDates.has(e.date)
            );
            if (missingEntries.length > 0) {
              const mergedBlob = applyDedicatedRules(
                mergeRemoteEntriesIntoStoreBlob(flyxaData, { state: { entries: missingEntries } } as unknown),
                dedicatedRules
              );
              const mergedValue = sanitizeStoreValue(JSON.stringify(mergedBlob));
              void enqueueStoreSave(userId, mergedValue);
              return mergedValue;
            }
          } catch { /* non-fatal — return main store as-is */ }
          return sanitizeStoreValue(JSON.stringify(flyxaData));
        }

        // user_store exists but 0 entries — try store_entries_backup table.
        // Use flyxaData (already has dedicated risk_rules applied) as the base.
        const recovered = await recoverFromJournalEntries(userId, flyxaData);
        if (recovered) {
          void enqueueStoreSave(userId, recovered);
          return recovered;
        }

        // Last resort: per-user safe backup (then legacy).
        // Use flyxaData so dedicated rules survive even this recovery path.
        const safeEntries = readLocalEntriesSafe(userId).length > 0
          ? readLocalEntriesSafe(userId)
          : readLegacyEntriesSafe(userId);
        if (safeEntries.length > 0) {
          const base = flyxaData;
          const rebuilt = JSON.stringify({
            ...base,
            state: { ...(base.state as Record<string, unknown> ?? {}), entries: safeEntries },
          });
          const sanitizedRebuilt = sanitizeStoreValue(rebuilt);
          void enqueueStoreSave(userId, sanitizedRebuilt);
          return sanitizedRebuilt;
        }

        return sanitizeStoreValue(JSON.stringify(flyxaData));
      }

      // No user_store row — try store_entries_backup table
      const recovered = await recoverFromJournalEntries(userId, null);
      if (recovered) {
        void enqueueStoreSave(userId, recovered);
        return recovered;
      }

      // Per-user localStorage cache
      const local = localStorage.getItem(storeKey);
      if (local) {
        const sanitizedLocal = sanitizeStoreValue(local);
        void enqueueStoreSave(userId, sanitizedLocal);
        return sanitizedLocal;
      }

      // Legacy localStorage — one-time migration for existing users
      const legacyLocal = readLegacyLocalStore(userId);
      if (legacyLocal) {
        const sanitizedLegacy = sanitizeStoreValue(legacyLocal);
        void enqueueStoreSave(userId, sanitizedLegacy);
        return sanitizedLegacy;
      }

      // Per-user safe backup, then legacy
      const safeEntries = readLocalEntriesSafe(userId).length > 0
        ? readLocalEntriesSafe(userId)
        : readLegacyEntriesSafe(userId);
      if (safeEntries.length > 0) {
        const rebuilt = JSON.stringify({ state: { entries: safeEntries }, version: 1 });
        const sanitizedRebuilt = sanitizeStoreValue(rebuilt);
        void enqueueStoreSave(userId, sanitizedRebuilt);
        return sanitizedRebuilt;
      }
    } catch {
      const local = localStorage.getItem(storeKey);
      if (local) return sanitizeStoreValue(local);
      const legacy = readLegacyLocalStore(userId);
      if (legacy) return sanitizeStoreValue(legacy);
      return null;
    }

    return null;
  },

  setItem: async (_key: string, value: string): Promise<void> => {
    const sanitizedValue = sanitizeStoreValue(value);

    // Guard: never overwrite existing user data with a blank/default initial state
    // (protects against HMR in dev and auth/hydration races after hard refresh).
    const incomingEntries = extractEntries(sanitizedValue);
    const incomingHasUserData = (() => {
      try {
        const parsed = JSON.parse(sanitizedValue) as { state?: Record<string, unknown> };
        const st = parsed?.state ?? {};
        const moods = st.journalMoods;
        const titles = st.journalTitles;
        const accounts = st.accounts as Array<Record<string, unknown>> | undefined;
        const rivals = st.rivals as unknown[] | undefined;
        const goals = st.goals as unknown[] | undefined;
        return (
          (moods != null && typeof moods === 'object' && Object.keys(moods).length > 0) ||
          (titles != null && typeof titles === 'object' && Object.keys(titles).length > 0) ||
          hasMeaningfulRiskRules(st) ||
          typeof st.riskRulesUpdatedAt === 'string' ||
          hasMeaningfulPlanBlocks(st) ||
          // User has created accounts beyond the built-in default
          (Array.isArray(accounts) && accounts.some(a => a.id !== 'default-account')) ||
          // User has rivals or goals
          (Array.isArray(rivals) && rivals.length > 0) ||
          (Array.isArray(goals) && goals.length > 0)
        );
      } catch { return false; }
    })();
    const incomingIsBlankUserSnapshot = incomingEntries.length === 0 && !incomingHasUserData;
    let resolvedUserId: string | null = null;

    if (incomingIsBlankUserSnapshot) {
      try {
        const uid = cachedUserId;
        const existing = uid
          ? (localStorage.getItem(localStoreKey(uid)) ?? localStorage.getItem(LEGACY_STORE_KEY))
          : localStorage.getItem(LEGACY_STORE_KEY);
        if (existing) {
          // Return if local cache has entries OR any meaningful non-default state
          if (extractEntries(existing).length > 0) return;
          try {
            const parsed = JSON.parse(existing) as { state?: Record<string, unknown> };
            const st = parsed?.state ?? {};
            const accounts = st.accounts as Array<Record<string, unknown>> | undefined;
            if (hasMeaningfulRiskRules(st) || typeof st.riskRulesUpdatedAt === 'string' || hasMeaningfulPlanBlocks(st)) return;
            if (Array.isArray(accounts) && accounts.some(a => a.id !== 'default-account')) return;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      // If Supabase has ANY existing record for this user, restore from it
      // rather than letting the blank initial Zustand state overwrite real data.
      // This fires on hard refresh before getItem has hydrated the store, and
      // also protects users who have accounts/plans but no journal entries yet.
      resolvedUserId = await getUserId();
      if (!resolvedUserId) return;
      try {
        const { data, error } = await supabase
          .from('user_store')
          .select('flyxa_data, updated_at')
          .eq('user_id', resolvedUserId)
          .maybeSingle();
        if (!error && data?.flyxa_data && Object.keys(data.flyxa_data).length > 0) {
          const remoteValue = sanitizeStoreValue(JSON.stringify(data.flyxa_data));
          localStorage.setItem(localStoreKey(resolvedUserId), remoteValue);
          localStorage.setItem(localSavedAtKey(resolvedUserId), Date.now().toString());
          latestValue = null;
          pendingValue = null;
          return;
        }
      } catch {
        // Network failures must not turn into a destructive blank save.
        return;
      }
    }

    const revision = ++setItemRevision;

    // Capture the latest accepted value synchronously before any awaits so a
    // refresh or explicit flush always sees the newest state.
    latestValue = sanitizedValue;
    pendingValue = sanitizedValue;

    // Auth is normally already cached after hydration. Write the browser cache
    // immediately so a fast refresh cannot reload an older snapshot while
    // getSession() is still resolving.
    if (cachedUserId) {
      try {
        localStorage.setItem(localStoreKey(cachedUserId), sanitizedValue);
        localStorage.setItem(localSavedAtKey(cachedUserId), Date.now().toString());
      } catch { /* quota exceeded */ }
    }

    const userId = resolvedUserId ?? await getUserId();
    if (!userId) return;
    // Multiple Zustand writes can be awaiting auth at once. An older call must
    // never finish later and replace the newest pending snapshot.
    if (revision !== setItemRevision) return;

    const storeKey = localStoreKey(userId);
    const currentValue = latestValue ?? sanitizedValue;

    try {
      localStorage.setItem(storeKey, currentValue);
      localStorage.setItem(localSavedAtKey(userId), Date.now().toString());
    } catch { /* quota exceeded */ }

    pendingValue = currentValue;
    if (saveTimer) clearTimeout(saveTimer);

    const entries = extractEntries(currentValue);
    let deletedTradeIds = new Set<string>();
    let deletedEntryDates = new Set<string>();
    try {
      const parsed = JSON.parse(currentValue) as unknown;
      deletedTradeIds = deletedTradeIdsFromBlob(parsed);
      deletedEntryDates = deletedEntryDatesFromBlob(parsed);
    } catch {
      // sanitizedValue was already validated by extractEntries; keep an empty tombstone set.
    }
    mirrorLocalEntriesSafe(entries, userId, deletedTradeIds, deletedEntryDates);

    saveTimer = setTimeout(() => {
      if (pendingValue) void enqueueStoreSave(userId, pendingValue);
    }, SAVE_DEBOUNCE_MS);
  },

  removeItem: async (_key: string): Promise<void> => {
    // Clear only this user's local cache — Supabase data is never deleted on sign-out
    // so the user's data persists and reloads correctly on next sign-in.
    // Other users' per-user caches are untouched so they can re-login quickly.
    const userId = cachedUserId;
    if (userId) {
      try {
        localStorage.removeItem(localStoreKey(userId));
        localStorage.removeItem(localSavedAtKey(userId));
      } catch { /* ignore */ }
    }
    // Clean up legacy shared keys so they can't interfere going forward.
    clearLegacyKeys();
  },
};
