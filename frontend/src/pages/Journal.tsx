import { useEffect, useMemo, useState, useCallback, useRef, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Download,
  Leaf,
  Moon,
  PenLine,
  Plus,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { journalApi } from '../services/api.js';
import { JournalBackupPayload, JournalEntry } from '../types/index.js';
import Modal from '../components/common/Modal.js';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useAuth } from '../contexts/AuthContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';

// constants

const JOURNAL_BACKUP_STORAGE_PREFIX = 'tw-journal-backup:';
const JOURNAL_BACKUP_VERSION = 1;
const JOURNAL_MOODS_STORAGE_PREFIX = 'flyxa-journal-moods-v1:';
const JOURNAL_MOODS = ['Calm', 'Focused', 'Confident', 'Tired', 'Frustrated'] as const;
const MOOD_ICONS: Record<(typeof JOURNAL_MOODS)[number], LucideIcon> = {
  Calm: Leaf,
  Focused: Target,
  Confident: ShieldCheck,
  Tired: Moon,
  Frustrated: AlertTriangle,
};

const MOOD_STYLES: Record<string, { bg: string; color: string; border: string }> = {
  Focused:    { bg: '#1a3166', color: '#60a5fa', border: '#1e3d80' },
  Calm:       { bg: '#0d3325', color: '#34d399', border: '#0f4030' },
  Frustrated: { bg: '#3d1515', color: '#f87171', border: '#4d1a1a' },
  Confident:  { bg: '#2d1f0a', color: '#fbbf24', border: '#3a280e' },
  Tired:      { bg: '#1f1a2e', color: '#a78bfa', border: '#2a2240' },
};

const AMBER = '#f59e0b';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const BORDER = 'var(--app-border)';
const BSUB = 'rgba(255,255,255,0.04)';
const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const ACCENT = 'var(--accent)';
const ACCENT_DIM = 'var(--accent-dim)';
const JOURNAL_SECTION_TABS = [
  { key: 'reflection', label: 'Reflection' },
  { key: 'lessons', label: 'Lessons' },
  { key: 'gratitude', label: 'Gratitude' },
] as const;
type JournalSectionTab = (typeof JOURNAL_SECTION_TABS)[number]['key'];

// helpers

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function parseJournalSections(content: string): Record<JournalSectionTab, string> {
  const normalized = (content ?? '').replace(/\r\n/g, '\n');
  const sections: Record<JournalSectionTab, string> = {
    reflection: '',
    lessons: '',
    gratitude: '',
  };

  if (!normalized.trim()) {
    return sections;
  }

  const lines = normalized.split('\n');
  let activeTab: JournalSectionTab = 'reflection';
  let foundSectionHeader = false;

  lines.forEach(line => {
    const trimmed = line.trim();
    if (/^##\s*reflection\s*$/i.test(trimmed)) {
      activeTab = 'reflection';
      foundSectionHeader = true;
      return;
    }
    if (/^##\s*lessons\s*$/i.test(trimmed)) {
      activeTab = 'lessons';
      foundSectionHeader = true;
      return;
    }
    if (/^##\s*pre[- ]?market\s*$/i.test(trimmed) || /^##\s*gratitude\s*$/i.test(trimmed)) {
      // Backward compatible: old Pre-market section becomes Gratitude.
      activeTab = 'gratitude';
      foundSectionHeader = true;
      return;
    }

    sections[activeTab] = sections[activeTab]
      ? `${sections[activeTab]}\n${line}`
      : line;
  });

  if (!foundSectionHeader) {
    return {
      reflection: normalized.trim(),
      lessons: '',
      gratitude: '',
    };
  }

  return {
    reflection: sections.reflection.trim(),
    lessons: sections.lessons.trim(),
    gratitude: sections.gratitude.trim(),
  };
}

function serializeJournalSections(sections: Record<JournalSectionTab, string>): string {
  const cleaned = {
    reflection: sections.reflection.trim(),
    lessons: sections.lessons.trim(),
    gratitude: sections.gratitude.trim(),
  };

  return [
    '## Reflection',
    cleaned.reflection,
    '',
    '## Lessons',
    cleaned.lessons,
    '',
    '## Gratitude',
    cleaned.gratitude,
  ].join('\n').trim();
}

