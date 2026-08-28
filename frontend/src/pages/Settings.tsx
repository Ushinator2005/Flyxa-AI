import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, FileJson, FileSpreadsheet, Monitor, Palette, RotateCcw, Scan, Tag, Trash2, Upload, User, Wallet, X, DollarSign, Clock, Database, Code } from 'lucide-react';
import { ColorSwatchPicker } from '../components/common/ColorPicker.js';
import WaitlistReferralsPanel from '../components/settings/WaitlistReferralsPanel.js';
import DatePicker from '../components/common/DatePicker.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useTheme } from '../contexts/ThemeContext.js';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useTrades } from '../hooks/useTrades.js';
import { useRivals } from '../hooks/useRivals.js';
import { useSubscription } from '../hooks/useSubscription.js';
import { accountApi, supabase } from '../services/api.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { clearCurrentUserStoreCache, readLocalSafeBackupEntries } from '../store/supabaseStorage.js';
import { TradingAccountStatus, TradingAccountType } from '../types/index.js';
import type { BillingAccount as StoreBillingAccount } from '../store/types.js';
import { normalizeConfluenceKey, normalizeConfluenceTag } from '../utils/confluenceTags.js';
import { recoverMissingTradesFromLocalBackup } from '../utils/browserRecovery.js';
import { getEvaluationTemplates, type EvaluationTemplate } from '../utils/evaluationCoach.js';
import { CALENDAR_CACHE_KEY, LEGACY_CALENDAR_CACHE_KEYS } from '../utils/calendarCache.js';
import { MARKET_CLOCK_OPTIONS } from '../utils/marketHours.js';

const ACCOUNT_TYPES: TradingAccountType[] = ['Futures', 'Forex', 'Stocks'];

// ── Prop-firm evaluation templates (multi-firm catalog) ────────────────
function firmTemplates(firm: string): EvaluationTemplate[] {
  return getEvaluationTemplates().filter(template => template.firm === firm);
}

function templateFirmNames(): string[] {
  return Array.from(new Set(getEvaluationTemplates().map(template => template.firm)))
    .sort((a, b) => a.localeCompare(b));
}

function isTemplateEval(account: { broker: string; status: string }): boolean {
  return account.status === 'Eval' && firmTemplates(account.broker).length > 0;
}

function firmPrograms(firm: string): string[] {
  return Array.from(new Set(firmTemplates(firm).map(template => template.program ?? ''))).filter(Boolean);
}

function programSizes(firm: string, program: string): number[] {
  return Array.from(new Set(
    firmTemplates(firm)
      .filter(template => !program || template.program === program)
      .map(template => template.accountSize),
  )).sort((a, b) => a - b);
}

function templateTargetBalance(firm: string, program: string, accountSize: number): string {
  const template = resolveEvaluationTemplate(firm, program, accountSize, 'standard');
  return template ? String(template.accountSize + template.profitTarget) : '';
}

function resolveEvaluationTemplate(
  firm: string,
  program: string,
  accountSize: number,
  path: 'standard' | 'no_activation_fee',
): EvaluationTemplate | undefined {
  const candidates = firmTemplates(firm).filter(template => (
    (!program || template.program === program) && template.accountSize === accountSize
  ));
  if (firm === 'Topstep') return candidates.find(template => template.path === path) ?? candidates[0];
  return candidates[0];
}
const DEFAULT_ACCOUNT_COLOR = '#3b82f6';
const DEFAULT_TIMEZONE = 'America/New_York';
const ACCOUNT_STATUSES: TradingAccountStatus[] = ['Eval', 'Funded', 'Live', 'Passed', 'Blown'];
const moneyValue = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
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

const CONFLUENCE_GROUPS = [
  {
    key: 'bias',
    title: 'Bias & narrative',
    description: 'Directional context',
    match: (label: string) => /\b(htf|ltf|bias|narrative|trend|smt)\b/i.test(label),
  },
  {
    key: 'liquidity',
    title: 'Liquidity',
    description: 'Sweeps and traps',
    match: (label: string) => /\b(liquidity|sweep|turtle|soup)\b/i.test(label),
  },
  {
    key: 'structure',
    title: 'Structure',
    description: 'Blocks, shifts and levels',
    match: (label: string) => /\b(structure|order\s*block|orderblock|ob|bisi|disrespect)\b/i.test(label),
  },
  {
    key: 'imbalance',
    title: 'Imbalance',
    description: 'FVGs and repricing',
    match: (label: string) => /\b(fvg|ifvg|fair value|rebalance|reabalance|sibi|iifvg)\b/i.test(label),
  },
  {
    key: 'execution',
    title: 'Execution',
    description: 'Confirmation and timing',
    match: (label: string) => /\b(volume|confirmation|displacement|amd|discount|stdv)\b/i.test(label),
  },
  {
    key: 'other',
    title: 'Other',
    description: 'Custom tags',
    match: () => true,
  },
] as const;
type ConfluenceGroupKey = (typeof CONFLUENCE_GROUPS)[number]['key'];

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
const MONO = "'DM Mono', monospace";


function normalizeUsername(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

function usernameFromUser(email?: string, displayName?: string): string {
  // Prefer email prefix (e.g. "ushinator2005") over display name (e.g. "ushi")
  // to match what the backend generates in ensureOwnProfile.
  const source = email?.split('@')[0] || displayName || '';
  return normalizeUsername(source.replace(/\s+/g, '_'));
}

function getAuthAvatarUrl(user: ReturnType<typeof useAuth>['user']): string | null {
  const metadata = user?.user_metadata as Record<string, unknown> | undefined;
  const avatarUrl = metadata?.avatar_url;
  const picture = metadata?.picture;
  if (typeof avatarUrl === 'string' && avatarUrl.trim()) return avatarUrl.trim();
  if (typeof picture === 'string' && picture.trim()) return picture.trim();
  return null;
}

function getConfluenceCategoryOverridesKey(userId: string) {
  return `tw_confluence_category_overrides_${userId}`;
}

function getConfluenceStorageKey(label: string) {
  return normalizeConfluenceKey(normalizeConfluenceTag(label));
}

function toMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    return 0;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
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

// ─── sub-components ──────────────────────────────────────────────────────────


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


function SafetyActionButton({
  children,
  icon,
  onClick,
  disabled = false,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'primary';
}) {
  const [hovered, setHovered] = useState(false);
  const primary = tone === 'primary';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minWidth: 0,
        height: '36px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        paddingInline: '12px',
        borderRadius: '6px',
        border: `1px solid ${disabled ? BORDER : primary ? 'transparent' : 'rgba(255,255,255,0.11)'}`,
        background: disabled
          ? 'transparent'
          : primary
            ? hovered ? '#fbbf24' : AMBER
            : hovered ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.018)',
        color: disabled ? T3 : primary ? '#11100f' : T1,
        font: primary ? `800 11px ${SANS}` : `650 11px ${SANS}`,
        letterSpacing: primary ? '0.035em' : undefined,
        textTransform: primary ? 'uppercase' : undefined,
        boxShadow: 'none',
        whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <span style={{ color: disabled ? T3 : primary ? '#11100f' : T2, display: 'inline-flex' }}>{icon}</span>
      {children}
    </button>
  );
}

// Known prop-firm domains, keyed by normalized firm name, for logo lookup.
const FIRM_DOMAINS: Record<string, string> = {
  alphafutures: 'alpha-futures.com',
  apextraderfunding: 'apextraderfunding.com',
  apex: 'apextraderfunding.com',
  fundednextfutures: 'fundednext.com',
  fundednext: 'fundednext.com',
  lucidtrading: 'lucidtrading.com',
  myfundedfutures: 'myfundedfutures.com',
  mff: 'myfundedfutures.com',
  takeprofittrader: 'takeprofittrader.com',
  takeprofit: 'takeprofittrader.com',
  topstep: 'topstep.com',
  topsteptrader: 'topstep.com',
  tradeify: 'tradeify.co',
  ftmo: 'ftmo.com',
  the5ers: 'the5ers.com',
  bulenox: 'bulenox.com',
  elitetraderfunding: 'elitetraderfunding.com',
  etf: 'elitetraderfunding.com',
  tradeday: 'tradeday.com',
  earn2trade: 'earn2trade.com',
  leeloo: 'leelootrading.com',
  leelootrading: 'leelootrading.com',
  uprofit: 'uprofit.com',
  myfundedfx: 'myfundedfx.com',
  fundingpips: 'fundingpips.com',
  e8: 'e8markets.com',
  e8markets: 'e8markets.com',
  blueguardian: 'blueguardian.com',
  blueberryfunded: 'blueberryfunded.com',
};

function firmDomain(firm: string | undefined | null): string | undefined {
  if (!firm) return undefined;
  return FIRM_DOMAINS[firm.toLowerCase().replace(/[^a-z0-9]/g, '')];
}

function FirmLogo({ firm, name, isDefault }: { firm?: string; name?: string; isDefault: boolean }) {
  const domain = firmDomain(firm);
  const [failed, setFailed] = useState(false);
  const initial = (firm || name || '?').trim().charAt(0).toUpperCase();
  const showLogo = !!domain && !failed;
  return (
    <div style={{
      gridColumn: 1, gridRow: '1 / span 2', alignSelf: 'center',
      width: 44, height: 44, borderRadius: 11, flexShrink: 0, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em',
      color: isDefault ? AMBER : T1,
      background: showLogo ? '#000' : (isDefault ? 'rgba(245,158,11,0.10)' : 'var(--app-panel-strong)'),
      border: showLogo ? 'none' : `1px solid ${isDefault ? 'rgba(245,158,11,0.35)' : BORDER}`,
    }}>
      {showLogo ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${domain}&sz=128`}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : initial}
    </div>
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
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '100%', maxWidth: '100%' }}>
      <style>{`.stg-sel option{background:#1a1917;color:#e8e3dc;}`}</style>
      <select
        className="stg-sel"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          appearance: 'none',
          colorScheme: 'dark',
          background: 'none',
          border: 'none',
          borderRadius: 0,
          padding: '6px 18px 6px 2px',
          color: focused ? AMBER : T1,
          fontSize: compact ? 12 : 13,
          textAlign: 'right',
          textAlignLast: 'right',
          outline: 'none',
          cursor: 'pointer',
          transition: 'color 0.16s',
          fontFamily: SANS,
        }}
      >
        {children}
      </select>
      <span style={{ position: 'absolute', right: 3, top: '44%', width: 5, height: 5, borderRight: '1.2px solid var(--app-text-muted)', borderBottom: '1.2px solid var(--app-text-muted)', transform: 'translateY(-50%) rotate(45deg)', pointerEvents: 'none' }} />
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
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: '100%', maxWidth: '100%' }}>
      <style>{`.stg-sel option{background:#1a1917;color:#e8e3dc;}`}</style>
      <select
        className="stg-sel"
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
          background: 'none',
          border: 'none',
          borderRadius: 0,
          padding: '6px 18px 6px 2px',
          color: focused ? AMBER : hovered ? T1 : T1,
          fontSize: '13px',
          textAlign: 'right',
          textAlignLast: 'right',
          outline: 'none',
          transition: 'color 0.16s',
          fontFamily: SANS,
        }}
      >
        {children}
      </select>
      <span style={{ position: 'absolute', right: 3, top: '44%', width: 5, height: 5, borderRight: '1.2px solid var(--app-text-muted)', borderBottom: '1.2px solid var(--app-text-muted)', transform: 'translateY(-50%) rotate(45deg)', pointerEvents: 'none' }} />
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
      <style>{`.stg-timefield::-webkit-calendar-picker-indicator{display:none;-webkit-appearance:none;margin:0;}`}</style>
      <input
        type="time"
        className="stg-timefield"
        value={value}
        onChange={event => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: '100%',
          colorScheme: 'dark',
          background: 'none',
          border: 'none',
          borderBottom: `1px solid ${focused ? AMBER : hovered ? 'rgba(255,255,255,0.14)' : BORDER}`,
          borderRadius: 0,
          padding: '6px 2px',
          color: T1,
          fontSize: '12.5px',
          outline: 'none',
          transition: 'border-color 0.16s',
          fontFamily: 'var(--font-mono)',
        }}
      />
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

