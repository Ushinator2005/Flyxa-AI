import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { journalApi } from '../../services/api.js';
import { JournalEntry, Trade } from '../../types/index.js';
import { buildMonthlyHeatmapData } from '../../utils/tradeAnalytics.js';
import { useAppSettings } from '../../contexts/AppSettingsContext.js';

function getCellBg(pnl: number | undefined): string {
  if (pnl === undefined) return '';
  if (pnl > 200) return 'bg-emerald-800/60';
  if (pnl > 50) return 'bg-emerald-700/40';
  if (pnl > 0) return 'bg-emerald-900/40';
  if (pnl > -50) return 'bg-red-900/40';
  if (pnl > -200) return 'bg-red-700/40';
  return 'bg-red-800/60';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TABS = [
  { key: 'reflection', label: 'Reflection' },
  { key: 'lessons', label: 'Lessons' },
  { key: 'gratitude', label: 'Gratitude' },
] as const;

type JournalTab = (typeof TABS)[number]['key'];
type EmotionTone = 'neutral' | 'green' | 'amber' | 'red';

interface DailyJournalEmotion {
  label: string;
  tone: EmotionTone;
}

interface DailyJournalModalEntry {
  date: string;
  reflection: string;
  lessons: string;
  gratitude: string;
  status: 'complete' | 'incomplete';
  discipline: number;
  disciplineNote: string;
  emotions: DailyJournalEmotion[];
  pnl: number;
  account: string;
  accountStatus: string;
  lastSaved?: string;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countTotalWords(values: Record<JournalTab, string>): number {
  return countWords(values.reflection) + countWords(values.lessons) + countWords(values.gratitude);
}

function parseJournalContent(content: string): Record<JournalTab, string> {
  const normalized = (content ?? '').replace(/\r\n/g, '\n');
  const result: Record<JournalTab, string> = {
    reflection: '',
    lessons: '',
    gratitude: '',
  };

  if (!normalized.trim()) {
    return result;
  }

  const lines = normalized.split('\n');
  let activeTab: JournalTab = 'reflection';
  let foundSectionHeader = false;

  lines.forEach(line => {
    if (/^##\s*reflection\s*$/i.test(line.trim())) {
      activeTab = 'reflection';
      foundSectionHeader = true;
      return;
    }
    if (/^##\s*pre[- ]?market\s*$/i.test(line.trim())) {
      activeTab = 'gratitude';
      foundSectionHeader = true;
      return;
    }
    if (/^##\s*gratitude\s*$/i.test(line.trim())) {
      activeTab = 'gratitude';
      foundSectionHeader = true;
      return;
    }
    if (/^##\s*lessons\s*$/i.test(line.trim())) {
      activeTab = 'lessons';
      foundSectionHeader = true;
      return;
    }

    result[activeTab] = result[activeTab]
      ? `${result[activeTab]}\n${line}`
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
    reflection: result.reflection.trim(),
    lessons: result.lessons.trim(),
    gratitude: result.gratitude.trim(),
  };
}

function serializeJournalContent(values: Record<JournalTab, string>): string {
  const cleaned: Record<JournalTab, string> = {
    reflection: values.reflection.trim(),
    lessons: values.lessons.trim(),
    gratitude: values.gratitude.trim(),
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

function formatSaveAge(value?: string): string {
  if (!value) {
    return 'not saved yet';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'saved recently';
  }

  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) {
    return 'saved just now';
  }
  if (diffMs < 3_600_000) {
    const mins = Math.max(1, Math.floor(diffMs / 60_000));
    return `saved ${mins} min ago`;
  }
  if (diffMs < 86_400_000) {
    const hours = Math.max(1, Math.floor(diffMs / 3_600_000));
    return `saved ${hours} hr ago`;
  }

  const days = Math.max(1, Math.floor(diffMs / 86_400_000));
  return `saved ${days} day ago`;
}

function formatPnl(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function getDisciplineTone(score: number): 'green' | 'amber' | 'red' {
  if (score >= 3.8) return 'green';
  if (score >= 2.8) return 'amber';
  return 'red';
}

function emotionToneFromLabel(label: string): EmotionTone {
  const normalized = label.toLowerCase();
  if (normalized.includes('focus') || normalized.includes('calm') || normalized.includes('confident')) {
    return 'green';
  }
  if (normalized.includes('fomo') || normalized.includes('revenge') || normalized.includes('overconfident')) {
    return 'red';
  }
  if (normalized.includes('anxious') || normalized.includes('tired') || normalized.includes('hesitant')) {
    return 'amber';
  }
  return 'neutral';
}

function nextEmotionTone(current: EmotionTone): EmotionTone {
  if (current === 'neutral') return 'green';
  if (current === 'green') return 'amber';
  if (current === 'amber') return 'red';
  return 'neutral';
}

function getTabPlaceholder(tab: JournalTab): string {
  if (tab === 'reflection') {
    return 'What happened today? Be honest — this is just for you.';
  }
  if (tab === 'lessons') {
    return 'What would you do differently next time?';
  }
  return 'What are 3 things you are grateful for today?\n1.\n2.\n3.';
}

function StatusChip({ status }: { status: 'complete' | 'incomplete' }) {
  const complete = status === 'complete';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
        padding: '4px 8px',
        border: complete ? '1px solid rgba(34,197,94,0.28)' : '1px solid var(--border)',
        color: complete ? 'var(--green)' : 'var(--txt-3)',
        background: complete ? 'var(--green-dim)' : 'var(--surface-2)',
      }}
    >
      {complete && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--green)',
            flexShrink: 0,
          }}
        />
      )}
      {complete ? 'Complete' : 'Incomplete'}
    </span>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <p
      style={{
        margin: 0,
        marginBottom: 6,
        fontSize: 11,
        color: 'var(--txt-3)',
      }}
    >
      {label}
    </p>
  );
}

