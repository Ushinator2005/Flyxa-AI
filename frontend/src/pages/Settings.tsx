import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, FileJson, FileSpreadsheet, Monitor, Palette, Plus, Scan, Tag, Trash2, Upload, User, Wallet, X, DollarSign } from 'lucide-react';
import ColorPickerField from '../components/common/ColorPicker.js';
import { SectionPanel } from '../components/ds/SectionPanel.js';
import DatePicker from '../components/common/DatePicker.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useTheme } from '../contexts/ThemeContext.js';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRivals } from '../hooks/useRivals.js';
import { accountApi, supabase } from '../services/api.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { clearCurrentUserStoreCache } from '../store/supabaseStorage.js';
import { TradingAccountStatus, TradingAccountType } from '../types/index.js';
import { normalizeConfluenceTag } from '../utils/confluenceTags.js';

const ACCOUNT_TYPES: TradingAccountType[] = ['Futures', 'Forex', 'Stocks'];
const DEFAULT_ACCOUNT_COLOR = '#3b82f6';
const DEFAULT_TIMEZONE = 'America/New_York';
const ACCOUNT_STATUSES: TradingAccountStatus[] = ['Eval', 'Funded', 'Live', 'Passed', 'Blown'];
const ACCOUNT_TABLE_GRID_COLUMNS = 'minmax(0,1fr) minmax(0,1fr) 120px 170px 150px 90px';
const ACCOUNT_TABLE_COLUMN_GAP = '16px';
const PROFILE_IMAGE_BUCKET = 'trade-screenshots';
const TIMEZONE_REGION_PRIORITY = ['America', 'Europe', 'Asia', 'Pacific'];
const SESSION_TIME_FIELDS = [
  { key: 'asia', label: 'Asia' },
  { key: 'london', label: 'London' },
  { key: 'preMarket', label: 'Pre Market' },
  { key: 'newYork', label: 'New York' },
] as const;
type SessionTimeKey = (typeof SESSION_TIME_FIELDS)[number]['key'];
const ACCOUNT_STATUS_STYLES: Record<TradingAccountStatus, { background: string; border: string; color: string }> = {
  Eval: {
    background: 'rgba(37,99,235,0.12)',
    border: 'rgba(37,99,235,0.24)',
    color: '#60a5fa',
  },
  Funded: {
    background: 'rgba(245,158,11,0.12)',
    border: 'rgba(245,158,11,0.24)',
    color: '#fbbf24',
  },
  Live: {
    background: 'rgba(168,85,247,0.12)',
    border: 'rgba(168,85,247,0.24)',
    color: '#c084fc',
  },
  Passed: {
    background: 'rgba(34,197,94,0.12)',
    border: 'rgba(34,197,94,0.24)',
    color: '#4ade80',
  },
  Blown: {
    background: 'rgba(239,68,68,0.12)',
    border: 'rgba(239,68,68,0.24)',
    color: '#fca5a5',
  },
};

interface TimezoneGroup {
  region: string;
  zones: string[];
}

const TIMEZONE_GROUPS: TimezoneGroup[] = (() => {
  const intlWithSupportedValues = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intlWithSupportedValues.supportedValuesOf?.('timeZone') ?? [];
  const timezoneList = zones.includes(DEFAULT_TIMEZONE) ? zones : [...zones, DEFAULT_TIMEZONE];
  const grouped = new Map<string, string[]>();

  timezoneList.forEach(zone => {
    const [region] = zone.split('/');
    const group = region || 'Other';
    const bucket = grouped.get(group) ?? [];
    bucket.push(zone);
    grouped.set(group, bucket);
  });

  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const aIndex = TIMEZONE_REGION_PRIORITY.indexOf(a);
      const bIndex = TIMEZONE_REGION_PRIORITY.indexOf(b);

      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      }

      return a.localeCompare(b);
    })
    .map(([region, groupZones]) => ({
      region,
      zones: [...groupZones].sort((a, b) => a.localeCompare(b)),
    }));
})();

const getUtcOffset = (timezone: string) => {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(new Date());
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
  const offset = offsetPart
    .replace('GMT', 'UTC')
    .replace('UTC+0', 'UTC')
    .replace('UTC-0', 'UTC');
  return offset ? `(${offset})` : '(UTC)';
};

const formatTimezoneOptionLabel = (timezone: string) => {
  const zoneParts = timezone.split('/');
  const citySegment = zoneParts[zoneParts.length - 1] || timezone;
  const cityLabel = citySegment.replace(/_/g, ' ');
  return `${getUtcOffset(timezone)} ${cityLabel}`;
};

const SESSION_COLORS: Record<SessionTimeKey, string> = {
  asia: '#ef4444',
  london: '#4f8ef7',
  preMarket: '#a78bfa',
  newYork: '#34d399',
};

