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
      deletedTradeIds: [],
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

function mirrorLocalEntriesSafe(entries: Record<string, unknown>[], userId: string): void {
  try {
    const next: Record<string, unknown> = {};
    for (const entry of entries) {
      const id = entry.id as string;
      next[id] = stripBase64Images(entry);
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

async function syncEntriesToTable(userId: string, entries: Record<string, unknown>[]): Promise<void> {
  if (entries.length === 0) return;

  const rows = entries.map(e => ({
    id: e.id as string,
    user_id: userId,
    date: e.date as string,
    data: stripBase64Images(e) as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }));
  await supabase.from('store_entries_backup').upsert(rows, { onConflict: 'id' });

  const currentIds = entries.map(e => e.id as string);
  await supabase
    .from('store_entries_backup')
    .delete()
    .eq('user_id', userId)
    .not('id', 'in', `(${currentIds.join(',')})`);
}

async function recoverFromJournalEntries(
  userId: string,
  baseBlob: unknown
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('store_entries_backup')
      .select('data')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    if (error || !data || data.length === 0) return null;

    const entries = data.map((row: { data: unknown }) => row.data);
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
  await syncEntriesToTable(userId, entries);
  mirrorLocalEntriesSafe(entries, userId);

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

  const value = pendingValue ?? (
    typeof window !== 'undefined'
      ? (localStorage.getItem(localStoreKey(userId)) ?? localStorage.getItem(LEGACY_STORE_KEY))
      : null
  );
  if (!value) return;

  pendingValue = null;
  await flushSaveWithRetry(userId, value);
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
        const remoteEntries = (data.flyxa_data as { state?: { entries?: unknown[] } })?.state?.entries;
        if (Array.isArray(remoteEntries) && remoteEntries.length > 0) {
          return sanitizeStoreValue(JSON.stringify(data.flyxa_data));
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
    mirrorLocalEntriesSafe(entries, userId);

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
