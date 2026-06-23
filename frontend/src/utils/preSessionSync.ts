import type { PreSessionData } from '../store/types.js';

export const PRE_SESSION_SYNC_STORAGE_KEY = 'flyxa.pre-session-sync.v1';

export interface PreSessionSyncPayload {
  date: string;
  data: PreSessionData;
  savedAt: string;
  nonce: string;
}

export function publishPreSessionSync(date: string, data: PreSessionData): void {
  if (typeof window === 'undefined') return;

  const payload: PreSessionSyncPayload = {
    date,
    data,
    savedAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };

  try {
    window.localStorage.setItem(PRE_SESSION_SYNC_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Persistence still succeeds through Zustand; this only powers live popup sync.
  }
}

export function parsePreSessionSync(value: string | null): PreSessionSyncPayload | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<PreSessionSyncPayload>;
    if (
      typeof parsed.date !== 'string'
      || !parsed.data
      || typeof parsed.data !== 'object'
      || typeof parsed.savedAt !== 'string'
      || typeof parsed.nonce !== 'string'
    ) {
      return null;
    }
    return parsed as PreSessionSyncPayload;
  } catch {
    return null;
  }
}