const AMBER = '#f59e0b';
const AMBER_DIM = 'rgba(245,158,11,0.1)';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const BORDER = 'var(--app-border)';
const BSUB = 'rgba(255,255,255,0.04)';
const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const SANS = 'var(--font-sans)';

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return `rgba(79,142,247,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function normalizeUsername(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

function toMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    return 0;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function getSessionDurationMinutes(start: string, end: string): number {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  const diff = endMinutes - startMinutes;
  if (diff > 0) return diff;
  if (diff < 0) return (1440 - startMinutes) + endMinutes;
  return 1440;
}

function formatSessionWindow(start: string, end: string): string {
  const hours = getSessionDurationMinutes(start, end) / 60;
  const normalized = Number.isInteger(hours) ? `${hours}` : hours.toFixed(1).replace(/\.0$/, '');
  return `${normalized}h window`;
}

function getSessionTimelineSegments(start: string, end: string): Array<{ left: number; width: number }> {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  if (startMinutes === endMinutes) {
    return [{ left: 0, width: 100 }];
  }

  if (endMinutes > startMinutes) {
    return [{
      left: (startMinutes / 1440) * 100,
      width: ((endMinutes - startMinutes) / 1440) * 100,
    }];
  }

  return [
    {
      left: (startMinutes / 1440) * 100,
      width: ((1440 - startMinutes) / 1440) * 100,
    },
    {
      left: 0,
      width: (endMinutes / 1440) * 100,
    },
  ];
}

// â”€â”€â”€ sub-components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span
        style={{
          color: T2,
          fontSize: '11px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, height: '1px', background: BSUB }} />
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '11px',
        fontWeight: 500,
        color: T2,
      }}
    >
      {children}
    </span>
  );
}

function StyledSelect({
  value,
  onChange,
  children,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  compact?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          appearance: 'none',
          background: S2,
          border: `1px solid ${focused ? AMBER : BORDER}`,
          borderRadius: '6px',
          padding: compact ? '6px 32px 6px 10px' : '10px 36px 10px 12px',
          color: T1,
          fontSize: compact ? '12px' : '13px',
          outline: 'none',
          cursor: 'pointer',
          boxShadow: focused ? '0 0 0 3px rgba(245,158,11,0.14)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: SANS,
        }}
      >
        {children}
      </select>
      <ChevronDown
        size={12}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        style={{ color: T3 }}
      />
    </div>
  );
}

function WorkspaceSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div className="relative">
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          appearance: 'none',
          colorScheme: 'dark',
          background: S2,
          border: `1px solid ${focused ? AMBER : hovered ? 'rgba(255,255,255,0.16)' : BORDER}`,
          borderRadius: '6px',
          padding: '10px 36px 10px 12px',
          color: T1,
          fontSize: '13px',
          fontWeight: 500,
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px rgba(245,158,11,0.14)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: SANS,
        }}
      >
        {children}
      </select>
      <span
        style={{
          position: 'absolute',
          right: '11px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          display: 'inline-flex',
          color: T3,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.25 4.5L6 8.25L9.75 4.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

function SessionTimeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div className="relative">
      <input
        type="time"
        value={value}
        onChange={event => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          colorScheme: 'dark',
          background: S2,
          border: `1px solid ${focused ? AMBER : hovered ? 'rgba(255,255,255,0.16)' : BORDER}`,
          borderRadius: '6px',
          padding: '10px 36px 10px 12px',
          color: T1,
          fontSize: '13px',
          fontWeight: 500,
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px rgba(245,158,11,0.14)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: SANS,
        }}
      />
      <span
        style={{
          position: 'absolute',
          right: '11px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          display: 'inline-flex',
          color: T3,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.75" />
          <path d="M12 8V12L14.6 13.4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: TradingAccountStatus;
  onChange: (value: TradingAccountStatus) => void;
}) {
  const [focused, setFocused] = useState(false);
  const palette = ACCOUNT_STATUS_STYLES[value];
  const isBlown = value === 'Blown';
  const isPassed = value === 'Passed';

  return (
    <div className="relative inline-flex min-w-[110px]">
      <select
        value={value}
        onChange={event => onChange(event.target.value as TradingAccountStatus)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          appearance: 'none',
          background: isBlown ? 'rgba(127,29,29,0.82)' : isPassed ? 'rgba(20,83,45,0.72)' : S2,
          border: `1px solid ${focused ? palette.color : isBlown ? 'rgba(252,165,165,0.85)' : isPassed ? 'rgba(74,222,128,0.7)' : palette.border}`,
          borderRadius: '999px',
          padding: (isBlown || isPassed) ? '6px 28px 6px 31px' : '6px 28px 6px 12px',
          color: isBlown ? '#fee2e2' : isPassed ? '#bbf7d0' : palette.color,
          fontSize: '11px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          outline: 'none',
          cursor: 'pointer',
          boxShadow: focused
            ? `0 0 0 3px ${palette.background}`
            : isBlown
              ? 'inset 0 0 0 1px rgba(239,68,68,0.32), 0 0 20px rgba(239,68,68,0.2)'
              : isPassed
                ? 'inset 0 0 0 1px rgba(34,197,94,0.22), 0 0 16px rgba(34,197,94,0.15)'
                : `inset 0 0 0 1px ${palette.background}`,
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: SANS,
        }}
      >
        {ACCOUNT_STATUSES.map(status => (
          <option
            key={status}
            value={status}
            style={{
              backgroundColor: S2,
              color: ACCOUNT_STATUS_STYLES[status].color,
              fontWeight: 700,
            }}
          >
            {status}
          </option>
        ))}
      </select>
      {isBlown && (
        <AlertTriangle
          size={11}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
          style={{ color: '#fecaca' }}
        />
      )}
      {isPassed && (
        <Check
          size={11}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
          style={{ color: '#86efac' }}
        />
      )}
      <ChevronDown
        size={11}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
        style={{ color: isBlown ? '#fecaca' : isPassed ? '#86efac' : palette.color }}
      />
    </div>
  );
}

// â”€â”€â”€ main page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function Settings() {
  const location = useLocation();
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { profile, saveProfile } = useRivals();
  const journalEntries = useFlyxaStore(state => state.entries);
  const deletedTradeIds = useFlyxaStore(state => state.deletedTradeIds);
  const setEntries = useFlyxaStore(state => state.setEntries);
  const addPayout = useFlyxaStore(state => state.addPayout);
  const deletePayout = useFlyxaStore(state => state.deletePayout);
  const storeAccounts = useFlyxaStore(state => state.accounts);
  const getPayouts = (accountId: string) => storeAccounts.find(a => a.id === accountId)?.payouts ?? [];
  const {
    accounts,
    defaultTradeAccountId,
    preferences,
    confluenceOptions,
    addAccount,
    updateAccount,
    deleteAccount,
    updatePreferences,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
  } = useAppSettings();
  const [showAddAccountModal, setShowAddAccountModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [payoutTarget, setPayoutTarget] = useState<string | null>(null);
  const [payoutDate, setPayoutDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutNote, setPayoutNote] = useState('');
  const [newAccount, setNewAccount] = useState({
    name: '',
    broker: '',
    type: 'Futures' as TradingAccountType,
    status: 'Eval' as TradingAccountStatus,
    startingBalance: '' as string,
  });
  const [activeSection, setActiveSection] = useState<string>('profile');
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [showResetPanel, setShowResetPanel] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetWorking, setResetWorking] = useState(false);
  const [resetError, setResetError] = useState('');
  const [profileDraft, setProfileDraft] = useState('');
  const [profileStatus, setProfileStatus] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profilePhotoUploading, setProfilePhotoUploading] = useState(false);
  const profilePhotoInputRef = useRef<HTMLInputElement>(null);
  const profileRef = useRef<HTMLElement>(null);
  const generalRef = useRef<HTMLElement>(null);
  const displayRef = useRef<HTMLElement>(null);
  const scannerRef = useRef<HTMLElement>(null);
  const accountsRef = useRef<HTMLElement>(null);
  const journalRef = useRef<HTMLElement>(null);
  const [newConfluenceDraft, setNewConfluenceDraft] = useState('');
  const [editingConfluenceIndex, setEditingConfluenceIndex] = useState<number | null>(null);
  const [editingConfluenceDraft, setEditingConfluenceDraft] = useState('');
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveToastReadyRef = useRef(false);
  const confluenceSyncedRef = useRef(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importFeedback, setImportFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const deletedSet = new Set(deletedTradeIds);
  const loadedTradeCount = journalEntries.reduce((sum, entry) => sum + entry.trades.filter(t => !deletedSet.has(t.id)).length, 0);
  const backupStamp = new Date().toISOString().slice(0, 10);

  function downloadTextFile(filename: string, contents: string, type: string) {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleExportJson() {
    const deleted = new Set(deletedTradeIds);
    const cleanEntries = journalEntries.map(entry => ({
      ...entry,
      trades: entry.trades.filter(t => !deleted.has(t.id)),
    }));
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      user: user ? { id: user.id, email: user.email ?? null } : null,
      summary: {
        journalDays: cleanEntries.length,
        trades: loadedTradeCount,
      },
      entries: cleanEntries,
    };
    downloadTextFile(`flyxa-trade-backup-${backupStamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  function csvCell(value: unknown): string {
    const raw = value == null ? '' : String(value);
    return `"${raw.replace(/"/g, '""')}"`;
  }

  function handleExportCsv() {
    const rows = journalEntries.flatMap(entry => entry.trades.map(trade => ({
      entryDate: entry.date,
      symbol: trade.symbol,
      direction: trade.direction,
      entry: trade.entry,
      stopLoss: trade.sl,
      takeProfit: trade.tp,
      exit: trade.exit ?? '',
      contracts: trade.contracts,
      pnl: trade.pnl,
      result: trade.result,
      entryTime: trade.time ?? (trade as unknown as { entryTime?: string }).entryTime ?? '',
      account: trade.account ?? entry.account ?? '',
      notes: trade.reflection?.execution ?? '',
    })));
    const headers = ['entryDate', 'symbol', 'direction', 'entry', 'stopLoss', 'takeProfit', 'exit', 'contracts', 'pnl', 'result', 'entryTime', 'account', 'notes'];
    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(header => csvCell(row[header as keyof typeof row])).join(',')),
    ].join('\n');
    downloadTextFile(`flyxa-trades-${backupStamp}.csv`, csv, 'text/csv');
  }

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!e.target) return;
    e.target.value = '';            // reset so the same file can be re-selected
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const payload = JSON.parse(ev.target?.result as string ?? '');
        if (payload?.version !== 1 || !Array.isArray(payload?.entries)) {
          setImportFeedback({ ok: false, msg: 'Invalid backup file.' });
          setTimeout(() => setImportFeedback(null), 4000);
          return;
        }
        setEntries(payload.entries);
        setImportFeedback({ ok: true, msg: `Restored ${payload.entries.length} day${payload.entries.length !== 1 ? 's' : ''}.` });
        setTimeout(() => setImportFeedback(null), 4000);
      } catch {
        setImportFeedback({ ok: false, msg: 'Could not parse file.' });
        setTimeout(() => setImportFeedback(null), 4000);
      }
    };
    reader.readAsText(file);
  }

  const navSections = [
    {
      key: 'profile',
      title: 'Profile',
      description: 'Login and public identity.',
      icon: <User size={16} />,
      ref: profileRef,
    },
    {
      key: 'general',
      title: 'General',
      description: 'Global look and formatting defaults.',
      icon: <Palette size={16} />,
      ref: generalRef,
    },
    {
      key: 'display',
      title: 'Display',
      description: 'Chart defaults for new views.',
      icon: <Monitor size={16} />,
      ref: displayRef,
    },
    {
      key: 'scanner',
      title: 'Scanner',
      description: 'AI chart scanner zone colors.',
      icon: <Scan size={16} />,
      ref: scannerRef,
    },
    {
      key: 'accounts',
      title: 'Accounts',
      description: 'Manage trading accounts.',
      icon: <Wallet size={16} />,
      ref: accountsRef,
    },
    {
      key: 'journal',
      title: 'Journal',
      description: 'Confluence tags for trade logging.',
      icon: <Tag size={16} />,
      ref: journalRef,
    },
  ];

  function scrollToSection(key: string, ref: React.RefObject<HTMLElement | null>) {
    setActiveSection(key);
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleSaveProfile() {
    const username = normalizeUsername(profileDraft || profile?.username || '');
    setProfileDraft(username);
    if (!username) {
      setProfileStatus('Choose a username first.');
      return;
    }

    setProfileSaving(true);
    setProfileStatus('');
    try {
      await saveProfile({ username, displayName: username });
      setProfileDraft('');
      setProfileStatus('Profile saved.');
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : 'Could not save profile.');
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleProfilePhotoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const username = normalizeUsername(profileDraft || profile?.username || '');
    if (!username) {
      setProfileStatus('Choose a username before adding a profile picture.');
      return;
    }
    if (!user?.id) {
      setProfileStatus('Sign in before adding a profile picture.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      setProfileStatus('Choose an image file for your profile picture.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setProfileStatus('Profile picture must be under 5 MB.');
      return;
    }

    setProfilePhotoUploading(true);
    setProfileStatus('');
    try {
      const ext = file.type.split('/')[1] || 'png';
      const path = `${user.id}/profile-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const { error } = await supabase.storage.from(PROFILE_IMAGE_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (error) throw error;

      const { data } = supabase.storage.from(PROFILE_IMAGE_BUCKET).getPublicUrl(path);
      await saveProfile({
        username,
        displayName: username,
        avatarUrl: data.publicUrl,
      });
      setProfileDraft('');
      setProfileStatus('Profile picture updated.');
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : 'Could not update profile picture.');
    } finally {
      setProfilePhotoUploading(false);
    }
  }

  function clearResetLocalKeys() {
    if (!user?.id) return;
    const keys = [
      `tw_accounts_${user.id}`,
      `tw_preferences_${user.id}`,
      `tw_selected_account_${user.id}`,
      `tw_trade_accounts_${user.id}`,
      `tw_confluence_options_${user.id}`,
      'flyxa_entries',
      'flyxa_billing_accounts',
      'flyxa_trading_plan_state_v1',
      'flyxa_checklist',
      'tw_goals_local',
      'flyxa-store',
      'flyxa-store-uid',
      'flyxa-entries-safe',
      'flyxa-entries-safe-uid',
      'flyxa-store-saved-at',
      'flyxa_store_migrated_v1',
    ];
    keys.forEach(key => {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    });
  }

  async function handleConfirmResetAllData() {
    if (resetConfirmText !== 'RESET' || resetWorking) return;

    setResetWorking(true);
    setResetError('');
    try {
      // Server-side wipe: deletes user_store AND store_entries_backup from Supabase.
      // Both tables must be cleared — otherwise store_entries_backup acts as a
      // recovery source and brings all data back on the next page load.
      await accountApi.reset();

      // Clear all local caches so there is nothing to restore from on reload.
      await clearCurrentUserStoreCache();
      clearResetLocalKeys();

      setShowResetPanel(false);
      setResetConfirmText('');
      window.location.reload();
    } catch (error) {
      setResetError(error instanceof Error ? error.message : 'Could not reset account data.');
      setResetWorking(false);
    }
  }

  function resetNewAccountForm() {
    setNewAccount({
      name: '',
      broker: '',
      type: 'Futures',
      status: 'Eval',
      startingBalance: '',
    });
  }

  function closeAddAccountModal() {
    setShowAddAccountModal(false);
    resetNewAccountForm();
  }

  function handleAddAccount() {
    if (!newAccount.name.trim()) return;
    const parsedBalance = parseFloat(newAccount.startingBalance);
    addAccount({
      name: newAccount.name.trim(),
      broker: newAccount.broker.trim(),
      type: newAccount.type,
      status: newAccount.status,
      color: DEFAULT_ACCOUNT_COLOR,
      startingBalance: Number.isFinite(parsedBalance) && parsedBalance > 0 ? parsedBalance : undefined,
    });
    closeAddAccountModal();
  }

  function handleSessionTimeChange(session: SessionTimeKey, field: 'start' | 'end', value: string) {
    updatePreferences({
      sessionTimes: {
        ...preferences.sessionTimes,
        [session]: {
          ...preferences.sessionTimes[session],
          [field]: value,
        },
      },
    });
  }

  // shared inline input style for the accounts table
  const tableInputStyle: React.CSSProperties = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: T1,
    fontSize: '13px',
    padding: '4px 0',
    fontFamily: SANS,
  };

  const tableInputFocusedStyle: React.CSSProperties = {
    borderBottom: `1px solid ${AMBER}`,
  };

  const defaultTradeAccount = accounts.find(account => account.id === defaultTradeAccountId);
  const defaultTradeAccountName = defaultTradeAccount?.name ?? 'Default Account';
  const profileUsername = profile?.username ?? '';
  const displayName = (user?.user_metadata?.name as string | undefined)
    || (user?.user_metadata?.full_name as string | undefined)
    || user?.email?.split('@')[0]
    || 'Trader';
  const email = user?.email ?? 'No email on file';
  const avatarInitials = (profile?.avatarInitials || displayName.slice(0, 2)).toUpperCase();
  const avatarUrl = profile?.avatarUrl ?? null;

  useEffect(() => {
    const sectionEntries = [
      { key: 'profile', ref: profileRef },
      { key: 'general', ref: generalRef },
      { key: 'display', ref: displayRef },
      { key: 'scanner', ref: scannerRef },
      { key: 'accounts', ref: accountsRef },
      { key: 'journal', ref: journalRef },
    ];

    const updateActiveSectionFromScroll = () => {
      const stickyOffset = 180;
      let nextActive = 'profile';

      sectionEntries.forEach(section => {
        const top = section.ref.current?.getBoundingClientRect().top;
        if (typeof top === 'number' && top <= stickyOffset) {
          nextActive = section.key;
        }
      });

      setActiveSection(current => (current === nextActive ? current : nextActive));
    };

    updateActiveSectionFromScroll();
    window.addEventListener('scroll', updateActiveSectionFromScroll, { passive: true });

    return () => window.removeEventListener('scroll', updateActiveSectionFromScroll);
  }, []);
  useEffect(() => {
    const rawHash = location.hash.replace('#', '').trim().toLowerCase();
    if (!rawHash) return;

    const sectionKey = rawHash === 'add-account' ? 'accounts' : rawHash;
    const sectionRef =
      sectionKey === 'profile' ? profileRef
      : sectionKey === 'general' ? generalRef
      : sectionKey === 'display' ? displayRef
      : sectionKey === 'scanner' ? scannerRef
      : sectionKey === 'accounts' ? accountsRef
      : sectionKey === 'journal' ? journalRef
      : null;

    if (!sectionRef) return;

    const frame = window.requestAnimationFrame(() => {
      scrollToSection(sectionKey, sectionRef);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [location.hash]);
  useEffect(() => {
    if (!autoSaveToastReadyRef.current) {
      autoSaveToastReadyRef.current = true;
      return;
    }

    if (saveDebounceTimerRef.current) {
      clearTimeout(saveDebounceTimerRef.current);
    }

    saveDebounceTimerRef.current = setTimeout(() => {
      setShowSavedToast(true);

      if (saveHideTimerRef.current) {
        clearTimeout(saveHideTimerRef.current);
      }

      saveHideTimerRef.current = setTimeout(() => setShowSavedToast(false), 1200);
    }, 350);
  }, [accounts, preferences]);

  useEffect(() => (
    () => {
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
      }
      if (saveHideTimerRef.current) {
        clearTimeout(saveHideTimerRef.current);
      }
    }
  ), []);

  // Seed confluenceOptions with tags used in journal trades, normalising aliases to canonical names
  useEffect(() => {
    if (confluenceSyncedRef.current || journalEntries.length === 0) return;
    confluenceSyncedRef.current = true;

    // Step 1 – normalise any existing options that are currently abbreviations/aliases
    confluenceOptions.forEach((option, idx) => {
      const canonical = normalizeConfluenceTag(option);
      if (canonical !== option) updateConfluenceOption(idx, canonical);
    });

    // Step 2 – collect canonicalised tags from every trade; skip ones already present
    const existing = new Set(
      confluenceOptions.map(c => normalizeConfluenceTag(c).toLowerCase()),
    );
    journalEntries.forEach(entry => {
      entry.trades.forEach(trade => {
        (trade.confluences ?? []).forEach(tag => {
          const canonical = normalizeConfluenceTag(tag);
          if (!canonical || existing.has(canonical.toLowerCase())) return;
          existing.add(canonical.toLowerCase());
          addConfluenceOption(canonical);
        });
      });
    });
  }, [journalEntries, confluenceOptions, addConfluenceOption, updateConfluenceOption]);

  return (
    <div
      className="animate-fade-in space-y-4"
      style={{
        fontFamily: SANS,
      }}
    >

      {/* Page header */}
      <div data-tour-id="settings-header">
        <h1 style={{ fontSize: '18px', fontWeight: 600, color: T1, lineHeight: 1.2 }}>Settings</h1>
        <p style={{ marginTop: '4px', fontSize: '12px', color: T3 }}>
          Manage your profile, workspace preferences, display defaults, and trading accounts.
        </p>
      </div>

      {/* Nav cards */}
      <div
        data-tour-id="settings-nav"
        style={{
          position: 'sticky',
          top: '8px',
          zIndex: 25,
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(130px, 1fr))',
          borderRadius: '8px',
          border: `1px solid ${BORDER}`,
          background: S1,
          backdropFilter: 'blur(8px)',
          overflow: 'hidden',
          overflowX: 'auto',
        }}
      >
        {navSections.map((section, i) => {
          const isActive = activeSection === section.key;
          return (
            <button
              key={section.key}
              type="button"
              onClick={() => scrollToSection(section.key, section.ref)}
              style={{
                position: 'relative',
                textAlign: 'left',
                background: isActive ? 'rgba(245,158,11,0.06)' : 'transparent',
                border: 'none',
                borderLeft: i > 0 ? `1px solid ${BORDER}` : 'none',
                borderTop: `2px solid ${isActive ? AMBER : 'transparent'}`,
                padding: '13px 14px 11px',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '7px',
                  marginBottom: '5px',
                  color: isActive ? AMBER : T3,
                }}
              >
                {section.icon}
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    color: isActive ? AMBER : T1,
                    letterSpacing: '-0.01em',
                    lineHeight: 1,
                  }}
                >
                  {section.title}
                </span>
              </div>
              <p style={{ fontSize: '10px', color: T3, lineHeight: 1.45, paddingLeft: '23px' }}>
                {section.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* Profile section */}
      <section ref={profileRef} data-tour-id="settings-profile" style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="Profile" />
        <SectionPanel
          title="Data safety"
          subtitle="Confirm which login owns the data currently loaded on this device."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>

            {/* Account */}
            <div>
              <FieldLabel>Account</FieldLabel>
              <div
                style={{
                  height: '38px',
                  borderRadius: '6px',
                  border: `1px solid ${BORDER}`,
                  background: S2,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  gap: '8px',
                  overflow: 'hidden',
                }}
              >
                <User size={12} style={{ color: T3, flexShrink: 0 }} />
                <span
                  style={{
                    fontSize: '12px',
                    color: T1,
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {user?.email ?? 'Not signed in'}
                </span>
              </div>
            </div>

            {/* Journal data */}
            <div>
              <FieldLabel>Journal data</FieldLabel>
              <div
                style={{
                  height: '38px',
                  borderRadius: '6px',
                  border: `1px solid ${BORDER}`,
                  background: S2,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  gap: '8px',
                }}
              >
                <span style={{ fontSize: '14px', fontWeight: 600, color: T1, lineHeight: 1 }}>{journalEntries.length}</span>
                <span style={{ fontSize: '11px', color: T3 }}>{journalEntries.length === 1 ? 'day' : 'days'}</span>
                <span style={{ fontSize: '11px', color: T3, opacity: 0.3 }}>·</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: T1, lineHeight: 1 }}>{loadedTradeCount}</span>
                <span style={{ fontSize: '11px', color: T3 }}>{loadedTradeCount === 1 ? 'trade' : 'trades'}</span>
              </div>
            </div>

            {/* Export backup */}
            <div>
              <FieldLabel>Export backup</FieldLabel>
              <div style={{ display: 'flex', gap: '8px' }}>
                {([
                  {
                    label: 'JSON',
                    icon: <FileJson size={13} />,
                    onClick: handleExportJson,
                    disabled: journalEntries.length === 0,
                    color: '#4f8ef7',
                    bg: 'rgba(79,142,247,0.09)',
                    bgHover: 'rgba(79,142,247,0.17)',
                    border: 'rgba(79,142,247,0.35)',
                    borderHover: 'rgba(79,142,247,0.6)',
                  },
                  {
                    label: 'CSV',
                    icon: <FileSpreadsheet size={13} />,
                    onClick: handleExportCsv,
                    disabled: loadedTradeCount === 0,
                    color: '#34d399',
                    bg: 'rgba(52,211,153,0.09)',
                    bgHover: 'rgba(52,211,153,0.17)',
                    border: 'rgba(52,211,153,0.35)',
                    borderHover: 'rgba(52,211,153,0.6)',
                  },
                ] as const).map(btn => (
                  <button
                    key={btn.label}
                    type="button"
                    onClick={btn.onClick}
                    disabled={btn.disabled}
                    style={{
                      flex: 1,
                      height: '38px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '5px',
                      borderRadius: '6px',
                      border: `1px solid ${btn.disabled ? BORDER : btn.border}`,
                      background: btn.disabled ? 'transparent' : btn.bg,
                      color: btn.disabled ? T3 : btn.color,
                      fontSize: '12px',
                      fontWeight: 600,
                      fontFamily: SANS,
                      cursor: btn.disabled ? 'not-allowed' : 'pointer',
                      opacity: btn.disabled ? 0.38 : 1,
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={e => {
                      if (!btn.disabled) {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.background = btn.bgHover;
                        el.style.borderColor = btn.borderHover;
                      }
                    }}
                    onMouseLeave={e => {
                      if (!btn.disabled) {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.background = btn.bg;
                        el.style.borderColor = btn.border;
                      }
                    }}
                  >
                    {btn.icon}
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Import / restore */}
            <div>
              <FieldLabel>Restore from backup</FieldLabel>
              <input
                ref={importFileRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleImportJson}
              />
              <button
                type="button"
                onClick={() => importFileRef.current?.click()}
                style={{
                  height: '38px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  paddingInline: '14px',
                  borderRadius: '6px',
                  border: `1px solid rgba(251,191,36,0.35)`,
                  background: 'rgba(251,191,36,0.07)',
                  color: '#fbbf24',
                  fontSize: '12px',
                  fontWeight: 600,
                  fontFamily: SANS,
                  cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.background = 'rgba(251,191,36,0.14)';
                  el.style.borderColor = 'rgba(251,191,36,0.6)';
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.background = 'rgba(251,191,36,0.07)';
                  el.style.borderColor = 'rgba(251,191,36,0.35)';
                }}
              >
                <Upload size={13} />
                Import JSON
              </button>
              {importFeedback && (
                <p style={{
                  marginTop: '8px',
                  fontSize: '12px',
                  color: importFeedback.ok ? '#4ade80' : '#f87171',
                  fontFamily: SANS,
                }}>
                  {importFeedback.ok ? '✓ ' : '✗ '}{importFeedback.msg}
                </p>
              )}
            </div>

          </div>
        </SectionPanel>
        <SectionPanel
          title="Your profile"
          subtitle="Set the username other traders use to find you and send rival requests."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', alignItems: 'stretch' }}>
            <div
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: '8px',
                background: S2,
                padding: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <input
                ref={profilePhotoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={event => { void handleProfilePhotoChange(event); }}
                style={{ display: 'none' }}
              />
              <div
                style={{
                  width: '52px',
                  height: '52px',
                  borderRadius: '12px',
                  background: AMBER_DIM,
                  border: `1px solid ${AMBER}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: AMBER,
                  fontFamily: 'var(--font-mono)',
                  fontSize: '13px',
                  fontWeight: 700,
                  flexShrink: 0,
                  overflow: 'hidden',
                }}
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : avatarInitials}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ color: T1, fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayName}
                </p>
                <p style={{ marginTop: '3px', color: T3, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {email}
                </p>
                <p style={{ marginTop: '8px', color: profileUsername ? 'var(--cobalt)' : T3, fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                  {profileUsername ? `@${profileUsername}` : 'Username not set'}
                </p>
                <button
                  type="button"
                  disabled={profilePhotoUploading}
                  onClick={() => profilePhotoInputRef.current?.click()}
                  style={{
                    marginTop: '10px',
                    height: '28px',
                    borderRadius: '6px',
                    border: `1px solid ${BORDER}`,
                    background: profilePhotoUploading ? 'rgba(255,255,255,0.03)' : S1,
                    color: profilePhotoUploading ? T3 : T2,
                    padding: '0 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: profilePhotoUploading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {profilePhotoUploading ? 'Uploading...' : avatarUrl ? 'Change photo' : 'Add photo'}
                </button>
              </div>
            </div>

            <div
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: '8px',
                background: S2,
                padding: '14px',
              }}
            >
              <FieldLabel>Username</FieldLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 92px', gap: '8px' }}>
                <input
                  value={profileDraft}
                  placeholder={profileUsername || 'your_username'}
                  onChange={event => setProfileDraft(normalizeUsername(event.target.value))}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void handleSaveProfile();
                  }}
                  style={{
                    width: '100%',
                    minWidth: 0,
                    height: '38px',
                    borderRadius: '6px',
                    border: `1px solid ${BORDER}`,
                    background: S1,
                    color: T1,
                    padding: '0 12px',
                    fontSize: '13px',
                    outline: 'none',
                    fontFamily: SANS,
                  }}
                />
                <button
                  type="button"
                  disabled={profileSaving}
                  onClick={() => { void handleSaveProfile(); }}
                  style={{
                    height: '38px',
                    borderRadius: '6px',
                    border: `1px solid ${AMBER}`,
                    background: profileSaving ? 'rgba(245,158,11,0.08)' : AMBER_DIM,
                    color: AMBER,
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: profileSaving ? 'not-allowed' : 'pointer',
                    opacity: profileSaving ? 0.65 : 1,
                  }}
                >
                  {profileSaving ? 'Saving' : 'Save'}
                </button>
              </div>
              <p style={{ marginTop: '9px', color: T3, fontSize: '11px', lineHeight: 1.5 }}>
                This is your public Flyxa username for rivals, requests, and leaderboards.
              </p>
              {profileStatus && (
                <p style={{ marginTop: '8px', color: profileStatus.includes('saved') ? 'var(--green)' : AMBER, fontSize: '11px', fontWeight: 600 }}>
                  {profileStatus}
                </p>
              )}
            </div>
          </div>
        </SectionPanel>
      </section>

      {/* General section */}
      <section ref={generalRef} style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="General" />
        <SectionPanel
          title="Workspace preferences"
          subtitle="Control the global look and formatting defaults for the app."
        >
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <label>
              <span
                style={{
                  display: 'block',
                  marginBottom: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: T2,
                }}
              >
                Theme
              </span>
              <WorkspaceSelect
                value={theme}
                onChange={v => setTheme(v as 'dark' | 'light')}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </WorkspaceSelect>
            </label>

            <label>
              <span
                style={{
                  display: 'block',
                  marginBottom: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: T2,
                }}
              >
                Date Format
              </span>
              <WorkspaceSelect
                value={preferences.dateFormat}
                onChange={v => updatePreferences({ dateFormat: v as typeof preferences.dateFormat })}
              >
                <option value="dd/MM/yyyy">DD/MM/YYYY</option>
                <option value="MM/dd/yyyy">MM/DD/YYYY</option>
                <option value="yyyy-MM-dd">YYYY-MM-DD</option>
              </WorkspaceSelect>
            </label>

            <label>
              <span
                style={{
                  display: 'block',
                  marginBottom: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: T2,
                }}
              >
                Currency Symbol
              </span>
              <WorkspaceSelect
                value={preferences.currencySymbol}
                onChange={v => updatePreferences({ currencySymbol: v as typeof preferences.currencySymbol })}
              >
                <option value="$">$ USD</option>
                <option value="€">€ EUR</option>
                <option value="£">£ GBP</option>
                <option value="A$">A$ AUD</option>
              </WorkspaceSelect>
            </label>

            <label>
              <span
                style={{
                  display: 'block',
                  marginBottom: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: T2,
                }}
              >
                Timezone
              </span>
              <WorkspaceSelect
                value={preferences.timezone}
                onChange={value => updatePreferences({ timezone: value })}
              >
                {TIMEZONE_GROUPS.map(group => (
                  <optgroup key={group.region} label={group.region}>
                    {group.zones.map(zone => (
                      <option key={zone} value={zone}>{formatTimezoneOptionLabel(zone)}</option>
                    ))}
                  </optgroup>
                ))}
              </WorkspaceSelect>
            </label>
          </div>
        </SectionPanel>

        <div style={{ marginTop: '16px' }}>
          <SectionPanel
            title="Session times"
            subtitle="Set your default Asia, London, Pre Market, and New York trading windows."
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
              {SESSION_TIME_FIELDS.map(session => {
                const sessionColor = SESSION_COLORS[session.key];
                const startValue = preferences.sessionTimes[session.key].start;
                const endValue = preferences.sessionTimes[session.key].end;
                const timelineSegments = getSessionTimelineSegments(startValue, endValue);

                return (
                  <div
                    key={session.key}
                    style={{
                      border: `1px solid ${BORDER}`,
                      borderRadius: '8px',
                      padding: '14px',
                      background: S2,
                    }}
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '999px',
                            background: sessionColor,
                            boxShadow: `0 0 0 5px ${hexToRgba(sessionColor, 0.22)}`,
                          }}
                        />
                        <p style={{ fontSize: '12px', fontWeight: 600, color: T1 }}>
                          {session.label}
                        </p>
                      </div>
                      <span
                        style={{
                          border: `1px solid ${hexToRgba(sessionColor, 0.45)}`,
                          background: hexToRgba(sessionColor, 0.12),
                          color: sessionColor,
                          borderRadius: '999px',
                          padding: '3px 8px',
                          fontSize: '11px',
                          fontWeight: 500,
                        }}
                      >
                        {formatSessionWindow(startValue, endValue)}
                      </span>
                    </div>

                    <div className="mb-3">
                      <div
                        style={{
                            position: 'relative',
                            height: '4px',
                            borderRadius: '999px',
                            background: 'rgba(255,255,255,0.06)',
                            overflow: 'hidden',
                          }}
                        >
                        {timelineSegments.map((segment, index) => (
                          <span
                            key={`${session.key}-${index}`}
                            style={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              left: `${segment.left}%`,
                              width: `${segment.width}%`,
                              borderRadius: '999px',
                              background: sessionColor,
                            }}
                          />
                        ))}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                          marginTop: '6px',
                        }}
                      >
                        {['12AM', '6AM', '12PM', '6PM', '12AM'].map(tick => (
                          <span
                            key={`${session.key}-${tick}`}
                            style={{
                              textAlign: 'center',
                              fontSize: '9px',
                              color: T3,
                              fontFamily: 'var(--font-mono)',
                            }}
                          >
                            {tick}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                      <label>
                        <FieldLabel>Start</FieldLabel>
                        <SessionTimeField
                          value={startValue}
                          onChange={value => handleSessionTimeChange(session.key, 'start', value)}
                        />
                      </label>
                      <label>
                        <FieldLabel>End</FieldLabel>
                        <SessionTimeField
                          value={endValue}
                          onChange={value => handleSessionTimeChange(session.key, 'end', value)}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionPanel>
        </div>

        <div style={{ marginTop: '16px' }}>
          <SectionPanel
            title="Product tour"
            subtitle="Reopen the feature walkthrough if you want to review the app tab by tab."
          >
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('flyxa:restart-tour'))}
              style={{
                height: '36px',
                borderRadius: '6px',
                border: `1px solid ${AMBER}`,
                background: AMBER_DIM,
                color: AMBER,
                padding: '0 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Restart Website Tour
            </button>
          </SectionPanel>
        </div>
      </section>

      {/* Display section */}
      <section ref={displayRef} style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="Display" />
        <SectionPanel
          title="Chart defaults"
          subtitle="Choose the chart defaults you want when opening new views."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
            <label>
              <FieldLabel>Default timeframe</FieldLabel>
              <StyledSelect
                value={preferences.defaultTimeframe}
                onChange={v => updatePreferences({ defaultTimeframe: v as typeof preferences.defaultTimeframe })}
              >
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="15m">15 minutes</option>
                <option value="1h">1 hour</option>
              </StyledSelect>
            </label>

            <label>
              <FieldLabel>Default chart type</FieldLabel>
              <StyledSelect
                value={preferences.defaultChartType}
                onChange={v => updatePreferences({ defaultChartType: v as typeof preferences.defaultChartType })}
              >
                <option value="Candles">Candles</option>
                <option value="Line">Line</option>
                <option value="Area">Area</option>
              </StyledSelect>
            </label>
          </div>
        </SectionPanel>
      </section>

      {/* Scanner section */}
      <section ref={scannerRef} data-tour-id="settings-scanner" style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="Scanner" />
        <SectionPanel
          title="Chart zone colors"
          subtitle="Match these colors to the zone boxes drawn on your TradingView chart so the AI can identify each level correctly."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            {([
              { key: 'entry' as const, label: 'Entry zone', hint: 'Color of the entry price zone box on your chart' },
              { key: 'stopLoss' as const, label: 'Stop Loss zone', hint: 'Color of the stop loss zone box on your chart' },
              { key: 'takeProfit' as const, label: 'Take Profit zone', hint: 'Color of the take profit zone box on your chart' },
            ]).map(({ key, label, hint }) => {
              const hex = preferences.scannerColors?.[key] ?? (key === 'entry' ? '#E67E22' : key === 'stopLoss' ? '#C0392B' : '#1A6B5A');
              return (
                <div key={key}>
                  <FieldLabel>{label}</FieldLabel>
                  <ColorPickerField
                    label={label}
                    hint={hint}
                    value={hex}
                    onChange={color => updatePreferences({
                      scannerColors: {
                        ...preferences.scannerColors,
                        [key]: color,
                      },
                    })}
                  />
                </div>
              );
            })}
          </div>
          <p style={{ marginTop: '12px', fontSize: '11px', color: T3, lineHeight: 1.6 }}>
            Click a swatch to open the color picker and match it to the zone color on your TradingView chart.
          </p>
        </SectionPanel>
      </section>

      {/* Accounts section */}
      <section ref={accountsRef} data-tour-id="settings-accounts" style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="Accounts" />
        <SectionPanel
          title="Trading accounts"
          subtitle="Manage the trading accounts available across the dashboard and journal."
          right={
            <button
              type="button"
              data-tour-id="settings-add-account"
              onClick={() => setShowAddAccountModal(true)}
              style={{
                height: '34px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: AMBER,
                border: 'none',
                borderRadius: '5px',
                padding: '0 14px',
                color: '#000',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.88'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
            >
              <Plus size={13} />
              Add Account
            </button>
          }
        >
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ minWidth: 680 }}>
          {/* Table header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: ACCOUNT_TABLE_GRID_COLUMNS,
              gap: ACCOUNT_TABLE_COLUMN_GAP,
              padding: '0 4px 8px',
              borderBottom: `1px solid ${BSUB}`,
              marginBottom: '4px',
            }}
          >
            {['Account name', 'Broker', 'Starting balance', 'Account type', 'Status', 'Actions'].map(col => (
              <span
                key={col}
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  color: T3,
                }}
              >
                {col}
              </span>
            ))}
          </div>

          {/* Account rows */}
          <div>
            {accounts.filter(account => account.id !== DEFAULT_ACCOUNT_ID && !account.archived).map(account => (
              <div key={account.id}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: ACCOUNT_TABLE_GRID_COLUMNS,
                    gap: ACCOUNT_TABLE_COLUMN_GAP,
                    alignItems: 'center',
                    padding: '10px 4px',
                    borderBottom: account.status === 'Blown'
                      ? '1px solid rgba(248,113,113,0.26)'
                      : `1px solid ${BSUB}`,
                    background: account.status === 'Blown' ? 'rgba(127,29,29,0.08)' : 'transparent',
                    borderRadius: account.status === 'Blown' ? '8px' : '0',
                  }}
                >
                  {/* Account name */}
                  <div>
                    <input
                      style={tableInputStyle}
                      value={account.name}
                      onChange={e => updateAccount(account.id, { name: e.target.value })}
                      onFocus={e => Object.assign(e.target.style, tableInputFocusedStyle)}
                      onBlur={e => { e.target.style.borderBottom = 'none'; }}
                      placeholder="Account name"
                    />
                    {account.id === defaultTradeAccountId && (
                      <span
                        style={{
                          display: 'inline-block',
                          marginTop: '4px',
                          background: AMBER_DIM,
                          color: AMBER,
                          fontSize: '10px',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          borderRadius: '999px',
                          padding: '3px 9px',
                        }}
                      >
                        Default
                      </span>
                    )}
                  </div>

                  {/* Broker */}
                  <input
                    style={tableInputStyle}
                    value={account.broker ?? ''}
                    onChange={e => updateAccount(account.id, { broker: e.target.value })}
                    onFocus={e => Object.assign(e.target.style, tableInputFocusedStyle)}
                    onBlur={e => { e.target.style.borderBottom = 'none'; }}
                    placeholder="Broker"
                  />

                  {/* Starting balance */}
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    style={tableInputStyle}
                    value={account.startingBalance ?? ''}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      updateAccount(account.id, { startingBalance: Number.isFinite(v) && v >= 0 ? v : undefined });
                    }}
                    onFocus={e => Object.assign(e.target.style, tableInputFocusedStyle)}
                    onBlur={e => { e.target.style.borderBottom = 'none'; }}
                    placeholder="e.g. 100000"
                  />

                  {/* Account type */}
                  <StyledSelect
                    value={account.type}
                    onChange={v => updateAccount(account.id, { type: v as TradingAccountType })}
                    compact
                  >
                    {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </StyledSelect>

                  {/* Status */}
                  <StatusSelect
                    value={account.status}
                    onChange={status => updateAccount(account.id, { status })}
                  />

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {/* Payouts button — live/funded accounts only */}
                    {(account.status === 'Funded' || account.status === 'Live') && (
                      <button
                        type="button"
                        onClick={() => setPayoutTarget(payoutTarget === account.id ? null : account.id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          background: payoutTarget === account.id
                            ? '#f59e0b'
                            : (getPayouts(account.id).length ?? 0) > 0
                              ? 'rgba(245,158,11,0.18)'
                              : 'rgba(245,158,11,0.08)',
                          border: `1px solid ${payoutTarget === account.id ? '#f59e0b' : 'rgba(245,158,11,0.45)'}`,
                          borderRadius: '6px',
                          padding: '5px 10px',
                          color: payoutTarget === account.id ? '#1a1208' : '#f59e0b',
                          fontSize: '11.5px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                        }}
                      >
                        <DollarSign size={12} />
                        Payouts{getPayouts(account.id).length > 0 ? ` (${getPayouts(account.id).length})` : ''}
                      </button>
                    )}
                    {account.id !== DEFAULT_ACCOUNT_ID && (account.status === 'Blown' || account.status === 'Passed') && (
                      <button
                        type="button"
                        onClick={() => updateAccount(account.id, { archived: true })}
                        title="Hide from active account list. Trades remain accessible."
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: 'transparent',
                          border: `1px solid rgba(107,114,128,0.3)`,
                          borderRadius: '6px',
                          padding: '4px 8px',
                          color: 'rgba(156,163,175,0.9)',
                          fontSize: '11px',
                          cursor: 'pointer',
                          transition: 'background 0.15s, color 0.15s',
                        }}
                        onMouseEnter={e => {
                          const el = e.currentTarget as HTMLButtonElement;
                          el.style.background = 'rgba(107,114,128,0.12)';
                          el.style.color = '#d1d5db';
                        }}
                        onMouseLeave={e => {
                          const el = e.currentTarget as HTMLButtonElement;
                          el.style.background = 'transparent';
                          el.style.color = 'rgba(156,163,175,0.9)';
                        }}
                      >
                        Archive
                      </button>
                    )}
                    {account.id !== DEFAULT_ACCOUNT_ID && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(account.id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          background: 'transparent',
                          border: '1px solid rgba(239,68,68,0.2)',
                          borderRadius: '6px',
                          padding: '4px 8px',
                          color: 'rgba(252,165,165,0.8)',
                          fontSize: '11px',
                          cursor: 'pointer',
                          transition: 'background 0.15s, color 0.15s',
                        }}
                        onMouseEnter={e => {
                          const el = e.currentTarget as HTMLButtonElement;
                          el.style.background = 'rgba(239,68,68,0.1)';
                          el.style.color = '#fca5a5';
                        }}
                        onMouseLeave={e => {
                          const el = e.currentTarget as HTMLButtonElement;
                          el.style.background = 'transparent';
                          el.style.color = 'rgba(252,165,165,0.8)';
                        }}
                      >
                        <Trash2 size={11} />
                        Delete
                      </button>
                    )}
                  </div>
                </div>


                {/* Payouts panel */}
                {payoutTarget === account.id && (
                  <div style={{
                    margin: '8px 0 4px',
                    borderRadius: '8px',
                    border: '1px solid var(--app-border)',
                    borderLeft: `3px solid ${AMBER}`,
                    background: 'var(--app-panel)',
                    padding: '14px 16px',
                  }}>
                    {/* Add payout form */}
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--app-text-muted)' }}>Date</label>
                        <DatePicker
                          value={payoutDate}
                          onChange={setPayoutDate}
                          compact
                          align="left"
                          max={new Date().toISOString().slice(0, 10)}
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--app-text-muted)' }}>Amount ($)</label>
                        <input
                          type="number"
                          min="0"
                          step="100"
                          placeholder="e.g. 1500"
                          value={payoutAmount}
                          onChange={e => setPayoutAmount(e.target.value)}
                          style={{ height: 30, width: 120, borderRadius: 6, border: '1px solid var(--app-border)', background: 'var(--app-panel-strong)', color: 'var(--app-text)', fontSize: 12, padding: '0 8px' }}
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--app-text-muted)' }}>Note</label>
                        <input
                          type="text"
                          placeholder="optional"
                          value={payoutNote}
                          onChange={e => setPayoutNote(e.target.value)}
                          style={{ height: 30, width: 170, borderRadius: 6, border: '1px solid var(--app-border)', background: 'var(--app-panel-strong)', color: 'var(--app-text)', fontSize: 12, padding: '0 8px' }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const amt = parseFloat(payoutAmount);
                          if (!payoutDate || !Number.isFinite(amt) || amt <= 0) return;
                          addPayout(account.id, { id: crypto.randomUUID(), date: payoutDate, amount: amt, note: payoutNote.trim() || undefined });
                          setPayoutAmount('');
                          setPayoutNote('');
                        }}
                        style={{ height: 30, borderRadius: 6, border: 'none', background: AMBER, color: '#111', fontSize: 12, fontWeight: 700, padding: '0 16px', cursor: 'pointer' }}
                      >
                        Add
                      </button>
                    </div>

                    {/* Payout list */}
                    {getPayouts(account.id).length > 0 ? (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          {[...getPayouts(account.id)].sort((a, b) => b.date.localeCompare(a.date)).map(payout => (
                            <div key={payout.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--app-border)' }}>
                              <span style={{ fontSize: 11, color: 'var(--app-text-muted)', minWidth: 84, fontFamily: 'var(--font-mono)' }}>{payout.date}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: AMBER, fontFamily: 'var(--font-mono)', minWidth: 100 }}>
                                +${payout.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--app-text-subtle)', flex: 1 }}>{payout.note ?? ''}</span>
                              <button
                                type="button"
                                onClick={() => deletePayout(account.id, payout.id)}
                                style={{ background: 'none', border: 'none', color: 'var(--app-text-subtle)', cursor: 'pointer', lineHeight: 0, padding: 2, opacity: 0.6 }}
                                title="Remove"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--app-text-muted)' }}>
                            Total:{' '}
                            <span style={{ fontWeight: 700, color: AMBER, fontFamily: 'var(--font-mono)' }}>
                              ${getPayouts(account.id).reduce((s, p) => s + p.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <p style={{ fontSize: 11, color: 'var(--app-text-subtle)', margin: 0 }}>No payouts logged yet.</p>
                    )}
                  </div>
                )}

                {/* Delete confirmation */}
                {deleteTarget === account.id && (
                  <div
                    style={{
                      margin: '8px 4px',
                      borderRadius: '8px',
                      border: '1px solid rgba(245,158,11,0.2)',
                      background: 'rgba(245,158,11,0.06)',
                      padding: '12px 16px',
                    }}
                  >
                    <p style={{ fontSize: '13px', color: '#fde68a' }}>
                      Delete{' '}
                      <span style={{ fontWeight: 600, color: '#fff' }}>{account.name}</span>?{' '}
                      Trades on this account will fall back to {defaultTradeAccountName}.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => { deleteAccount(account.id); setDeleteTarget(null); }}
                        className="btn-danger"
                        style={{ fontSize: '12px', padding: '6px 14px' }}
                      >
                        Confirm Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(null)}
                        className="btn-secondary"
                        style={{ fontSize: '12px', padding: '6px 14px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          </div>{/* end minWidth wrapper */}
          </div>{/* end overflow-x wrapper */}

          {/* Add another account trigger */}
          <button
            type="button"
            onClick={() => setShowAddAccountModal(true)}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              padding: '10px',
              marginTop: '4px',
              background: 'transparent',
              border: 'none',
              borderTop: `1px solid ${BSUB}`,
              color: T3,
              fontSize: '12px',
              cursor: 'pointer',
              borderRadius: '0 0 6px 6px',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = AMBER_DIM;
              el.style.color = AMBER;
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = 'transparent';
              el.style.color = T3;
            }}
          >
            <Plus size={13} />
            Add another account
          </button>

          {/* Archived accounts */}
          {accounts.some(a => a.id !== DEFAULT_ACCOUNT_ID && a.archived) && (
            <div style={{ marginTop: '20px', borderTop: `1px solid ${BSUB}`, paddingTop: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: 600, color: T2, marginBottom: '10px' }}>
                Archived accounts
              </p>
              {accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && a.archived).map(account => (
                <div key={account.id} style={{ marginBottom: '6px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      borderRadius: deleteTarget === account.id ? '6px 6px 0 0' : '6px',
                      border: `1px solid ${BSUB}`,
                      borderBottom: deleteTarget === account.id ? 'none' : `1px solid ${BSUB}`,
                      background: 'rgba(255,255,255,0.02)',
                      opacity: 0.75,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '12px', color: T1 }}>{account.name}</span>
                      <span style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: account.status === 'Blown' ? '#fca5a5' : '#86efac',
                        background: account.status === 'Blown' ? 'rgba(239,68,68,0.08)' : 'rgba(74,222,128,0.08)',
                        border: `1px solid ${account.status === 'Blown' ? 'rgba(239,68,68,0.25)' : 'rgba(74,222,128,0.25)'}`,
                        borderRadius: '4px',
                        padding: '2px 6px',
                      }}>{account.status}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => updateAccount(account.id, { archived: false })}
                        style={{
                          fontSize: '11px',
                          padding: '3px 10px',
                          borderRadius: '5px',
                          border: `1px solid rgba(96,165,250,0.25)`,
                          background: 'transparent',
                          color: 'rgba(147,197,253,0.9)',
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(96,165,250,0.1)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                      >
                        Unarchive
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(deleteTarget === account.id ? null : account.id)}
                        style={{
                          fontSize: '11px',
                          padding: '3px 10px',
                          borderRadius: '5px',
                          border: '1px solid rgba(239,68,68,0.2)',
                          background: 'transparent',
                          color: 'rgba(252,165,165,0.8)',
                          cursor: 'pointer',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {deleteTarget === account.id && (
                    <div style={{
                      padding: '10px 14px',
                      borderRadius: '0 0 6px 6px',
                      border: `1px solid ${BSUB}`,
                      borderTop: 'none',
                      background: 'rgba(245,158,11,0.04)',
                    }}>
                      <p style={{ fontSize: '12px', color: '#fde68a', marginBottom: '8px' }}>
                        Delete <strong style={{ color: '#fff' }}>{account.name}</strong>? Trades will fall back to {defaultTradeAccountName}.
                      </p>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button type="button" onClick={() => { deleteAccount(account.id); setDeleteTarget(null); }} className="btn-danger" style={{ fontSize: '12px', padding: '5px 12px' }}>Confirm Delete</button>
                        <button type="button" onClick={() => setDeleteTarget(null)} className="btn-secondary" style={{ fontSize: '12px', padding: '5px 12px' }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionPanel>
      </section>

      {/* Journal section */}
      <section ref={journalRef} style={{ scrollMarginTop: '140px' }}>
        <SectionDivider label="Journal" />
        <SectionPanel
          title="Confluence tags"
          subtitle="Pre-defined tags you can quickly apply when logging trades in the journal. Click a tag to rename it."
        >
          {/* Existing tags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: confluenceOptions.length > 0 ? '14px' : '0' }}>
            {confluenceOptions.map((option, idx) => (
              editingConfluenceIndex === idx ? (
                <input
                  key={idx}
                  autoFocus
                  value={editingConfluenceDraft}
                  maxLength={64}
                  onChange={e => setEditingConfluenceDraft(e.target.value)}
                  onBlur={() => {
                    const canonical = normalizeConfluenceTag(editingConfluenceDraft);
                    if (canonical && canonical !== option) updateConfluenceOption(idx, canonical);
                    setEditingConfluenceIndex(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const canonical = normalizeConfluenceTag(editingConfluenceDraft);
                      if (canonical && canonical !== option) updateConfluenceOption(idx, canonical);
                      setEditingConfluenceIndex(null);
                    }
                    if (e.key === 'Escape') setEditingConfluenceIndex(null);
                  }}
                  style={{
                    height: '28px',
                    padding: '0 10px',
                    borderRadius: '6px',
                    border: `1px solid ${AMBER}`,
                    background: AMBER_DIM,
                    color: T1,
                    fontSize: '12px',
                    fontFamily: SANS,
                    outline: 'none',
                    minWidth: '80px',
                    maxWidth: '200px',
                  }}
                />
              ) : (
                <div
                  key={idx}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    height: '28px',
                    padding: '0 4px 0 10px',
                    borderRadius: '6px',
                    border: `1px solid ${BORDER}`,
                    background: S2,
                    cursor: 'text',
                    userSelect: 'none',
                  }}
                  onClick={() => {
                    setEditingConfluenceIndex(idx);
                    setEditingConfluenceDraft(option);
                  }}
                >
                  <span style={{ fontSize: '12px', color: T1 }}>{option}</span>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      deleteConfluenceOption(idx);
                      if (editingConfluenceIndex === idx) setEditingConfluenceIndex(null);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '18px',
                      height: '18px',
                      borderRadius: '4px',
                      border: 'none',
                      background: 'transparent',
                      color: T3,
                      cursor: 'pointer',
                      padding: 0,
                      flexShrink: 0,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#fca5a5'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.12)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T3; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                  >
                    <X size={10} />
                  </button>
                </div>
              )
            ))}
          </div>

          {/* Add new tag */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              placeholder={confluenceOptions.length >= 64 ? 'Max 64 tags reached' : 'New confluence tag…'}
              value={newConfluenceDraft}
              maxLength={64}
              disabled={confluenceOptions.length >= 64}
              onChange={e => setNewConfluenceDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const canonical = normalizeConfluenceTag(newConfluenceDraft);
                  if (canonical && confluenceOptions.length < 64) {
                    addConfluenceOption(canonical);
                    setNewConfluenceDraft('');
                  }
                }
              }}
              style={{
                flex: 1,
                height: '32px',
                padding: '0 10px',
                borderRadius: '6px',
                border: `1px solid ${BORDER}`,
                background: S2,
                color: T1,
                fontSize: '12px',
                fontFamily: SANS,
                outline: 'none',
                opacity: confluenceOptions.length >= 64 ? 0.45 : 1,
              }}
            />
            <button
              type="button"
              disabled={!newConfluenceDraft.trim() || confluenceOptions.length >= 64}
              onClick={() => {
                const canonical = normalizeConfluenceTag(newConfluenceDraft);
                if (canonical && confluenceOptions.length < 64) {
                  addConfluenceOption(canonical);
                  setNewConfluenceDraft('');
                }
              }}
              style={{
                height: '32px',
                padding: '0 12px',
                borderRadius: '6px',
                border: `1px solid ${BORDER}`,
                background: 'transparent',
                color: T3,
                fontSize: '12px',
                fontFamily: SANS,
                cursor: !newConfluenceDraft.trim() || confluenceOptions.length >= 64 ? 'not-allowed' : 'pointer',
                opacity: !newConfluenceDraft.trim() || confluenceOptions.length >= 64 ? 0.4 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                flexShrink: 0,
              }}
            >
              <Plus size={13} />
              Add
            </button>
          </div>

          {confluenceOptions.length > 0 && (
            <p style={{ marginTop: '10px', fontSize: '11px', color: T3 }}>
              {confluenceOptions.length} of 64 tags · Click a tag to rename, or × to delete.
            </p>
          )}
        </SectionPanel>
      </section>

      {/* ── Danger Zone ── */}
      <section style={{ scrollMarginTop: '140px', marginTop: 8 }}>
        <SectionDivider label="Danger Zone" />
        <SectionPanel
          title="Reset all data"
          subtitle="Permanently wipe this account back to a fresh state. Your username is preserved."
        >
          {!showResetPanel ? (
            <button
              type="button"
              onClick={() => setShowResetPanel(true)}
              style={{
                height: 36, padding: '0 18px', borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.5)',
                background: 'rgba(239,68,68,0.08)',
                color: '#f87171', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', fontFamily: SANS,
              }}
            >
              Reset all data…
            </button>
          ) : (
            <div style={{ border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '16px', background: 'rgba(239,68,68,0.05)' }}>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                This will permanently erase <strong>trades, journal entries, accounts, goals, backtests, settings, risk rules, pre-session data, friends, and cached backups</strong>. Only your Flyxa username will be kept.
              </p>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: T3 }}>
                Type <strong style={{ color: '#f87171' }}>RESET</strong> to confirm:
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={resetConfirmText}
                  onChange={e => setResetConfirmText(e.target.value)}
                  placeholder="RESET"
                  style={{
                    height: 34, padding: '0 12px', borderRadius: 6, width: 140,
                    border: '1px solid rgba(239,68,68,0.4)',
                    background: 'var(--app-panel-strong)',
                    color: 'var(--txt)', fontSize: 13, fontFamily: SANS, outline: 'none',
                  }}
                />
                <button
                  type="button"
                  disabled={resetConfirmText !== 'RESET' || resetWorking}
                  onClick={() => { void handleConfirmResetAllData(); }}
                  style={{
                    height: 34, padding: '0 16px', borderRadius: 6,
                    border: 'none',
                    background: resetConfirmText === 'RESET' && !resetWorking ? '#ef4444' : 'rgba(239,68,68,0.2)',
                    color: resetConfirmText === 'RESET' && !resetWorking ? '#fff' : 'rgba(239,68,68,0.4)',
                    fontSize: 13, fontWeight: 700, cursor: resetConfirmText === 'RESET' && !resetWorking ? 'pointer' : 'not-allowed',
                    fontFamily: SANS, transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {resetWorking ? 'Resetting...' : 'Confirm Reset'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowResetPanel(false); setResetConfirmText(''); }}
                  style={{
                    height: 34, padding: '0 14px', borderRadius: 6,
                    border: `1px solid ${BORDER}`, background: 'transparent',
                    color: T3, fontSize: 13, cursor: 'pointer', fontFamily: SANS,
                  }}
                >
                  Cancel
                </button>
              </div>
              {resetError && (
                <p style={{ margin: '10px 0 0', color: '#fca5a5', fontSize: 12 }}>
                  {resetError}
                </p>
              )}
            </div>
          )}
        </SectionPanel>
      </section>

      {showSavedToast && (
        <div
          style={{
            position: 'fixed',
            right: '18px',
            bottom: '18px',
            zIndex: 60,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            borderRadius: '999px',
            border: '1px solid rgba(74,222,128,0.45)',
            background: 'rgba(6,78,59,0.9)',
            color: '#bbf7d0',
            padding: '9px 14px',
            fontSize: '12px',
            fontWeight: 600,
            boxShadow: '0 12px 30px rgba(2,6,23,0.34)',
          }}
        >
          <Check size={14} />
          Saved
        </div>
      )}

      {showAddAccountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <button
            type="button"
            aria-label="Close add account modal"
            onClick={closeAddAccountModal}
            className="absolute inset-0 bg-black/70"
          />
          <div
            style={{
              position: 'relative',
              width: 'min(680px, 100%)',
              borderRadius: '10px',
              border: `1px solid ${BORDER}`,
              background: S1,
              boxShadow: '0 28px 80px rgba(2,6,23,0.5)',
              padding: '18px',
            }}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p style={{ fontSize: '15px', fontWeight: 600, color: T1 }}>Add Trading Account</p>
                <p style={{ marginTop: '4px', fontSize: '12px', color: T3 }}>
                  Create an account profile without cluttering the table.
                </p>
              </div>
              <button
                type="button"
                onClick={closeAddAccountModal}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '34px',
                  height: '34px',
                  borderRadius: '999px',
                  border: `1px solid ${BORDER}`,
                  background: S2,
                  color: T3,
                }}
              >
                <X size={14} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px' }}>
              <label>
                <FieldLabel>Account name</FieldLabel>
                <input
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                  }}
                  placeholder="Account name"
                  value={newAccount.name}
                  onChange={e => setNewAccount(current => ({ ...current, name: e.target.value }))}
                  autoFocus
                />
              </label>

              <label>
                <FieldLabel>Broker</FieldLabel>
                <input
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                  }}
                  placeholder="Broker"
                  value={newAccount.broker}
                  onChange={e => setNewAccount(current => ({ ...current, broker: e.target.value }))}
                />
              </label>

              <label>
                <FieldLabel>Account type</FieldLabel>
                <StyledSelect
                  value={newAccount.type}
                  onChange={value => setNewAccount(current => ({ ...current, type: value as TradingAccountType }))}
                >
                  {ACCOUNT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                </StyledSelect>
              </label>

              <label>
                <FieldLabel>Status</FieldLabel>
                <StatusSelect
                  value={newAccount.status}
                  onChange={status => setNewAccount(current => ({ ...current, status }))}
                />
              </label>

              <label style={{ gridColumn: '1 / -1' }}>
                <FieldLabel>Starting balance ($)</FieldLabel>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                  }}
                  placeholder="e.g. 100000"
                  value={newAccount.startingBalance}
                  onChange={e => setNewAccount(current => ({ ...current, startingBalance: e.target.value }))}
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeAddAccountModal}
                className="btn-secondary"
                style={{ fontSize: '12px', padding: '7px 14px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddAccount}
                className="btn-primary"
                style={{ fontSize: '12px', padding: '7px 14px' }}
              >
                Save Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}




