import type { StateStorage } from 'zustand/middleware';
import { supabase } from '../services/api.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const SAVE_DEBOUNCE_MS = 500;
const LOCAL_SAVED_AT_KEY = 'flyxa-store-saved-at';
const LOCAL_STORE_UID_KEY = 'flyxa-store-uid';
const LOCAL_ENTRIES_SAFE_KEY = 'flyxa-entries-safe';
const LOCAL_ENTRIES_SAFE_UID_KEY = 'flyxa-entries-safe-uid';

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
      // Deleted trades have been purged from entries — IDs are no longer needed.
      // Clearing here prevents the array from growing unboundedly over time.
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

function mirrorLocalEntriesSafe(entries: Record<string, unknown>[], userId: string): void {
  try {
    const next: Record<string, unknown> = {};
    for (const entry of entries) {
      const id = entry.id as string;
      next[id] = stripBase64Images(entry);
    }
    localStorage.setItem(LOCAL_ENTRIES_SAFE_KEY, JSON.stringify(next));
    localStorage.setItem(LOCAL_ENTRIES_SAFE_UID_KEY, userId);
  } catch { /* quota */ }
}

/**
 * Read the local safe entry backup, but ONLY if it belongs to the given user.
 * This prevents entries from a previously signed-in user from leaking into
 * a newly created account on the same device.
 */
function readLocalEntriesSafe(userId: string): Record<string, unknown>[] {
  try {
    const storedUid = localStorage.getItem(LOCAL_ENTRIES_SAFE_UID_KEY);
    if (storedUid !== userId) return [];
    const raw = localStorage.getItem(LOCAL_ENTRIES_SAFE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(map).filter(
      (e): e is Record<string, unknown> => e != null && typeof e === 'object'
    );
  } catch {
    return [];
  }
}

// Sync entry rows to the dedicated store_entries_backup table.
// Upsert current entries first, then remove orphans — never delete before writing.
// This way a crash between the two steps leaves stale-but-harmless extra rows
// rather than an empty backup table.
async function syncEntriesToTable(userId: string, entries: Record<string, unknown>[]): Promise<void> {
  if (entries.length > 0) {
    const rows = entries.map(e => ({
      id: e.id as string,
      user_id: userId,
      date: e.date as string,
      data: stripBase64Images(e) as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }));
    await supabase.from('store_entries_backup').upsert(rows, { onConflict: 'id' });
  }

  // Remove rows that are no longer in the store (only after upsert succeeds).
  const currentIds = entries.map(e => e.id as string);
  if (currentIds.length > 0) {
    await supabase
      .from('store_entries_backup')
      .delete()
      .eq('user_id', userId)
      .not('id', 'in', `(${currentIds.join(',')})`);
  } else {
    await supabase.from('store_entries_backup').delete().eq('user_id', userId);
  }
}

// Recover entries from store_entries_backup table and rebuild a store blob.
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

  // Primary store — single blob. Throw on error so the retry wrapper can catch it.
  const { error } = await supabase.from('user_store').upsert(
    { user_id: userId, flyxa_data: sanitized, updated_at: now },
    { onConflict: 'user_id' }
  );
  if (error) throw error;

  try { localStorage.setItem(LOCAL_SAVED_AT_KEY, Date.now().toString()); } catch { /* quota */ }

  // Secondary store — per-entry rows mirror the current store.
  const entries = extractEntries(sanitizedValue);
  await syncEntriesToTable(userId, entries);
  mirrorLocalEntriesSafe(entries, userId);
}

// Retries flushSave up to 2 extra times (3 total) with increasing delays.
// Falls back silently after all attempts — data is still in localStorage.
async function flushSaveWithRetry(userId: string, value: string, attempt = 0): Promise<void> {
  try {
    await flushSave(userId, value);
  } catch {
    if (attempt < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      return flushSaveWithRetry(userId, value, attempt + 1);
    }
    // All retries exhausted — data remains in localStorage fallback
  }
}

export async function flushSupabaseStoreNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const userId = await getUserId();
  if (!userId) return;

  const value = pendingValue ?? (typeof window !== 'undefined' ? localStorage.getItem('flyxa-store') : null);
  if (!value) return;

  pendingValue = null;
  await flushSaveWithRetry(userId, value);
}

// On page close/refresh, fire a keepalive fetch so the save completes even if
// the tab is being destroyed. Regular async calls are abandoned mid-flight on unload.
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

