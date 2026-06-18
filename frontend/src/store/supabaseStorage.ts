import type { StateStorage } from 'zustand/middleware';
import { supabase } from '../services/api.js';

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

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: string | null = null;
// latestValue is set synchronously at the start of setItem (before any awaits)
// so flushSupabaseStoreNow always has the freshest state even when setItem's
// async getUserId() call hasn't completed yet — fixing the race condition where
// flushSupabaseStoreNow could read stale localStorage and save the wrong state.
let latestValue: string | null = null;
let cachedUserId: string | null = null;
let cachedToken: string | null = null;

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
  return new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string'));
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
  if (deletedTradeIds.size === 0) return parsed;

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
      )),
      deletedTradeIds: Array.from(deletedTradeIds),
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

// ---------------------------------------------------------------------------
// Per-user safe-entry backup
// ---------------------------------------------------------------------------

function mirrorLocalEntriesSafe(
  entries: Record<string, unknown>[],
  userId: string,
  deletedTradeIds: Set<string> = new Set()
): void {
  try {
    // Merge into the existing safe backup rather than overwriting it wholesale.
    // This ensures the backup only ever grows: if the incoming state has fewer
    // trades for an entry than what's already saved (e.g. after a failed cloud
    // sync caused an older state to be reloaded), we keep the richer version.
    const existing = readLocalEntriesSafe(userId);
    const next: Record<string, unknown> = {};

    // Seed with existing safe entries
    for (const entry of existing) {
      const cleaned = removeDeletedTradesFromEntry(entry, deletedTradeIds);
      const trades = Array.isArray(cleaned.trades) ? cleaned.trades : [];
      if (trades.length > 0) next[entry.id as string] = cleaned;
    }

    // Merge incoming entries: replace only when the incoming version has at
    // least as many trades as what's already stored.
    for (const entry of entries) {
      const id = entry.id as string;
      const stripped = stripBase64Images(entry) as Record<string, unknown>;
      const existingEntry = next[id] as Record<string, unknown> | undefined;
      if (!existingEntry) {
        next[id] = stripped;
      } else {
        const existingCount = Array.isArray(existingEntry.trades) ? existingEntry.trades.length : 0;
        const incomingCount = Array.isArray(entry.trades) ? entry.trades.length : 0;
        if (incomingCount >= existingCount) {
          next[id] = stripped;
        }
        // else keep existing — it has more trades than what's being written now
      }
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
  deletedTradeIds: Set<string>
): Promise<void> {
  if (entries.length === 0) return;

  const existingBackups = await readBackupEntries(userId);
  const protectedEntries = mergeEntriesWithRecovery(entries, existingBackups, deletedTradeIds);
  const rows = protectedEntries.map(e => ({
    id: e.id as string,
    user_id: userId,
    date: e.date as string,
    data: stripBase64Images(e) as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }));
  await supabase.from('store_entries_backup').upsert(rows, { onConflict: 'id' });
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

function mergeEntriesWithRecovery(
  primaryEntries: Record<string, unknown>[],
  recoveryEntries: Record<string, unknown>[],
  deletedTradeIds: Set<string>
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();

  for (const entry of primaryEntries) {
    if (typeof entry.id === 'string') {
      merged.set(entry.id, removeDeletedTradesFromEntry(entry, deletedTradeIds));
    }
  }

  for (const recoveryEntry of recoveryEntries) {
    if (typeof recoveryEntry.id !== 'string') continue;
    const cleanedRecovery = removeDeletedTradesFromEntry(recoveryEntry, deletedTradeIds);
    const existing = merged.get(recoveryEntry.id);

    if (!existing) {
      const recoveredTrades = Array.isArray(cleanedRecovery.trades) ? cleanedRecovery.trades : [];
      // Only revive missing entries that contain real trades. This avoids
      // resurrecting intentionally deleted blank journal days.
      if (recoveredTrades.length > 0) merged.set(recoveryEntry.id, cleanedRecovery);
      continue;
    }

    const existingTrades = Array.isArray(existing.trades) ? existing.trades : [];
    const recoveryTrades = Array.isArray(cleanedRecovery.trades) ? cleanedRecovery.trades : [];
    const tradesById = new Map<string, unknown>();

    for (const trade of recoveryTrades) {
      if (trade && typeof trade === 'object' && typeof (trade as Record<string, unknown>).id === 'string') {
        tradesById.set((trade as Record<string, unknown>).id as string, trade);
      }
    }
    for (const trade of existingTrades) {
      if (trade && typeof trade === 'object' && typeof (trade as Record<string, unknown>).id === 'string') {
        tradesById.set((trade as Record<string, unknown>).id as string, trade);
      }
    }

    merged.set(recoveryEntry.id, {
      ...cleanedRecovery,
      ...existing,
      trades: Array.from(tradesById.values()),
    });
  }

  const consolidated = new Map<string, Record<string, unknown>>();

  for (const entry of merged.values()) {
    const date = typeof entry.date === 'string' ? entry.date : '';
    const account = typeof entry.account === 'string' ? entry.account : '';
    const key = date && account ? `${date}::${account}` : `id::${String(entry.id ?? '')}`;
    const existing = consolidated.get(key);

    if (!existing) {
      consolidated.set(key, entry);
      continue;
    }

    const existingTrades = Array.isArray(existing.trades) ? existing.trades : [];
    const incomingTrades = Array.isArray(entry.trades) ? entry.trades : [];
    const richerEntry = incomingTrades.length > existingTrades.length ? entry : existing;
    const fallbackEntry = richerEntry === entry ? existing : entry;
    const tradesById = new Map<string, unknown>();

    for (const trade of [...existingTrades, ...incomingTrades]) {
      if (trade && typeof trade === 'object' && typeof (trade as Record<string, unknown>).id === 'string') {
        tradesById.set((trade as Record<string, unknown>).id as string, trade);
      }
    }

    consolidated.set(key, {
      ...fallbackEntry,
      ...richerEntry,
      trades: Array.from(tradesById.values()),
    });
  }

  return Array.from(consolidated.values());
}

function countStoredTrades(entries: Record<string, unknown>[]): number {
  return entries.reduce(
    (total, entry) => total + (Array.isArray(entry.trades) ? entry.trades.length : 0),
    0
  );
}

function storedEntrySignature(entries: Record<string, unknown>[]): string {
  return entries
    .map(entry => {
      const entryId = typeof entry.id === 'string' ? entry.id : '';
      const tradeIds = (Array.isArray(entry.trades) ? entry.trades : [])
        .map(trade => (
          trade && typeof trade === 'object' && typeof (trade as Record<string, unknown>).id === 'string'
            ? (trade as Record<string, unknown>).id as string
            : ''
        ))
        .filter(Boolean)
        .sort();
      return `${entryId}:${tradeIds.join(',')}`;
    })
    .sort()
    .join('|');
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
  const sanitizedValue = sanitizeStoreValue(value);
  const parsed = JSON.parse(sanitizedValue) as unknown;
  const sanitized = stripBase64Images(parsed);
  const now = new Date().toISOString();

  const { error } = await supabase.from('user_store').upsert(
    { user_id: userId, flyxa_data: sanitized, updated_at: now },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  try { localStorage.setItem(localSavedAtKey(userId), Date.now().toString()); } catch { /* quota */ }

  const entries = extractEntries(sanitizedValue);
  const deletedTradeIds = deletedTradeIdsFromBlob(sanitized);
  await syncEntriesToTable(userId, entries, deletedTradeIds);
  mirrorLocalEntriesSafe(entries, userId, deletedTradeIds);

  const preSessions = extractPreSessionHistory(sanitizedValue);
  await syncPreSessionsToTable(userId, preSessions);
}

async function flushSaveWithRetry(userId: string, value: string, attempt = 0): Promise<void> {
  try {
    await flushSave(userId, value);
  } catch {
    if (attempt < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      return flushSaveWithRetry(userId, value, attempt + 1);
    }
  }
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

  latestValue = null;
  pendingValue = null;
  await flushSaveWithRetry(userId, value);
}

/**
 * Returns entries stored in the per-user safe-entry localStorage backup.
 * This backup is written on every save, even before Supabase sync completes,
 * so it can contain recently-logged trades that didn't make it to the cloud.
 */
export function readLocalSafeBackupEntries(userId: string): Record<string, unknown>[] {
  return readLocalEntriesSafe(userId);
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
  window.addEventListener('beforeunload', () => {
    if (!pendingValue || !cachedUserId || !cachedToken) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    const value = sanitizeStoreValue(pendingValue);
    const userId = cachedUserId;
    const token = cachedToken;
    pendingValue = null;

    try {
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
  });
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
      const { data, error } = await supabase
        .from('user_store')
        .select('flyxa_data, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data?.flyxa_data) {
        // Supabase is the source of truth across all devices.
        // Also recover preSessionHistory from the pre_sessions table if the main blob is missing it.
        let flyxaData = data.flyxa_data as Record<string, unknown>;
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
          const remoteRecords = remoteEntries.filter(
            (entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object'
          );
          const backupEntries = await readBackupEntries(userId);
          const safeEntries = readLocalEntriesSafe(userId);
          const deletedTradeIds = deletedTradeIdsFromBlob(flyxaData);
          const recoveredEntries = mergeEntriesWithRecovery(
            mergeEntriesWithRecovery(remoteRecords, backupEntries, deletedTradeIds),
            safeEntries,
            deletedTradeIds
          );

          if (
            recoveredEntries.length !== remoteRecords.length ||
            countStoredTrades(recoveredEntries) !== countStoredTrades(remoteRecords) ||
            storedEntrySignature(recoveredEntries) !== storedEntrySignature(remoteRecords)
          ) {
            flyxaData = {
              ...flyxaData,
              state: {
                ...(flyxaData.state as Record<string, unknown> ?? {}),
                entries: recoveredEntries,
              },
            };
            void flushSaveWithRetry(userId, JSON.stringify(flyxaData));
          }

          return sanitizeStoreValue(JSON.stringify(flyxaData));
        }

        // user_store exists but 0 entries — try store_entries_backup table
        const recovered = await recoverFromJournalEntries(userId, data.flyxa_data);
        if (recovered) {
          void flushSaveWithRetry(userId, recovered);
          return recovered;
        }

        // Last resort: per-user safe backup (then legacy)
        const safeEntries = readLocalEntriesSafe(userId).length > 0
          ? readLocalEntriesSafe(userId)
          : readLegacyEntriesSafe(userId);
        if (safeEntries.length > 0) {
          const base = data.flyxa_data as Record<string, unknown>;
          const rebuilt = JSON.stringify({
            ...base,
            state: { ...(base.state as Record<string, unknown> ?? {}), entries: safeEntries },
          });
          const sanitizedRebuilt = sanitizeStoreValue(rebuilt);
          void flushSaveWithRetry(userId, sanitizedRebuilt);
          return sanitizedRebuilt;
        }

        return sanitizeStoreValue(JSON.stringify(data.flyxa_data));
      }

      // No user_store row — try store_entries_backup table
      const recovered = await recoverFromJournalEntries(userId, null);
      if (recovered) {
        void flushSaveWithRetry(userId, recovered);
        return recovered;
      }

      // Per-user localStorage cache
      const local = localStorage.getItem(storeKey);
      if (local) {
        const sanitizedLocal = sanitizeStoreValue(local);
        void flushSaveWithRetry(userId, sanitizedLocal);
        return sanitizedLocal;
      }

      // Legacy localStorage — one-time migration for existing users
      const legacyLocal = readLegacyLocalStore(userId);
      if (legacyLocal) {
        const sanitizedLegacy = sanitizeStoreValue(legacyLocal);
        void flushSaveWithRetry(userId, sanitizedLegacy);
        return sanitizedLegacy;
      }

      // Per-user safe backup, then legacy
      const safeEntries = readLocalEntriesSafe(userId).length > 0
        ? readLocalEntriesSafe(userId)
        : readLegacyEntriesSafe(userId);
      if (safeEntries.length > 0) {
        const rebuilt = JSON.stringify({ state: { entries: safeEntries }, version: 1 });
        const sanitizedRebuilt = sanitizeStoreValue(rebuilt);
        void flushSaveWithRetry(userId, sanitizedRebuilt);
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

    // Capture the latest value synchronously before any awaits so that
    // flushSupabaseStoreNow (called concurrently from mutateEntries) always
    // reads the freshest state rather than stale localStorage.
    latestValue = sanitizedValue;

    // Guard: never overwrite existing journal data with a blank/default state
    // (protects against HMR in dev transiently wiping data).
    const incomingEntries = extractEntries(sanitizedValue);
    const incomingHasUserData = (() => {
      try {
        const parsed = JSON.parse(sanitizedValue) as { state?: Record<string, unknown> };
        const st = parsed?.state ?? {};
        const moods = st.journalMoods;
        const titles = st.journalTitles;
        return (
          (moods != null && typeof moods === 'object' && Object.keys(moods).length > 0) ||
          (titles != null && typeof titles === 'object' && Object.keys(titles).length > 0)
        );
      } catch { return false; }
    })();

    if (incomingEntries.length === 0 && !incomingHasUserData) {
      try {
        const uid = cachedUserId;
        const existing = uid
          ? (localStorage.getItem(localStoreKey(uid)) ?? localStorage.getItem(LEGACY_STORE_KEY))
          : localStorage.getItem(LEGACY_STORE_KEY);
        if (existing && extractEntries(existing).length > 0) return;
      } catch { /* ignore */ }
    }

    const userId = await getUserId();
    if (!userId) return;

    const storeKey = localStoreKey(userId);

    try {
      localStorage.setItem(storeKey, sanitizedValue);
      localStorage.setItem(localSavedAtKey(userId), Date.now().toString());
    } catch { /* quota exceeded */ }

    pendingValue = sanitizedValue;
    if (saveTimer) clearTimeout(saveTimer);

    const entries = extractEntries(sanitizedValue);
    let deletedTradeIds = new Set<string>();
    try {
      deletedTradeIds = deletedTradeIdsFromBlob(JSON.parse(sanitizedValue) as unknown);
    } catch {
      // sanitizedValue was already validated by extractEntries; keep an empty tombstone set.
    }
    mirrorLocalEntriesSafe(entries, userId, deletedTradeIds);

    saveTimer = setTimeout(() => {
      if (pendingValue) void flushSaveWithRetry(userId, pendingValue);
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