function getSectionPlaceholder(tab: JournalSectionTab): string {
  if (tab === 'reflection') {
    return 'What happened today? Be honest - this is just for you.';
  }
  if (tab === 'lessons') {
    return 'What would you do differently next time?';
  }
  return 'What are 3 things you are grateful for today?\n1.\n2.\n3.';
}

function getPreview(text: string) {
  return text.slice(0, 140).replace(/\n/g, ' ').trim();
}

function formatEntryTitleFromDate(date: string) {
  const parsed = parseISO(date);
  return Number.isNaN(parsed.getTime()) ? 'Untitled entry' : format(parsed, 'EEEE, MMMM d');
}

function truncateTitle(title: string) {
  if (title.length <= 54) return title;
  return `${title.slice(0, 54).trimEnd()}...`;
}


function getDisplayTitle(entry: JournalEntry, titleByEntryId: Record<string, string>) {
  const stored = titleByEntryId[entry.id]?.trim();
  return stored ? truncateTitle(stored) : formatEntryTitleFromDate(entry.date);
}

function getEntryContent(entry: JournalEntry) {
  const parsed = parseJournalSections(typeof entry.content === 'string' ? entry.content : '');
  return [parsed.reflection, parsed.lessons, parsed.gratitude]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function formatEntryDate(date: string, pattern: string) {
  const parsed = parseISO(date);
  return Number.isNaN(parsed.getTime()) ? (date || 'Unknown date') : format(parsed, pattern);
}

function normalizeBackupDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeBackupEntries(value: unknown): Array<Pick<JournalEntry, 'date' | 'content' | 'screenshots'>> {
  if (!Array.isArray(value)) return [];
  const output: Array<Pick<JournalEntry, 'date' | 'content' | 'screenshots'>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const date = normalizeBackupDate(record.date);
    if (!date) continue;
    output.push({
      date,
      content: typeof record.content === 'string' ? record.content : '',
      screenshots: Array.isArray(record.screenshots)
        ? record.screenshots.filter((s): s is string => typeof s === 'string')
        : [],
    });
  }
  return output;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function buildBackupFilename(date = new Date()) {
  const stamp = format(date, 'yyyy-MM-dd_HH-mm');
  return `flyxa-ai-journal-backup-${stamp}.json`;
}

function downloadBackupPayload(payload: JournalBackupPayload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildBackupFilename();
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// EntryItem

function EntryItem({
  entry,
  mood,
  titleByEntryId,
  selected,
  onClick,
}: {
  entry: JournalEntry;
  mood?: string;
  titleByEntryId: Record<string, string>;
  selected: boolean;
  onClick: () => void;
}) {
  const content = getEntryContent(entry);
  const preview = getPreview(content);
  const title = getDisplayTitle(entry, titleByEntryId);
  const wc = wordCount(content);
  const hasContent = wc > 0;
  const moodStyle = mood ? (MOOD_STYLES[mood] ?? null) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        width: '100%',
        borderRadius: '8px',
        border: `1px solid ${selected ? ACCENT : BORDER}`,
        background: selected ? ACCENT_DIM : S1,
        marginBottom: '6px',
        cursor: 'pointer',
        textAlign: 'left',
        overflow: 'hidden',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.02)';
      }}
      onMouseLeave={e => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = S1;
      }}
    >
      {/* Date badge */}
      <div
        data-tour-id="journal-header"
        style={{
          width: '46px',
          flexShrink: 0,
          borderRight: `1px solid ${selected ? 'rgba(245,158,11,0.3)' : BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '10px 0',
          gap: '2px',
        }}
      >
        <span style={{ fontSize: '9px', fontWeight: 700, color: selected ? AMBER : T3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {formatEntryDate(entry.date, 'MMM')}
        </span>
        <span style={{ fontSize: '18px', fontWeight: 600, color: selected ? AMBER : T1, lineHeight: 1, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
          {formatEntryDate(entry.date, 'd')}
        </span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
        <p style={{ fontSize: '12px', fontWeight: 600, color: T1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '4px' }}>
          {title}
        </p>
        <p style={{ fontSize: '11px', color: T2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {hasContent ? preview : "A clean page waiting for today's note."}
        </p>
      </div>

      {/* Meta */}
      <div style={{ padding: '10px 10px', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', gap: '6px', flexShrink: 0 }}>
        {mood && moodStyle && (
          <span style={{ borderRadius: '20px', fontSize: '10px', fontWeight: 600, padding: '2px 7px', background: moodStyle.bg, color: moodStyle.color, whiteSpace: 'nowrap' }}>
            {mood}
          </span>
        )}
      </div>
    </button>
  );
}

// Journal page

export default function Journal() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [selected, setSelected] = useState<JournalEntry | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<JournalEntry | null>(null);
  const moodByEntryId = useFlyxaStore(state => state.journalMoods);
  const titleByEntryId = useFlyxaStore(state => state.journalTitles);
  const setJournalMoodAction = useFlyxaStore(state => state.setJournalMood);
  const setJournalTitleAction = useFlyxaStore(state => state.setJournalTitle);
  const [titleDraft, setTitleDraft] = useState('');
  const [activeSectionTab, setActiveSectionTab] = useState<JournalSectionTab>('reflection');
  const [sectionDraft, setSectionDraft] = useState<Record<JournalSectionTab, string>>({
    reflection: '',
    lessons: '',
    gratitude: '',
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodsHydratedRef = useRef<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null);
  const backupStorageKey = useMemo(
    () => `${JOURNAL_BACKUP_STORAGE_PREFIX}${user?.id ?? 'anonymous'}`,
    [user?.id]
  );
  const moodsStorageKey = useMemo(
    () => `${JOURNAL_MOODS_STORAGE_PREFIX}${user?.id ?? 'anonymous'}`,
    [user?.id]
  );

  const fetchEntries = useCallback(async () => {
    try {
      const data = await journalApi.getAll();
      setEntries(data as JournalEntry[]);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchEntries(); }, [fetchEntries]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const payload: JournalBackupPayload = {
      version: JOURNAL_BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      user_id: user?.id ?? null,
      entries: entries.map((entry) => ({
        date: entry.date,
        content: typeof entry.content === 'string' ? entry.content : '',
        screenshots: Array.isArray(entry.screenshots) ? entry.screenshots.filter((s): s is string => typeof s === 'string') : [],
      })),
      moods: moodByEntryId,
      titles: titleByEntryId,
    };
    try {
      window.localStorage.setItem(backupStorageKey, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors.
    }
  }, [backupStorageKey, entries, moodByEntryId, titleByEntryId, user?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hydrationKey = user?.id ?? 'anonymous';
    if (moodsHydratedRef.current === hydrationKey) return;
    moodsHydratedRef.current = hydrationKey;

    try {
      const raw = window.localStorage.getItem(moodsStorageKey);
      if (!raw) return;
      const parsed = normalizeStringMap(JSON.parse(raw));
      Object.entries(parsed).forEach(([entryId, mood]) => {
        if (!moodByEntryId[entryId]) setJournalMoodAction(entryId, mood);
      });
    } catch {
      // ignore malformed local fallback cache
    }
  }, [moodByEntryId, moodsStorageKey, setJournalMoodAction, user?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(moodsStorageKey, JSON.stringify(moodByEntryId));
    } catch {
      // ignore storage quota errors
    }
  }, [moodByEntryId, moodsStorageKey]);

  function updateEntryMood(entryId: string, mood: string) {
    setJournalMoodAction(entryId, mood);
    setSaving(true);
    setSaved(false);
    void flushSupabaseStoreNow()
      .then(() => {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        setSaving(false);
      });
  }

  useEffect(() => {
    setSelected(current => {
      if (!current) return current;
      return entries.find(entry => entry.id === current.id) ?? current;
    });
  }, [entries]);

  useEffect(() => {
    const requestedDate = searchParams.get('date');
    if (!requestedDate || entries.length === 0) return;
    const match = entries.find(entry => entry.date === requestedDate);
    if (match && selected?.id !== match.id) setSelected(match);
  }, [entries, searchParams, selected]);

  useEffect(() => {
    if (selected && textareaRef.current) textareaRef.current.focus();
  }, [activeSectionTab, selected?.id]);

  useEffect(() => {
    if (!selected) { setTitleDraft(''); return; }
    setTitleDraft(titleByEntryId[selected.id] ?? '');
  }, [selected, titleByEntryId]);

  useEffect(() => {
    if (!selected) {
      setSectionDraft({
        reflection: '',
        lessons: '',
        gratitude: '',
      });
      setActiveSectionTab('reflection');
      return;
    }

    setSectionDraft(parseJournalSections(selected.content ?? ''));
    setActiveSectionTab('reflection');
  }, [selected?.id]);

  function persistEntryTitle(entryId: string, nextTitle: string) {
    const normalized = nextTitle.trim();
    setJournalTitleAction(entryId, normalized);
  }

  function applyEntryUpdateLocally(entryId: string, updates: Partial<JournalEntry>) {
    setEntries(current => current.map(e => (e.id === entryId ? { ...e, ...updates } : e)));
    setSelected(current => (current?.id === entryId ? { ...current, ...updates } : current));
  }

  async function autoSave(content: string) {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await journalApi.update(selected.id, { content } as Record<string, unknown>);
      applyEntryUpdateLocally(selected.id, updated as JournalEntry);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  }

  function handleContentChange(content: string) {
    if (!selected) return;
    const nextSections: Record<JournalSectionTab, string> = {
      ...sectionDraft,
      [activeSectionTab]: content,
    };
    setSectionDraft(nextSections);
    const serializedContent = serializeJournalSections(nextSections);
    applyEntryUpdateLocally(selected.id, { content: serializedContent });
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void autoSave(serializedContent); }, 1500);
  }

  function handleTitleChange(nextTitle: string) {
    if (!selected) return;
    setTitleDraft(nextTitle);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => { persistEntryTitle(selected.id, nextTitle); }, 300);
  }

  function handleTitleBlur() {
    if (!selected) return;
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    persistEntryTitle(selected.id, titleDraft);
  }

  async function handleDateChange(nextDate: string) {
    if (!selected || !nextDate || nextDate === selected.date) return;
    const duplicate = entries.find(e => e.id !== selected.id && e.date === nextDate);
    if (duplicate) {
      window.alert(`There is already a journal entry for ${formatEntryDate(nextDate, 'MMMM d, yyyy')}.`);
      return;
    }
    const previousDate = selected.date;
    applyEntryUpdateLocally(selected.id, { date: nextDate });
    setSaving(true);
    setSaved(false);
    try {
      const updated = await journalApi.update(selected.id, { date: nextDate } as Record<string, unknown>);
      applyEntryUpdateLocally(selected.id, updated as JournalEntry);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error(error);
      applyEntryUpdateLocally(selected.id, { date: previousDate });
    } finally {
      setSaving(false);
    }
  }

  async function createEntry() {
    const today = format(new Date(), 'yyyy-MM-dd');
    const existing = entries.find(e => e.date === today);
    if (existing) { setSelected(existing); return; }
    try {
      const created = await journalApi.create({ date: today, content: '', screenshots: [] } as Record<string, unknown>);
      await fetchEntries();
      setSelected(created as JournalEntry);
    } catch (error) {
      console.error(error);
    }
  }

  async function deleteEntry(entry: JournalEntry) {
    try {
      await journalApi.delete(entry.id);
      if (selected?.id === entry.id) setSelected(null);
      setJournalTitleAction(entry.id, '');
      await fetchEntries();
    } catch (error) {
      console.error(error);
    }
    setDeleteTarget(null);
  }

  async function exportBackup() {
    setBackupBusy('export');
    try {
      const serverPayload = await journalApi.exportBackup();
      const payload: JournalBackupPayload = {
        version: JOURNAL_BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        user_id: user?.id ?? null,
        entries: normalizeBackupEntries(serverPayload.entries),
        moods: moodByEntryId,
        titles: titleByEntryId,
      };
      downloadBackupPayload(payload);
    } catch (error) {
      console.error(error);
      const fallbackPayload: JournalBackupPayload = {
        version: JOURNAL_BACKUP_VERSION,
        exported_at: new Date().toISOString(),
        user_id: user?.id ?? null,
        entries: entries.map((entry) => ({
          date: entry.date,
          content: entry.content ?? '',
          screenshots: Array.isArray(entry.screenshots) ? entry.screenshots : [],
        })),
        moods: moodByEntryId,
        titles: titleByEntryId,
      };
      downloadBackupPayload(fallbackPayload);
    } finally {
      setBackupBusy(null);
    }
  }

  function triggerBackupImport() {
    backupInputRef.current?.click();
  }

  async function handleBackupImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setBackupBusy('import');
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalizedEntries = normalizeBackupEntries(parsed.entries);
      const normalizedMoods = normalizeStringMap(parsed.moods);
      const normalizedTitles = normalizeStringMap(parsed.titles);

      if (normalizedEntries.length === 0) {
        window.alert('This backup file has no valid journal entries.');
        return;
      }

      const restoreResult = await journalApi.restoreBackup(normalizedEntries);
      if (Object.keys(normalizedMoods).length > 0) {
        Object.entries(normalizedMoods).forEach(([id, mood]) => setJournalMoodAction(id, mood));
      }
      if (Object.keys(normalizedTitles).length > 0) {
        Object.entries(normalizedTitles).forEach(([id, title]) => setJournalTitleAction(id, title));
      }

      await fetchEntries();

      window.alert(
        `Backup restored. Created ${restoreResult.created}, updated ${restoreResult.updated}, skipped ${restoreResult.skipped}, failed ${restoreResult.failed}.`
      );
    } catch (error) {
      console.error(error);
      window.alert('Import failed. Please verify this is a valid Flyxa AI journal backup JSON file.');
    } finally {
      setBackupBusy(null);
      event.target.value = '';
    }
  }

  const filtered = useMemo(
    () => entries.filter(
      entry =>
        search === '' ||
        getEntryContent(entry).toLowerCase().includes(search.toLowerCase()) ||
        (entry.date ?? '').includes(search)
    ),
    [entries, search]
  );

  const grouped = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
    const bucket = new Map<string, JournalEntry[]>();
    sorted.forEach(entry => {
      const month = formatEntryDate(entry.date, 'MMMM yyyy');
      const current = bucket.get(month) ?? [];
      current.push(entry);
      bucket.set(month, current);
    });
    return Array.from(bucket.entries());
  }, [filtered]);

  const totalWords = useMemo(
    () => entries.reduce((sum, entry) => sum + wordCount(getEntryContent(entry)), 0),
    [entries]
  );
  const selectedWordCount = selected ? wordCount(getEntryContent(selected)) : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="lg" label="Loading daily journal..." />
      </div>
    );
  }

  return (
    <div
      className="animate-fade-in"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}
    >
      <style>{`input[type="text"]::placeholder { color: var(--app-text-subtle); } textarea::placeholder { color: var(--app-text-subtle); }`}</style>

      {/* Top header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '14px 20px',
          borderBottom: `1px solid ${BORDER}`,
          flexShrink: 0,
          background: S1,
        }}
      >
        <div>
          <h1 style={{ fontSize: '17px', fontWeight: 600, color: T1, margin: 0, lineHeight: 1.2 }}>Daily Journal</h1>
          <p style={{ fontSize: '11px', color: T3, marginTop: '3px' }}>Your private trading log — pick up where you left off.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {selected && (
            <span style={{ fontSize: '11px', color: T3, fontFamily: 'var(--font-mono)' }}>
              {totalWords} words total
            </span>
          )}
          <button
            type="button"
            onClick={() => { void exportBackup(); }}
            disabled={backupBusy !== null}
            style={{
              height: '32px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: S2,
              border: `1px solid ${BORDER}`,
              borderRadius: '5px',
              padding: '0 10px',
              color: T2,
              fontSize: '12px',
              fontWeight: 600,
              cursor: backupBusy !== null ? 'not-allowed' : 'pointer',
              opacity: backupBusy !== null ? 0.7 : 1,
              flexShrink: 0,
            }}
          >
            <Download size={13} />
            {backupBusy === 'export' ? 'Exporting...' : 'Export backup'}
          </button>
          <button
            type="button"
            onClick={triggerBackupImport}
            disabled={backupBusy !== null}
            style={{
              height: '32px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: S2,
              border: `1px solid ${BORDER}`,
              borderRadius: '5px',
              padding: '0 10px',
              color: T2,
              fontSize: '12px',
              fontWeight: 600,
              cursor: backupBusy !== null ? 'not-allowed' : 'pointer',
              opacity: backupBusy !== null ? 0.7 : 1,
              flexShrink: 0,
            }}
          >
            <Upload size={13} />
            {backupBusy === 'import' ? 'Importing...' : 'Import backup'}
          </button>
          <button
            type="button"
            data-tour-id="journal-new-entry"
            onClick={createEntry}
            disabled={backupBusy !== null}
            style={{
              height: '32px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: AMBER,
              border: 'none',
              borderRadius: '5px',
              padding: '0 12px',
              color: '#000',
              fontSize: '12px',
              fontWeight: 600,
              cursor: backupBusy !== null ? 'not-allowed' : 'pointer',
              opacity: backupBusy !== null ? 0.7 : 1,
              flexShrink: 0,
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.88'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
          >
            <Plus size={13} />
            New entry
          </button>
          <input
            ref={backupInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(event) => { void handleBackupImport(event); }}
            style={{ display: 'none' }}
          />
        </div>
      </div>

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '300px 1fr', minHeight: 0, overflow: 'hidden' }}>

        {/* Left: entry list */}
        <div data-tour-id="journal-entry-list" style={{ borderRight: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {/* Search */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: T3, pointerEvents: 'none' }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search entries..."
                style={{
                  width: '100%',
                  background: S2,
                  border: `1px solid ${BORDER}`,
                  borderRadius: '6px',
                  padding: '7px 10px 7px 30px',
                  fontSize: '12px',
                  color: T2,
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.15s',
                }}
                onFocus={e => { e.target.style.borderColor = ACCENT; }}
                onBlur={e => { e.target.style.borderColor = BORDER; }}
              />
            </div>
          </div>

          {/* Entry list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
            {grouped.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', gap: '10px' }}>
                <PenLine size={20} style={{ color: T3 }} />
                <p style={{ fontSize: '13px', color: T2, margin: 0 }}>{search ? 'No matching entries' : 'No entries yet'}</p>
                <p style={{ fontSize: '11px', color: T3, margin: 0, textAlign: 'center' }}>
                  {search ? 'Try a different keyword.' : 'Hit "New entry" to begin your first session note.'}
                </p>
              </div>
            ) : (
              grouped.map(([month, monthEntries]) => (
                <div key={month} style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: T3, textTransform: 'uppercase', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>
                      {month}
                    </span>
                    <div style={{ flex: 1, height: '1px', background: BSUB }} />
                    <span style={{ fontSize: '10px', color: T3, whiteSpace: 'nowrap' }}>
                      {monthEntries.length} {monthEntries.length === 1 ? 'entry' : 'entries'}
                    </span>
                  </div>
                  {monthEntries.map(entry => (
                    <EntryItem
                      key={entry.id}
                      entry={entry}
                      mood={moodByEntryId[entry.id]}
                      titleByEntryId={titleByEntryId}
                      selected={selected?.id === entry.id}
                      onClick={() => setSelected(entry)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right: editor or empty state */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {!selected ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: T3 }}>
              <PenLine size={28} style={{ opacity: 0.4 }} />
              <p style={{ fontSize: '14px', color: T2, margin: 0 }}>Select an entry to read or write</p>
              <p style={{ fontSize: '12px', color: T3, margin: 0 }}>Or create a new one for today</p>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

              {/* Entry header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: '16px',
                  padding: '16px 20px 12px',
                  borderBottom: `1px solid ${BORDER}`,
                  flexShrink: 0,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <h2 style={{ fontSize: '19px', fontWeight: 600, color: T1, letterSpacing: '-0.03em', margin: 0, lineHeight: 1.1 }}>
                    {formatEntryDate(selected.date, 'EEEE, MMMM d')}
                  </h2>
                  <p style={{ fontSize: '11px', color: T3, marginTop: '5px' }}>
                    {formatEntryDate(selected.date, 'yyyy')}
                    <span style={{ margin: '0 5px' }}>|</span>
                    {selectedWordCount} words written
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    value={selected.date}
                    onChange={e => void handleDateChange(e.target.value)}
                    style={{
                      background: S2,
                      border: `1px solid ${BORDER}`,
                      borderRadius: '6px',
                      padding: '5px 10px',
                      fontSize: '12px',
                      color: T2,
                      colorScheme: 'dark',
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  />

                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '5px 10px',
                      border: `1px solid ${BORDER}`,
                      borderRadius: '6px',
                      fontSize: '11px',
                      color: saving ? AMBER : T2,
                      cursor: 'default',
                      userSelect: 'none',
                    }}
                  >
                    {saving ? 'Saving...' : saved ? 'Saved' : 'Auto-save on'}
                  </span>

                  <button
                    type="button"
                    onClick={() => setDeleteTarget(selected)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '5px 10px',
                      border: `1px solid ${BORDER}`,
                      borderRadius: '6px',
                      background: 'transparent',
                      fontSize: '11px',
                      color: T2,
                      cursor: 'pointer',
                      transition: 'border-color 0.15s, color 0.15s',
                    }}
                    onMouseEnter={e => { const el = e.currentTarget as HTMLButtonElement; el.style.borderColor = '#7f1d1d'; el.style.color = '#f87171'; }}
                    onMouseLeave={e => { const el = e.currentTarget as HTMLButtonElement; el.style.borderColor = BORDER; el.style.color = T2; }}
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </div>
              </div>

              {/* Mood toggles */}
              <div data-tour-id="journal-mood" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '10px 20px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
                {JOURNAL_MOODS.map(mood => {
                  const isActive = moodByEntryId[selected.id] === mood;
                  const ms = MOOD_STYLES[mood];
                  const MoodIcon = MOOD_ICONS[mood];
                  return (
                    <button
                      key={mood}
                      type="button"
                      onClick={() => updateEntryMood(selected.id, mood)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 11px',
                        borderRadius: '20px',
                        border: `1px solid ${isActive ? ms.border : BORDER}`,
                        background: isActive ? ms.bg : S2,
                        fontSize: '11px',
                        color: isActive ? ms.color : T2,
                        cursor: 'pointer',
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      {isActive && (
                        <svg width="7" height="7" viewBox="0 0 8 8" style={{ flexShrink: 0 }}>
                          <circle cx="4" cy="4" r="4" fill={ms.color} />
                        </svg>
                      )}
                      <MoodIcon size={11} />
                      {mood}
                    </button>
                  );
                })}
              </div>

              {/* Writing area — fills remaining height */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                {/* Title input */}
                <input
                  type="text"
                  value={titleDraft}
                  onChange={e => handleTitleChange(e.target.value)}
                  onBlur={handleTitleBlur}
                  placeholder="Entry title..."
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '14px 20px 10px',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    fontSize: '14px',
                    fontWeight: 600,
                    color: T1,
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                    flexShrink: 0,
                  }}
                />

                {/* Hint bar */}
                <div style={{ borderTop: `1px solid ${BSUB}`, borderBottom: `1px solid ${BSUB}`, padding: '6px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <span style={{ fontSize: '11px', color: T3 }}>Reflection · Lessons · Gratitude</span>
                  <span style={{ fontSize: '11px', color: T3 }}>Autosaves after 1.5s</span>
                </div>

                {/* Section tabs */}
                <div data-tour-id="journal-section-tabs" style={{ padding: '0 20px', borderBottom: `1px solid ${BSUB}`, display: 'flex', alignItems: 'center', gap: '18px', flexShrink: 0 }}>
                  {JOURNAL_SECTION_TABS.map(tab => {
                    const active = activeSectionTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setActiveSectionTab(tab.key)}
                        style={{
                          border: 'none',
                          borderBottom: `2px solid ${active ? ACCENT : 'transparent'}`,
                          background: 'transparent',
                          color: active ? ACCENT : T2,
                          fontSize: '12px',
                          fontWeight: 500,
                          padding: '9px 0',
                          cursor: 'pointer',
                          transition: 'color 0.12s, border-color 0.12s',
                        }}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {/* Body textarea */}
                <textarea
                  data-tour-id="journal-editor"
                  ref={textareaRef}
                  value={sectionDraft[activeSectionTab]}
                  onChange={e => handleContentChange(e.target.value)}
                  placeholder={getSectionPlaceholder(activeSectionTab)}
                  style={{
                    display: 'block',
                    width: '100%',
                    flex: 1,
                    minHeight: 0,
                    padding: '16px 20px',
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    resize: 'none',
                    fontSize: '13px',
                    color: T2,
                    lineHeight: 1.75,
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete modal */}
      <Modal isOpen={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Journal Entry">
        <p className="mb-6 text-[13px] leading-relaxed text-slate-300">
          Permanently delete the entry for{' '}
          <span className="font-semibold text-white">
            {deleteTarget ? formatEntryDate(deleteTarget.date, 'MMMM d, yyyy') : ''}
          </span>
          ? This cannot be undone.
        </p>
        <div className="flex gap-2">
          <button onClick={() => deleteTarget && deleteEntry(deleteTarget)} className="btn-danger flex items-center gap-2 text-sm">
            <Trash2 size={13} />
            Delete Entry
          </button>
          <button onClick={() => setDeleteTarget(null)} className="btn-secondary text-sm">
            Cancel
          </button>
        </div>
      </Modal>
    </div>
  );
}