function DailyJournalModal({
  entry,
  isLoading,
  error,
  canPrev,
  canNext,
  onClose,
  onPrev,
  onNext,
  onSave,
  onViewTrades,
}: {
  entry: DailyJournalModalEntry;
  isLoading: boolean;
  error: string;
  canPrev: boolean;
  canNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: (tab: JournalTab, content: string) => Promise<void> | void;
  onViewTrades: () => void;
}) {
  const [activeTab, setActiveTab] = useState<JournalTab>('reflection');
  const [draftByTab, setDraftByTab] = useState<Record<JournalTab, string>>({
    reflection: entry.reflection,
    lessons: entry.lessons,
    gratitude: entry.gratitude,
  });
  const [lastSaved, setLastSaved] = useState(entry.lastSaved);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [emotionToneByLabel, setEmotionToneByLabel] = useState<Record<string, EmotionTone>>(
    () => Object.fromEntries(entry.emotions.map(emotion => [emotion.label, emotion.tone]))
  );
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraftByTab({
      reflection: entry.reflection,
      lessons: entry.lessons,
      gratitude: entry.gratitude,
    });
    setLastSaved(entry.lastSaved);
    setSaveError('');
    setSaving(false);
    setActiveTab('reflection');
    setEmotionToneByLabel(Object.fromEntries(entry.emotions.map(emotion => [emotion.label, emotion.tone])));
  }, [entry]);

  useEffect(() => {
    textAreaRef.current?.focus();
  }, [activeTab, entry.date]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const totalWordCount = countTotalWords(draftByTab);
  const status: 'complete' | 'incomplete' = totalWordCount > 0 ? 'complete' : 'incomplete';
  const disciplineTone = getDisciplineTone(entry.discipline);

  const emotionItems = useMemo(() => {
    const labels = Object.keys(emotionToneByLabel);
    if (labels.length === 0) {
      return ['Focused', 'Calm', 'Anxious', 'FOMO'].map(label => ({
        label,
        tone: 'neutral' as EmotionTone,
      }));
    }
    return labels.map(label => ({ label, tone: emotionToneByLabel[label] ?? 'neutral' as EmotionTone }));
  }, [emotionToneByLabel]);

  const handleSave = async () => {
    setSaveError('');
    setSaving(true);
    try {
      await Promise.resolve(onSave(activeTab, draftByTab[activeTab]));
      const now = new Date().toISOString();
      setLastSaved(now);
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error ? saveFailure.message : 'Unable to save this note.');
    } finally {
      setSaving(false);
    }
  };

  const parsedDate = parseISO(entry.date);
  const headerDate = Number.isNaN(parsedDate.getTime()) ? entry.date : format(parsedDate, 'do MMMM yyyy');
  const dayStripDate = Number.isNaN(parsedDate.getTime()) ? entry.date : format(parsedDate, 'EEE, dd MMM');
  const sidebarDate = Number.isNaN(parsedDate.getTime()) ? entry.date : format(parsedDate, 'do MMMM yyyy');
  const weekdayName = Number.isNaN(parsedDate.getTime()) ? '' : format(parsedDate, 'EEEE');
  const saveMetaText = formatSaveAge(lastSaved);

  return createPortal(
    <div className="fixed inset-0 z-[1200]" style={TOKEN_SCOPE_STYLE}>
      <style>
        {`
          .flyxa-journal-modal {
            width: min(820px, calc(100vw - 32px));
            max-height: 88vh;
          }
          .flyxa-journal-body {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 200px;
            min-height: 0;
            flex: 1;
            overflow: hidden;
          }
          .flyxa-journal-nav-btn {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            border: 1px solid var(--border);
            background: var(--surface-2);
            color: var(--txt-3);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: color 120ms ease, border-color 120ms ease;
          }
          .flyxa-journal-nav-btn:hover {
            color: var(--txt);
            border-color: rgba(255,255,255,0.14);
          }
          .flyxa-journal-tab {
            height: 34px;
            border: none;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: var(--txt-2);
            font-size: 12px;
            margin-right: 20px;
            padding: 9px 0;
            cursor: pointer;
            transition: color 120ms ease, border-color 120ms ease;
          }
          .flyxa-journal-tab:hover {
            color: var(--txt);
          }
          .flyxa-journal-tab.is-active {
            color: var(--amber);
            border-color: var(--amber);
          }
          .flyxa-journal-emotion-tag {
            border-radius: 3px;
            border: 1px solid var(--border);
            padding: 3px 7px;
            font-size: 10px;
            line-height: 1;
            background: transparent;
            color: var(--txt-3);
            cursor: pointer;
            transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
          }
          @media (max-width: 900px) {
            .flyxa-journal-modal {
              width: calc(100vw - 20px);
              max-height: 92vh;
            }
            .flyxa-journal-body {
              grid-template-columns: minmax(0, 1fr);
            }
            .flyxa-journal-meta {
              border-top: 1px solid var(--border);
              border-left: none !important;
              max-height: 230px;
            }
          }
        `}
      </style>

      <button
        type="button"
        aria-label="Close daily journal"
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.65)' }}
      />

      <div className="absolute inset-0 grid place-items-center p-4">
        <div
          className="flyxa-journal-modal"
          style={{
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              padding: '18px 22px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            <div>
              <p
                style={{
                  margin: 0,
                  marginBottom: 4,
                  fontSize: 11,
                  color: 'var(--txt-3)',
                }}
              >
                Daily Journal
              </p>
              <p style={{ margin: 0, marginBottom: 2, fontSize: 16, fontWeight: 600, color: 'var(--txt)' }}>
                {headerDate}
              </p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--txt-2)' }}>
                Review and edit your session note
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                aria-label="Previous day"
                className="flyxa-journal-nav-btn"
                onClick={onPrev}
                disabled={!canPrev}
                style={!canPrev ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                aria-label="Next day"
                className="flyxa-journal-nav-btn"
                onClick={onNext}
                disabled={!canNext}
                style={!canNext ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              >
                <ChevronRight size={13} />
              </button>
              <button
                type="button"
                onClick={onViewTrades}
                style={{
                  height: 28,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '0 12px',
                  borderRadius: 4,
                  border: '1px solid var(--amber)',
                  background: 'var(--amber-dim)',
                  color: 'var(--amber)',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '0.01em',
                }}
              >
                <ExternalLink size={11} />
                View trades
              </button>
              <button
                type="button"
                aria-label="Close"
                className="flyxa-journal-nav-btn"
                onClick={onClose}
              >
                <X size={13} />
              </button>
            </div>
          </header>

          <div className="flyxa-journal-body">
            <section
              style={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                borderRight: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  padding: '14px 22px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 22,
                    fontWeight: 500,
                    color: 'var(--txt)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {dayStripDate}
                </span>
                <span style={{ width: 1, height: 28, background: 'var(--border)' }} />
                <StatusChip status={status} />
              </div>

              <div style={{ padding: '0 22px', borderBottom: '1px solid var(--border)' }}>
                {TABS.map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`flyxa-journal-tab${activeTab === tab.key ? ' is-active' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 22px' }}>
                {isLoading ? (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--txt-3)' }}>
                    Loading daily journal entry...
                  </p>
                ) : error ? (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--red)' }}>
                    {error}
                  </p>
                ) : (
                  <textarea
                    ref={textAreaRef}
                    value={draftByTab[activeTab]}
                    onChange={event => {
                      const nextValue = event.target.value;
                      setDraftByTab(current => ({ ...current, [activeTab]: nextValue }));
                    }}
                    placeholder={getTabPlaceholder(activeTab)}
                    style={{
                      width: '100%',
                      minHeight: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      resize: 'none',
                      color: 'var(--txt)',
                      fontSize: 13,
                      lineHeight: 1.85,
                      fontFamily: 'var(--font-sans)',
                    }}
                  />
                )}
              </div>

              <footer
                style={{
                  borderTop: '1px solid var(--border)',
                  padding: '10px 22px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-3)' }}>
                  {saveMetaText}
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {saveError && (
                    <span style={{ fontSize: 11, color: 'var(--red)' }}>{saveError}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => { void handleSave(); }}
                    disabled={isLoading || !!error || saving}
                    style={{
                      height: 30,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '0 12px',
                      border: 'none',
                      borderRadius: 4,
                      background: 'var(--amber)',
                      color: '#000',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: isLoading || !!error || saving ? 'not-allowed' : 'pointer',
                      opacity: isLoading || !!error || saving ? 0.6 : 1,
                    }}
                  >
                    <Check size={12} />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </footer>
            </section>

            <aside
              className="flyxa-journal-meta"
              style={{
                minWidth: 0,
                minHeight: 0,
                overflowY: 'auto',
                padding: '18px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 0,
              }}
            >
              <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
                <SectionTitle label="Date" />
                <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{sidebarDate}</p>
                <p style={{ margin: 0, marginTop: 2, fontSize: 11, color: 'var(--txt-3)' }}>{weekdayName}</p>
              </div>

              <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <SectionTitle label="Status" />
                <StatusChip status={status} />
              </div>

              <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <SectionTitle label="Discipline" />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, marginBottom: 8 }}>
                  {[1, 2, 3, 4, 5].map(pip => {
                    const filled = entry.discipline >= pip;
                    let fillColor = 'var(--surface-3)';
                    if (filled && disciplineTone === 'green') fillColor = 'var(--green)';
                    if (filled && disciplineTone === 'amber') fillColor = 'var(--amber)';
                    if (filled && disciplineTone === 'red') fillColor = 'var(--red)';
                    return (
                      <span
                        key={`discipline-pip-${pip}`}
                        style={{
                          height: 3,
                          borderRadius: 2,
                          background: fillColor,
                        }}
                      />
                    );
                  })}
                </div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--txt)', fontFamily: 'var(--font-mono)' }}>
                  {entry.discipline.toFixed(1)}/5
                </p>
                <p style={{ margin: 0, marginTop: 2, fontSize: 11, color: 'var(--txt-3)' }}>
                  {entry.disciplineNote}
                </p>
              </div>

              <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <SectionTitle label="State of mind" />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {emotionItems.map(emotion => {
                    const tone = emotionToneByLabel[emotion.label] ?? 'neutral';
                    const styleByTone: Record<EmotionTone, { color: string; background: string; border: string }> = {
                      neutral: {
                        color: 'var(--txt-3)',
                        background: 'transparent',
                        border: 'var(--border)',
                      },
                      green: {
                        color: 'var(--green)',
                        background: 'var(--green-dim)',
                        border: 'rgba(34,197,94,0.3)',
                      },
                      amber: {
                        color: 'var(--amber)',
                        background: 'var(--amber-dim)',
                        border: 'rgba(245,158,11,0.3)',
                      },
                      red: {
                        color: 'var(--red)',
                        background: 'var(--red-dim)',
                        border: 'rgba(239,68,68,0.3)',
                      },
                    };

                    return (
                      <button
                        key={emotion.label}
                        type="button"
                        className="flyxa-journal-emotion-tag"
                        style={{
                          color: styleByTone[tone].color,
                          background: styleByTone[tone].background,
                          borderColor: styleByTone[tone].border,
                        }}
                        onClick={() => {
                          setEmotionToneByLabel(current => ({
                            ...current,
                            [emotion.label]: nextEmotionTone(current[emotion.label] ?? 'neutral'),
                          }));
                        }}
                      >
                        {emotion.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ paddingTop: 12 }}>
                <SectionTitle label="Session P&L" />
                <p
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 500,
                    fontFamily: 'var(--font-mono)',
                    color: entry.pnl >= 0 ? 'var(--green)' : 'var(--red)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatPnl(entry.pnl)}
                </p>
                <p style={{ margin: 0, marginTop: 2, fontSize: 11, color: 'var(--txt-3)' }}>
                  {entry.account} · {entry.accountStatus}
                </p>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

const TOKEN_SCOPE_STYLE = {
  '--surface-1': 'var(--app-panel)',
  '--surface-2': 'var(--app-panel-strong)',
  '--surface-3': 'rgba(255,255,255,0.08)',
  '--border': 'var(--app-border)',
  '--txt': 'var(--app-text)',
  '--txt-2': 'var(--app-text-muted)',
  '--txt-3': 'var(--app-text-subtle)',
  '--amber': 'var(--accent)',
  '--amber-dim': 'var(--accent-dim)',
  '--green': '#22c55e',
  '--green-dim': 'rgba(34,197,94,0.10)',
  '--red': '#ef4444',
  '--red-dim': 'rgba(239,68,68,0.10)',
} as CSSProperties;

export default function MonthlyHeatmap({ trades = [] }: { trades?: Trade[] }) {
  const now = new Date();
  const today = useMemo(() => new Date(), []);
  const navigate = useNavigate();
  const { accounts } = useAppSettings();
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [journals, setJournals] = useState<Record<number, { id: string; date: string }>>({});
  const [activeJournalId, setActiveJournalId] = useState<string | null>(null);
  const [activeJournalDate, setActiveJournalDate] = useState<string | null>(null);
  const [selectedJournal, setSelectedJournal] = useState<JournalEntry | null>(null);
  const [journalLoading, setJournalLoading] = useState(false);
  const [journalError, setJournalError] = useState('');
  const [lastSavedById, setLastSavedById] = useState<Record<string, string>>({});
  const journalRequestRef = useRef(0);

  useEffect(() => {
    if (activeJournalId) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }

    document.body.style.overflow = '';
    return undefined;
  }, [activeJournalId]);

  useEffect(() => {
    journalApi.getAll()
      .then(data => setJournalEntries(data as JournalEntry[]))
      .catch(() => setJournalEntries([]));
  }, []);

  useEffect(() => {
    setLastSavedById(current => {
      const next = { ...current };
      let changed = false;

      journalEntries.forEach(entry => {
        if (!next[entry.id]) {
          next[entry.id] = entry.created_at;
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [journalEntries]);

  const { days, counts } = useMemo(
    () => buildMonthlyHeatmapData(trades, year, month),
    [month, trades, year]
  );

  useEffect(() => {
    const nextJournals = journalEntries.reduce<Record<number, { id: string; date: string }>>((acc, journal) => {
      const parsed = new Date(`${journal.date}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) return acc;
      if (parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month) return acc;
      acc[parsed.getDate()] = { id: journal.id, date: journal.date };
      return acc;
    }, {});
    setJournals(nextJournals);
  }, [journalEntries, month, year]);

  useEffect(() => {
    if (!activeJournalId) {
      return;
    }
    const latest = journalEntries.find(entry => entry.id === activeJournalId);
    if (latest) {
      setSelectedJournal(latest);
    }
  }, [activeJournalId, journalEntries]);

  const prevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(y => y - 1);
    } else {
      setMonth(m => m - 1);
    }
  };

  const nextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(y => y + 1);
    } else {
      setMonth(m => m + 1);
    }
  };

  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startOffset = firstDay.getDay();

  const cells: Array<number | null> = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  while (cells.length % 7 !== 0) cells.push(null);

  // Sun–Sat display order (Sun-indexed week: 0=Sun,1=Mon,...,6=Sat)
  const ALL_DAY_INDICES = [0, 1, 2, 3, 4, 5, 6]; // Sun Mon Tue Wed Thu Fri Sat
  const WEEKDAY_INDICES = [1, 2, 3, 4, 5]; // Mon–Fri only (for row-visibility check)
  // On mobile: 7 equal cols (no Weekly P&L). On desktop: Sun/Sat narrow + Weekly P&L.
  const GRID_COLS = isMobile ? 'repeat(7, 1fr)' : '0.45fr 1fr 1fr 1fr 1fr 1fr 0.45fr 1fr';
  const weeks: Array<Array<number | null>> = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7) as Array<number | null>);
  }
  const lastVisibleWeekIdx = weeks.reduce((last, w, i) =>
    ALL_DAY_INDICES.every(idx => w[idx] === null) ? last : i, -1);
  let weekCounter = 0;
  const weekNumbers = weeks.map(w =>
    WEEKDAY_INDICES.every(idx => w[idx] === null) ? null : ++weekCounter
  );

  const journalOrder = useMemo(
    () => [...journalEntries].sort((a, b) => a.date.localeCompare(b.date)),
    [journalEntries]
  );

  const activeJournalIndex = useMemo(
    () => (activeJournalId ? journalOrder.findIndex(entry => entry.id === activeJournalId) : -1),
    [activeJournalId, journalOrder]
  );
  const canPrevJournal = activeJournalIndex > 0;
  const canNextJournal = activeJournalIndex >= 0 && activeJournalIndex < journalOrder.length - 1;

  const openJournalModal = async (journalId: string, journalDate: string) => {
    const requestId = journalRequestRef.current + 1;
    journalRequestRef.current = requestId;

    setActiveJournalId(journalId);
    setActiveJournalDate(journalDate);
    setJournalError('');

    const existing = journalEntries.find(entry => entry.id === journalId);
    if (existing) {
      setSelectedJournal(existing);
      setJournalLoading(false);
      return;
    }

    setSelectedJournal(null);
    setJournalLoading(true);
    try {
      const fetched = await journalApi.getById(journalId);
      if (journalRequestRef.current !== requestId) return;
      setSelectedJournal(fetched as JournalEntry);
    } catch {
      if (journalRequestRef.current !== requestId) return;
      setJournalError('Unable to load this daily journal entry.');
    } finally {
      if (journalRequestRef.current !== requestId) return;
      setJournalLoading(false);
    }
  };

  const closeJournalModal = useCallback(() => {
    journalRequestRef.current += 1;
    setActiveJournalId(null);
    setActiveJournalDate(null);
    setSelectedJournal(null);
    setJournalError('');
    setJournalLoading(false);
  }, []);

  const handlePrevJournal = useCallback(() => {
    if (!canPrevJournal) return;
    const previous = journalOrder[activeJournalIndex - 1];
    if (previous) {
      void openJournalModal(previous.id, previous.date);
    }
  }, [activeJournalIndex, canPrevJournal, journalOrder]);

  const handleNextJournal = useCallback(() => {
    if (!canNextJournal) return;
    const next = journalOrder[activeJournalIndex + 1];
    if (next) {
      void openJournalModal(next.id, next.date);
    }
  }, [activeJournalIndex, canNextJournal, journalOrder]);

  const handleSaveTab = useCallback(async (tab: JournalTab, content: string) => {
    if (!selectedJournal) {
      throw new Error('No journal is selected.');
    }

    const parsed = parseJournalContent(selectedJournal.content);
    const nextTabs = {
      ...parsed,
      [tab]: content,
    };
    const nextContent = serializeJournalContent(nextTabs);

    const updated = await journalApi.update(
      selectedJournal.id,
      { content: nextContent } as Record<string, unknown>
    );
    const updatedEntry = updated as JournalEntry;

    setSelectedJournal(updatedEntry);
    setJournalEntries(current =>
      current.map(entry => (entry.id === updatedEntry.id ? updatedEntry : entry))
    );
    setLastSavedById(current => ({
      ...current,
      [selectedJournal.id]: new Date().toISOString(),
    }));
  }, [selectedJournal]);

  const modalEntry = useMemo<DailyJournalModalEntry | null>(() => {
    if (!activeJournalDate) {
      return null;
    }

    const fallbackTabs: Record<JournalTab, string> = {
      reflection: '',
      lessons: '',
      gratitude: '',
    };
    const parsed = selectedJournal ? parseJournalContent(selectedJournal.content) : fallbackTabs;
    const dayTrades = trades.filter(trade => trade.trade_date === activeJournalDate);
    const pnl = dayTrades.reduce((sum, trade) => sum + trade.pnl, 0);

    const tradesWithScore = dayTrades.filter(trade => typeof trade.plan_score === 'number');
    const tradesWithPlanLogged = tradesWithScore.length > 0
      ? tradesWithScore
      : dayTrades.filter(trade => typeof trade.followed_plan === 'boolean');
    const avgPlanScore = tradesWithScore.length > 0
      ? tradesWithScore.reduce((s, t) => s + (t.plan_score as number), 0) / tradesWithScore.length
      : tradesWithPlanLogged.length > 0
        ? (tradesWithPlanLogged.filter(t => t.followed_plan === true).length / tradesWithPlanLogged.length) * 100
        : null;
    const discipline = avgPlanScore !== null
      ? Number((1 + (avgPlanScore / 100) * 4).toFixed(1))
      : 0;
    const disciplineNote = avgPlanScore !== null
      ? `${Math.round(avgPlanScore)}% plan adherence`
      : 'No trades logged';

    const emotionLabelsFromTrades: string[] = [];
    dayTrades.forEach((trade) => {
      if (typeof trade.emotional_state === 'string' && trade.emotional_state.trim().length > 0) {
        emotionLabelsFromTrades.push(trade.emotional_state);
      }
    });
    const emotionLabels = Array.from(new Set<string>([
      ...emotionLabelsFromTrades,
      'Focused',
      'Calm',
      'Anxious',
      'FOMO',
    ]));
    const emotions = emotionLabels.map(label => ({
      label,
      tone: emotionToneFromLabel(label),
    }));

    const accountIdCount = dayTrades.reduce<Record<string, number>>((acc, trade) => {
      const accountId = trade.accountId ?? trade.account_id;
      if (!accountId) return acc;
      acc[accountId] = (acc[accountId] ?? 0) + 1;
      return acc;
    }, {});
    const dominantAccountId = Object.entries(accountIdCount)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const matchedAccount = dominantAccountId
      ? accounts.find(account => account.id === dominantAccountId)
      : null;

    const wordCount = countTotalWords(parsed);
    const status = wordCount > 0 ? 'complete' : 'incomplete';

    return {
      date: activeJournalDate,
      reflection: parsed.reflection,
      lessons: parsed.lessons,
      gratitude: parsed.gratitude,
      status,
      discipline,
      disciplineNote,
      emotions,
      pnl,
      account: matchedAccount?.name ?? 'Primary account',
      accountStatus: matchedAccount?.status ?? 'Journal only',
      lastSaved: selectedJournal ? lastSavedById[selectedJournal.id] : undefined,
    };
  }, [accounts, activeJournalDate, lastSavedById, selectedJournal, trades]);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-base font-medium text-slate-300">
          Daily P&L - {MONTHS[month - 1]} {year}
        </h2>
        <div className="flex items-center gap-0.5">
          <button onClick={prevMonth} className="rounded-lg p-1.5 text-slate-500 transition-colors hover:text-slate-200">
            <ChevronLeft size={16} />
          </button>
          <button onClick={nextMonth} className="rounded-lg p-1.5 text-slate-500 transition-colors hover:text-slate-200">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-600">
        {/* Header: Sun–Sat + Week */}
        <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS }} className="bg-slate-900/30">
          <div className="border-b border-r border-slate-600 py-2 text-center text-xs font-medium text-slate-600">
            {isMobile ? 'Su' : 'Sun'}
          </div>
          {(isMobile ? ['Mo', 'Tu', 'We', 'Th', 'Fr'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).map(d => (
            <div key={d} className="border-b border-r border-slate-600 py-2 text-center text-xs font-medium text-slate-500">
              {d}
            </div>
          ))}
          <div className={`border-b border-slate-600 py-2 text-center text-xs font-medium text-slate-600${!isMobile ? ' border-r' : ''}`}>
            {isMobile ? 'Sa' : 'Sat'}
          </div>
          {!isMobile && (
            <div className="border-b border-slate-600 py-2 text-center text-xs font-medium text-white">
              Weekly P&L
            </div>
          )}
        </div>

        {/* Week rows */}
        {weeks.map((week, wi) => {
          if (ALL_DAY_INDICES.every(idx => week[idx] === null)) return null;
          const isLastWeek = wi === lastVisibleWeekIdx;
          const visibleWeekNum = weekNumbers[wi];

          const weekPnl = week.reduce<number>((sum, d) => {
            if (d === null) return sum;
            const p = days[d];
            return p !== undefined ? sum + p : sum;
          }, 0);
          const weekTradeCount = week.reduce<number>((sum, d) => d !== null ? sum + (counts[d] ?? 0) : sum, 0);

          return (
            <div
              key={`week-${wi}`}
              style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gridAutoRows: isMobile ? '54px' : '84px' }}
            >
              {ALL_DAY_INDICES.map((dayIdx, ci) => {
                const day = week[dayIdx] ?? null;
                const isLastCol = !isMobile ? false : ci === ALL_DAY_INDICES.length - 1;
                if (day === null) {
                  return (
                    <div
                      key={`empty-${wi}-${ci}`}
                      className={`${!isLastCol ? 'border-r ' : ''}border-slate-600${!isLastWeek ? ' border-b' : ''}`}
                    />
                  );
                }

                const pnl = days[day];
                const tradeCount = counts[day] ?? 0;
                const journalEntry = journals[day];
                const hasJournal = !!journalEntry;
                const canOpenJournal = hasJournal || tradeCount > 0;
                const isToday = day === today.getDate()
                  && month === today.getMonth() + 1
                  && year === today.getFullYear();
                const title = [
                  pnl !== undefined ? `${day} - ${formatPnl(pnl)}` : `${day} - No trades`,
                  hasJournal ? 'Daily journal completed' : undefined,
                  !canOpenJournal ? 'No trade or journal entry' : undefined,
                ].filter(Boolean).join(' | ');

                return (
                  <div
                    key={day}
                    title={title}
                    onClick={() => {
                      if (!canOpenJournal) return;
                      const targetDate = format(new Date(year, month - 1, day), 'yyyy-MM-dd');
                      if (journalEntry) {
                        void openJournalModal(journalEntry.id, targetDate);
                      } else {
                        navigate(`/scanner?date=${targetDate}`);
                      }
                    }}
                    className={[
                      `relative flex flex-col ${!isLastCol ? 'border-r ' : ''}border-slate-600 transition-colors`,
                      isMobile ? 'p-1' : 'p-2',
                      !isLastWeek ? 'border-b' : '',
                      canOpenJournal ? 'cursor-pointer hover:ring-1 hover:ring-amber-400/35 hover:ring-inset' : 'cursor-default',
                      isToday ? 'bg-cyan-500/[0.04]' : (pnl !== undefined ? getCellBg(pnl) : (hasJournal ? 'bg-slate-600/20' : '')),
                    ].join(' ')}
                  >
                    {isToday && (
                      <span aria-hidden="true" className="pointer-events-none absolute inset-0 border border-cyan-400/45" />
                    )}
                    {isToday ? (
                      <span className={`inline-flex flex-col items-start leading-none text-cyan-400 ${isMobile ? 'text-xs font-semibold' : 'text-sm font-semibold'}`}>
                        <span>{day}</span>
                        <span className="mt-0.5 h-[3px] w-[3px] self-start rounded-full bg-cyan-400" />
                      </span>
                    ) : (
                      <span className={`leading-none text-slate-400 ${isMobile ? 'text-xs' : 'text-sm'}`}>{day}</span>
                    )}
                    {pnl !== undefined ? (
                      <div className="mt-auto flex flex-col" style={{ gap: isMobile ? 0 : 2 }}>
                        <span className={`font-semibold ${pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`} style={{ fontSize: isMobile ? 10 : 14, lineHeight: 1.2 }}>
                          {pnl >= 0 ? '+' : ''}
                          {Math.abs(pnl) >= 1000
                            ? `${(pnl / 1000).toFixed(1)}k`
                            : pnl.toFixed(0)}
                        </span>
                        {tradeCount > 0 && !isMobile && (
                          <span className="text-xs leading-none text-slate-400 opacity-90">
                            {tradeCount} {tradeCount === 1 ? 'trade' : 'trades'}
                          </span>
                        )}
                      </div>
                    ) : hasJournal ? (
                      <div className="mt-auto flex flex-col" style={{ gap: isMobile ? 0 : 2 }}>
                        <span className="font-semibold text-slate-500" style={{ fontSize: isMobile ? 10 : 14, lineHeight: 1.2 }}>
                          $0
                        </span>
                        {!isMobile && (
                          <span className="text-xs leading-none text-slate-600 opacity-90">
                            0 trades
                          </span>
                        )}
                      </div>
                    ) : null}
                    {hasJournal && (
                      <span
                        className={`absolute rounded-full bg-amber-400 shadow-[0_0_0_2px_rgba(15,23,42,0.9)] ${isMobile ? 'bottom-1 right-1 h-1.5 w-1.5' : 'bottom-2 right-2 h-2.5 w-2.5'}`}
                        aria-label="Daily journal completed"
                      />
                    )}
                  </div>
                );
              })}

              {/* Weekly P&L cell — desktop only */}
              {!isMobile && (
                <div
                  className={`flex flex-col items-center justify-center gap-1 px-2${!isLastWeek ? ' border-b border-slate-600' : ''}`}
                >
                  <span style={{ fontSize: 11, fontWeight: 500, color: '#ffffff' }}>
                    Week {visibleWeekNum}
                  </span>
                  <span
                    className={`tabular-nums ${weekPnl > 0 ? 'text-emerald-300' : weekPnl < 0 ? 'text-red-400' : 'text-white'}`}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 500 }}
                  >
                    {formatPnl(weekPnl)}
                  </span>
                  <span style={{ fontSize: 9, color: '#ffffff' }}>
                    {weekTradeCount} {weekTradeCount === 1 ? 'trade' : 'trades'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {activeJournalId && modalEntry && (
        <DailyJournalModal
          entry={modalEntry}
          isLoading={journalLoading}
          error={journalError}
          canPrev={canPrevJournal}
          canNext={canNextJournal}
          onClose={closeJournalModal}
          onPrev={handlePrevJournal}
          onNext={handleNextJournal}
          onSave={handleSaveTab}
          onViewTrades={() => {
            closeJournalModal();
            navigate(`/scanner?date=${activeJournalDate}`);
          }}
        />
      )}
    </div>
  );
}