// ─── main page ────────────────────────────────────────────────────────────────

// Rail nav — grouped like the settings handoff. Keys map to the section blocks
// rendered in the content pane (one shown at a time).
const RAIL_GROUPS: Array<{ label: string; items: Array<{ key: string; label: string; icon: React.ReactNode }> }> = [
  { label: 'Account', items: [
    { key: 'profile', label: 'Profile', icon: <User size={15} /> },
    { key: 'accounts', label: 'Trading accounts', icon: <Wallet size={15} /> },
    { key: 'billing', label: 'Membership', icon: <DollarSign size={15} /> },
  ] },
  { label: 'Workspace', items: [
    { key: 'general', label: 'General', icon: <Palette size={15} /> },
    { key: 'sessions', label: 'Session times', icon: <Clock size={15} /> },
    { key: 'display', label: 'Display', icon: <Monitor size={15} /> },
    { key: 'scanner', label: 'Scanner', icon: <Scan size={15} /> },
    { key: 'journal', label: 'Journal tags', icon: <Tag size={15} /> },
  ] },
  { label: 'Data', items: [
    { key: 'databackup', label: 'Backup & recovery', icon: <Database size={15} /> },
    { key: 'dev', label: 'Developer', icon: <Code size={15} /> },
  ] },
];

// Flat-row primitives from the settings handoff: a section header, a label-left
// / control-right row with a hairline, and a group label.
const DIM = 'var(--app-text-muted)';
function StgHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ paddingBottom: 8 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.025em', color: T1, margin: 0 }}>{title}</h2>
      {sub && <p style={{ margin: '5px 0 0', fontSize: 13, color: DIM, lineHeight: 1.5 }}>{sub}</p>}
    </div>
  );
}
function StgRow({ label, desc, children }: { label: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="stg-row" style={{ display: 'grid', gridTemplateColumns: '1fr minmax(0, 268px)', gap: 28, alignItems: 'center', padding: '15px 0', borderTop: `1px solid ${BORDER}` }}>
      <div>
        <b style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T1, letterSpacing: '-0.1px' }}>{label}</b>
        {desc && <p style={{ margin: '3px 0 0', fontSize: 12.5, color: DIM, lineHeight: 1.5 }}>{desc}</p>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, alignItems: 'center' }}>{children}</div>
    </div>
  );
}
// v3: controls are text on a hairline, never a filled box. Fill is reserved for
// toggles and the single amber Save action.
const STG_BTN: React.CSSProperties = { background: 'none', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, padding: '7px 13px', fontSize: 12, fontWeight: 600, color: T1, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: SANS };
const STG_TXT: React.CSSProperties = { width: '100%', minWidth: 0, background: 'none', border: 'none', borderBottom: `1px solid ${BORDER}`, borderRadius: 0, padding: '6px 2px', color: T1, fontSize: 13, outline: 'none', fontFamily: SANS, textAlign: 'right' };

