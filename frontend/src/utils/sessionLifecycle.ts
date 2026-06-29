import type { PreSessionData } from '../store/types.js';
import { getTimeZoneParts } from './calendarTime.js';

export function isLivePreSession(
  session: PreSessionData | null | undefined,
): session is PreSessionData & { startedAt: string } {
  return Boolean(session?.startedAt && !session.endedAt);
}

export function getPreSessionDate(session: PreSessionData, timezone: string): string {
  const anchor =
    session.sessionStartedAt ??
    session.startedAt ??
    session.endedAt ??
    session.postSessionStartedAt ??
    new Date().toISOString();

  return getTimeZoneParts(new Date(anchor), timezone).date;
}

export function markPreSessionEnded(
  activeSession: PreSessionData,
  existingSession?: PreSessionData | null,
  endedAt = new Date().toISOString(),
): PreSessionData {
  const sessionStartedAt =
    existingSession?.sessionStartedAt ??
    activeSession.sessionStartedAt ??
    activeSession.startedAt ??
    null;

  return {
    ...(existingSession ?? {}),
    ...activeSession,
    startedAt: null,
    sessionStartedAt,
    endedAt,
    postSessionStartedAt: existingSession?.postSessionStartedAt ?? endedAt,
  };
}
