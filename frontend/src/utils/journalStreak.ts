import { useEffect, useMemo, useState } from 'react';
import { journalApi } from '../services/api.js';

// Single source of truth for the "daily journal streak" — the consecutive-days
// figure shown on the Daily Journal page. The Rules page reuses this so its
// streak can never drift from the journal's.

type JournalSectionTab = 'reflection' | 'lessons' | 'gratitude';

interface StreakEntry {
  date: unknown;
  content?: unknown;
}

// Split a journal entry's markdown into its three sections. Mirrors the parser
// on the Journal page.
function parseSections(content: string): Record<JournalSectionTab, string> {
  const normalized = (content ?? '').replace(/\r\n/g, '\n');
  const sections: Record<JournalSectionTab, string> = { reflection: '', lessons: '', gratitude: '' };
  if (!normalized.trim()) return sections;

  let activeTab: JournalSectionTab = 'reflection';
  normalized.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (/^##\s*reflection\s*$/i.test(trimmed)) { activeTab = 'reflection'; return; }
    if (/^##\s*lessons\s*$/i.test(trimmed)) { activeTab = 'lessons'; return; }
    if (/^##\s*pre[- ]?market\s*$/i.test(trimmed) || /^##\s*gratitude\s*$/i.test(trimmed)) { activeTab = 'gratitude'; return; }
    sections[activeTab] = sections[activeTab] ? `${sections[activeTab]}\n${line}` : line;
  });
  return sections;
}

function getEntryContent(entry: StreakEntry): string {
  const parsed = parseSections(typeof entry.content === 'string' ? entry.content : '');
  return [parsed.reflection, parsed.lessons, parsed.gratitude].filter(Boolean).join('\n\n').trim();
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function normalizeBackupDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// Consecutive days (ending today or yesterday) with a written journal entry.
export function computeDailyJournalStreak(entries: StreakEntry[]): number {
  const writtenDates = new Set(
    entries
      .filter(entry => getEntryContent(entry).length > 0)
      .map(entry => normalizeBackupDate(entry.date))
      .filter((date): date is string => Boolean(date))
  );

  const today = localDateKey(new Date());
  const yesterday = shiftDateKey(today, -1);
  let cursor = writtenDates.has(today) ? today : writtenDates.has(yesterday) ? yesterday : '';
  let streak = 0;
  while (cursor && writtenDates.has(cursor)) {
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

// Fetches journal entries and returns the live streak. Use where the entries
// aren't already loaded (e.g. the Rules page).
export function useDailyJournalStreak(): number {
  const [entries, setEntries] = useState<StreakEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    journalApi.getAll()
      .then(data => { if (!cancelled) setEntries(data as StreakEntry[]); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return useMemo(() => computeDailyJournalStreak(entries), [entries]);
}