export default function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { profile, saveProfile } = useRivals();
  const journalEntries = useFlyxaStore(state => state.entries);
  const deletedTradeIds = useFlyxaStore(state => state.deletedTradeIds);
  const setEntries = useFlyxaStore(state => state.setEntries);
  const addPayout = useFlyxaStore(state => state.addPayout);
  const deletePayout = useFlyxaStore(state => state.deletePayout);
  const storeAccounts = useFlyxaStore(state => state.accounts);
  const { trades } = useTrades();
  const resetAllData = useFlyxaStore(state => state.resetAllData);
  const getPayouts = (accountId: string) => storeAccounts.find(a => a.id === accountId)?.payouts ?? [];
  const {
    accounts,
    defaultTradeAccountId,
    preferences,
    confluenceOptions,
    addAccount,
    updateAccount,
    deleteAccount,
    setDefaultAccount,
    updatePreferences,
    addConfluenceOption,
    updateConfluenceOption,
    deleteConfluenceOption,
    decorateTrades,
  } = useAppSettings();
  const [showAddAccountModal, setShowAddAccountModal] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [billingOffer, setBillingOffer] = useState<{
    accountId: string;
    accountName: string;
    firm: string;
    sizeLabel: string;
    status: TradingAccountStatus;
    template?: EvaluationTemplate;
    pricePaid?: number;
    purchaseDate?: string;
  } | null>(null);
  const storeBillingAccounts = useFlyxaStore(state => state.billingAccounts) as StoreBillingAccount[];
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
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
    targetBalance: '' as string,
    pricePaid: '' as string,
    purchaseDate: '' as string,
    evaluationProgram: 'Trading Combine',
    evaluationPath: 'no_activation_fee' as 'standard' | 'no_activation_fee',
    dailyLossMode: 'none' as 'none' | 'purchase_fixed',
  });
  const [draftTargetBalances, setDraftTargetBalances] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<string>('profile');
  const subscription = useSubscription();
  // Dev-only scanner eval capture — localStorage is the sanctioned home for
  // this flag (ephemeral tooling state, read synchronously by the scan path).
  const [evalCaptureOn, setEvalCaptureOn] = useState(() => {
    try { return localStorage.getItem('flyxa-eval-capture') === '1'; } catch { return false; }
  });
  const toggleEvalCapture = () => {
    setEvalCaptureOn(prev => {
      const next = !prev;
      try {
        if (next) localStorage.setItem('flyxa-eval-capture', '1');
        else localStorage.removeItem('flyxa-eval-capture');
      } catch { /* flag is best-effort */ }
      return next;
    });
  };
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
  // Overrides live in the Zustand store (synced to Supabase). The wrapper keeps
  // the functional-update call sites below working unchanged.
  const confluenceCategoryOverrides = useFlyxaStore(state => state.confluenceCategoryOverrides);
  const setStoreConfluenceOverrides = useFlyxaStore(state => state.setConfluenceCategoryOverrides);
  const setConfluenceCategoryOverrides = useCallback((
    update: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)
  ) => {
    const current = useFlyxaStore.getState().confluenceCategoryOverrides;
    const next = typeof update === 'function' ? update(current) : update;
    if (next !== current) setStoreConfluenceOverrides(next);
  }, [setStoreConfluenceOverrides]);
  const [draggingConfluenceIndex, setDraggingConfluenceIndex] = useState<number | null>(null);
  const [dragOverConfluenceGroup, setDragOverConfluenceGroup] = useState<ConfluenceGroupKey | null>(null);
  const [hoveredConfluenceRow, setHoveredConfluenceRow] = useState<number | null>(null);
  const [confluenceSearch, setConfluenceSearch] = useState('');
  const [expandedUnusedGroups, setExpandedUnusedGroups] = useState<Set<string>>(new Set());
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveToastReadyRef = useRef(false);
  const confluenceSyncedRef = useRef(false);
  const newTagInputRef = useRef<HTMLInputElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importFeedback, setImportFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const deletedSet = new Set(deletedTradeIds);
  const loadedTradeCount = journalEntries.reduce((sum, entry) => sum + entry.trades.filter(t => !deletedSet.has(t.id)).length, 0);
  const backupStamp = new Date().toISOString().slice(0, 10);

  // Net P&L per account, computed exactly like the dashboard: decorate trades to
  // resolve their account ids (the same account association the dashboard filter
  // uses), and sum pnl − commission per account. Balance then = startingBalance +
  // netPnL − payouts, matching the dashboard's live balance everywhere.
  const netPnlByAccount = useMemo(() => {
    const map = new Map<string, number>();
    for (const trade of decorateTrades(trades)) {
      const net = Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);
      for (const acctId of (trade.accountIds.length ? trade.accountIds : [trade.accountId])) {
        map.set(acctId, (map.get(acctId) ?? 0) + net);
      }
    }
    return map;
  }, [decorateTrades, trades]);
  const liveBalanceFor = (account: { id: string; startingBalance?: number | null }): number | null => {
    const sb = account.startingBalance;
    const pnl = netPnlByAccount.get(account.id) ?? 0;
    const payouts = (storeAccounts.find(a => a.id === account.id)?.payouts ?? []).reduce((s, p) => s + p.amount, 0);
    if (sb == null && pnl === 0 && payouts === 0) return null;
    return (sb ?? 0) + pnl - payouts;
  };

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
        setEntries(payload.entries, { notifyAchievements: false });
        setImportFeedback({ ok: true, msg: `Restored ${payload.entries.length} day${payload.entries.length !== 1 ? 's' : ''}.` });
        setTimeout(() => setImportFeedback(null), 4000);
      } catch {
        setImportFeedback({ ok: false, msg: 'Could not parse file.' });
        setTimeout(() => setImportFeedback(null), 4000);
      }
    };
    reader.readAsText(file);
  }

  async function handleRecoverFromLocalCache() {
    if (!user?.id) return;
    if (readLocalSafeBackupEntries(user.id).length === 0) {
      setImportFeedback({ ok: false, msg: 'No local browser backup found.' });
      setTimeout(() => setImportFeedback(null), 4000);
      return;
    }

    // Shared with the automatic on-load recovery; tombstone-aware so deleted
    // trades and days are never resurrected.
    const { tradesRecovered, daysRecovered } = await recoverMissingTradesFromLocalBackup(user.id);

    if (tradesRecovered === 0 && daysRecovered === 0) {
      setImportFeedback({ ok: true, msg: 'Already up to date, no missing trades found.' });
      setTimeout(() => setImportFeedback(null), 4000);
      return;
    }

    const parts: string[] = [];
    if (tradesRecovered > 0) parts.push(`${tradesRecovered} trade${tradesRecovered !== 1 ? 's' : ''}`);
    if (daysRecovered > 0) parts.push(`${daysRecovered} day${daysRecovered !== 1 ? 's' : ''}`);
    setImportFeedback({ ok: true, msg: `Recovered ${parts.join(' and ')} from browser cache.` });
    setTimeout(() => setImportFeedback(null), 6000);
  }


  function scrollToSection(key: string, _ref?: React.RefObject<HTMLElement | null>) {
    // One section shows at a time now, so switching is just a state change; scroll
    // the content pane back to the top instead of scrolling a stacked anchor.
    setActiveSection(key);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' });
  }

  async function handleSaveProfile() {
    const fallbackUsername = usernameFromUser(user?.email, displayName);
    const username = normalizeUsername(profileDraft || profile?.username || fallbackUsername);
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

    const fallbackUsername = usernameFromUser(user?.email, displayName);
    const username = normalizeUsername(profileDraft || profile?.username || fallbackUsername);
    setProfileDraft(username);
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
      `tw_journal_backup_${user.id}`,
      `tw_journal_moods_${user.id}`,
      'flyxa_entries',
      'flyxa_billing_accounts',
      'flyxa_trading_plan_state_v1',
      'flyxa_checklist',
      'tw_goals_local',
      'tw_scanner_draft',
      'tw_scanner_draft_image',
      'tw_backtest_trade_prefill',
      'flyxa-store',
      'flyxa-store-uid',
      'flyxa-entries-safe',
      'flyxa-entries-safe-uid',
      'flyxa-store-saved-at',
      'flyxa_store_migrated_v1',
      'flyxa.session-trades-v1',
      'flyxa.session-done-prompt',
      'flyxa.trade-check-dock.position',
      'flyxa_presession_done_date',
      'flyxa_payout_gallery_photos_v1',
      'flyxa_breaking_cache_v1',
      'flyxa_news_cache_v2',
      CALENDAR_CACHE_KEY,
      ...LEGACY_CALENDAR_CACHE_KEYS,
      'flyxa_breaking_news_last_seen',
      'flyxa_news_sources',
      'flyxa-journal-sections',
    ];
    keys.forEach(key => {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    });
    const prefixes = [
      'flyxa.weekly-reflection.',
      'flyxa_store_v2_',
      'flyxa_store_saved_at_',
      'flyxa_entries_safe_',
    ];
    try {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key && prefixes.some(prefix => key.startsWith(prefix))) {
          window.localStorage.removeItem(key);
        }
      }
    } catch { /* ignore */ }
    try { window.sessionStorage.removeItem('tw_backtest_config_v1'); } catch { /* ignore */ }
  }

  async function handleConfirmResetAllData() {
    if (resetConfirmText !== 'RESET' || resetWorking) return;

    setResetWorking(true);
    setResetError('');
    try {
      // Server-side wipe: deletes user_store AND store_entries_backup from Supabase.
      // Both tables must be cleared � otherwise store_entries_backup acts as a
      // recovery source and brings all data back on the next page load.
      await accountApi.reset();

      // Clear all local caches so there is nothing to restore from on reload.
      await clearCurrentUserStoreCache();
      resetAllData();
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
      targetBalance: '',
      pricePaid: '',
      purchaseDate: '',
      evaluationProgram: 'Trading Combine',
      evaluationPath: 'no_activation_fee',
      dailyLossMode: 'none',
    });
  }

  function closeAddAccountModal() {
    setShowAddAccountModal(false);
    resetNewAccountForm();
  }

  function handleAddAccount() {
    if (!newAccount.name.trim()) return;
    const parsedBalance = parseFloat(newAccount.startingBalance);
    const parsedTarget = parseFloat(newAccount.targetBalance);
    const parsedPrice = parseFloat(newAccount.pricePaid);
    const selectedTemplate = isTemplateEval(newAccount)
      ? resolveEvaluationTemplate(newAccount.broker, newAccount.evaluationProgram, parsedBalance, newAccount.evaluationPath)
      : undefined;
    const dailyLossLimit = newAccount.dailyLossMode === 'purchase_fixed'
      ? selectedTemplate?.optionalDailyLossLimit ?? 0
      : selectedTemplate?.dailyLossLimit ?? 0;
    const newAccountId = addAccount({
      name: newAccount.name.trim(),
      broker: newAccount.broker.trim(),
      type: newAccount.type,
      status: newAccount.status,
      color: DEFAULT_ACCOUNT_COLOR,
      startingBalance: Number.isFinite(parsedBalance) && parsedBalance > 0 ? parsedBalance : undefined,
      targetBalance: Number.isFinite(parsedTarget) && parsedTarget > 0
        ? parsedTarget
        : selectedTemplate ? selectedTemplate.accountSize + selectedTemplate.profitTarget : undefined,
      pricePaid: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : undefined,
      purchaseDate: newAccount.purchaseDate.trim() || undefined,
      firmRuleVersionId: selectedTemplate?.id,
      evaluationProgram: selectedTemplate?.program,
      evaluationPath: selectedTemplate?.path === 'no_activation_fee'
        ? 'no_activation_fee'
        : selectedTemplate?.path === 'standard' ? 'standard' : undefined,
      dailyLossMode: selectedTemplate ? newAccount.dailyLossMode : undefined,
      dailyLossLimit,
      maxDrawdown: selectedTemplate?.maxDrawdown,
      profitTarget: selectedTemplate?.profitTarget ?? null,
      minimumTradingDays: selectedTemplate?.minimumTradingDays,
      maxContracts: selectedTemplate?.maxContracts,
      maxMicros: selectedTemplate?.maxMicros,
      consistencyLimitPct: selectedTemplate?.consistencyLimitPct,
      drawdownType: selectedTemplate?.drawdownType,
      trailingStopsAt: selectedTemplate?.trailingStopsAt,
      ruleVerifiedAt: selectedTemplate?.verifiedAt,
      ruleSourceUrl: selectedTemplate?.sourceUrl,
    });
    const firm = newAccount.broker.trim();
    if (firm && firm !== 'Other') {
      setBillingOffer({
        accountId: newAccountId,
        accountName: newAccount.name.trim(),
        firm,
        sizeLabel: Number.isFinite(parsedBalance) && parsedBalance > 0 ? `${parsedBalance / 1000}K` : 'Custom',
        status: newAccount.status,
        template: selectedTemplate,
        pricePaid: Number.isFinite(parsedPrice) && parsedPrice >= 0 ? parsedPrice : undefined,
        purchaseDate: newAccount.purchaseDate.trim() || undefined,
      });
    }
    closeAddAccountModal();
  }

  function addOfferToBilling() {
    if (!billingOffer) return;
    const template = billingOffer.template;
    const catalogPrice = template?.priceAmount ?? template?.monthlyPrice ?? 0;
    // Prefer the price the trader actually entered in Settings; fall back to the
    // firm's catalog price only when none was provided.
    const hasEnteredPrice = typeof billingOffer.pricePaid === 'number';
    const actualPrice = hasEnteredPrice ? billingOffer.pricePaid! : catalogPrice;
    const listPrice = catalogPrice || actualPrice;
    const cadenceNote = template?.priceCadence === 'monthly'
      ? 'Monthly subscription; add renewal months as separate entries.'
      : '';
    const entry: StoreBillingAccount = {
      id: `billing-${crypto.randomUUID()}`,
      sourceAccountId: billingOffer.accountId,
      entryKind: 'account',
      firm: billingOffer.firm,
      accountType: template?.program ?? 'Evaluation',
      size: billingOffer.sizeLabel,
      listPrice,
      discountCode: '',
      discountPct: 0,
      actualPrice,
      purchaseDate: billingOffer.purchaseDate || new Date().toISOString().slice(0, 10),
      status: billingOffer.status === 'Funded' || billingOffer.status === 'Live'
        ? 'Funded'
        : billingOffer.status === 'Passed' ? 'Passed'
        : billingOffer.status === 'Blown' ? 'Blown'
        : 'Eval 1',
      payoutReceived: 0,
      payouts: [],
      notes: [
        `Added from Settings account: ${billingOffer.accountName}`,
        actualPrice === 0 ? 'Add the purchase price to complete billing.' : '',
        cadenceNote,
      ].filter(Boolean).join(' '),
      pricingPath: billingOffer.firm === 'Topstep' ? (template?.path === 'no_activation_fee' ? 'no_activation_fee' : 'standard') : undefined,
      activationFee: template?.activationFee,
      firmRuleVersionId: template?.id,
      ruleVerifiedAt: template?.verifiedAt,
      ruleSourceUrl: template?.sourceUrl,
    };
    hydrateSharedData({ billingAccounts: [entry, ...storeBillingAccounts] });
    setBillingOffer(null);
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

  const defaultTradeAccount = accounts.find(account => account.id === defaultTradeAccountId);
  const defaultTradeAccountName = defaultTradeAccount?.name ?? 'Default Account';
  const profileUsername = profile?.username ?? '';
  const displayName = (user?.user_metadata?.name as string | undefined)
    || (user?.user_metadata?.full_name as string | undefined)
    || user?.email?.split('@')[0]
    || 'Trader';
  const suggestedProfileUsername = usernameFromUser(user?.email, displayName);
  const visibleProfileUsername = profileUsername || suggestedProfileUsername;
  const hasSavedProfileUsername = Boolean(profileUsername);
  const email = user?.email ?? 'No email on file';
  const avatarInitials = (profile?.avatarInitials || displayName.slice(0, 2)).toUpperCase();
  const avatarUrl = profile?.avatarUrl ?? getAuthAvatarUrl(user);

  useEffect(() => {
    // Keep the draft in sync with the saved username as it loads.
    // Only overwrite if the user hasn't manually changed the draft away from the suggestion.
    setProfileDraft(prev => {
      const alreadyCustom = prev !== '' && prev !== suggestedProfileUsername;
      if (alreadyCustom) return prev;
      return profileUsername || suggestedProfileUsername || '';
    });
  }, [profileUsername, suggestedProfileUsername]);

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

      // Sections no longer stack, so scroll must not drive the active tab (it
      // would fight the rail). Kept as a no-op reference to avoid churn.
      void nextActive;
    };

    updateActiveSectionFromScroll();
    window.addEventListener('scroll', updateActiveSectionFromScroll, { passive: true });

    return () => window.removeEventListener('scroll', updateActiveSectionFromScroll);
  }, []);
  useEffect(() => {
    const rawHash = location.hash.replace('#', '').trim().toLowerCase();
    if (!rawHash) return;

    const sectionKey = rawHash === 'add-account' ? 'accounts' : rawHash;
    if (rawHash === 'add-account') setShowAddAccountModal(true);
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

  // One-time migration: overrides used to live in a per-user localStorage key.
  // If the store has none yet but the legacy key does, hydrate the store from it
  // (it will sync to Supabase automatically), then drop the legacy key.
  useEffect(() => {
    if (!user?.id) return;
    if (Object.keys(useFlyxaStore.getState().confluenceCategoryOverrides).length > 0) return;

    const legacyKey = getConfluenceCategoryOverridesKey(user.id);
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      localStorage.removeItem(legacyKey);
      if (typeof parsed === 'object' && parsed !== null) {
        const next: Record<string, string> = {};
        Object.entries(parsed as Record<string, unknown>).forEach(([tagKey, groupKey]) => {
          if (typeof groupKey === 'string') next[tagKey] = groupKey;
        });
        if (Object.keys(next).length > 0) setStoreConfluenceOverrides(next);
      }
    } catch { /* ignore malformed legacy data */ }
  }, [user?.id, setStoreConfluenceOverrides]);

  // Seed confluenceOptions with tags used in journal trades, normalising aliases to canonical names
  useEffect(() => {
    if (confluenceSyncedRef.current || journalEntries.length === 0) return;
    confluenceSyncedRef.current = true;

    // Step 1 � normalise any existing options that are currently abbreviations/aliases
    confluenceOptions.forEach((option, idx) => {
      const canonical = normalizeConfluenceTag(option);
      if (canonical !== option) updateConfluenceOption(idx, canonical);
    });

    // Step 2 � collect canonicalised tags from every trade; skip ones already present
    const existing = new Set(
      confluenceOptions.map(c => normalizeConfluenceKey(normalizeConfluenceTag(c))),
    );
    journalEntries.forEach(entry => {
      entry.trades.forEach(trade => {
        (trade.confluences ?? []).forEach(tag => {
          const canonical = normalizeConfluenceTag(tag);
          const key = normalizeConfluenceKey(canonical);
          if (!canonical || existing.has(key)) return;
          existing.add(key);
          addConfluenceOption(canonical);
        });
      });
    });
  }, [journalEntries, confluenceOptions, addConfluenceOption, updateConfluenceOption]);

  useEffect(() => {
    const validTagKeys = new Set(confluenceOptions.map(getConfluenceStorageKey));
    const validGroupKeys = new Set<string>(CONFLUENCE_GROUPS.map(group => group.key));

    setConfluenceCategoryOverrides(current => {
      const next: Record<string, string> = {};
      let changed = false;

      Object.entries(current).forEach(([tagKey, groupKey]) => {
        if (validTagKeys.has(tagKey) && validGroupKeys.has(groupKey)) {
          next[tagKey] = groupKey;
        } else {
          changed = true;
        }
      });

      return changed || Object.keys(next).length !== Object.keys(current).length ? next : current;
    });
  }, [confluenceOptions]);

  const confluenceUsageCounts = journalEntries.reduce<Record<string, number>>((counts, entry) => {
    entry.trades.forEach(trade => {
      if (deletedSet.has(trade.id)) return;
      (trade.confluences ?? []).forEach(tag => {
        const storageKey = getConfluenceStorageKey(tag);
        if (!storageKey) return;
        counts[storageKey] = (counts[storageKey] ?? 0) + 1;
      });
    });
    return counts;
  }, {});

  const confluenceGroups = CONFLUENCE_GROUPS.map(group => ({
    ...group,
    items: [] as Array<{ option: string; index: number; usageCount: number; isManual: boolean }>,
  }));

  confluenceOptions.forEach((option, index) => {
    const storageKey = getConfluenceStorageKey(option);
    const overrideKey = confluenceCategoryOverrides[storageKey];
    const manualGroup = overrideKey ? confluenceGroups.find(group => group.key === overrideKey) : undefined;
    const targetGroup = manualGroup ?? confluenceGroups.find(group => group.match(option)) ?? confluenceGroups[confluenceGroups.length - 1];
    targetGroup.items.push({
      option,
      index,
      usageCount: confluenceUsageCounts[storageKey] ?? 0,
      isManual: Boolean(manualGroup),
    });
  });

  confluenceGroups.forEach(group => {
    group.items.sort((a, b) => b.usageCount - a.usageCount || a.option.localeCompare(b.option, undefined, { sensitivity: 'base' }));
  });

  const visibleConfluenceGroups = confluenceGroups;

  const _searchNorm = confluenceSearch.trim().toLowerCase();
  const displayGroups = _searchNorm
    ? visibleConfluenceGroups
        .map(group => ({ ...group, items: group.items.filter(({ option }) => option.toLowerCase().includes(_searchNorm)) }))
        .filter(group => group.items.length > 0)
    : visibleConfluenceGroups;

  function startEditingConfluence(index: number, option: string) {
    setEditingConfluenceIndex(index);
    setEditingConfluenceDraft(option);
  }

  function commitEditingConfluence(index: number, option: string) {
    const canonical = normalizeConfluenceTag(editingConfluenceDraft);
    if (canonical && canonical !== option) {
      const oldStorageKey = getConfluenceStorageKey(option);
      const newStorageKey = getConfluenceStorageKey(canonical);
      setConfluenceCategoryOverrides(current => {
        if (!current[oldStorageKey] || oldStorageKey === newStorageKey) return current;
        const next = { ...current, [newStorageKey]: current[oldStorageKey] };
        delete next[oldStorageKey];
        return next;
      });
      updateConfluenceOption(index, canonical);
    }
    setEditingConfluenceIndex(null);
  }

  function handleAddConfluence() {
    const canonical = normalizeConfluenceTag(newConfluenceDraft);
    if (!canonical || confluenceOptions.length >= 64) return;
    addConfluenceOption(canonical);
    setNewConfluenceDraft('');
  }

  function moveConfluenceToGroup(index: number, groupKey: ConfluenceGroupKey) {
    const option = confluenceOptions[index];
    if (!option) return;
    const storageKey = getConfluenceStorageKey(option);
    setConfluenceCategoryOverrides(current => ({ ...current, [storageKey]: groupKey }));
    setDraggingConfluenceIndex(null);
    setDragOverConfluenceGroup(null);
  }

  return (
    <div
      className="animate-fade-in"
      style={{
        fontFamily: SANS,
        display: 'grid',
        gridTemplateColumns: '216px minmax(0, 1fr)',
        gap: '32px',
        alignItems: 'start',
        // Lift the page off the bare app background so it doesn't read as a stark
        // black block next to the panelled rest of the site.
        background: 'var(--app-panel-soft)',
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        padding: '22px 26px',
      }}
    >
      {/* Fixed rail — grouped nav that never scrolls away */}
      <aside
        data-tour-id="settings-nav"
        style={{ position: 'sticky', top: 12, alignSelf: 'start', paddingRight: 4 }}
      >
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1.35, color: T1, padding: '2px 10px 20px', margin: 0 }}>Settings</h1>
        {RAIL_GROUPS.map(group => (
          <div key={group.label}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T1, padding: '0 10px 6px', marginTop: 24 }}>
              {group.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {group.items.filter(item => item.key !== 'dev' || user?.email?.toLowerCase() === 'ushinator2005@gmail.com').map(item => {
                const on = activeSection === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-tour-id={item.key === 'profile' ? 'settings-profile' : item.key === 'accounts' ? 'settings-accounts' : item.key === 'scanner' ? 'settings-scanner' : undefined}
                    onClick={() => scrollToSection(item.key)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer',
                      fontSize: 13, fontWeight: on ? 600 : 500, fontFamily: SANS,
                      color: on ? AMBER : 'var(--app-text-muted)',
                      transition: 'color .14s',
                    }}
                    onMouseEnter={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.color = T1; }}
                    onMouseLeave={e => { if (!on) (e.currentTarget as HTMLButtonElement).style.color = 'var(--app-text-muted)'; }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 18, padding: '16px 10px 0', borderTop: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: T1 }}>{journalEntries.length}</span>
            <span style={{ fontSize: 12, color: T2, marginLeft: 7 }}>daily journals</span>
          </div>
          <div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: T1 }}>{loadedTradeCount}</span>
            <span style={{ fontSize: 12, color: T2, marginLeft: 7 }}>trades logged</span>
          </div>
        </div>
      </aside>

      {/* Content — one section at a time, centred in the column */}
      <main style={{ minWidth: 0, width: '100%', maxWidth: 760, marginInline: 'auto' }}>

      {/* Profile section */}
      <section ref={profileRef} data-tour-id="settings-profile" style={{ display: activeSection === 'profile' ? 'block' : 'none' }}>
        <StgHead title="Profile" sub="Your login, public identity, and how other traders find you." />

        <input
          ref={profilePhotoInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={event => { void handleProfilePhotoChange(event); }}
          style={{ display: 'none' }}
        />

        {/* Identity strip */}
        <div data-tour-id="settings-data-safety" style={{ display: 'flex', alignItems: 'center', gap: 15, marginTop: 26, paddingBottom: 22, borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ width: 52, height: 52, borderRadius: 9, background: AMBER_DIM, border: `1px solid ${AMBER}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: AMBER, fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, flexShrink: 0, overflow: 'hidden' }}>
            {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : avatarInitials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b style={{ display: 'block', fontSize: 15, fontWeight: 600, color: T1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</b>
            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--app-text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email}{' · '}
              <em style={{ fontStyle: 'normal', color: hasSavedProfileUsername ? 'var(--cobalt)' : AMBER }}>
                {hasSavedProfileUsername ? `@${profileUsername}` : visibleProfileUsername ? `@${visibleProfileUsername}` : 'no handle'}
              </em>
            </span>
          </div>
          <span style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: AMBER, border: '1px solid rgba(245,166,35,0.35)', padding: '5px 9px', borderRadius: 5, flexShrink: 0, whiteSpace: 'nowrap' }}>
            Beta · all features
          </span>
        </div>

        {/* Rows */}
        <style>{`.stg-profile-rows > .stg-row:first-child { border-top: none !important; }`}</style>
        <div className="stg-profile-rows" style={{ marginTop: 24 }}>
          <StgRow label="Username" desc="Your public handle for rivals, requests, and leaderboards.">
            <input
              value={profileDraft}
              placeholder={visibleProfileUsername || 'your_username'}
              onChange={event => setProfileDraft(normalizeUsername(event.target.value))}
              onKeyDown={event => { if (event.key === 'Enter') void handleSaveProfile(); }}
              style={STG_TXT}
            />
            <button type="button" disabled={profileSaving} onClick={() => { void handleSaveProfile(); }} className="settings-primary-action" style={{ height: 32, padding: '0 13px', fontSize: 11, boxShadow: 'none' }}>
              {profileSaving ? 'Saving' : 'Save'}
            </button>
          </StgRow>
          <StgRow label="Profile photo" desc="Shown on leaderboards and rival requests.">
            <button type="button" disabled={profilePhotoUploading} onClick={() => profilePhotoInputRef.current?.click()} style={STG_BTN}>
              {profilePhotoUploading ? 'Uploading…' : avatarUrl ? 'Change photo' : 'Add photo'}
            </button>
          </StgRow>
          <StgRow label="Email" desc="Used to sign in. This login owns the data on this device.">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--app-text-muted)' }}>{email}</span>
          </StgRow>
        </div>
        {profileStatus && (
          <p style={{ marginTop: 10, color: profileStatus.includes('saved') ? 'var(--green)' : AMBER, fontSize: 12, fontWeight: 600 }}>{profileStatus}</p>
        )}

        {/* Danger zone */}
        <div style={{ marginTop: 38, paddingTop: 8, borderTop: '1px solid rgba(255,69,58,0.18)' }}>
          <style>{`.stg-danger-rows > .stg-row:first-child { border-top: none !important; }`}</style>
          <div className="stg-danger-rows">
            <StgRow label="Sign out everywhere" desc="Ends every active session, including this browser.">
              <button type="button" onClick={() => { void signOut(); }} style={STG_BTN}>Sign out</button>
            </StgRow>
            <StgRow label="Delete account" desc="Permanently removes your journal, trades, and accounts. Export first.">
              <button type="button" onClick={() => setShowResetPanel(true)} style={{ ...STG_BTN, color: '#FF453A', borderColor: 'rgba(255,69,58,0.32)', background: 'transparent' }}>Delete account</button>
            </StgRow>
          </div>
          {showResetPanel && (
            <div style={{ border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '16px', background: 'rgba(239,68,68,0.05)', marginTop: 12 }}>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
                This will permanently erase <strong>trades, journal entries, accounts, goals, backtests, settings, risk rules, pre-session data, friends, and cached backups</strong>. Only your Flyxa username will be kept.
              </p>
              <p style={{ margin: '0 0 10px', fontSize: 12, color: T3 }}>
                Type <strong style={{ color: '#f87171' }}>RESET</strong> to confirm:
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={resetConfirmText} onChange={e => setResetConfirmText(e.target.value)} placeholder="RESET" style={{ height: 34, padding: '0 12px', borderRadius: 6, width: 140, border: '1px solid rgba(239,68,68,0.4)', background: 'var(--app-panel-strong)', color: 'var(--txt)', fontSize: 13, fontFamily: SANS, outline: 'none' }} />
                <button type="button" disabled={resetConfirmText !== 'RESET' || resetWorking} onClick={() => { void handleConfirmResetAllData(); }} style={{ height: 34, padding: '0 16px', borderRadius: 6, border: 'none', background: resetConfirmText === 'RESET' && !resetWorking ? '#ef4444' : 'rgba(239,68,68,0.2)', color: resetConfirmText === 'RESET' && !resetWorking ? '#fff' : 'rgba(239,68,68,0.4)', fontSize: 13, fontWeight: 700, cursor: resetConfirmText === 'RESET' && !resetWorking ? 'pointer' : 'not-allowed', fontFamily: SANS }}>
                  {resetWorking ? 'Deleting…' : 'Delete account'}
                </button>
                <button type="button" onClick={() => { setShowResetPanel(false); setResetConfirmText(''); }} style={{ height: 34, padding: '0 14px', borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: T3, fontSize: 13, cursor: 'pointer', fontFamily: SANS }}>Cancel</button>
              </div>
              {resetError && <p style={{ margin: '10px 0 0', color: '#fca5a5', fontSize: 12 }}>{resetError}</p>}
            </div>
          )}
        </div>
      </section>

      {/* Membership section */}
      <section style={{ display: activeSection === 'billing' ? 'block' : 'none' }}>
        <StgHead title="Membership" sub="Your Flyxa subscription, plan status, and billing portal." />
        <div style={{ marginTop: 24 }}>
          <StgRow
            label="Current plan"
            desc={subscription.loading
              ? 'Checking membership status…'
              : !subscription.configured
                ? 'Billing is not switched on in this environment, so all features are open.'
                : subscription.active
                  ? (subscription.currentPeriodEnd
                    ? `Membership active, renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
                    : 'Membership active.')
                  : 'No active membership on this account.'}
          >
            <span style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: AMBER, border: '1px solid rgba(245,166,35,0.35)', padding: '5px 9px', borderRadius: 5, whiteSpace: 'nowrap' }}>
              {!subscription.configured ? 'Beta · all features' : subscription.active ? 'Active' : 'Free'}
            </span>
          </StgRow>
          <StgRow label="Billing portal" desc="Payment method, invoices, and plan changes.">
            <button type="button" onClick={() => navigate('/upgrade')} style={subscription.configured && !subscription.active ? { ...STG_BTN, background: AMBER, borderColor: AMBER, color: '#141311' } : STG_BTN}>
              {subscription.configured && !subscription.active ? 'Start membership' : 'Manage membership'}
            </button>
          </StgRow>
        </div>
      </section>

      {/* General section */}
      <section ref={generalRef} style={{ display: activeSection === 'general' ? 'block' : 'none' }}>
        <StgHead title="General" sub="Global formatting and clock defaults for the whole app." />
        <div style={{ marginTop: 24 }}>
          <StgRow label="Theme" desc="Applies to every view.">
            <WorkspaceSelect value={theme} onChange={v => setTheme(v as 'dark' | 'light' | 'midnight')}>
              <option value="dark">Default</option>
              <option value="light">Light</option>
              <option value="midnight">Midnight</option>
            </WorkspaceSelect>
          </StgRow>
          <StgRow label="Date format">
            <WorkspaceSelect value={preferences.dateFormat} onChange={v => updatePreferences({ dateFormat: v as typeof preferences.dateFormat })}>
              <option value="dd/MM/yyyy">DD/MM/YYYY</option>
              <option value="MM/dd/yyyy">MM/DD/YYYY</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD</option>
            </WorkspaceSelect>
          </StgRow>
          <StgRow label="Currency symbol">
            <WorkspaceSelect value={preferences.currencySymbol} onChange={v => updatePreferences({ currencySymbol: v as typeof preferences.currencySymbol })}>
              <option value="$">$ USD</option>
              <option value="€">€ EUR</option>
              <option value="£">£ GBP</option>
              <option value="A$">A$ AUD</option>
            </WorkspaceSelect>
          </StgRow>
          <StgRow label="Timezone" desc="All timestamps and session windows are shown in this zone.">
            <WorkspaceSelect value={preferences.timezone} onChange={value => updatePreferences({ timezone: value })}>
              {TIMEZONE_GROUPS.map(group => (
                <optgroup key={group.region} label={group.region}>
                  {group.zones.map(zone => (
                    <option key={zone} value={zone}>{formatTimezoneOptionLabel(zone)}</option>
                  ))}
                </optgroup>
              ))}
            </WorkspaceSelect>
          </StgRow>
          <StgRow
            label="Market clock"
            desc={`${MARKET_CLOCK_OPTIONS.find(option => option.value === (preferences.marketClock ?? 'equities'))?.detail ?? ''} Drives the header clock and pre-session timing.`}
          >
            <WorkspaceSelect value={preferences.marketClock ?? 'equities'} onChange={v => updatePreferences({ marketClock: v as 'equities' | 'futures' | 'forex' })}>
              {MARKET_CLOCK_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </WorkspaceSelect>
          </StgRow>
          <StgRow label="Clock format" desc="Also applies to the news wire timestamps.">
            <WorkspaceSelect value={preferences.clockFormat ?? '12h'} onChange={v => updatePreferences({ clockFormat: v as '12h' | '24h' })}>
              <option value="12h">12-hour (9:27 AM)</option>
              <option value="24h">24-hour (09:27)</option>
            </WorkspaceSelect>
          </StgRow>
          <StgRow label="Product tour" desc="Reopen the feature walkthrough and review the app tab by tab.">
            <button type="button" onClick={() => window.dispatchEvent(new Event('flyxa:restart-tour'))} style={STG_BTN}>Restart tour</button>
          </StgRow>
        </div>
      </section>

      {/* Session times section */}
      <section style={{ display: activeSection === 'sessions' ? 'block' : 'none' }}>
        <StgHead title="Session times" sub="Your default Asia, London, Pre Market, and New York windows, in New York time." />

        {/* One shared 24-hour timeline: label column | track | duration column */}
        <div style={{ marginTop: 26, paddingTop: 18, paddingBottom: 6, borderTop: `1px solid ${BORDER}` }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ width: 88, flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: T2 }}>
              <span>12AM</span><span>6AM</span><span>12PM</span><span>6PM</span><span>12AM</span>
            </div>
            <div style={{ width: 40, flexShrink: 0 }} />
          </div>
          {SESSION_TIME_FIELDS.map(session => {
            const sessionColor = SESSION_COLORS[session.key];
            const startValue = preferences.sessionTimes[session.key].start;
            const endValue = preferences.sessionTimes[session.key].end;
            const segs = getSessionTimelineSegments(startValue, endValue);
            const hours = Math.round((segs.reduce((sum, seg) => sum + seg.width, 0) / 100 * 24) * 2) / 2;
            return (
              <div key={session.key} style={{ display: 'flex', alignItems: 'center', height: 20, marginBottom: 8 }}>
                <div style={{ width: 88, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 600, color: T1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: sessionColor, flexShrink: 0 }} />
                  {session.label}
                </div>
                <div style={{ position: 'relative', flex: 1, height: '100%' }}>
                  {[25, 50, 75].map(l => <span key={l} style={{ position: 'absolute', top: 0, bottom: 0, left: `${l}%`, width: 1, background: 'rgba(255,255,255,0.04)' }} />)}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.05)' }} />
                  {segs.map((seg, i) => (
                    <span key={i} style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', height: 4, borderRadius: 2, left: `${seg.left}%`, width: `${seg.width}%`, background: sessionColor }} />
                  ))}
                </div>
                <div style={{ width: 40, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10, color: T2 }}>{hours}h</div>
              </div>
            );
          })}
        </div>

        {/* Start / End editing rows */}
        <div style={{ marginTop: 22 }}>
          {SESSION_TIME_FIELDS.map(session => {
            const sessionColor = SESSION_COLORS[session.key];
            const startValue = preferences.sessionTimes[session.key].start;
            const endValue = preferences.sessionTimes[session.key].end;
            return (
              <div key={session.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 118px 118px', gap: 16, alignItems: 'center', padding: '13px 0', borderTop: `1px solid ${BORDER}` }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: T1 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sessionColor, flex: 'none' }} />
                  {session.label}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1.2px', textTransform: 'uppercase', color: T2, width: 42, flex: 'none' }}>Start</label>
                  <SessionTimeField value={startValue} onChange={value => handleSessionTimeChange(session.key, 'start', value)} />
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1.2px', textTransform: 'uppercase', color: T2, width: 42, flex: 'none' }}>End</label>
                  <SessionTimeField value={endValue} onChange={value => handleSessionTimeChange(session.key, 'end', value)} />
                </span>
              </div>
            );
          })}
        </div>

      </section>

      {/* Display section */}
      <section ref={displayRef} style={{ display: activeSection === 'display' ? 'block' : 'none' }}>
        <StgHead title="Display" sub="What a new chart view opens with." />
        <div style={{ marginTop: 24 }}>
          <StgRow label="Default timeframe">
            <StyledSelect value={preferences.defaultTimeframe} onChange={v => updatePreferences({ defaultTimeframe: v as typeof preferences.defaultTimeframe })}>
              <option value="1m">1 minute</option>
              <option value="5m">5 minutes</option>
              <option value="15m">15 minutes</option>
              <option value="1h">1 hour</option>
            </StyledSelect>
          </StgRow>
          <StgRow label="Default chart type">
            <StyledSelect value={preferences.defaultChartType} onChange={v => updatePreferences({ defaultChartType: v as typeof preferences.defaultChartType })}>
              <option value="Candles">Candles</option>
              <option value="Line">Line</option>
              <option value="Area">Area</option>
            </StyledSelect>
          </StgRow>
        </div>
      </section>

      {/* Scanner section */}
      <section ref={scannerRef} data-tour-id="settings-scanner" style={{ display: activeSection === 'scanner' ? 'block' : 'none' }}>
        <StgHead title="Scanner" sub="Match these colours to the zone boxes you draw on TradingView so the AI reads each level correctly." />
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: T2, paddingBottom: 2 }}>Chart zone colours</div>
          {([
            { key: 'entry' as const, label: 'Entry zone' },
            { key: 'stopLoss' as const, label: 'Stop loss' },
            { key: 'takeProfit' as const, label: 'Take profit' },
          ]).map(({ key, label }) => {
            const hex = preferences.scannerColors?.[key] ?? (key === 'entry' ? '#E67E22' : key === 'stopLoss' ? '#C0392B' : '#1A6B5A');
            return (
              <div key={key} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr) auto', alignItems: 'center', gap: 16, padding: '15px 0', borderTop: `1px solid ${BORDER}` }}>
                <ColorSwatchPicker
                  value={hex}
                  ariaLabel={`${label} colour`}
                  onChange={color => updatePreferences({ scannerColors: { ...preferences.scannerColors, [key]: color } })}
                />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: T1 }}>{label}</span>
                <span style={{ fontSize: 12, color: T2, fontFamily: MONO, letterSpacing: '0.03em' }}>{hex.toUpperCase()}</span>
              </div>
            );
          })}

          {/* Auto-detect zones */}
          {(() => {
            const on = preferences.scannerAutoDetect ?? true;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 20, padding: '18px 0 0', marginTop: 22, borderTop: `1px solid ${BORDER}` }}>
                <div>
                  <b style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: T1 }}>Auto-detect zones</b>
                  <p style={{ margin: '4px 0 0', fontSize: 12.5, color: DIM }}>Read zone boxes without needing an exact colour match.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label="Toggle auto-detect zones"
                  onClick={() => updatePreferences({ scannerAutoDetect: !on })}
                  style={{ flexShrink: 0, width: 42, height: 23, borderRadius: 12, border: on ? '1px solid transparent' : `1px solid ${BORDER}`, background: on ? AMBER : 'rgba(255,255,255,0.06)', position: 'relative', cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s' }}
                >
                  <span style={{ position: 'absolute', top: 2, left: on ? 21 : 2, width: 17, height: 17, borderRadius: '50%', background: on ? '#fff' : T3, transition: 'left 0.15s, background 0.15s' }} />
                </button>
              </div>
            );
          })()}
        </div>
      </section>

      {/* Backup & recovery section */}
      <section style={{ display: activeSection === 'databackup' ? 'block' : 'none' }}>
        <StgHead title="Backup & recovery" sub={`Export before major imports or account changes. ${journalEntries.length} journal ${journalEntries.length === 1 ? 'day' : 'days'}, ${loadedTradeCount} ${loadedTradeCount === 1 ? 'trade' : 'trades'} logged.`} />
        <input ref={importFileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportJson} />
        <div style={{ marginTop: 24 }}>
          <StgRow label="Export journal" desc="Full trade and journal history in your chosen format.">
            <SafetyActionButton icon={<FileJson size={13} />} onClick={handleExportJson} disabled={journalEntries.length === 0}>JSON</SafetyActionButton>
            <SafetyActionButton icon={<FileSpreadsheet size={13} />} onClick={handleExportCsv} disabled={loadedTradeCount === 0}>CSV</SafetyActionButton>
          </StgRow>
          <StgRow label="Import" desc="Bring in trade history from a CSV or a previous export.">
            <SafetyActionButton icon={<Upload size={13} />} onClick={() => importFileRef.current?.click()}>Choose file</SafetyActionButton>
          </StgRow>
          <StgRow label="Recover missing trades" desc="Merges this browser's local backup when cloud data is missing.">
            <SafetyActionButton icon={<RotateCcw size={13} />} tone="primary" onClick={() => { void handleRecoverFromLocalCache(); }}>Run recovery</SafetyActionButton>
          </StgRow>
        </div>
        {importFeedback && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: importFeedback.ok ? '#4ade80' : '#f87171', fontFamily: SANS }}>
            {importFeedback.ok ? '✓ ' : '✗ '}{importFeedback.msg}
          </p>
        )}
      </section>

      {/* Developer section — owner only, never rendered for anyone else */}
      {user?.email?.toLowerCase() === 'ushinator2005@gmail.com' && (
      <section style={{ display: activeSection === 'dev' ? 'block' : 'none' }}>
        <StgHead title="Developer" sub="Internal tooling. Not shown to normal accounts." />
        <div style={{ marginTop: 24 }}>
          <StgRow label="Eval capture" desc="Records every scan as a regression case for the scanner test suite. Leave off for normal trading.">
            <button
              type="button"
              role="switch"
              aria-checked={evalCaptureOn}
              aria-label="Toggle scanner eval capture"
              onClick={toggleEvalCapture}
              style={{ flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: `1px solid ${evalCaptureOn ? AMBER : BORDER}`, background: evalCaptureOn ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.04)', position: 'relative', cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s' }}
            >
              <span style={{ position: 'absolute', top: 2, left: evalCaptureOn ? 20 : 2, width: 16, height: 16, borderRadius: '50%', background: evalCaptureOn ? AMBER : T3, transition: 'left 0.15s, background 0.15s' }} />
            </button>
          </StgRow>
        </div>
        <p style={{ margin: '18px 0 0', fontFamily: MONO, fontSize: 11, lineHeight: 1.7, color: DIM }}>
          While on, each chart you scan downloads a <span style={{ color: AMBER }}>bundle.json</span>. Drop it into <span style={{ color: AMBER }}>scanner-evals/cases/</span>, correct any wrong fields, and it becomes ground truth for <span style={{ color: AMBER }}>npm run evals</span>.
        </p>
        <div style={{ marginTop: 18 }}>
          <WaitlistReferralsPanel />
        </div>
      </section>
      )}

      {/* Accounts section */}
      <section ref={accountsRef} data-tour-id="settings-accounts" style={{ display: activeSection === 'accounts' ? 'block' : 'none' }}>
        <StgHead title="Trading accounts" sub="The accounts available across your dashboard and journal." />
        <div style={{ marginTop: 24 }}>
          {accounts.filter(account => account.id !== DEFAULT_ACCOUNT_ID && !account.archived).map(account => {
            const editing = editingAccountId === account.id;
            const st = account.status;
            const statusText = st === 'Eval' ? 'In evaluation' : st === 'Funded' ? 'Funded' : st === 'Live' ? 'Live' : st === 'Passed' ? 'Passed' : st === 'Blown' ? 'Blown' : String(st);
            const statusDot = st === 'Blown' ? '#f87171' : st === 'Eval' ? '#f59e0b' : '#34d399';
            const isDefault = account.id === defaultTradeAccountId;
            const metaLabel: React.CSSProperties = { fontStyle: 'normal', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: T2, marginRight: 8 };
            const metaVal: React.CSSProperties = { fontStyle: 'normal', fontWeight: 500, color: T1 };
            return (
              <div key={account.id}>
                {/* Self-describing account row */}
                <div style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) auto', gap: '5px 16px', alignItems: 'center', padding: '16px 0', borderTop: `1px solid ${BORDER}`, fontFamily: SANS }}>
                  {/* Firm logo — focal anchor */}
                  <FirmLogo firm={account.broker} name={account.name} isDefault={isDefault} />
                  <div style={{ gridColumn: 2, gridRow: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, minWidth: 0 }}>
                    <b style={{ fontSize: 14.5, fontWeight: 600, color: T1, letterSpacing: '-0.15px' }}>{account.name || 'Untitled account'}</b>
                    {isDefault && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: AMBER }}>Default</span>}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T2 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusDot, flexShrink: 0 }} />
                      {statusText}
                    </span>
                  </div>
                  <div style={{ gridColumn: 2, gridRow: 2, display: 'flex', flexWrap: 'wrap', gap: '4px 20px', marginTop: 3, fontSize: 12, color: T2 }}>
                    <span><i style={metaLabel}>Firm</i><em style={metaVal}>{account.broker || '—'}</em></span>
                    <span><i style={metaLabel}>Type</i><em style={metaVal}>{account.type}</em></span>
                    <span><i style={metaLabel}>Balance</i><em style={metaVal}>{(() => { const b = liveBalanceFor(account); return b != null ? moneyValue(b) : '—'; })()}</em>{account.targetBalance != null && <> to <em style={metaVal}>{moneyValue(account.targetBalance)}</em> target</>}</span>
                  </div>
                  <div style={{ gridColumn: 3, gridRow: '1 / span 2', alignSelf: 'center', justifySelf: 'end' }}>
                    <button type="button" onClick={() => setEditingAccountId(editing ? null : account.id)} style={STG_BTN}>{editing ? 'Done' : 'Edit'}</button>
                  </div>
                </div>

                {/* Inline editor */}
                {editing && (
                  <div style={{ paddingBottom: 18 }}>
                    {([
                      ['Account name', <input key="n" style={{ ...STG_TXT, borderBottom: 'none' }} value={account.name} onChange={e => updateAccount(account.id, { name: e.target.value })} placeholder="Account name" />],
                      ['Firm', <input key="f" style={{ ...STG_TXT, borderBottom: 'none' }} value={account.broker ?? ''} onChange={e => updateAccount(account.id, { broker: e.target.value })} placeholder="Firm" />],
                      ['Starting balance', <input key="s" type="number" min="0" step="1000" style={{ ...STG_TXT, borderBottom: 'none' }} value={account.startingBalance ?? ''} onChange={e => { const v = parseFloat(e.target.value); updateAccount(account.id, { startingBalance: Number.isFinite(v) && v >= 0 ? v : undefined }); }} placeholder="e.g. 100000" />],
                      ['Target balance', <input key="t" type="number" min="0" step="1000" style={{ ...STG_TXT, borderBottom: 'none' }} value={account.id in draftTargetBalances ? draftTargetBalances[account.id] : String(account.targetBalance ?? '')} onChange={e => setDraftTargetBalances(prev => ({ ...prev, [account.id]: e.target.value }))} onBlur={e => { const v = parseFloat(e.target.value); updateAccount(account.id, { targetBalance: Number.isFinite(v) && v >= 0 ? v : undefined }); setDraftTargetBalances(prev => { const next = { ...prev }; delete next[account.id]; return next; }); }} placeholder="e.g. 110000" />],
                      ['Account type', <StyledSelect key="ty" value={account.type} onChange={v => updateAccount(account.id, { type: v as TradingAccountType })}>{ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</StyledSelect>],
                      ['Status', <StatusSelect key="st" value={account.status} onChange={status => updateAccount(account.id, { status })} />],
                    ] as Array<[string, React.ReactNode]>).map(([label, ctl]) => (
                      <div key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,244px)', gap: 34, alignItems: 'center', padding: '9px 0' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: T1 }}>{label}</span>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{ctl}</div>
                      </div>
                    ))}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
                      {account.id !== defaultTradeAccountId && account.status !== 'Blown' && account.status !== 'Passed' && (
                        <button type="button" onClick={() => setDefaultAccount(account.id)} style={STG_BTN}>Set as default</button>
                      )}
                      {isDefault && account.isDefault === true && (
                        <button type="button" onClick={() => setDefaultAccount(null)} style={STG_BTN}>Remove default</button>
                      )}
                      {(account.status === 'Funded' || account.status === 'Live') && (
                        <button type="button" onClick={() => setPayoutTarget(payoutTarget === account.id ? null : account.id)} style={STG_BTN}>Payouts{getPayouts(account.id).length > 0 ? ` (${getPayouts(account.id).length})` : ''}</button>
                      )}
                      <button type="button" onClick={() => updateAccount(account.id, { archived: true })} style={STG_BTN}>Archive</button>
                      <button type="button" onClick={() => setDeleteTarget(account.id)} style={{ ...STG_BTN, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}>Delete</button>
                    </div>
                  </div>
                )}


                {/* Payouts panel */}
                {payoutTarget === account.id && (() => {
                  const payouts = getPayouts(account.id);
                  const total = payouts.reduce((s, p) => s + p.amount, 0);
                  const amt = parseFloat(payoutAmount);
                  const canAdd = Boolean(payoutDate) && Number.isFinite(amt) && amt > 0;
                  const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  const fmtDate = (d: string) => {
                    const dt = new Date(`${d}T00:00:00`);
                    return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
                  };
                  const inputStyle: React.CSSProperties = { height: 34, borderRadius: 7, border: `1px solid ${BORDER}`, background: S2, color: T1, fontSize: 12.5, padding: '0 10px', outline: 'none' };
                  const submit = () => {
                    if (!canAdd) return;
                    addPayout(account.id, { id: crypto.randomUUID(), date: payoutDate, amount: amt, note: payoutNote.trim() || undefined });
                    setPayoutAmount('');
                    setPayoutNote('');
                  };
                  return (
                    <div style={{ marginTop: 12, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: T2 }}>Payouts</span>
                        {payouts.length > 0 && (
                          <span style={{ fontSize: 12, color: T2 }}>
                            {payouts.length} logged&nbsp;·&nbsp;<b style={{ fontFamily: MONO, fontWeight: 600, color: '#34d399' }}>${usd(total)}</b> withdrawn
                          </span>
                        )}
                      </div>

                      {/* Add form — one clean row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 128px minmax(0,1fr) auto', gap: 9, alignItems: 'center', marginBottom: payouts.length > 0 ? 16 : 0 }}>
                        <DatePicker value={payoutDate} onChange={setPayoutDate} compact align="left" max={new Date().toISOString().slice(0, 10)} />
                        <input type="number" min="0" step="100" placeholder="Amount $" value={payoutAmount}
                          onChange={e => setPayoutAmount(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                          style={{ ...inputStyle, fontFamily: MONO }} />
                        <input type="text" placeholder="Note (optional)" value={payoutNote}
                          onChange={e => setPayoutNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                          style={{ ...inputStyle, fontFamily: SANS }} />
                        <button type="button" disabled={!canAdd} onClick={submit}
                          style={{ height: 34, borderRadius: 7, border: 'none', background: canAdd ? AMBER : 'rgba(245,158,11,0.22)', color: canAdd ? '#141311' : 'rgba(20,19,17,0.55)', fontSize: 12, fontWeight: 700, padding: '0 18px', cursor: canAdd ? 'pointer' : 'not-allowed', fontFamily: SANS }}>
                          Add
                        </button>
                      </div>

                      {/* List */}
                      {payouts.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          {[...payouts].sort((a, b) => b.date.localeCompare(a.date)).map((payout, i) => (
                            <div key={payout.id} style={{ display: 'grid', gridTemplateColumns: '84px 128px minmax(0,1fr) 22px', gap: 12, alignItems: 'center', padding: '9px 0', borderTop: i === 0 ? 'none' : `1px solid ${BSUB}` }}>
                              <span style={{ fontSize: 11.5, color: T2, fontFamily: MONO }}>{fmtDate(payout.date)}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#34d399', fontFamily: MONO }}>+${usd(payout.amount)}</span>
                              <span style={{ fontSize: 12, color: T3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{payout.note ?? ''}</span>
                              <button type="button" onClick={() => deletePayout(account.id, payout.id)} title="Remove payout"
                                style={{ background: 'none', border: 'none', color: T3, cursor: 'pointer', lineHeight: 0, padding: 2, opacity: 0.55, justifySelf: 'end' }}
                                onMouseEnter={e => { const el = e.currentTarget; el.style.opacity = '1'; el.style.color = '#f87171'; }}
                                onMouseLeave={e => { const el = e.currentTarget; el.style.opacity = '0.55'; el.style.color = T3; }}>
                                <X size={13} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p style={{ fontSize: 12, color: T3, margin: '2px 0 0' }}>No payouts logged yet. Add your first withdrawal above.</p>
                      )}
                    </div>
                  );
                })()}

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
            );
            })}

          {/* Add another account */}
          <button
            type="button"
            data-tour-id="settings-add-account"
            onClick={() => setShowAddAccountModal(true)}
            style={{
              display: 'block',
              width: '100%',
              padding: '16px 0 0',
              background: 'transparent',
              border: 'none',
              borderTop: `1px solid ${BORDER}`,
              marginTop: 4,
              color: AMBER,
              fontSize: 12.5,
              fontWeight: 600,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: SANS,
            }}
          >
            + Add another account
          </button>
        </div>{/* end accounts list */}

        {/* Archived accounts — its own section below the table (v2) */}
        {accounts.some(a => a.id !== DEFAULT_ACCOUNT_ID && a.archived) && (
          <div style={{ marginTop: 34, paddingTop: 20, borderTop: `1px solid ${BORDER}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <b style={{ display: 'block', fontSize: 13, fontWeight: 600, color: T1 }}>Archived accounts</b>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: DIM }}>Hidden from the dashboard but kept for history.</p>
              </div>
              <button type="button" onClick={() => setArchivedExpanded(current => !current)} style={STG_BTN}>
                {archivedExpanded ? 'Hide' : `Show ${accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && a.archived).length} archived`}
              </button>
            </div>
            <div style={{ marginTop: archivedExpanded ? 12 : 0 }}>
              {archivedExpanded && accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && a.archived).map(account => (
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
          </div>
        )}
      </section>

      {/* Journal section */}
      <section ref={journalRef} style={{ display: activeSection === 'journal' ? 'block' : 'none' }}>
        <StgHead title="Journal tags" sub="Keep your confluence tags tidy so trade reviews stay readable. Drag tags between categories." />

        {/* Search — underlined, no icon */}
        <div style={{ marginTop: 20 }}>
          <input
            placeholder="Search tags"
            value={confluenceSearch}
            onChange={e => setConfluenceSearch(e.target.value)}
            style={{ width: '100%', background: 'none', border: 'none', borderBottom: `1px solid ${BORDER}`, borderRadius: 0, padding: '8px 2px', color: T1, fontSize: 13, fontFamily: SANS, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        {(() => {
          const allItems = displayGroups.flatMap(g => g.items);
          const maxUsage = Math.max(1, ...allItems.map(i => i.usageCount));
          const unusedCount = allItems.filter(i => i.usageCount === 0).length;
          const nameGroups = new Map<string, string[]>();
          displayGroups.forEach(g => g.items.forEach(i => {
            const k = i.option.toLowerCase();
            const arr = nameGroups.get(k) ?? [];
            if (!arr.includes(g.title)) arr.push(g.title);
            nameGroups.set(k, arr);
          }));
          const dualCount = [...nameGroups.values()].filter(v => v.length > 1).length;
          const isSearching = Boolean(confluenceSearch.trim());
          return (
            <>
              {/* Stats line */}
              <div style={{ marginTop: 16, fontSize: 12.5, color: T2 }}>
                <span style={{ color: T1, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{confluenceOptions.length}</span> tags across {displayGroups.length} categories
                {unusedCount > 0 && <>{'   '}·{'   '}<span style={{ color: AMBER }}>{unusedCount} unused</span></>}
                {dualCount > 0 && <>{'   '}·{'   '}<span style={{ color: AMBER }}>{dualCount} in two categories</span></>}
              </div>
              <div style={{ marginTop: 3, fontSize: 12, color: T3 }}>Bar length is uses, against your heaviest tag ({maxUsage}).</div>

              {/* Category columns — flat */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '0 48px', marginTop: 10, alignItems: 'start' }}>
                {displayGroups.map(group => {
                  const usedItems = isSearching ? group.items : group.items.filter(i => i.usageCount > 0);
                  const unusedItems = isSearching ? [] : group.items.filter(i => i.usageCount === 0);
                  const expanded = expandedUnusedGroups.has(group.key);
                  const CAP = 5;
                  const shownUsed = expanded || isSearching ? usedItems : usedItems.slice(0, CAP);
                  const moreCount = (usedItems.length - shownUsed.length) + (expanded ? 0 : unusedItems.length);
                  const visibleItems = [...shownUsed, ...(expanded ? unusedItems : [])];
                  return (
                    <div
                      key={group.key}
                      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverConfluenceGroup(group.key); }}
                      onDragLeave={() => setDragOverConfluenceGroup(current => current === group.key ? null : current)}
                      onDrop={event => {
                        event.preventDefault();
                        const transferValue = event.dataTransfer.getData('text/plain');
                        const indexFromTransfer = transferValue === '' ? NaN : Number(transferValue);
                        const indexToMove = Number.isInteger(indexFromTransfer) ? indexFromTransfer : draggingConfluenceIndex;
                        if (indexToMove !== null) moveConfluenceToGroup(indexToMove, group.key);
                      }}
                      style={{ minWidth: 0, borderRadius: 8, outline: dragOverConfluenceGroup === group.key ? `1px solid ${AMBER}` : '1px solid transparent', outlineOffset: 6, transition: 'outline-color 0.15s' }}
                    >
                      {/* Category header */}
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '18px 0 8px', borderTop: `1px solid ${BORDER}` }}>
                        <b style={{ fontSize: 14, fontWeight: 600, color: T1 }}>{group.title}</b>
                        <span style={{ fontSize: 12, color: T2, fontFamily: 'var(--font-mono)' }}>{group.items.length}</span>
                      </div>

                      {/* Tag rows */}
                      {visibleItems.map(({ option, index, usageCount }) => {
                        const isHovered = hoveredConfluenceRow === index;
                        const isEditing = editingConfluenceIndex === index;
                        const alsoIn = (nameGroups.get(option.toLowerCase()) ?? []).filter(t => t !== group.title);
                        return (
                          <div
                            key={`${option}-${index}`}
                            draggable={!isEditing}
                            onMouseEnter={() => setHoveredConfluenceRow(index)}
                            onMouseLeave={() => setHoveredConfluenceRow(current => current === index ? null : current)}
                            onDragStart={event => { setDraggingConfluenceIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
                            onDragEnd={() => { setDraggingConfluenceIndex(null); setDragOverConfluenceGroup(null); }}
                            style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 128px 34px', gap: 16, alignItems: 'center', padding: '9px 0', borderTop: '1px solid rgba(255,255,255,0.045)', cursor: isEditing ? 'default' : 'grab', opacity: draggingConfluenceIndex === index ? 0.45 : 1 }}
                          >
                            {/* Name + also-in, or edit input */}
                            <div style={{ minWidth: 0 }}>
                              {isEditing ? (
                                <input
                                  autoFocus
                                  value={editingConfluenceDraft}
                                  maxLength={64}
                                  onChange={e => setEditingConfluenceDraft(e.target.value)}
                                  onBlur={() => commitEditingConfluence(index, option)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitEditingConfluence(index, option); if (e.key === 'Escape') setEditingConfluenceIndex(null); }}
                                  style={{ width: '100%', minWidth: 0, height: 28, padding: '0 8px', borderRadius: 5, border: `1px solid ${AMBER}`, background: AMBER_DIM, color: T1, fontSize: 13, fontFamily: SANS, outline: 'none' }}
                                />
                              ) : (
                                <>
                                  <button type="button" onClick={() => startEditingConfluence(index, option)} title={`Rename ${option}`}
                                    style={{ maxWidth: '100%', display: 'block', border: 'none', background: 'transparent', color: usageCount === 0 ? T2 : T1, padding: 0, fontFamily: SANS, fontSize: 13, fontWeight: 500, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}>
                                    {option}
                                  </button>
                                  {alsoIn.length > 0 && <span style={{ display: 'block', fontSize: 11, color: AMBER, marginTop: 2 }}>also in {alsoIn.join(', ')}</span>}
                                </>
                              )}
                            </div>

                            {/* Usage bar, or Remove on hover */}
                            {isHovered && !isEditing ? (
                              <button type="button" title={`Delete ${option}`}
                                onClick={() => {
                                  const storageKey = getConfluenceStorageKey(option);
                                  setConfluenceCategoryOverrides(current => { if (!current[storageKey]) return current; const next = { ...current }; delete next[storageKey]; return next; });
                                  deleteConfluenceOption(index);
                                  if (editingConfluenceIndex === index) setEditingConfluenceIndex(null);
                                }}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, border: 'none', background: 'transparent', color: '#fca5a5', fontSize: 11, fontWeight: 500, cursor: 'pointer', padding: 0 }}>
                                <Trash2 size={11} /> Remove
                              </button>
                            ) : (
                              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: 2, width: `${(usageCount / maxUsage) * 100}%`, background: usageCount === 0 ? 'transparent' : 'rgba(255,255,255,0.42)' }} />
                              </div>
                            )}

                            {/* Count */}
                            <span title={`${usageCount} trade${usageCount === 1 ? '' : 's'} tagged`} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'right', color: usageCount === 0 ? T3 : usageCount >= 5 ? '#86efac' : T2 }}>{usageCount}</span>
                          </div>
                        );
                      })}

                      {/* Show more / fewer */}
                      {!isSearching && moreCount > 0 && (
                        <button type="button"
                          onClick={() => setExpandedUnusedGroups(current => { const next = new Set(current); next.add(group.key); return next; })}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 0 0', border: 'none', background: 'transparent', color: T2, fontSize: 12, cursor: 'pointer', fontFamily: SANS }}>
                          Show {moreCount} more
                        </button>
                      )}
                      {!isSearching && expanded && (
                        <button type="button"
                          onClick={() => setExpandedUnusedGroups(current => { const next = new Set(current); next.delete(group.key); return next; })}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 0 0', border: 'none', background: 'transparent', color: T2, fontSize: 12, cursor: 'pointer', fontFamily: SANS }}>
                          Show fewer
                        </button>
                      )}

                      {/* Add tag (focuses the add field) */}
                      {!isSearching && confluenceOptions.length < 64 && (
                        <button type="button"
                          onClick={() => { newTagInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); newTagInputRef.current?.focus(); }}
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 0 0', border: 'none', background: 'transparent', color: T2, fontSize: 12, cursor: 'pointer', fontFamily: SANS }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = AMBER; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T2; }}>
                          + Add tag
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add a new tag */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', marginTop: 26, paddingTop: 18, borderTop: `1px solid ${BORDER}` }}>
                <input
                  ref={newTagInputRef}
                  placeholder={confluenceOptions.length >= 64 ? 'Max 64 tags reached' : 'New confluence tag'}
                  value={newConfluenceDraft}
                  maxLength={64}
                  disabled={confluenceOptions.length >= 64}
                  onChange={e => setNewConfluenceDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddConfluence(); }}
                  style={{ height: 40, padding: '0 14px', borderRadius: 8, border: `1px solid ${BORDER}`, background: S2, color: T1, fontSize: 13, fontFamily: SANS, outline: 'none', opacity: confluenceOptions.length >= 64 ? 0.45 : 1 }}
                />
                <button type="button" disabled={!newConfluenceDraft.trim() || confluenceOptions.length >= 64} onClick={handleAddConfluence} className="settings-primary-action" style={{ height: 40, padding: '0 16px', flexShrink: 0 }}>
                  Add tag
                </button>
              </div>
            </>
          );
        })()}
      </section>

      </main>

      {showSavedToast && createPortal(
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: '24px',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            borderRadius: '999px',
            border: '1px solid rgba(74,222,128,0.45)',
            background: 'rgba(6,78,59,0.92)',
            color: '#bbf7d0',
            padding: '9px 16px',
            fontSize: '12px',
            fontWeight: 600,
            boxShadow: '0 12px 30px rgba(2,6,23,0.34)',
          }}
        >
          <Check size={14} />
          Saved
        </div>,
        document.body,
      )}

      {showAddAccountModal && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center px-4">
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
                <FieldLabel>Firm</FieldLabel>
                <StyledSelect
                  value={newAccount.broker}
                  onChange={value => {
                    const firstTemplate = firmTemplates(value)[0];
                    setNewAccount(current => ({
                      ...current,
                      broker: value,
                      type: firstTemplate ? 'Futures' : current.type,
                      status: firstTemplate ? 'Eval' : current.status,
                      evaluationProgram: firstTemplate?.program ?? current.evaluationProgram,
                      startingBalance: firstTemplate ? String(firstTemplate.accountSize) : current.startingBalance,
                      targetBalance: firstTemplate ? String(firstTemplate.accountSize + firstTemplate.profitTarget) : current.targetBalance,
                      evaluationPath: value === 'Topstep' ? current.evaluationPath : 'standard',
                      dailyLossMode: 'none',
                    }));
                  }}
                >
                  <option value="">Select firm</option>
                  {Array.from(new Set([...templateFirmNames(), 'Apex Trader Funding', 'FTMO']))
                    .sort((a, b) => a.localeCompare(b))
                    .map(firm => <option key={firm} value={firm}>{firm}</option>)}
                  <option value="Other">Other / broker account</option>
                </StyledSelect>
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

              {isTemplateEval(newAccount) && (
                <>
                  <label>
                    <FieldLabel>Program</FieldLabel>
                    <StyledSelect
                      value={newAccount.evaluationProgram}
                      onChange={value => {
                        const sizes = programSizes(newAccount.broker, value);
                        setNewAccount(current => ({
                          ...current,
                          evaluationProgram: value,
                          startingBalance: sizes.length ? String(sizes[0]) : current.startingBalance,
                          targetBalance: sizes.length
                            ? templateTargetBalance(current.broker, value, sizes[0]) || current.targetBalance
                            : current.targetBalance,
                        }));
                      }}
                    >
                      {firmPrograms(newAccount.broker).map(program => <option key={program} value={program}>{program}</option>)}
                    </StyledSelect>
                  </label>

                  {newAccount.broker === 'Topstep' && (
                    <label>
                      <FieldLabel>Pricing path</FieldLabel>
                      <StyledSelect value={newAccount.evaluationPath} onChange={value => setNewAccount(current => ({ ...current, evaluationPath: value as 'standard' | 'no_activation_fee' }))}>
                        <option value="standard">Standard � $149 activation</option>
                        <option value="no_activation_fee">No Activation Fee</option>
                      </StyledSelect>
                    </label>
                  )}

                  <label>
                    <FieldLabel>Account size</FieldLabel>
                    <StyledSelect
                      value={newAccount.startingBalance}
                      onChange={value => setNewAccount(current => ({
                        ...current,
                        startingBalance: value,
                        targetBalance: templateTargetBalance(current.broker, current.evaluationProgram, Number(value)) || current.targetBalance,
                      }))}
                    >
                      {programSizes(newAccount.broker, newAccount.evaluationProgram).map(size => (
                        <option key={size} value={String(size)}>{moneyValue(size)}</option>
                      ))}
                    </StyledSelect>
                  </label>

                  {resolveEvaluationTemplate(newAccount.broker, newAccount.evaluationProgram, Number(newAccount.startingBalance), newAccount.evaluationPath)?.optionalDailyLossLimit != null && (
                    <label>
                      <FieldLabel>Fixed daily loss limit</FieldLabel>
                      <StyledSelect value={newAccount.dailyLossMode} onChange={value => setNewAccount(current => ({ ...current, dailyLossMode: value as 'none' | 'purchase_fixed' }))}>
                        <option value="none">Not added at purchase</option>
                        <option value="purchase_fixed">Added at purchase</option>
                      </StyledSelect>
                    </label>
                  )}
                </>
              )}

              <label>
                <FieldLabel>Starting balance ($)</FieldLabel>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  readOnly={isTemplateEval(newAccount)}
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                    opacity: isTemplateEval(newAccount) ? 0.7 : 1,
                  }}
                  placeholder="e.g. 100000"
                  value={newAccount.startingBalance}
                  onChange={e => setNewAccount(current => ({ ...current, startingBalance: e.target.value }))}
                />
              </label>

              <label>
                <FieldLabel>Target balance ($)</FieldLabel>
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
                  placeholder="e.g. 110000"
                  value={newAccount.targetBalance}
                  onChange={e => setNewAccount(current => ({ ...current, targetBalance: e.target.value }))}
                />
              </label>

              <label>
                <FieldLabel>Price paid ($) — optional, flows to Billing</FieldLabel>
                <input
                  type="number"
                  min="0"
                  step="1"
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                  }}
                  placeholder="e.g. 149"
                  value={newAccount.pricePaid}
                  onChange={e => setNewAccount(current => ({ ...current, pricePaid: e.target.value }))}
                />
              </label>

              <label>
                <FieldLabel>Purchase date — optional</FieldLabel>
                <input
                  type="date"
                  style={{
                    ...tableInputStyle,
                    background: S2,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '6px',
                    padding: '10px 12px',
                  }}
                  value={newAccount.purchaseDate}
                  onChange={e => setNewAccount(current => ({ ...current, purchaseDate: e.target.value }))}
                />
              </label>
            </div>

            {isTemplateEval(newAccount) && (() => {
              const template = resolveEvaluationTemplate(
                newAccount.broker,
                newAccount.evaluationProgram,
                Number(newAccount.startingBalance),
                newAccount.evaluationPath,
              );
              if (!template) return null;
              const configuredDailyLoss = newAccount.dailyLossMode === 'purchase_fixed'
                ? template.optionalDailyLossLimit
                : template.dailyLossLimit || null;
              const drawdownLabel = template.drawdownType === 'static' ? 'static MLL'
                : template.drawdownType === 'intraday_trailing' ? 'intraday trailing MLL'
                : 'EOD trailing MLL';
              const ruleParts = [
                `${moneyValue(template.profitTarget)} target`,
                `${moneyValue(template.maxDrawdown)} ${drawdownLabel}`,
                template.maxContracts ? `${template.maxContracts} contracts` : null,
                template.maxMicros ? `${template.maxMicros} micros` : null,
                template.consistencyLimitPct != null ? `${template.consistencyLimitPct}% consistency` : 'no consistency rule',
                template.minimumTradingDays ? `minimum ${template.minimumTradingDays} days` : 'no minimum days',
                configuredDailyLoss ? `${moneyValue(configuredDailyLoss)} daily loss limit` : null,
              ].filter(Boolean);
              return (
                <div style={{ marginTop: 14, padding: '12px 14px', border: `1px solid ${BORDER}`, background: S2, borderRadius: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <strong style={{ fontSize: 11, color: T1 }}>Rules that will be applied</strong>
                    <span style={{ fontSize: 9, color: '#34d399' }}>Verified {template.verifiedAt ? new Date(template.verifiedAt).toLocaleDateString() : ''}</span>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: T3, lineHeight: 1.6 }}>
                    {ruleParts.join(' · ')}
                  </p>
                  {template.sourceUrl && <a href={template.sourceUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 7, color: '#60a5fa', fontSize: 9 }}>Check official {template.firm} source</a>}
                </div>
              );
            })()}

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
                className="settings-primary-action"
                style={{ fontSize: '12px', padding: '7px 14px' }}
              >
                Save Account
              </button>
            </div>
          </div>
        </div>
        , document.body
      )}

      {billingOffer && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center px-4">
          <button
            type="button"
            aria-label="Dismiss billing prompt"
            onClick={() => setBillingOffer(null)}
            className="absolute inset-0 bg-black/70"
          />
          <div
            style={{
              position: 'relative',
              width: 'min(440px, 100%)',
              borderRadius: '10px',
              border: `1px solid ${BORDER}`,
              background: S1,
              boxShadow: '0 28px 80px rgba(2,6,23,0.5)',
              padding: '18px',
            }}
          >
            <p style={{ fontSize: '15px', fontWeight: 600, color: T1 }}>Track this account in Billing?</p>
            <p style={{ marginTop: '6px', fontSize: '12px', color: T3, lineHeight: 1.6 }}>
              Add {billingOffer.firm} {billingOffer.sizeLabel} to the Billing ledger to track its cost, resets, and ROI.
              {billingOffer.template?.priceAmount != null && (
                <> Purchase price {moneyValue(billingOffer.template.priceAmount)}
                  {billingOffer.template.priceCadence === 'monthly' ? '/month' : ''} will be pre-filled.</>
              )}
              {billingOffer.template && billingOffer.template.priceAmount == null && (
                <> No verified price for this program, you can add the cost in Billing.</>
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBillingOffer(null)}
                className="btn-secondary"
                style={{ fontSize: '12px', padding: '7px 14px' }}
              >
                Not now
              </button>
              <button
                type="button"
                onClick={addOfferToBilling}
                className="settings-primary-action"
                style={{ fontSize: '12px', padding: '7px 14px' }}
              >
                Add to Billing
              </button>
            </div>
          </div>
        </div>
        , document.body
      )}
    </div>
  );
}