export const supabaseZustandStorage: StateStorage = {
  getItem: async (_key: string): Promise<string | null> => {
    const userId = await getUserId();
    if (!userId) return null;

    try {
      const { data, error } = await supabase
        .from('user_store')
        .select('flyxa_data, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (!error && data?.flyxa_data) {
        // Supabase is the single source of truth across all devices.
        // Never let a local copy win when Supabase has data — a stale local
        // cache on Device B must never overwrite live data written by Device A.
        // Local is only used as a fallback when Supabase is unreachable or empty.
        const remoteEntries = (data.flyxa_data as { state?: { entries?: unknown[] } })?.state?.entries;
        if (Array.isArray(remoteEntries) && remoteEntries.length > 0) {
          return sanitizeStoreValue(JSON.stringify(data.flyxa_data));
        }

        // user_store exists but has 0 entries — try store_entries_backup table
        const recovered = await recoverFromJournalEntries(userId, data.flyxa_data);
        if (recovered) {
          void flushSaveWithRetry(userId, recovered);
          return recovered;
        }

        // Last resort: localStorage safe backup (only if it belongs to this user)
        const safeEntries = readLocalEntriesSafe(userId);
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

      // No user_store row — try store_entries_backup table first
      const recovered = await recoverFromJournalEntries(userId, null);
      if (recovered) {
        void flushSaveWithRetry(userId, recovered);
        return recovered;
      }

      // Then localStorage — only if it belongs to this user
      const local = localStorage.getItem('flyxa-store');
      const localUid = localStorage.getItem(LOCAL_STORE_UID_KEY);
      if (local && (!localUid || localUid === userId)) {
        const sanitizedLocal = sanitizeStoreValue(local);
        void flushSaveWithRetry(userId, sanitizedLocal);
        return sanitizedLocal;
      }

      // Last resort: safe backup (only if it belongs to this user)
      const safeEntries = readLocalEntriesSafe(userId);
      if (safeEntries.length > 0) {
        const rebuilt = JSON.stringify({ state: { entries: safeEntries }, version: 1 });
        const sanitizedRebuilt = sanitizeStoreValue(rebuilt);
        void flushSaveWithRetry(userId, sanitizedRebuilt);
        return sanitizedRebuilt;
      }
    } catch {
      const local = localStorage.getItem('flyxa-store');
      const localUid = localStorage.getItem(LOCAL_STORE_UID_KEY);
      if (local && (!localUid || localUid === userId)) return sanitizeStoreValue(local);
      return null;
    }

    return null;
  },

  setItem: async (_key: string, value: string): Promise<void> => {
    const sanitizedValue = sanitizeStoreValue(value);

    // Guard: never overwrite existing journal data with a blank/default state.
    // This protects against hot-module-reload in development (and any other scenario
    // where the store is transiently initialised with no data) clobbering real data.
    // We only skip when entries AND all user-data fields (moods, titles, trades) are empty —
    // a partial state (e.g. moods set but no entries) is intentional and must be saved.
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
        const existing = localStorage.getItem('flyxa-store');
        if (existing && extractEntries(existing).length > 0) return;
      } catch { /* ignore */ }
    }

    try {
      localStorage.setItem('flyxa-store', sanitizedValue);
      localStorage.setItem(LOCAL_SAVED_AT_KEY, Date.now().toString());
    } catch { /* quota exceeded */ }

    pendingValue = sanitizedValue;
    if (saveTimer) clearTimeout(saveTimer);

    const userId = await getUserId();
    if (!userId) return;

    try { localStorage.setItem(LOCAL_STORE_UID_KEY, userId); } catch { /* quota */ }

    const entries = extractEntries(sanitizedValue);
    mirrorLocalEntriesSafe(entries, userId);

    saveTimer = setTimeout(() => {
      if (pendingValue) void flushSaveWithRetry(userId, pendingValue);
    }, SAVE_DEBOUNCE_MS);
  },

  removeItem: async (_key: string): Promise<void> => {
    // Only clear the local device cache — never delete cloud data.
    // Supabase is the source of truth and must survive sign-out.
    // The safe backup is tagged with the signed-out user's ID, so it will
    // be ignored for any different account that signs in on this device.
    localStorage.removeItem('flyxa-store');
    localStorage.removeItem(LOCAL_SAVED_AT_KEY);
    localStorage.removeItem(LOCAL_STORE_UID_KEY);
    localStorage.removeItem(LOCAL_ENTRIES_SAFE_UID_KEY);
    localStorage.removeItem(LOCAL_ENTRIES_SAFE_KEY);
  },
};
