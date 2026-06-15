import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry } from '../store/types.js';
import { pushToast } from '../store/toastStore.js';
import { useTrades } from '../hooks/useTrades.js';
import { lookupContract } from '../constants/futuresContracts.js';
import { buildScannerAssets, inferSymbolFromFileName, inferTradeDateFromFileName, normalizeResolvedSymbol } from '../utils/tradeScannerPipeline.js';
import { getTimeZoneParts } from '../utils/calendarTime.js';
import { scanChart } from '../utils/scanChart.js';
import { uploadScreenshot } from '../utils/uploadScreenshot.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';
import CSVImportModal from '../components/common/CSVImportModal.js';
import ScannerDropZone from '../components/scanner/ScannerDropZone.js';
import DatePicker from '../components/common/DatePicker.js';
import './TradeJournal.css';

type RuleState = 'ok' | 'fail' | 'unchecked';
type EmotionState = 'neutral' | 'green' | 'amber' | 'red';
type TradeResult = 'win' | 'loss' | 'open' | 'be';
type TradeDirection = 'LONG' | 'SHORT';
type DayFilter = 'all' | 'win' | 'loss' | 'untagged';

interface JournalTrade {
  id: string;
  date?: string;
  symbol: string;
  direction: TradeDirection;
  entryTime: string;
  exitTime: string;
  durationMinutes?: number | null;
  entryPrice: number;
  exitPrice: number;
  entry?: number;
  exit?: number;
  sl?: number;
  tp?: number;
  priceLevelsSource?: 'ai' | 'manual';
  priceLevelsEdited?: boolean;
  breakevenRestore?: {
    exit?: number;
    exitPrice: number;
    pnlOverride?: number;
  };
  accountId?: string;
  accountIds?: string[];
  contracts: number;
  rr: number;
  pnl: number;
  pnlOverride?: number;
  commission?: number;
  result: TradeResult;
  screenshotUrl?: string;
  supportingImages?: string[];
  reflection?: {
    thesis: string;
    execution: string;
    adjustment: string;
    processGrade: number;
    followedPlan: boolean | null;
  };
  preEntry?: {
    confidenceAtEntry: number;
    emotionalState: string;
    hesitated: boolean | null;
    hesitationReason: string;
  };
  thesis?: {
    setup: string;
    invalidation: string;
    asymmetry: string;
    setupType: string;
  };
  executionReview?: {
    enteredAtLevel: boolean | null;
    waitedForConfirmation: boolean | null;
    correctSize: boolean | null;
    exitedAtPlan: boolean | null;
    movedStopCorrectly: boolean | null;
    resistedEarlyExit: boolean | null;
    note: string;
  };
  psychologyRatings?: {
    setupQuality: number;
    discipline: number;
    execution: number;
    patience: number;
    riskManagement: number;
    emotionalControl: number;
    notes: Record<string, string>;
  };
  behavioralFlags?: string[];
  stateOfMind?: Array<{ label: string; valence: 'positive' | 'caution' | 'negative' }>;
  processScore?: number;
  confluences?: string[];
  timeframe?: string;
}

interface JournalEntry {
  id: string;
  date: string;
  account?: string;
  accountIds?: string[];
  scannedImageUrl?: string;
  trades: JournalTrade[];
  screenshots: string[];
  reflection: {
    pre: string;
    post: string;
    lessons: string;
  };
  rules: Array<{ text: string; state: RuleState }>;
  psychology: {
    setupQuality: number;
    discipline: number;
    execution: number;
  };
  emotions: Array<{ label: string; state: EmotionState }>;
  dailyReflection?: {
    pre: string;
    post: string;
    lessons: string;
    bias: 'bullish' | 'neutral' | 'bearish' | null;
    newsRisk: 'clear' | 'caution' | 'avoid' | null;
    sessionTarget: number | null;
    sessionGrade: string | null;
    marketRespectedBias: boolean | null;
    lessonCategory: string | null;
  };
  physicalState?: {
    sleep: number;
    sleepHours: number;
    stress: number;
    energy: number;
    distractions: string[];
    environment: string;
  };
}

const DEFAULT_RULES = [
  'Followed daily loss limit',
  'Only took planned trades',
  'Respected position sizing rules',
  'No trading during lunch window',
  'Stopped after 3 consecutive losses',
];

const STATE_OF_MIND_TAGS = {
  positive: ['In the zone', 'Calm', 'Focused', 'Patient', 'Confident', 'Clear-headed', 'Decisive', 'Composed'],
  caution: ['Slightly anxious', 'Slightly rushed', 'Mildly frustrated', 'Uncertain', 'Distracted', 'Tired', 'Impatient'],
  negative: ['Revenge trading', 'FOMO', 'Overconfident', 'Fearful', 'Reckless', 'Frustrated', 'Desperate', 'Emotionally numb'],
} as const;

const TAGS = Array.from(new Set(Object.values(STATE_OF_MIND_TAGS).flat()));

function getTodayIso(tz?: string) {
  if (tz) return getTimeZoneParts(new Date(), tz).date;
  return new Date().toISOString().split('T')[0];
}

function getNowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function addSecondsToTime(time: string, seconds?: number | null): string | null {
  if (!Number.isFinite(seconds ?? NaN) || (seconds ?? 0) < 0) return null;
  const [hText, mText] = time.split(':');
  const hours = Number(hText);
  const minutes = Number(mText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const totalMinutes = (hours * 60) + minutes + Math.round((seconds ?? 0) / 60);
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const outHours = Math.floor(normalized / 60).toString().padStart(2, '0');
  const outMinutes = (normalized % 60).toString().padStart(2, '0');
  return `${outHours}:${outMinutes}`;
}

function minutesBetweenTimes(start: string, end: string): number | null {
  const [startHours, startMinutes] = start.split(':').map(Number);
  const [endHours, endMinutes] = end.split(':').map(Number);
  if (!Number.isFinite(startHours) || !Number.isFinite(startMinutes) || !Number.isFinite(endHours) || !Number.isFinite(endMinutes)) {
    return null;
  }
  const startTotal = (startHours * 60) + startMinutes;
  const endTotal = (endHours * 60) + endMinutes;
  let diff = endTotal - startTotal;
  if (diff < 0) diff += 24 * 60;
  if (diff <= 0) return null;
  return diff;
}

function formatDurationLabel(minutes?: number | null): string {
  if (!Number.isFinite(minutes ?? NaN) || (minutes ?? 0) <= 0) return '—';
  const m = Math.round(minutes ?? 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function resolveTradeDurationMinutes(trade?: Partial<JournalTrade> | null): number | null {
  if (!trade) return null;
  const record = trade as Partial<JournalTrade> & {
    duration?: number | null;
    trade_length_seconds?: number | null;
  };
  if (typeof record.durationMinutes === 'number' && Number.isFinite(record.durationMinutes)) {
    return record.durationMinutes;
  }
  if (typeof record.duration === 'number' && Number.isFinite(record.duration)) {
    return record.duration;
  }
  if (typeof record.trade_length_seconds === 'number' && Number.isFinite(record.trade_length_seconds)) {
    return Math.max(1, Math.round(record.trade_length_seconds / 60));
  }
  return null;
}

function parseDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

function formatMonth(value: Date) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(value);
}

function formatDateTitle(value: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parseDate(value));
}

function formatWeekday(value: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(parseDate(value)).toUpperCase();
}

function formatCurrency(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });
}

function formatSignedCurrency(value: number) {
  const abs = formatCurrency(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return formatCurrency(0);
}

function toPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function toR(value: number) {
  return `${value.toFixed(2)}R`;
}

function formatCurrencyFixed(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parsePrice(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function normalizeConfluences(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  const deduped = new Set<string>();
  const normalized: string[] = [];
  rawValues.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const cleaned = entry.trim().replace(/\s+/g, ' ');
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) return;
    deduped.add(key);
    normalized.push(cleaned);
  });

  return normalized;
}

function getTradeEntry(trade: JournalTrade): number | undefined {
  return parsePrice(trade.entry) ?? parsePrice(trade.entryPrice);
}

function getTradeExit(trade: JournalTrade): number | undefined {
  return parsePrice(trade.exit) ?? parsePrice(trade.exitPrice);
}

function computeTradePnl(trade: JournalTrade, entry?: number, exit?: number): number {
  if (entry === undefined || exit === undefined) return 0;
  const pointValue = lookupContract(trade.symbol)?.point_value ?? 1;
  const contracts = trade.contracts > 0 ? trade.contracts : 1;
  return trade.direction === 'LONG'
    ? (exit - entry) * contracts * pointValue
    : (entry - exit) * contracts * pointValue;
}

function computeTradeRr(trade: JournalTrade, entry?: number): number {
  if (entry === undefined || trade.sl === undefined || trade.tp === undefined) return 0;
  const risk = trade.direction === 'LONG' ? entry - trade.sl : trade.sl - entry;
  const reward = trade.direction === 'LONG' ? trade.tp - entry : entry - trade.tp;
  if (risk <= 0 || reward <= 0) return 0;
  return reward / risk;
}

function withTradeDerivedValues(trade: JournalTrade): JournalTrade {
  const entry = getTradeEntry(trade);
  const exit = getTradeExit(trade);
  const calcPnl = computeTradePnl(trade, entry, exit);
  const pnl = typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride)
    ? trade.pnlOverride
    : calcPnl;
  const rr = computeTradeRr(trade, entry);
  const result: TradeResult = exit === undefined ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be';
  return {
    ...trade,
    pnl,
    rr,
    result,
  };
}

function getTradeDateValue(trade: JournalTrade | null | undefined, fallbackDate: string): string {
  if (!trade) return fallbackDate;
  if (typeof trade.date === 'string' && isValidIsoDate(trade.date)) return trade.date;
  return fallbackDate;
}

function shiftMonth(current: Date, delta: number) {
  return new Date(current.getFullYear(), current.getMonth() + delta, 1);
}

function inMonth(dateValue: string, monthValue: Date) {
  const parsed = parseDate(dateValue);
  return parsed.getFullYear() === monthValue.getFullYear() && parsed.getMonth() === monthValue.getMonth();
}


function getRulesTemplate() {
  if (typeof window === 'undefined') return DEFAULT_RULES;
  try {
    const raw = window.localStorage.getItem('flyxa_checklist');
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_RULES;
    const cleaned = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return cleaned.length ? cleaned : DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

function createEmptyEntry(date: string, rulesTemplate: string[]): JournalEntry {
  return {
    id: crypto.randomUUID(),
    date,
    trades: [],
    screenshots: ['', '', ''],
    reflection: {
      pre: '',
      post: '',
      lessons: '',
    },
    rules: rulesTemplate.map(text => ({ text, state: 'unchecked' })),
    psychology: {
      setupQuality: 0,
      discipline: 0,
      execution: 0,
    },
    emotions: TAGS.map(label => ({ label, state: 'neutral' })),
  };
}

/** Converts a 0-100 process score to a letter grade. Returns '—' when score is 0 (no data). */
function scoreToGradeLetter(score: number): string {
  if (score === 0) return '—';
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B+';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C+';
  if (score >= 30) return 'C';
  return 'D';
}

/** CSS class suffix for a grade letter (e.g. 'A+' → 'Aplus'). */
function gradeCssKey(letter: string): string {
  return letter.replace('+', 'plus').replace('—', 'dash');
}

function computeEntryStats(entry: JournalEntry) {
  const pnl = entry.trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = entry.trades.filter(trade => trade.result === 'win').length;
  const losses = entry.trades.filter(trade => trade.result === 'loss').length;
  const tradeCount = entry.trades.length;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
  const avgRR = tradeCount ? entry.trades.reduce((sum, trade) => sum + trade.rr, 0) / tradeCount : 0;
  const okCount = entry.rules.filter(rule => rule.state === 'ok').length;
  const failCount = entry.rules.filter(rule => rule.state === 'fail').length;
  const evaluatedRules = okCount + failCount;
  const rulePassPct = evaluatedRules ? (okCount / evaluatedRules) * 100 : 0;
  const discipline = entry.psychology.discipline;
  const tradesWithGrade = entry.trades.filter(t => (t.reflection?.processGrade ?? 0) > 0);
  const avgProcessGrade = tradesWithGrade.length > 0
    ? tradesWithGrade.reduce((sum, t) => sum + t.reflection!.processGrade, 0) / tradesWithGrade.length
    : null;
  const effectiveDiscipline = avgProcessGrade !== null
    ? discipline * 0.7 + avgProcessGrade * 0.3
    : discipline;
  let grade = 'C';
  if (effectiveDiscipline >= 4 && rulePassPct >= 80) grade = 'A+';
  else if (effectiveDiscipline >= 3.5 && rulePassPct >= 70) grade = 'A';
  else if (effectiveDiscipline >= 3 && rulePassPct >= 60) grade = 'B+';
  else if (effectiveDiscipline >= 2.5 && rulePassPct >= 50) grade = 'B';
  else if (effectiveDiscipline >= 2) grade = 'C+';
  return { pnl, wins, losses, tradeCount, winRate, avgRR, grade };
}

function findBestDay(entries: JournalEntry[]) {
  if (!entries.length) return null;
  let best = -Infinity;
  entries.forEach(entry => {
    const pnl = computeEntryStats(entry).pnl;
    if (pnl > best) best = pnl;
  });
  return Number.isFinite(best) ? best : null;
}

function fromLegacyRecords(value: unknown[], rulesTemplate: string[]): JournalEntry[] {
  const grouped = new Map<string, JournalEntry>();
  value.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (typeof record.date !== 'string') return;
    const date = record.date;
    if (!grouped.has(date)) {
      grouped.set(date, createEmptyEntry(date, rulesTemplate));
    }
    const entry = grouped.get(date);
    if (!entry) return;

    const symbol = typeof record.symbol === 'string' && record.symbol.trim() ? record.symbol.trim().toUpperCase() : 'NQ';
    const direction: TradeDirection = record.direction === 'Short' ? 'SHORT' : 'LONG';
    const entryPrice = typeof record.entry_price === 'number' ? record.entry_price : 0;
    const exitPrice = typeof record.exit_price === 'number' ? record.exit_price : entryPrice;
    const contracts = typeof record.contract_size === 'number' && record.contract_size > 0 ? record.contract_size : 1;
    const pointValue = typeof record.point_value === 'number' && record.point_value > 0
      ? record.point_value
      : (lookupContract(symbol)?.point_value ?? 1);
    const pnl = direction === 'LONG'
      ? (exitPrice - entryPrice) * pointValue * contracts
      : (entryPrice - exitPrice) * pointValue * contracts;
    const result: TradeResult = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'open';
    const rr = typeof record.sl_price === 'number' && Number.isFinite(record.sl_price) && record.sl_price !== entryPrice
      ? Math.abs((direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) / Math.abs(entryPrice - record.sl_price))
      : 0;

    const trade: JournalTrade = {
      id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
      date,
      symbol,
      direction,
      entryTime: typeof record.time === 'string' ? record.time.slice(0, 5) : '09:30',
      exitTime: typeof record.time === 'string' ? record.time.slice(0, 5) : '09:45',
      durationMinutes:
        typeof record.trade_length_seconds === 'number' && Number.isFinite(record.trade_length_seconds)
          ? Math.max(1, Math.round(record.trade_length_seconds / 60))
          : null,
      entryPrice,
      exitPrice,
      entry: entryPrice > 0 ? entryPrice : undefined,
      exit: exitPrice > 0 ? exitPrice : undefined,
      sl: typeof record.sl_price === 'number' && Number.isFinite(record.sl_price) ? record.sl_price : undefined,
      tp: typeof record.tp_price === 'number' && Number.isFinite(record.tp_price) ? record.tp_price : undefined,
      priceLevelsSource: 'manual',
      priceLevelsEdited: true,
      contracts,
      rr,
      pnl,
      result,
      screenshotUrl: typeof record.screenshot === 'string' ? record.screenshot : undefined,
      confluences: normalizeConfluences(record.confluences),
    };
    entry.trades.push(withTradeDerivedValues(trade));
    if (trade.screenshotUrl && !entry.scannedImageUrl) entry.scannedImageUrl = trade.screenshotUrl;
  });
  return Array.from(grouped.values()).sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeEntries(value: unknown[], rulesTemplate: string[]): JournalEntry[] {
  if (!Array.isArray(value)) return [];
  const looksModern = value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return typeof record.date === 'string' && Array.isArray(record.trades);
  });
  if (!looksModern) return fromLegacyRecords(value, rulesTemplate);

  const normalized = value
    .map(item => {
      const record = item as Record<string, unknown>;
      const date = typeof record.date === 'string' ? record.date : getTodayIso();
      const tradesRaw = Array.isArray(record.trades) ? record.trades : [];
      const trades: JournalTrade[] = tradesRaw.map(tradeRaw => {
        const trade = tradeRaw as Record<string, unknown>;
        const symbol = typeof trade.symbol === 'string' ? trade.symbol : 'NQ';
        const direction: TradeDirection = trade.direction === 'SHORT' ? 'SHORT' : 'LONG';
        const entryPrice = typeof trade.entryPrice === 'number' && trade.entryPrice > 0 ? trade.entryPrice : typeof trade.entry === 'number' && trade.entry > 0 ? trade.entry : 0;
        const exitPrice = typeof trade.exitPrice === 'number' && trade.exitPrice > 0 ? trade.exitPrice : typeof trade.exit === 'number' && trade.exit > 0 ? trade.exit : 0;
        const contracts = typeof trade.contracts === 'number' && trade.contracts > 0 ? trade.contracts : 1;
        const pnl = typeof trade.pnl === 'number' ? trade.pnl : 0;
        const result: TradeResult = trade.result === 'win' || trade.result === 'loss' || trade.result === 'open' || trade.result === 'be'
          ? trade.result
          : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'open';
        const tradeRef = (() => {
          const r = trade.reflection as Record<string, unknown> | undefined;
          if (!r || typeof r !== 'object') return undefined;
          return {
            thesis: typeof r.thesis === 'string' ? r.thesis : '',
            execution: typeof r.execution === 'string' ? r.execution : '',
            adjustment: typeof r.adjustment === 'string' ? r.adjustment : '',
            processGrade: typeof r.processGrade === 'number' ? r.processGrade : 0,
            followedPlan: r.followedPlan === true || r.followedPlan === false ? r.followedPlan : null,
          };
        })();
        const normalizedTrade: JournalTrade = {
          id: typeof trade.id === 'string' ? trade.id : crypto.randomUUID(),
          date: typeof trade.date === 'string' && isValidIsoDate(trade.date) ? trade.date : date,
          symbol,
          direction,
          entryTime: typeof trade.entryTime === 'string' ? trade.entryTime : typeof trade.time === 'string' ? trade.time : '09:30',
          exitTime: typeof trade.exitTime === 'string' ? trade.exitTime : '09:45',
          durationMinutes: resolveTradeDurationMinutes(trade),
          entryPrice,
          exitPrice,
          entry: parsePrice(trade.entry) ?? parsePrice(entryPrice),
          exit: parsePrice(trade.exit) ?? parsePrice(exitPrice),
          sl: typeof trade.sl === 'number' && Number.isFinite(trade.sl) && trade.sl > 0 ? trade.sl : undefined,
          tp: typeof trade.tp === 'number' && Number.isFinite(trade.tp) && trade.tp > 0 ? trade.tp : undefined,
          priceLevelsSource: trade.priceLevelsSource === 'ai' ? 'ai' : 'manual',
          priceLevelsEdited: trade.priceLevelsEdited === true,
          breakevenRestore: (() => {
            const restore = trade.breakevenRestore as Record<string, unknown> | undefined;
            if (!restore || typeof restore !== 'object') return undefined;
            const exit = typeof restore.exit === 'number' && Number.isFinite(restore.exit) ? restore.exit : undefined;
            const exitPrice = typeof restore.exitPrice === 'number' && Number.isFinite(restore.exitPrice) ? restore.exitPrice : 0;
            const pnlOverride = typeof restore.pnlOverride === 'number' && Number.isFinite(restore.pnlOverride) ? restore.pnlOverride : undefined;
            return { exit, exitPrice, pnlOverride };
          })(),
          contracts,
          rr: typeof trade.rr === 'number' ? trade.rr : 0,
          pnl,
          result,
          screenshotUrl: typeof trade.screenshotUrl === 'string' ? trade.screenshotUrl : typeof trade.scannedImageUrl === 'string' ? trade.scannedImageUrl : undefined,
          supportingImages: Array.isArray(trade.supportingImages)
            ? (trade.supportingImages as unknown[]).filter((u): u is string => typeof u === 'string')
            : undefined,
          accountId: typeof trade.accountId === 'string' && trade.accountId ? trade.accountId : typeof trade.account === 'string' && trade.account ? trade.account : undefined,
          accountIds: Array.from(new Set([
            ...(Array.isArray(trade.accountIds) ? trade.accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : []),
            typeof trade.accountId === 'string' && trade.accountId ? trade.accountId : typeof trade.account === 'string' && trade.account ? trade.account : '',
          ].filter(Boolean))),
          reflection: tradeRef,
          preEntry: trade.preEntry && typeof trade.preEntry === 'object' ? trade.preEntry as JournalTrade['preEntry'] : undefined,
          thesis: trade.thesis && typeof trade.thesis === 'object' ? trade.thesis as JournalTrade['thesis'] : undefined,
          executionReview: trade.executionReview && typeof trade.executionReview === 'object' ? trade.executionReview as JournalTrade['executionReview'] : undefined,
          psychologyRatings: trade.psychologyRatings && typeof trade.psychologyRatings === 'object' ? trade.psychologyRatings as JournalTrade['psychologyRatings'] : undefined,
          behavioralFlags: Array.isArray(trade.behavioralFlags) ? trade.behavioralFlags as string[] : undefined,
          stateOfMind: Array.isArray(trade.stateOfMind)
            ? trade.stateOfMind
              .map((item) => {
                if (typeof item === 'string') return { label: item, valence: 'caution' as const };
                if (!item || typeof item !== 'object') return null;
                const value = item as Record<string, unknown>;
                const label = typeof value.label === 'string' ? value.label : '';
                const valence: 'positive' | 'negative' | 'caution' =
                  value.valence === 'positive' || value.valence === 'negative' || value.valence === 'caution'
                  ? value.valence as 'positive' | 'negative' | 'caution'
                  : 'caution';
                return label ? { label, valence } : null;
              })
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
            : undefined,
          processScore: typeof trade.processScore === 'number' ? trade.processScore : undefined,
          confluences: normalizeConfluences(trade.confluences),
          timeframe: typeof trade.timeframe === 'string' && trade.timeframe ? trade.timeframe : undefined,
          pnlOverride: typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride) ? trade.pnlOverride : undefined,
          commission: typeof trade.commission === 'number' && Number.isFinite(trade.commission) && trade.commission >= 0 ? trade.commission : undefined,
        };
        return withTradeDerivedValues(normalizedTrade);
      });

      const reflectionRaw = (record.reflection ?? {}) as Record<string, unknown>;
      const reflection = {
        pre: typeof reflectionRaw.pre === 'string' ? reflectionRaw.pre : '',
        post: typeof reflectionRaw.post === 'string' ? reflectionRaw.post : '',
        lessons: typeof reflectionRaw.lessons === 'string' ? reflectionRaw.lessons : '',
      };

      const rulesRaw = Array.isArray(record.rules) ? record.rules : [];
      const rules = rulesRaw.length
        ? rulesRaw.map(rule => {
          const valueRule = rule as Record<string, unknown>;
          const state: RuleState = valueRule.state === 'ok' || valueRule.state === 'fail' || valueRule.state === 'unchecked'
            ? valueRule.state
            : 'unchecked';
          return {
            text: typeof valueRule.text === 'string' ? valueRule.text : '',
            state,
          };
        }).filter(rule => rule.text)
        : rulesTemplate.map(text => ({ text, state: 'unchecked' as RuleState }));

      const psychologyRaw = (record.psychology ?? {}) as Record<string, unknown>;
      const psychology = {
        setupQuality: typeof psychologyRaw.setupQuality === 'number' ? psychologyRaw.setupQuality : 0,
        discipline: typeof psychologyRaw.discipline === 'number' ? psychologyRaw.discipline : 0,
        execution: typeof psychologyRaw.execution === 'number' ? psychologyRaw.execution : 0,
      };

      const emotionsRaw = Array.isArray(record.emotions) ? record.emotions : [];
      const emotionMap = new Map<string, EmotionState>();
      emotionsRaw.forEach(emotion => {
        const valueEmotion = emotion as Record<string, unknown>;
        if (typeof valueEmotion.label !== 'string') return;
        const state = valueEmotion.state === 'green' || valueEmotion.state === 'amber' || valueEmotion.state === 'red' || valueEmotion.state === 'neutral'
          ? valueEmotion.state
          : 'neutral';
        emotionMap.set(valueEmotion.label, state);
      });
      // Backward compatibility: recover day-level tags from older trade-level stateOfMind data.
      trades.forEach((trade) => {
        (trade.stateOfMind ?? []).forEach((tag) => {
          const mappedState: EmotionState = tag.valence === 'positive'
            ? 'green'
            : tag.valence === 'negative'
              ? 'red'
              : 'amber';
          if (!emotionMap.has(tag.label) || emotionMap.get(tag.label) === 'neutral') {
            emotionMap.set(tag.label, mappedState);
          }
        });
      });
      const emotions = TAGS.map(label => ({
        label,
        state: emotionMap.get(label) ?? 'neutral',
      }));

      const screenshotsRaw = Array.isArray(record.screenshots) ? record.screenshots : [];
      const screenshots = [0, 1, 2].map(index => typeof screenshotsRaw[index] === 'string' ? screenshotsRaw[index] : '');

      return {
        id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
        date,
        account: typeof record.account === 'string' && record.account ? record.account : undefined,
        accountIds: Array.isArray(record.accountIds)
          ? (record.accountIds as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
          : undefined,
        scannedImageUrl: typeof record.scannedImageUrl === 'string' ? record.scannedImageUrl : undefined,
        trades,
        screenshots,
        reflection,
        rules,
        psychology,
        emotions,
        dailyReflection: record.dailyReflection && typeof record.dailyReflection === 'object' ? record.dailyReflection as JournalEntry['dailyReflection'] : undefined,
        physicalState: record.physicalState && typeof record.physicalState === 'object' ? record.physicalState as JournalEntry['physicalState'] : undefined,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // Auto-correct: move any trade whose date doesn't match its parent entry to the right entry.
  const hasMismatch = normalized.some(entry => entry.trades.some(trade => trade.date !== entry.date));
  if (!hasMismatch) return normalized;

  const byDate = new Map<string, JournalEntry>(normalized.map(e => [e.date, { ...e, trades: [] }]));
  for (const entry of normalized) {
    for (const trade of entry.trades) {
      const tradeDate = trade.date ?? entry.date;
      if (!byDate.has(tradeDate)) byDate.set(tradeDate, createEmptyEntry(tradeDate, rulesTemplate));
      byDate.get(tradeDate)!.trades.push({ ...trade, date: tradeDate });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

interface PriceLevelsBlockProps {
  trade: JournalTrade;
  onMutate: (fields: Partial<JournalTrade>) => void;
}

interface ContractSizingBlockProps {
  trade: JournalTrade;
  onMutate: (fields: Partial<JournalTrade>) => void;
}

function DirectionSelectorBlock({ trade, onMutate }: ContractSizingBlockProps) {
  const options: Array<{ value: TradeDirection; label: string }> = [
    { value: 'LONG', label: 'Long' },
    { value: 'SHORT', label: 'Short' },
  ];

  return (
    <div className="tj-direction-card">
      <div className="tj-size-inline">
        <span className="tj-size-title">DIRECTION</span>
        <span className="tj-size-caption">Manual trade</span>
      </div>
      <div className="tj-direction-toggle" role="group" aria-label="Trade direction">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className={`tj-direction-btn ${option.value.toLowerCase()} ${trade.direction === option.value ? 'active' : ''}`}
            onClick={() => onMutate({ direction: option.value, priceLevelsSource: 'manual', priceLevelsEdited: true })}
            aria-pressed={trade.direction === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ContractSizingBlock({ trade, onMutate }: ContractSizingBlockProps) {
  const [localContracts, setLocalContracts] = useState(String(Math.max(1, Math.round(trade.contracts || 1))));

  useEffect(() => {
    setLocalContracts(String(Math.max(1, Math.round(trade.contracts || 1))));
  }, [trade.id, trade.contracts]);

  const commitContracts = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    const nextContracts = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    setLocalContracts(String(nextContracts));
    onMutate({ contracts: nextContracts });
  };

  const nudgeContracts = (delta: number) => {
    const parsed = Number.parseInt(localContracts, 10);
    const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    const next = Math.max(1, current + delta);
    setLocalContracts(String(next));
    onMutate({ contracts: next });
  };

  return (
    <div className="tj-size-card">
      <div className="tj-size-inline">
        <span className="tj-size-title">CONTRACT SIZING</span>
        <span className="tj-size-caption">Per trade</span>
      </div>
      <div className="tj-size-body">
        <button
          type="button"
          className="tj-size-btn"
          onClick={() => nudgeContracts(-1)}
          aria-label="Decrease contracts"
        >
          -
        </button>
        <input
          className="tj-size-input"
          type="number"
          min={1}
          step={1}
          value={localContracts}
          onChange={event => setLocalContracts(event.target.value)}
          onBlur={event => commitContracts(event.target.value)}
          aria-label="Contracts"
        />
        <button
          type="button"
          className="tj-size-btn"
          onClick={() => nudgeContracts(1)}
          aria-label="Increase contracts"
        >
          +
        </button>
      </div>
    </div>
  );
}

const ACCOUNT_STATUS_DOT: Record<string, string> = {
  Eval: '#60a5fa',
  Funded: '#fbbf24',
  Live: '#34d399',
  Blown: '#fca5a5',
};

function AccountSelectorBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (fields: Partial<JournalTrade>) => void }) {
  const { accounts } = useAppSettings();
  const selectedAccountIds = Array.from(new Set([...(trade.accountIds ?? []), trade.accountId].filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const toggleAccount = (accountId: string, checked: boolean) => {
    const nextIds = checked
      ? Array.from(new Set([...selectedAccountIds, accountId]))
      : selectedAccountIds.filter(id => id !== accountId);
    onMutate({ accountIds: nextIds, accountId: nextIds[0], account: nextIds[0] } as Partial<JournalTrade>);
  };

  return (
    <div className="tj-account-card">
      <span className="tj-size-title">ACCOUNTS</span>
      <div className="tj-account-check-list">
        {accounts.filter(account =>
          account.id !== DEFAULT_ACCOUNT_ID &&
          (!account.archived || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Blown'   || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Passed'  || selectedAccountIds.includes(account.id))
        ).map(account => {
          const isInactive = account.archived || account.status === 'Blown' || account.status === 'Passed';
          const statusLabel = account.archived ? ' (Archived)' : account.status === 'Blown' ? ' (Blown)' : account.status === 'Passed' ? ' (Passed)' : '';
          return (
            <label
              key={account.id}
              className={`tj-account-check ${selectedAccountIds.includes(account.id) ? 'selected' : ''} ${isInactive ? 'opacity-50' : ''}`}
              title={account.archived ? 'Archived account' : account.status === 'Passed' ? 'Passed accounts cannot be allocated to new trades' : undefined}
            >
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(account.id)}
                onChange={event => toggleAccount(account.id, event.target.checked)}
                disabled={isInactive}
              />
              <span>{account.name}{statusLabel}</span>
            </label>
          );
        })}
      </div>
      {(() => {
        const selected = accounts.find(a => a.id === selectedAccountIds[0]);
        if (!selected) return null;
        const dotColor = ACCOUNT_STATUS_DOT[selected.status] ?? '#888';
        return (
          <span className="tj-account-dot" style={{ background: dotColor }} title={selected.status} />
        );
      })()}
    </div>
  );
}

function BlankDayAccountSelector({ entry, onMutate }: { entry: JournalEntry; onMutate: (fields: Partial<JournalEntry>) => void }) {
  const { accounts } = useAppSettings();
  const selectedAccountIds = Array.from(new Set([
    ...(entry.accountIds ?? []),
    ...(entry.account ? [entry.account] : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)));

  const toggleAccount = (accountId: string, checked: boolean) => {
    const nextIds = checked
      ? Array.from(new Set([...selectedAccountIds, accountId]))
      : selectedAccountIds.filter(id => id !== accountId);
    onMutate({ accountIds: nextIds, account: nextIds[0] });
  };

  return (
    <div className="tj-account-card">
      <span className="tj-size-title">ACCOUNTS</span>
      <div className="tj-account-check-list">
        {accounts.filter(account =>
          account.id !== DEFAULT_ACCOUNT_ID &&
          (!account.archived || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Blown'  || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Passed' || selectedAccountIds.includes(account.id))
        ).map(account => {
          const isInactive = account.archived || account.status === 'Blown' || account.status === 'Passed';
          const statusLabel = account.archived ? ' (Archived)' : account.status === 'Blown' ? ' (Blown)' : account.status === 'Passed' ? ' (Passed)' : '';
          return (
            <label
              key={account.id}
              className={`tj-account-check ${selectedAccountIds.includes(account.id) ? 'selected' : ''} ${isInactive ? 'opacity-50' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(account.id)}
                onChange={e => toggleAccount(account.id, e.target.checked)}
                disabled={isInactive}
              />
              <span>{account.name}{statusLabel}</span>
            </label>
          );
        })}
      </div>
      {(() => {
        const selected = accounts.find(a => a.id === selectedAccountIds[0]);
        if (!selected) return null;
        const dotColor = ACCOUNT_STATUS_DOT[selected.status] ?? '#888';
        return <span className="tj-account-dot" style={{ background: dotColor }} title={selected.status} />;
      })()}
    </div>
  );
}

function PriceLevelsBlock({ trade, onMutate }: PriceLevelsBlockProps) {
  const entry = getTradeEntry(trade);
  const exit = getTradeExit(trade);
  const [local, setLocal] = useState({
    entry: entry !== undefined ? String(entry) : '',
    exit: exit !== undefined ? String(exit) : '',
    sl: trade.sl != null ? String(trade.sl) : '',
    tp: trade.tp != null ? String(trade.tp) : '',
  });
  const [pnlEditMode, setPnlEditMode] = useState(false);
  const [pnlEditValue, setPnlEditValue] = useState('');
  const [commissionLocal, setCommissionLocal] = useState(
    typeof trade.commission === 'number' && trade.commission > 0 ? String(trade.commission) : ''
  );

  useEffect(() => {
    setLocal({
      entry: getTradeEntry(trade) !== undefined ? String(getTradeEntry(trade)) : '',
      exit: getTradeExit(trade) !== undefined ? String(getTradeExit(trade)) : '',
      sl: trade.sl != null ? String(trade.sl) : '',
      tp: trade.tp != null ? String(trade.tp) : '',
    });
    setPnlEditMode(false);
    setCommissionLocal(typeof trade.commission === 'number' && trade.commission > 0 ? String(trade.commission) : '');
  }, [trade.id, trade.entry, trade.entryPrice, trade.exit, trade.exitPrice, trade.sl, trade.tp, trade.commission]);

  const parseLocal = (value: string): number | undefined => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  const entryValue = parseLocal(local.entry);
  const exitValue = parseLocal(local.exit);
  const slValue = parseLocal(local.sl);
  const tpValue = parseLocal(local.tp);

  const commit = (field: 'entry' | 'exit' | 'sl' | 'tp', value: string) => {
    const parsed = parseLocal(value);
    const nextFields: Partial<JournalTrade> = {
      priceLevelsSource: 'manual',
      priceLevelsEdited: true,
    };
    if (field === 'entry') {
      nextFields.entry = parsed;
      nextFields.entryPrice = parsed ?? 0;
      nextFields.breakevenRestore = undefined;
    } else if (field === 'exit') {
      nextFields.exit = parsed;
      nextFields.exitPrice = parsed ?? 0;
      nextFields.breakevenRestore = undefined;
    } else if (field === 'sl') {
      nextFields.sl = parsed;
    } else {
      nextFields.tp = parsed;
    }
    onMutate(nextFields);
  };

  const pointValue = lookupContract(trade.symbol)?.point_value ?? 1;
  const contracts = trade.contracts > 0 ? trade.contracts : 1;

  const stopDelta = entryValue !== undefined && slValue !== undefined ? Math.abs(slValue - entryValue) : null;
  const tpDelta = entryValue !== undefined && tpValue !== undefined ? Math.abs(tpValue - entryValue) : null;
  const exitDelta = entryValue !== undefined && exitValue !== undefined
    ? trade.direction === 'LONG' ? exitValue - entryValue : entryValue - exitValue
    : null;

  const netPnl = entryValue !== undefined && exitValue !== undefined
    ? trade.direction === 'LONG'
      ? (exitValue - entryValue) * contracts * pointValue
      : (entryValue - exitValue) * contracts * pointValue
    : null;

  const effectivePnl = typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride)
    ? trade.pnlOverride
    : netPnl;

  const rr = (() => {
    if (entryValue === undefined || slValue === undefined || tpValue === undefined) return null;
    const risk = trade.direction === 'LONG' ? entryValue - slValue : slValue - entryValue;
    const reward = trade.direction === 'LONG' ? tpValue - entryValue : entryValue - tpValue;
    if (risk <= 0 || reward <= 0) return null;
    return reward / risk;
  })();

  const isBreakevenActive = entryValue !== undefined
    && exitValue !== undefined
    && Math.abs(exitValue - entryValue) < 0.000001
    && effectivePnl === 0;

  const handleBreakevenToggle = () => {
    if (entryValue === undefined) return;
    if (isBreakevenActive && trade.breakevenRestore) {
      const restore = trade.breakevenRestore;
      const restoredExit = restore.exit !== undefined ? String(restore.exit) : '';
      setLocal(prev => ({ ...prev, exit: restoredExit }));
      onMutate({
        exit: restore.exit,
        exitPrice: restore.exitPrice,
        pnlOverride: restore.pnlOverride,
        breakevenRestore: undefined,
        priceLevelsSource: 'manual',
        priceLevelsEdited: true,
      });
      return;
    }

    const v = String(entryValue);
    setLocal(prev => ({ ...prev, exit: v }));
    onMutate({
      exit: entryValue,
      exitPrice: entryValue,
      pnlOverride: 0,
      breakevenRestore: {
        exit: exitValue,
        exitPrice: trade.exitPrice,
        pnlOverride: trade.pnlOverride,
      },
      priceLevelsSource: 'manual',
      priceLevelsEdited: true,
    });
  };

  const sourceText = trade.priceLevelsEdited ? 'Manually set' : trade.priceLevelsSource === 'ai' ? 'AI extracted' : 'Manually set';
  const renderPointsDiff = (delta: number | null, mode: 'pos' | 'neg' | 'auto') => {
    if (delta === null) return '-';
    const isPositive = mode === 'pos' || (mode === 'auto' && delta >= 0);
    const sign = isPositive ? '+' : '-';
    return (
      <span className={`tj-pl-points ${isPositive ? 'pos' : 'neg'}`}>
        {`${sign}${Math.abs(delta).toFixed(2)} pts`}
      </span>
    );
  };

  return (
    <div className="tj-pl-card">
      <div className="tj-pl-header">
        <span className="tj-pl-title">PRICE LEVELS</span>
        <span className="tj-pl-source">{sourceText}</span>
      </div>
      <div className="tj-pl-grid">
        <div className="tj-pl-cell">
          <div className="tj-pl-label">ENTRY</div>
          <input
            className="tj-pl-input entry"
            type="number"
            step="0.25"
            value={local.entry}
            onChange={event => setLocal(prev => ({ ...prev, entry: event.target.value }))}
            onBlur={event => commit('entry', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff" aria-hidden="true">&nbsp;</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label">STOP LOSS</div>
          <input
            className="tj-pl-input sl"
            type="number"
            step="0.25"
            value={local.sl}
            onChange={event => setLocal(prev => ({ ...prev, sl: event.target.value }))}
            onBlur={event => commit('sl', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(stopDelta, 'neg')}</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label">TAKE PROFIT</div>
          <input
            className="tj-pl-input tp"
            type="number"
            step="0.25"
            value={local.tp}
            onChange={event => setLocal(prev => ({ ...prev, tp: event.target.value }))}
            onBlur={event => commit('tp', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(tpDelta, 'pos')}</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <span>EXIT</span>
            {entryValue !== undefined && (
              <button
                type="button"
                onClick={handleBreakevenToggle}
                style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: '1px solid var(--amber)',
                  background: isBreakevenActive ? 'var(--amber)' : 'transparent',
                  color: isBreakevenActive ? '#111' : 'var(--amber)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 700,
                  lineHeight: 1.3,
                  letterSpacing: '0.03em',
                  flexShrink: 0,
                }}
                title={isBreakevenActive && trade.breakevenRestore ? 'Restore previous exit' : 'Set exit to entry price (Breakeven)'}
              >
                {isBreakevenActive && trade.breakevenRestore ? '↺ BE' : 'BE'}
              </button>
            )}
          </div>
          <input
            className="tj-pl-input exit"
            type="number"
            step="0.25"
            value={local.exit}
            onChange={event => setLocal(prev => ({ ...prev, exit: event.target.value }))}
            onBlur={event => commit('exit', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(exitDelta, 'auto')}</div>
        </div>
      </div>
      <div className="tj-pl-summary">
        <div className="tj-pl-summary-block">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <div className="tj-pl-summary-label" style={{ marginBottom: 0 }}>GROSS P&amp;L</div>
            {trade.pnlOverride !== undefined && (
              <button
                type="button"
                onClick={() => { onMutate({ pnlOverride: undefined }); setPnlEditMode(false); }}
                style={{ fontSize: 9, color: 'var(--txt-3)', cursor: 'pointer', border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', lineHeight: 1 }}
                title="Reset to calculated value"
              >
                ↺ auto
              </button>
            )}
          </div>
          {pnlEditMode ? (
            <input
              type="number"
              step="0.01"
              autoFocus
              value={pnlEditValue}
              onChange={e => setPnlEditValue(e.target.value)}
              onBlur={() => {
                const parsed = parseFloat(pnlEditValue);
                if (Number.isFinite(parsed)) onMutate({ pnlOverride: parsed });
                setPnlEditMode(false);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const parsed = parseFloat(pnlEditValue);
                  if (Number.isFinite(parsed)) onMutate({ pnlOverride: parsed });
                  setPnlEditMode(false);
                } else if (e.key === 'Escape') {
                  setPnlEditMode(false);
                }
              }}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 18,
                fontWeight: 600,
                width: 130,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: parseFloat(pnlEditValue) > 0 ? 'var(--green)' : parseFloat(pnlEditValue) < 0 ? 'var(--red)' : 'var(--txt)',
                padding: '2px 6px',
                outline: 'none',
              }}
            />
          ) : (
            <div
              className={`tj-pl-summary-value ${effectivePnl !== null && effectivePnl > 0 ? 'pos' : effectivePnl !== null && effectivePnl < 0 ? 'neg' : ''}`}
              onClick={() => { setPnlEditValue(String(effectivePnl ?? 0)); setPnlEditMode(true); }}
              title="Click to override Gross P&L"
              style={{ cursor: 'pointer' }}
            >
              {effectivePnl === null ? '-' : formatCurrencyFixed(effectivePnl)}
            </div>
          )}
        </div>
        <div className="tj-pl-summary-block">
          <div className="tj-pl-summary-label">R:R</div>
          <div className={`tj-pl-summary-rr ${rr !== null && rr >= 2 ? 'pos' : rr !== null && rr >= 1 ? 'amber' : rr !== null ? 'neg' : ''}`}>
            {rr === null ? '-' : `${rr.toFixed(2)}R`}
          </div>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)', borderLeft: '3px solid var(--amber)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '10px 12px 10px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="tj-pl-summary-label" style={{ marginBottom: 0, whiteSpace: 'nowrap', color: 'var(--amber)' }}>FEES</div>
          <input
            type="number"
            min="0"
            step="0.01"
            value={commissionLocal}
            onChange={e => setCommissionLocal(e.target.value)}
            onBlur={() => {
              const parsed = parseFloat(commissionLocal);
              const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
              setCommissionLocal(value > 0 ? String(value) : '');
              onMutate({ commission: value > 0 ? value : undefined });
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const parsed = parseFloat(commissionLocal);
                const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                setCommissionLocal(value > 0 ? String(value) : '');
                onMutate({ commission: value > 0 ? value : undefined });
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="0.00"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 500,
              width: 80,
              background: 'var(--amber-dim, rgba(245,158,11,0.08))',
              border: '1px solid var(--amber)',
              borderRadius: 4,
              color: 'var(--txt)',
              padding: '3px 7px',
              outline: 'none',
            }}
          />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="tj-pl-summary-label" style={{ marginBottom: 2 }}>NET P&amp;L</div>
          {effectivePnl !== null ? (() => {
            const net = effectivePnl - (trade.commission ?? 0);
            return (
              <div className={`tj-pl-summary-value ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}`} style={{ fontSize: 18 }}>
                {formatCurrencyFixed(net)}
              </div>
            );
          })() : (
            <div className="tj-pl-summary-value">-</div>
          )}
        </div>
      </div>
    </div>
  );
}



// ── Behavioral flag penalty weights ──────────────────────────────────────────
const FLAG_PENALTIES: Record<string, number> = {
  // Critical — direct account risk / emotional breakdown
  'sized-up':       20,
  'revenge':        20,
  'added-losing':   20,
  // Serious — discipline failures that damage edge
  'off-playbook':   12,
  'reentry-stop':   12,
  'past-inval':     12,
  'moved-stop':     12,
  'boredom-trade':  12,
  // Minor — execution imperfections
  'chased-entry':    6,
  'no-confirmation': 6,
  'overtraded':      6,
  'exit-early':      6,
  'moved-target':    6,
  // Minimal — conservative mistakes
  'be-too-early':    4,
};

// ── Helper: computeProcessScore ──────────────────────────────────────────────
function computeProcessScore(trade: JournalTrade): number {
  const r = trade.psychologyRatings;
  if (!r) return 0;
  const scores = [r.setupQuality, r.discipline, r.execution, r.patience, r.riskManagement, r.emotionalControl].filter(v => v > 0);
  if (scores.length === 0) return 0;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  let score = avg * 20;
  const flags = trade.behavioralFlags ?? [];
  score -= flags.reduce((total, id) => total + (FLAG_PENALTIES[id] ?? 8), 0);
  const er = trade.executionReview;
  if (er && er.enteredAtLevel && er.waitedForConfirmation && er.correctSize && er.exitedAtPlan && er.movedStopCorrectly && er.resistedEarlyExit) score += 5;
  if ((trade.preEntry?.confidenceAtEntry ?? 0) >= 4) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── SectionHead collapsible header ───────────────────────────────────────────
function SectionHead({ title, collapsed, onToggle }: {
  title: string;
  sectionKey?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="tj-section-head" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={onToggle}>
      <span className="tj-section-title">{title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--app-text-subtle)', fontFamily: 'var(--font-mono)' }}>
        {collapsed ? '▶' : '▼'}
      </span>
    </div>
  );
}

// ── A — DailyReflectionBlock ──────────────────────────────────────────────────
function DailyReflectionBlock({ entry, onMutateEntry }: {
  entry: JournalEntry;
  onMutateEntry: (fields: Partial<JournalEntry>) => void;
}) {
  const dr = entry.dailyReflection ?? { pre: entry.reflection.pre, post: entry.reflection.post, lessons: entry.reflection.lessons, bias: null, newsRisk: null, sessionTarget: null, sessionGrade: null, marketRespectedBias: null, lessonCategory: null };
  const [activeTab, setActiveTab] = useState<'pre' | 'post' | 'lessons'>('pre');
  const [localPre, setLocalPre] = useState(dr.pre);
  const [localPost, setLocalPost] = useState(dr.post);
  const [localLessons, setLocalLessons] = useState(dr.lessons);

  useEffect(() => {
    const d = entry.dailyReflection ?? { pre: entry.reflection.pre, post: entry.reflection.post, lessons: entry.reflection.lessons, bias: null, newsRisk: null, sessionTarget: null, sessionGrade: null, marketRespectedBias: null, lessonCategory: null };
    setLocalPre(d.pre); setLocalPost(d.post); setLocalLessons(d.lessons);
  }, [entry.id]);

  // Save local textarea content when section is collapsed (component unmounts)
  const unmountRef = useRef({ localPre, localPost, localLessons, dr, onMutateEntry });
  unmountRef.current = { localPre, localPost, localLessons, dr, onMutateEntry };
  useEffect(() => {
    return () => {
      const { localPre: p, localPost: po, localLessons: l, dr: d, onMutateEntry: m } = unmountRef.current;
      m({ dailyReflection: { ...d, pre: p, post: po, lessons: l } });
    };
  }, []);

  const update = (patch: Partial<typeof dr>) => {
    onMutateEntry({ dailyReflection: { ...dr, ...patch } });
  };

  const LESSON_CATS = ['Entry Timing','Exit Management','Sizing','Patience','Risk Management','Entry Selection','Emotional Control','Rule Following','Market Reading'];
  const GRADES = ['A+','A','B+','B','C+','C'];
  const biasOptions: Array<{ v: 'bullish'|'neutral'|'bearish'; label: string }> = [{ v:'bullish', label:'BULLISH' },{ v:'neutral', label:'NEUTRAL' },{ v:'bearish', label:'BEARISH' }];
  const newsOptions: Array<{ v: 'clear'|'caution'|'avoid'; label: string }> = [{ v:'clear', label:'CLEAR' },{ v:'caution', label:'CAUTION' },{ v:'avoid', label:'AVOID' }];

  return (
    <div className="tj-card" style={{ marginBottom: 8 }}>
      <div className="tj-tabs">
        {(['pre','post','lessons'] as const).map(tab => (
          <button key={tab} type="button" className={`tj-tab${activeTab===tab?' active':''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'pre' ? 'Pre-market' : tab === 'post' ? 'Post-session' : 'Lessons'}
          </button>
        ))}
      </div>

      {activeTab === 'pre' && (
        <div style={{ padding: '0' }}>
          <textarea className="tj-reflect" style={{ minHeight: 80, display:'block' }}
            value={localPre}
            onChange={e => setLocalPre(e.target.value)}
            onBlur={e => update({ pre: e.target.value })}
            placeholder="Game plan, key levels, bias, and conditions you're watching. Write this BEFORE the open."
          />
          <div style={{ display:'flex', gap:12, padding:'10px 14px', borderTop:'1px solid var(--app-border)', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Bias</div>
              <div style={{ display:'flex', gap:3 }}>
                {biasOptions.map(o => (
                  <button key={o.v} type="button" onClick={() => update({ bias: dr.bias === o.v ? null : o.v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.bias===o.v?'var(--amber-border)':'var(--app-border)'}`, background:dr.bias===o.v?'var(--amber-dim)':'transparent', color:dr.bias===o.v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>News Risk</div>
              <div style={{ display:'flex', gap:3 }}>
                {newsOptions.map(o => (
                  <button key={o.v} type="button" onClick={() => update({ newsRisk: dr.newsRisk === o.v ? null : o.v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.newsRisk===o.v?(o.v==='clear'?'var(--green-border)':o.v==='avoid'?'var(--red-border)':'var(--amber-border)'):'var(--app-border)'}`, background:dr.newsRisk===o.v?(o.v==='clear'?'var(--green-dim)':o.v==='avoid'?'var(--red-dim)':'var(--amber-dim)'):'transparent', color:dr.newsRisk===o.v?(o.v==='clear'?'var(--green)':o.v==='avoid'?'var(--red)':'var(--amber)'):'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'post' && (
        <div>
          <textarea className="tj-reflect" style={{ minHeight:80, display:'block' }}
            value={localPost}
            onChange={e => setLocalPost(e.target.value)}
            onBlur={e => update({ post: e.target.value })}
            placeholder="How did the session go vs the plan?"
          />
          <div style={{ display:'flex', gap:12, padding:'10px 14px', borderTop:'1px solid var(--app-border)', flexWrap:'wrap', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Session Grade</div>
              <div style={{ display:'flex', gap:3 }}>
                {GRADES.map(g => (
                  <button key={g} type="button" onClick={() => update({ sessionGrade: dr.sessionGrade === g ? null : g })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.sessionGrade===g?'var(--amber-border)':'var(--app-border)'}`, background:dr.sessionGrade===g?'var(--amber-dim)':'transparent', color:dr.sessionGrade===g?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginLeft:'auto' }}>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Market respected bias?</div>
              <div style={{ display:'flex', gap:3 }}>
                {[true,false].map(v => (
                  <button key={String(v)} type="button" onClick={() => update({ marketRespectedBias: dr.marketRespectedBias === v ? null : v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.marketRespectedBias===v?'var(--amber-border)':'var(--app-border)'}`, background:dr.marketRespectedBias===v?'var(--amber-dim)':'transparent', color:dr.marketRespectedBias===v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {v ? 'YES' : 'NO'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'lessons' && (
        <div>
          <textarea className="tj-reflect" style={{ minHeight:80, display:'block' }}
            value={localLessons}
            onChange={e => setLocalLessons(e.target.value)}
            onBlur={e => update({ lessons: e.target.value })}
            placeholder="One specific thing to do differently next session. Not 'be more disciplined' — something concrete and actionable."
          />
          <div style={{ padding:'10px 14px', borderTop:'1px solid var(--app-border)' }}>
            <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>Lesson Category</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {LESSON_CATS.map(cat => (
                <button key={cat} type="button" onClick={() => update({ lessonCategory: dr.lessonCategory === cat ? null : cat })}
                  style={{ padding:'3px 8px', fontSize:9, borderRadius:3, border:`1px solid ${dr.lessonCategory===cat?'var(--amber-border)':'var(--app-border)'}`, background:dr.lessonCategory===cat?'var(--amber-dim)':'transparent', color:dr.lessonCategory===cat?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── B — PreEntryBlock ─────────────────────────────────────────────────────────
function PreEntryBlock({ trade, entry, allEntries, onMutate }: {
  trade: JournalTrade;
  entry: JournalEntry;
  allEntries: JournalEntry[];
  onMutate: (fields: Partial<JournalTrade>) => void;
}) {
  const pe = trade.preEntry ?? { confidenceAtEntry:0, emotionalState:'', hesitated:null, hesitationReason:'' };
  const [hesReason, setHesReason] = useState(pe.hesitationReason ?? '');
  useEffect(() => { setHesReason(trade.preEntry?.hesitationReason ?? ''); }, [trade.id]);

  const update = (patch: Partial<typeof pe>) => onMutate({ preEntry: { ...pe, ...patch } });

  // Save hesitation reason on unmount (section collapse)
  const unmountRef = useRef({ hesReason, pe, onMutate });
  unmountRef.current = { hesReason, pe, onMutate };
  useEffect(() => {
    return () => {
      const { hesReason: h, pe: p, onMutate: m } = unmountRef.current;
      if (h !== (p.hesitationReason ?? '')) m({ preEntry: { ...p, hesitationReason: h } });
    };
  }, []);

  const EMOTIONAL_STATES = ['Calm and focused','Slightly anxious','Scared / nervous','Excited / hyped','Frustrated (from earlier trade)','Bored / impatient','Fearful of missing','Revenge-motivated','In the zone','Distracted / not present','Overconfident'];
  const CONF_LABELS = ['','Low / forced','Uncertain','Moderate','Confident','High conviction'];

  const dayTrades = entry.trades;
  const tradeIndex = dayTrades.findIndex(t => t.id === trade.id);
  const tradeNumber = tradeIndex + 1;
  const prevTrades = dayTrades.slice(0, tradeIndex);
  const dailyPnlBefore = prevTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const prevWasLoss = tradeIndex > 0 && (dayTrades[tradeIndex-1]?.result === 'loss');
  const isThirdPlus = tradeNumber >= 3;

  const dr = entry.dailyReflection;
  const maxLoss = dr?.sessionTarget ? -Math.abs(dr.sessionTarget) : null;
  const nearLimit = maxLoss !== null && dailyPnlBefore <= maxLoss * 0.8 && dailyPnlBefore < 0;

  // allEntries is available if needed for cross-day context
  void allEntries;

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, overflow:'hidden', marginBottom:8 }}>

      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--app-border)' }}>
        <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:2 }}>Confidence at Entry</div>
        <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:8 }}>How certain were you this was the right trade?</div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ display:'flex', gap:4 }}>
            {[1,2,3,4,5].map(v => (
              <button key={v} type="button" onClick={() => update({ confidenceAtEntry: v })}
                style={{ width:28, height:6, borderRadius:2, border:'none', cursor:'pointer', background: pe.confidenceAtEntry >= v ? (v <= 2 ? 'var(--red)' : v === 3 ? 'var(--amber)' : 'var(--green)') : 'var(--app-panel-strong)' }} />
            ))}
          </div>
          {pe.confidenceAtEntry > 0 && (
            <span style={{ fontSize:11, fontFamily:'var(--font-mono)', color:'var(--amber)' }}>{CONF_LABELS[pe.confidenceAtEntry]}</span>
          )}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', borderBottom:'1px solid var(--app-border)' }}>
        <div style={{ padding:'12px 14px', borderRight:'1px solid var(--app-border)' }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>Emotional State at Entry</div>
          <select value={pe.emotionalState} onChange={e => update({ emotionalState: e.target.value })}
            style={{ width:'100%', padding:'5px 8px', fontSize:11, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:4, color:'var(--txt)', outline:'none', cursor:'pointer' }}>
            <option value="">Select state...</option>
            {EMOTIONAL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ padding:'12px 14px' }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:2 }}>Hesitated at Entry?</div>
          <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:6 }}>Did you delay or second-guess before pressing the button?</div>
          <div style={{ display:'flex', gap:4, marginBottom: pe.hesitated ? 8 : 0 }}>
            {[true,false].map(v => (
              <button key={String(v)} type="button" onClick={() => update({ hesitated: pe.hesitated === v ? null : v })}
                style={{ padding:'3px 10px', fontSize:10, borderRadius:4, border:`1px solid ${pe.hesitated===v?'var(--amber-border)':'var(--app-border)'}`, background:pe.hesitated===v?'var(--amber-dim)':'transparent', color:pe.hesitated===v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                {v ? 'YES' : 'NO'}
              </button>
            ))}
          </div>
          {pe.hesitated && (
            <textarea value={hesReason} onChange={e => setHesReason(e.target.value)} onBlur={e => update({ hesitationReason: e.target.value })}
              placeholder="What made you hesitate?" style={{ width:'100%', minHeight:40, padding:'6px 8px', fontSize:10, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:4, color:'var(--txt)', outline:'none', resize:'none', boxSizing:'border-box' }} />
          )}
        </div>
      </div>

      <div style={{ padding:'10px 14px', display:'flex', gap:20, alignItems:'center', flexWrap:'wrap' }}>
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em' }}>Trade # Today</div>
          <div style={{ fontSize:13, fontFamily:'var(--font-mono)', color:'var(--app-text)', marginTop:2 }}>{tradeNumber}</div>
        </div>
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em' }}>Daily P&L Before</div>
          <div style={{ fontSize:13, fontFamily:'var(--font-mono)', color: dailyPnlBefore > 0 ? 'var(--green)' : dailyPnlBefore < 0 ? 'var(--red)' : 'var(--app-text-muted)', marginTop:2 }}>
            {dailyPnlBefore >= 0 ? '+' : ''}{dailyPnlBefore.toFixed(2)}
          </div>
        </div>
        {isThirdPlus && prevWasLoss && (
          <div style={{ padding:'3px 10px', borderRadius:4, background:'var(--amber-dim)', border:'1px solid var(--amber-border)', fontSize:10, color:'var(--amber)', fontFamily:'var(--font-sans)' }}>
            Trade {tradeNumber} after loss — check revenge risk
          </div>
        )}
        {nearLimit && (
          <div style={{ padding:'3px 10px', borderRadius:4, background:'var(--amber-dim)', border:'1px solid var(--amber-border)', fontSize:10, color:'var(--amber)' }}>
            Within ${Math.abs(dailyPnlBefore - (maxLoss ?? 0)).toFixed(0)} of daily limit
          </div>
        )}
      </div>
    </div>
  );
}

// ── C — TradeThesisBlock ──────────────────────────────────────────────────────
function TradeThesisBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (f: Partial<JournalTrade>) => void }) {
  const th = trade.thesis ?? { setup:'', invalidation:'', asymmetry:'', setupType:'' };
  const confluences = normalizeConfluences(trade.confluences);
  const [local, setLocal] = useState(th);
  const [confluenceDraft, setConfluenceDraft] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const navigate = useNavigate();
  const { confluenceOptions } = useAppSettings();
  useEffect(() => { setLocal(trade.thesis ?? { setup:'', invalidation:'', asymmetry:'', setupType:'' }); }, [trade.id]);
  useEffect(() => { setConfluenceDraft(''); setSuggestionIndex(-1); }, [trade.id]);

  const update = (patch: Partial<typeof th>) => onMutate({ thesis: { ...th, ...patch } });
  const commit = (field: keyof typeof th, value: string) => update({ [field]: value });
  const setConfluences = (next: string[]) => onMutate({ confluences: normalizeConfluences(next) });

  const suggestions = confluenceDraft.trim().length > 0
    ? confluenceOptions.filter(opt =>
        opt.toLowerCase().includes(confluenceDraft.toLowerCase()) &&
        !confluences.includes(opt)
      )
    : [];

  const addConfluence = () => {
    const next = (suggestionIndex >= 0 && suggestions[suggestionIndex])
      ? suggestions[suggestionIndex]
      : confluenceDraft.trim();
    if (!next) return;
    setConfluences([...confluences, next]);
    setConfluenceDraft('');
    setSuggestionIndex(-1);
  };

  const selectSuggestion = (opt: string) => {
    setConfluences([...confluences, opt]);
    setConfluenceDraft('');
    setSuggestionIndex(-1);
  };

  const removeConfluence = (indexToRemove: number) => {
    setConfluences(confluences.filter((_, index) => index !== indexToRemove));
  };

  // Save unsaved textarea content on unmount (section collapse)
  const unmountRef = useRef({ local, th, onMutate });
  unmountRef.current = { local, th, onMutate };
  useEffect(() => {
    return () => {
      const { local: l, th: t, onMutate: m } = unmountRef.current;
      if (l.setup !== t.setup || l.invalidation !== t.invalidation || l.asymmetry !== t.asymmetry) {
        m({ thesis: { ...t, setup: l.setup, invalidation: l.invalidation, asymmetry: l.asymmetry } });
      }
    };
  }, []);

  const COLS: Array<{ key: 'setup'|'invalidation'|'asymmetry'; title: string; sub: string; placeholder: string }> = [
    { key:'setup', title:'Trade Thesis', sub:'What specific edge did you see?', placeholder:"What conditions were present? Why this level, this direction, right now?" },
    { key:'invalidation', title:'Invalidation', sub:'What would prove you wrong?', placeholder:"If price does X, the trade is invalid and I should be out. What specific price action kills this thesis?" },
    { key:'asymmetry', title:'Why this R:R?', sub:'Is the risk worth the reward?', placeholder:"Where is price likely going? What liquidity target makes this trade worth taking at this R:R?" },
  ];

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, marginBottom:8 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', borderBottom:'1px solid var(--app-border)', overflow:'hidden', borderRadius:'5px 5px 0 0' }}>
        {COLS.map((col, i) => (
          <div key={col.key} style={{ borderRight: i < 2 ? '1px solid var(--app-border)' : undefined }}>
            <div style={{ padding:'8px 12px 6px', borderBottom:'1px solid var(--app-border)' }}>
              <div style={{ fontSize:11, fontWeight:500, color:'var(--app-text-muted)' }}>{col.title}</div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', fontStyle:'italic' }}>{col.sub}</div>
            </div>
            <textarea value={local[col.key]} onChange={e => setLocal(p => ({ ...p, [col.key]: e.target.value }))} onBlur={e => commit(col.key, e.target.value)} placeholder={col.placeholder}
              className="tj-reflect" style={{ minHeight:72, fontSize:12, padding:'10px 12px', display:'block' }} />
          </div>
        ))}
      </div>
      <div style={{ padding:'10px 14px', borderTop:'1px solid var(--app-border)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <span style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em' }}>Confluences</span>
          <button type="button" onClick={() => navigate('/settings#journal')} style={{ background:'none', border:'none', padding:0, cursor:'pointer', fontSize:10, color:'var(--cobalt)', fontFamily:'var(--font-sans)' }}>Manage tags →</button>
        </div>
        <div style={{ display:'flex', gap:6, marginBottom:8 }}>
          <div style={{ flex:1, position:'relative' }}>
            <input
              value={confluenceDraft}
              onChange={(event) => { setConfluenceDraft(event.target.value); setSuggestionIndex(-1); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addConfluence();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSuggestionIndex(i => Math.max(i - 1, -1));
                } else if (event.key === 'Escape') {
                  setSuggestionIndex(-1);
                  setConfluenceDraft('');
                }
              }}
              placeholder="Type a confluence and press Enter (e.g., FVG, HTF bias, liquidity sweep)"
              style={{ width:'100%', boxSizing:'border-box', padding:'7px 9px', fontSize:11, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:4, color:'var(--app-text)', outline:'none' }}
            />
            {suggestions.length > 0 && (
              <div style={{
                position:'absolute', top:'calc(100% + 2px)', left:0, right:0, zIndex:300,
                background:'var(--app-panel-strong)', border:'1px solid var(--app-border)',
                borderRadius:4, boxShadow:'0 4px 14px rgba(0,0,0,0.35)',
                maxHeight:160, overflowY:'auto',
              }}>
                {suggestions.map((opt, i) => (
                  <button
                    key={opt}
                    type="button"
                    onMouseDown={e => { e.preventDefault(); selectSuggestion(opt); }}
                    onMouseEnter={() => setSuggestionIndex(i)}
                    style={{
                      display:'block', width:'100%', textAlign:'left',
                      padding:'6px 10px', fontSize:11, fontFamily:'var(--font-sans)',
                      background: i === suggestionIndex ? 'var(--cobalt-dim)' : 'transparent',
                      color: i === suggestionIndex ? '#8ab6ff' : 'var(--app-text-muted)',
                      border:'none', borderBottom: i < suggestions.length - 1 ? '1px solid var(--app-border)' : 'none',
                      cursor:'pointer',
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={addConfluence}
            style={{ padding:'7px 10px', fontSize:10, borderRadius:4, border:'1px solid var(--amber-border)', background:'var(--amber-dim)', color:'var(--amber)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}
          >
            Add
          </button>
        </div>
        {confluences.length > 0 ? (
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {confluences.map((item, index) => (
              <button
                key={`${item}-${index}`}
                type="button"
                onClick={() => removeConfluence(index)}
                title="Remove confluence"
                style={{ padding:'3px 8px', fontSize:10, borderRadius:4, border:'1px solid var(--app-border)', background:'var(--app-panel-strong)', color:'var(--app-text-muted)', cursor:'pointer', fontFamily:'var(--font-sans)' }}
              >
                {item} ×
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize:10, color:'var(--app-text-subtle)' }}>No confluences tagged yet.</div>
        )}
      </div>
    </div>
  );
}

// ── D — ExecutionReviewBlock ──────────────────────────────────────────────────
function ExecutionReviewBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (f: Partial<JournalTrade>) => void }) {
  const er = trade.executionReview ?? { enteredAtLevel:null, waitedForConfirmation:null, correctSize:null, exitedAtPlan:null, movedStopCorrectly:null, resistedEarlyExit:null, note:'' };
  const [note, setNote] = useState(er.note ?? '');
  useEffect(() => { setNote(trade.executionReview?.note ?? ''); }, [trade.id]);
  const update = (patch: Partial<typeof er>) => onMutate({ executionReview: { ...er, ...patch } });

  // Save note on unmount (section collapse)
  const unmountRef = useRef({ note, er, onMutate });
  unmountRef.current = { note, er, onMutate };
  useEffect(() => {
    return () => {
      const { note: n, er: e, onMutate: m } = unmountRef.current;
      if (n !== (e.note ?? '')) m({ executionReview: { ...e, note: n } });
    };
  }, []);

  const YNToggle = ({ label, field, value }: { label: string; field: keyof typeof er; value: boolean | null }) => (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
      <span style={{ fontSize:10, color:'var(--app-text-muted)' }}>{label}</span>
      <div style={{ display:'flex', gap:3 }}>
        {[true,false].map(v => (
          <button key={String(v)} type="button" onClick={() => update({ [field]: value === v ? null : v } as Partial<typeof er>)}
            style={{ padding:'2px 8px', fontSize:9, borderRadius:3, border:`1px solid ${value===v?(v?'var(--green-border)':'var(--red-border)'):'var(--app-border)'}`, background:value===v?(v?'var(--green-dim)':'var(--red-dim)'):'transparent', color:value===v?(v?'var(--green)':'var(--red)'):'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
            {v ? 'YES' : 'NO'}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, overflow:'hidden', marginBottom:8 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', borderBottom:'1px solid var(--app-border)' }}>
        <div style={{ padding:'12px 14px', borderRight:'1px solid var(--app-border)', display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:0 }}>Entry Execution</div>
          <YNToggle label="Entered exactly at my level" field="enteredAtLevel" value={er.enteredAtLevel} />
          <YNToggle label="Waited for confirmation" field="waitedForConfirmation" value={er.waitedForConfirmation} />
          <YNToggle label="Correct position size" field="correctSize" value={er.correctSize} />
        </div>
        <div style={{ padding:'12px 14px', display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:0 }}>Exit Execution</div>
          <YNToggle label="Exited at planned level" field="exitedAtPlan" value={er.exitedAtPlan} />
          <YNToggle label="Moved stop to BE at right time" field="movedStopCorrectly" value={er.movedStopCorrectly} />
          <YNToggle label="Resisted urge to exit early" field="resistedEarlyExit" value={er.resistedEarlyExit} />
        </div>
      </div>
      <textarea value={note} onChange={e => setNote(e.target.value)} onBlur={e => update({ note: e.target.value })}
        placeholder="Anything specific about how you managed this trade that you want to remember — good or bad."
        style={{ width:'100%', minHeight:60, padding:'10px 14px', fontSize:11, fontFamily:'var(--font-sans)', background:'transparent', border:'none', outline:'none', resize:'none', color:'var(--txt)', boxSizing:'border-box' }} />
    </div>
  );
}

// ── E — PsychologyRatingsBlock ────────────────────────────────────────────────
function PsychologyRatingsBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (f: Partial<JournalTrade>) => void }) {
  const r = trade.psychologyRatings ?? { setupQuality:0, discipline:0, execution:0, patience:0, riskManagement:0, emotionalControl:0, notes:{} };
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  const [noteValues, setNoteValues] = useState<Record<string, string>>(r.notes ?? {});
  useEffect(() => { setNoteValues(trade.psychologyRatings?.notes ?? {}); }, [trade.id]);

  const update = (patch: Partial<typeof r>) => onMutate({ psychologyRatings: { ...r, ...patch } });
  const pipColor = (score: number, v: number) => score >= v ? (score <= 2 ? 'var(--red)' : score === 3 ? 'var(--amber)' : 'var(--green)') : 'var(--app-panel-strong)';

  const CARDS: Array<{ key: keyof Omit<typeof r,'notes'>; label: string; sub: string }> = [
    { key:'setupQuality', label:'Trade Quality', sub:'How clean and high-conviction was this trade?' },
    { key:'discipline', label:'Discipline', sub:'Did you follow your rules completely?' },
    { key:'execution', label:'Execution', sub:'Did you enter and exit as planned?' },
    { key:'patience', label:'Patience', sub:'Did you wait for the right moment?' },
    { key:'riskManagement', label:'Risk Management', sub:'Did you respect sizing and stops?' },
    { key:'emotionalControl', label:'Emotional Control', sub:'Were you in control throughout?' },
  ];

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:8 }}>
      {CARDS.map(card => {
        const score = r[card.key] as number;
        return (
          <div key={card.key} style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'10px 12px' }}>
            <div style={{ fontSize:9, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--app-text-subtle)', marginBottom:2 }}>{card.label}</div>
            <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:8 }}>{card.sub}</div>
            <div style={{ display:'flex', gap:3, marginBottom:6 }}>
              {[1,2,3,4,5].map(v => (
                <button key={v} type="button" onClick={() => update({ [card.key]: v })}
                  style={{ flex:1, height:5, borderRadius:2, border:'none', cursor:'pointer', background: pipColor(score, v) }} />
              ))}
            </div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:15, fontWeight:500, fontFamily:'var(--font-mono)', color: score===0?'var(--app-text-subtle)':score<=2?'var(--red)':score===3?'var(--amber)':'var(--green)' }}>{score > 0 ? score : '—'}</span>
              <button type="button" onClick={() => setNoteOpen(p => ({ ...p, [card.key]: !p[card.key] }))}
                style={{ fontSize:10, color:'var(--app-text-subtle)', background:'none', border:'none', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                {noteValues[card.key] ? '✎ note' : '+ note'}
              </button>
            </div>
            {noteOpen[card.key] && (
              <input type="text" value={noteValues[card.key] ?? ''} onChange={e => setNoteValues(p => ({ ...p, [card.key]: e.target.value }))}
                onBlur={e => { update({ notes: { ...r.notes, [card.key]: e.target.value } }); if (!e.target.value) setNoteOpen(p => ({ ...p, [card.key]: false })); }}
                placeholder="Why this score?"
                style={{ width:'100%', marginTop:6, padding:'3px 6px', fontSize:10, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:3, color:'var(--txt)', outline:'none', boxSizing:'border-box' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── F — BehavioralFlagsBlock ──────────────────────────────────────────────────
const BEHAVIORAL_FLAGS_LEFT = [
  { id:'chased-entry',    label:'Chased entry — outside the zone' },
  { id:'no-confirmation', label:'Jumped in before confirmation' },
  { id:'off-playbook',    label:'Took unplanned trade' },
  { id:'sized-up',        label:'Oversized position' },
  { id:'added-losing',    label:'Added to a losing position' },
  { id:'be-too-early',    label:'Moved to breakeven too early' },
  { id:'overtraded',      label:'Overtraded — too many setups' },
];
const BEHAVIORAL_FLAGS_RIGHT = [
  { id:'moved-stop',    label:'Widened stop loss after entry' },
  { id:'exit-early',    label:'Exited too early (fear)' },
  { id:'moved-target',  label:'Moved or ignored take profit' },
  { id:'past-inval',    label:'Held past invalidation' },
  { id:'boredom-trade', label:'Traded out of boredom' },
  { id:'revenge',       label:'Revenge trade after a loss' },
  { id:'reentry-stop',  label:'Re-entered immediately after stop out' },
];

function BehavioralFlagsBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (f: Partial<JournalTrade>) => void }) {
  const flags = trade.behavioralFlags ?? [];
  const toggle = (id: string) => {
    const next = flags.includes(id) ? flags.filter(f => f !== id) : [...flags, id];
    onMutate({ behavioralFlags: next });
  };

  const FlagRow = ({ id, label }: { id: string; label: string }) => {
    const checked = flags.includes(id);
    return (
      <div onClick={() => toggle(id)} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderBottom:'1px solid var(--app-border)', cursor:'pointer' }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.018)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
        <div style={{ width:14, height:14, borderRadius:2, border:`1px solid ${checked?'var(--red-border)':'var(--app-border)'}`, background:checked?'var(--red-dim)':'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
          {checked && <span style={{ fontSize:9, color:'var(--red)', lineHeight:1 }}>✕</span>}
        </div>
        <span style={{ fontSize:11, color: checked ? 'var(--red)' : 'var(--app-text-muted)' }}>{label}</span>
      </div>
    );
  };

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, overflow:'hidden', marginBottom:8 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr' }}>
        <div style={{ borderRight:'1px solid var(--app-border)' }}>
          {BEHAVIORAL_FLAGS_LEFT.map(f => <FlagRow key={f.id} id={f.id} label={f.label} />)}
        </div>
        <div>
          {BEHAVIORAL_FLAGS_RIGHT.map(f => <FlagRow key={f.id} id={f.id} label={f.label} />)}
        </div>
      </div>
      <div style={{ padding:'10px 14px', borderTop:'1px solid var(--app-border)' }}>
        {flags.length > 0
          ? <span style={{ fontSize:11, color:'var(--red)', fontFamily:'var(--font-mono)' }}>{flags.length} behavioral flag{flags.length > 1 ? 's' : ''} this trade</span>
          : <span style={{ fontSize:11, color:'var(--app-text-subtle)' }}>No behavioral flags</span>}
      </div>
    </div>
  );
}

// ── G — StateOfMindBlock ──────────────────────────────────────────────────────
function StateOfMindBlock({ entry, activeTrade, onMutateEntry, onMutateTrade }: {
  entry: JournalEntry;
  activeTrade: JournalTrade | null;
  onMutateEntry: (f: Partial<JournalEntry>) => void;
  onMutateTrade?: (f: Partial<JournalTrade>) => void;
}) {
  const emotions = entry.emotions;
  const selectedFor = (label: string, _valence: 'positive' | 'caution' | 'negative') =>
    emotions.some(e => e.label === label && e.state !== 'neutral');

  const toggle = (label: string, valence: 'positive' | 'caution' | 'negative') => {
    const nextEmotions: JournalEntry['emotions'] = emotions.map((e) =>
      e.label === label
        ? {
            ...e,
            state: e.state === 'neutral'
              ? (valence === 'positive' ? 'green' : valence === 'caution' ? 'amber' : 'red') as EmotionState
              : 'neutral',
          }
        : e
    );
    onMutateEntry({ emotions: nextEmotions });

    // Keep selected-trade tags in sync as a convenience, but persist day tags as source of truth.
    if (onMutateTrade && activeTrade) {
      const selected = nextEmotions.filter((emotion) => emotion.state !== 'neutral');
      const nextTradeSom = selected.map((emotion) => ({
        label: emotion.label,
        valence: emotion.state === 'green' ? 'positive' as const : emotion.state === 'amber' ? 'caution' as const : 'negative' as const,
      }));
      onMutateTrade({ stateOfMind: nextTradeSom });
    }
  };

  const groups: Array<{ key: 'positive'|'caution'|'negative'; color: string; bg: string; border: string }> = [
    { key:'positive', color:'var(--green)', bg:'var(--green-dim)', border:'var(--green-border)' },
    { key:'caution',  color:'var(--amber)', bg:'var(--amber-dim)', border:'var(--amber-border)' },
    { key:'negative', color:'var(--red)',   bg:'var(--red-dim)',   border:'var(--red-border)' },
  ];

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'12px 14px', marginBottom:8 }}>
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {groups.map((g, gi) => (
          <div key={g.key}>
            {gi > 0 && <div style={{ height:1, background:'var(--app-border)', marginBottom:10 }} />}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {STATE_OF_MIND_TAGS[g.key].map(label => {
                const sel = selectedFor(label, g.key);
                return (
                  <button key={label} type="button" onClick={() => toggle(label, g.key)}
                    style={{ padding:'3px 8px', fontSize:10, borderRadius:3, border:`1px solid ${sel?g.border:'var(--app-border)'}`, background:sel?g.bg:'transparent', color:sel?g.color:'var(--app-text-muted)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── H — PhysicalStateBlock ────────────────────────────────────────────────────
function PhysicalStateBlock({ entry, onMutateEntry }: { entry: JournalEntry; onMutateEntry: (f: Partial<JournalEntry>) => void }) {
  const ps = entry.physicalState ?? { sleep:0, sleepHours:0, stress:0, energy:0, distractions:[], environment:'' };
  const update = (patch: Partial<typeof ps>) => onMutateEntry({ physicalState: { ...ps, ...patch } });

  const DISTRACTIONS = ['Phone','Other screen','People','Noise','None'];
  const ENVIRONMENTS = ['Home','Office','Travelling','Unusual environment'];

  const PipRow = ({ label, value, field, colorFn }: { label: string; value: number; field: keyof typeof ps; colorFn: (v: number) => string }) => (
    <div style={{ minWidth:80 }}>
      <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>{label}</div>
      <div style={{ display:'flex', gap:3 }}>
        {[1,2,3,4,5].map(v => (
          <button key={v} type="button" onClick={() => update({ [field]: v } as Partial<typeof ps>)}
            style={{ width:16, height:5, borderRadius:2, border:'none', cursor:'pointer', background: (value as number) >= v ? colorFn(value) : 'var(--app-panel-strong)' }} />
        ))}
      </div>
    </div>
  );

  const toggleDistraction = (d: string) => {
    let next: string[];
    if (d === 'None') { next = ps.distractions.includes('None') ? [] : ['None']; }
    else { next = ps.distractions.includes(d) ? ps.distractions.filter(x => x !== d) : [...ps.distractions.filter(x => x !== 'None'), d]; }
    update({ distractions: next });
  };

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'12px 14px', marginBottom:8 }}>
      <div style={{ display:'flex', flexWrap:'wrap', gap:16, alignItems:'flex-start' }}>
        <PipRow label="Sleep" value={ps.sleep} field="sleep" colorFn={() => 'var(--cobalt)'} />
        <PipRow label="Stress" value={ps.stress} field="stress" colorFn={v => v <= 2 ? 'var(--green)' : v === 3 ? 'var(--amber)' : 'var(--red)'} />
        <PipRow label="Energy" value={ps.energy} field="energy" colorFn={() => 'var(--green)'} />
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>Distractions</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
            {DISTRACTIONS.map(d => {
              const sel = ps.distractions.includes(d);
              const isNone = d === 'None';
              return (
                <button key={d} type="button" onClick={() => toggleDistraction(d)}
                  style={{ padding:'2px 6px', fontSize:9, borderRadius:2, border:`1px solid ${sel?(isNone?'var(--green-border)':'var(--amber-border)'):'var(--app-border)'}`, background:sel?(isNone?'var(--green-dim)':'var(--amber-dim)'):'transparent', color:sel?(isNone?'var(--green)':'var(--amber)'):'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                  {d}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>Environment</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>
            {ENVIRONMENTS.map(e => {
              const sel = ps.environment === e;
              return (
                <button key={e} type="button" onClick={() => update({ environment: sel ? '' : e })}
                  style={{ padding:'2px 6px', fontSize:9, borderRadius:2, border:`1px solid ${sel?'var(--amber-border)':'var(--app-border)'}`, background:sel?'var(--amber-dim)':'transparent', color:sel?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                  {e}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── I — ProcessScoreBlock ─────────────────────────────────────────────────────
function ProcessScoreBlock({ trade, entries, navigate, onSaveEntries }: { trade: JournalTrade; entries: JournalEntry[]; navigate: (path: string) => void; onSaveEntries: () => void }) {
  const score = computeProcessScore(trade);
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B+' : score >= 60 ? 'B' : score >= 50 ? 'C+' : 'C';
  const scoreColor = score >= 70 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
  const flags = trade.behavioralFlags ?? [];

  const allTrades = entries.flatMap(e => e.trades);
  const wins = allTrades.filter(t => t.result === 'win' && (t.processScore ?? computeProcessScore(t)) > 0);
  const losses = allTrades.filter(t => t.result === 'loss' && (t.processScore ?? computeProcessScore(t)) > 0);
  const avgWinScore = wins.length ? Math.round(wins.reduce((s, t) => s + (t.processScore ?? computeProcessScore(t)), 0) / wins.length) : null;
  const avgLossScore = losses.length ? Math.round(losses.reduce((s, t) => s + (t.processScore ?? computeProcessScore(t)), 0) / losses.length) : null;

  const insights: Array<{ text: string; color: string }> = [];
  if (flags.length > 0) insights.push({ text: `${flags.length} behavioral flag${flags.length > 1 ? 's' : ''} reduced your score by ${Math.min(flags.length * 8, 40)} points`, color: 'var(--red)' });
  if (avgWinScore !== null && avgLossScore !== null) insights.push({ text: `Your avg score on wins is ${avgWinScore} vs ${avgLossScore} on losses`, color: 'var(--app-text-muted)' });
  const conf = trade.preEntry?.confidenceAtEntry ?? 0;
  const disc = trade.psychologyRatings?.discipline ?? 0;
  if (conf >= 4 && disc <= 2) insights.push({ text: 'Confidence was high but discipline was low — review your sizing decision', color: 'var(--amber)' });

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'14px 16px', marginBottom:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:20, marginBottom:12 }}>
        <div>
          <div style={{ fontSize:32, fontWeight:600, fontFamily:'var(--font-mono)', color:scoreColor, lineHeight:1 }}>{score > 0 ? score : '—'}</div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginTop:2 }}>Process Score</div>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ height:4, borderRadius:2, background:'var(--app-panel-strong)', overflow:'hidden', marginBottom:8 }}>
            <div style={{ height:'100%', borderRadius:2, background:scoreColor, width:`${score}%`, transition:'width 0.3s ease' }} />
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            {insights.map((ins, i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                <span style={{ width:6, height:6, borderRadius:'50%', background:ins.color, flexShrink:0, marginTop:3 }} />
                <span style={{ fontSize:11, color:'var(--app-text-muted)' }}>{ins.text}</span>
              </div>
            ))}
            {insights.length === 0 && score > 0 && (
              <span style={{ fontSize:11, color:'var(--app-text-subtle)' }}>Complete more fields to see insights</span>
            )}
          </div>
        </div>
        <div style={{ fontSize:24, fontWeight:700, fontFamily:'var(--font-mono)', color:scoreColor }}>{score > 0 ? grade : '—'}</div>
      </div>
      <button type="button" onClick={() => { onSaveEntries(); navigate(`/flyxa-ai/ask?tradeId=${trade.id}`); }}
        style={{ width:'100%', padding:'10px 16px', fontSize:12, fontWeight:600, fontFamily:'var(--font-sans)', background:'var(--cobalt)', color:'#fff', border:'none', borderRadius:5, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
        ✦ Analyse this trade with Flyxa AI →
      </button>
    </div>
  );
}

export default function TradeJournal() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { preferences, accounts, selectedAccountId } = useAppSettings();
  const { user } = useAuth();
  const { deleteTrade: deleteTradeEverywhere, createTrade } = useTrades();
  const persistedEntries = useFlyxaStore(state => state.entries);
  const setEntriesInStore = useFlyxaStore(state => state.setEntries);
  const rulesTemplate = useMemo(() => getRulesTemplate(), []);
  const entries = useMemo(() => normalizeEntries(persistedEntries, rulesTemplate), [persistedEntries, rulesTemplate]);

  const recentForm = useMemo(() => {
    const allTrades = entries.flatMap(e =>
      e.trades.filter(t => t.result !== 'open').map(t => ({ ...t, entryDate: e.date }))
    );
    const sorted = [...allTrades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const last10 = sorted.slice(-10);

    // Sparkline: cumulative P&L starting from 0 before first trade
    const cumPnl = [0];
    last10.forEach(t => { cumPnl.push(cumPnl[cumPnl.length - 1] + t.pnl); });
    const SW = 240, SH = 48, SP = 4;
    const minV = Math.min(...cumPnl);
    const maxV = Math.max(...cumPnl);
    const vRange = maxV - minV || 1;
    const toX = (i: number) => SP + (i / Math.max(cumPnl.length - 1, 1)) * (SW - 2 * SP);
    const toY = (v: number) => SH - SP - ((v - minV) / vRange) * (SH - 2 * SP);
    const sparkPoints = cumPnl.map((v, i) => ({ x: toX(i), y: toY(v) }));
    const sparkZeroY = Math.max(SP, Math.min(SH - SP, toY(0)));
    const sparkPositive = cumPnl[cumPnl.length - 1] >= 0;

    // 7-day rolling stats
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(now.getDate() - 6);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const last7d = allTrades.filter(t => t.entryDate >= cutoffStr);
    const wins7d = last7d.filter(t => t.result === 'win').length;
    const total7d = last7d.length;
    const netPnl7d = last7d.reduce((s, t) => s + t.pnl, 0);

    return {
      last10,
      winsLast10: last10.filter(t => t.result === 'win').length,
      lossesLast10: last10.filter(t => t.result !== 'win').length,
      sparkPoints,
      sparkZeroY,
      sparkPositive,
      total7d,
      winRate7d: total7d > 0 ? (wins7d / total7d) * 100 : null,
      netPnl7d: total7d > 0 ? netPnl7d : null,
      avgPnl7d: total7d > 0 ? netPnl7d / total7d : null,
    };
  }, [entries]);

  const [monthCursor, setMonthCursor] = useState(() => {
    const today = parseDate(getTodayIso(preferences.timezone));
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [query, setQuery] = useState('');
  const [activeTradeId, setActiveTradeId] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanPreviewUrl, setScanPreviewUrl] = useState('');
  const [deleteTradeId, setDeleteTradeId] = useState<string | null>(null);
  const [selectedTradeIds, setSelectedTradeIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [deleteEntryConfirm, setDeleteEntryConfirm] = useState(false);
  const [isScreenshotFullscreen, setIsScreenshotFullscreen] = useState(false);
  const [isTradeDateEditorOpen, setIsTradeDateEditorOpen] = useState(false);
  const [tradeDateDraft, setTradeDateDraft] = useState(getTodayIso(preferences.timezone));
  const [showCSVImport, setShowCSVImport] = useState(false);

  // Collapsible section state — persisted to localStorage
  const COLLAPSE_KEY = 'flyxa-journal-sections';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}'); } catch { return {}; }
  });
  const toggleSection = (key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const screenshotInputRef = useRef<HTMLInputElement>(null);
  const screenshotSlotRef = useRef<number | null>(null);
  const supportingImageInputRef = useRef<HTMLInputElement>(null);

  const [viewingImageIndex, setViewingImageIndex] = useState(0);
  const [slideDir, setSlideDir] = useState<'left' | 'right'>('right');

  // Editable entry time / duration drafts
  const [draftEntryTime, setDraftEntryTime] = useState('');
  const [draftDuration, setDraftDuration] = useState('');

  const mutateEntries = useCallback((updater: (prev: JournalEntry[]) => JournalEntry[]) => {
    const current = normalizeEntries(useFlyxaStore.getState().entries as unknown[], rulesTemplate);
    const next = updater(current);
    setEntriesInStore(next as unknown as StoreJournalEntry[]);
    void flushSupabaseStoreNow().catch(() => {
      // Best effort: local persist already happened; cloud sync can retry on next write.
    });
  }, [rulesTemplate, setEntriesInStore]);

  const handleCSVImport = useCallback(async (trades: Array<{
    symbol: string; direction: 'Long' | 'Short';
    entry_price: number; exit_price: number; pnl: number; trade_date: string;
    trade_time?: string; close_time?: string; contract_size?: number;
    sl_price?: number; tp_price?: number; pre_trade_notes?: string;
    followed_plan?: boolean; emotional_state?: string; confluences?: string[];
  }>) => {
    let ok = 0;
    for (const t of trades) {
      try {
        await createTrade({
          symbol: t.symbol,
          direction: t.direction,
          entry_price: t.entry_price,
          exit_price: t.exit_price,
          sl_price: t.sl_price ?? t.entry_price,
          tp_price: t.tp_price ?? t.entry_price,
          exit_reason: t.pnl > 0 ? 'TP' : t.pnl < 0 ? 'SL' : 'BE',
          pnl: t.pnl,
          pnlOverride: t.pnl,
          contract_size: t.contract_size ?? 1,
          trade_date: t.trade_date,
          trade_time: t.trade_time ?? '09:30',
          close_time: t.close_time ?? null,
          pre_trade_notes: t.pre_trade_notes ?? '',
          post_trade_notes: '',
          followed_plan: t.followed_plan ?? null,
          emotional_state: t.emotional_state ?? null,
          confluences: t.confluences ?? [],
        });
        ok++;
      } catch {
        // skip individual failures, count successes
      }
    }
    pushToast({ tone: 'green', durationMs: 4000, message: `Imported ${ok} trade${ok !== 1 ? 's' : ''} from CSV` });
    void flushSupabaseStoreNow().catch(() => {});
  }, [createTrade]);

  const mutateTradeFields = useCallback((tradeId: string, fields: Partial<JournalTrade>) => {
    if (!selectedEntryId) return;
    mutateEntries(prev => prev.map(entry => {
      if (entry.id !== selectedEntryId) return entry;
      return {
        ...entry,
        trades: entry.trades.map(trade => {
          if (trade.id !== tradeId) return trade;
          return withTradeDerivedValues({ ...trade, ...fields });
        }),
      };
    }));
  }, [mutateEntries, selectedEntryId]);


  useEffect(() => {
    if (!entries.length) {
      setSelectedEntryId(null);
      return;
    }
    if (!selectedEntryId || !entries.some(entry => entry.id === selectedEntryId)) {
      const mostRecent = [...entries].sort((a, b) => b.date.localeCompare(a.date))[0];
      setSelectedEntryId(mostRecent.id);
    }
  }, [entries, selectedEntryId]);

  useEffect(() => {
    const date = params.get('date');
    const tradeId = params.get('tradeId');
    if (!date) return;
    const targetEntry = entries.find(entry => entry.date === date);
    if (!targetEntry) return;
    setSelectedEntryId(targetEntry.id);
    if (tradeId) setActiveTradeId(tradeId);
    setShowScanner(false);
  }, [entries, params]);

  useEffect(() => {
    const currentSelected = entries.find(entry => entry.id === selectedEntryId) ?? null;
    if (!currentSelected || !currentSelected.trades.length) {
      setActiveTradeId(null);
      return;
    }
    if (!activeTradeId || !currentSelected.trades.some(trade => trade.id === activeTradeId)) {
      setActiveTradeId(currentSelected.trades[0].id);
    }
  }, [activeTradeId, entries, selectedEntryId]);

  const entriesInMonth = useMemo(
    () => entries.filter(entry => inMonth(entry.date, monthCursor)),
    [entries, monthCursor],
  );

  const tradedEntriesInMonth = useMemo(
    () => entriesInMonth.filter(entry => entry.trades.length > 0),
    [entriesInMonth],
  );

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entriesInMonth
      .filter(entry => {
        const stats = computeEntryStats(entry);
        // Win/loss/untagged filters only apply to days with trades
        if (entry.trades.length > 0) {
          if (dayFilter === 'win' && stats.pnl <= 0) return false;
          if (dayFilter === 'loss' && stats.pnl >= 0) return false;
          if (dayFilter === 'untagged' && entry.emotions.some(emotion => emotion.state !== 'neutral')) return false;
        } else if (dayFilter !== 'all') {
          // Blank days are hidden when a specific filter is active
          return false;
        }
        if (!needle) return true;
        const symbolMatch = entry.trades.some(trade => trade.symbol.toLowerCase().includes(needle));
        const noteMatch = `${entry.reflection.pre} ${entry.reflection.post} ${entry.reflection.lessons}`.toLowerCase().includes(needle);
        return symbolMatch || noteMatch;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [dayFilter, entriesInMonth, query]);

  const selectedEntry = useMemo(
    () => entries.find(entry => entry.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );

  const activeTrade = useMemo(() => {
    if (!selectedEntry || !selectedEntry.trades.length) return null;
    return selectedEntry.trades.find(trade => trade.id === activeTradeId) ?? selectedEntry.trades[0];
  }, [activeTradeId, selectedEntry]);

  useEffect(() => {
    if (!selectedEntry || !activeTrade) return;
    setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
    setIsTradeDateEditorOpen(false);
  }, [activeTrade?.id, selectedEntry?.id, selectedEntry?.date]);

  const monthSummary = useMemo(() => {
    const dayPnL = tradedEntriesInMonth.map(entry => computeEntryStats(entry).pnl);
    const monthPnl = dayPnL.reduce((sum, pnl) => sum + pnl, 0);
    const daysTraded = tradedEntriesInMonth.length;
    let wins = 0;
    let losses = 0;
    tradedEntriesInMonth.forEach(entry => {
      const stats = computeEntryStats(entry);
      wins += stats.wins;
      losses += stats.losses;
    });
    const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
    const bestDay = findBestDay(tradedEntriesInMonth);
    return { monthPnl, daysTraded, winRate, bestDay };
  }, [tradedEntriesInMonth]);

  const addBlankDay = useCallback(() => {
    // Always create for today — never inherit the currently-viewed entry's date
    const date = getTodayIso(preferences.timezone);
    const existing = entries.find(entry => entry.date === date);
    if (existing) {
      setSelectedEntryId(existing.id);
      setShowScanner(false);
      return;
    }
    const blank = createEmptyEntry(date, rulesTemplate);
    mutateEntries(prev => [blank, ...prev]);
    setSelectedEntryId(blank.id);
    setShowScanner(false);
  }, [entries, mutateEntries, preferences.timezone, rulesTemplate]);

  const saveTradeDate = useCallback(() => {
    if (!selectedEntry || !activeTrade) return;
    const nextDate = tradeDateDraft.trim();
    if (!isValidIsoDate(nextDate)) {
      pushToast({ tone: 'red', durationMs: 3000, message: 'Enter a valid date (YYYY-MM-DD).' });
      return;
    }
    if (nextDate > getTodayIso(preferences.timezone)) {
      pushToast({ tone: 'red', durationMs: 3000, message: 'Trade date cannot be in the future.' });
      return;
    }

    const currentTradeDate = getTradeDateValue(activeTrade, selectedEntry.date);
    // Only skip the move if the date hasn't changed AND the trade is already in the right entry
    if (nextDate === currentTradeDate && selectedEntry.date === nextDate) {
      setIsTradeDateEditorOpen(false);
      return;
    }

    let nextSelectedId: string | null = null;
    mutateEntries((prev) => {
      let movedTrade: JournalTrade | null = null;
      const withoutTrade = prev.map((entry) => {
        const tradeIdx = entry.trades.findIndex((trade) => trade.id === activeTrade.id);
        if (tradeIdx < 0) return entry;
        movedTrade = entry.trades[tradeIdx];
        return {
          ...entry,
          trades: entry.trades.filter((trade) => trade.id !== activeTrade.id),
        };
      });

      if (!movedTrade) return prev;
      const tradeToMove = movedTrade as JournalTrade;
      const movedWithDate = withTradeDerivedValues({ ...tradeToMove, date: nextDate });
      const target = withoutTrade.find((entry) => entry.date === nextDate);

      if (target) {
        nextSelectedId = target.id;
        return withoutTrade.map((entry) => (
          entry.id === target.id
            ? { ...entry, trades: [movedWithDate, ...entry.trades] }
            : entry
        ));
      }

      const created = createEmptyEntry(nextDate, rulesTemplate);
      created.trades = [movedWithDate];
      nextSelectedId = created.id;
      return [created, ...withoutTrade];
    });

    if (nextSelectedId) {
      setSelectedEntryId(nextSelectedId);
      setActiveTradeId(activeTrade.id);
    }
    const parsed = parseDate(nextDate);
    setMonthCursor(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    setIsTradeDateEditorOpen(false);
    pushToast({ tone: 'green', durationMs: 3000, message: 'Trade moved to selected date.' });
  }, [activeTrade, mutateEntries, rulesTemplate, selectedEntry, tradeDateDraft]);

  const goToScanner = useCallback(() => {
    setShowScanner(true);
    navigate('/scanner');
  }, [navigate]);

  const addManualTrade = useCallback(() => {
    if (!selectedEntry) return;
    const entryAccount = accounts.find(a => a.id === selectedEntry.account);
    if (entryAccount?.status === 'Passed') return;
    const basePrice = 0;
    const newTrade: JournalTrade = {
      id: crypto.randomUUID(),
      date: selectedEntry.date,
      symbol: 'NQ',
      direction: 'LONG',
      entryTime: getNowTime(),
      exitTime: getNowTime(),
      durationMinutes: null,
      entryPrice: basePrice,
      exitPrice: basePrice,
      entry: undefined,
      exit: undefined,
      priceLevelsSource: 'manual',
      priceLevelsEdited: false,
      contracts: 1,
      rr: 0,
      pnl: 0,
      result: 'open',
      confluences: [],
    };
    mutateEntries(prev => prev.map(entry => entry.id === selectedEntry.id ? { ...entry, trades: [withTradeDerivedValues(newTrade), ...entry.trades] } : entry));
  }, [accounts, mutateEntries, selectedEntry]);

  const applyScannedTrade = useCallback((fileDataUrl: string, trade: JournalTrade, date: string) => {
    let nextSelectedId: string | null = null;
    mutateEntries(prev => {
      const existing = prev.find(entry => entry.id === selectedEntryId) ?? prev.find(entry => entry.date === date);
      if (existing) {
        nextSelectedId = existing.id;
        return prev.map(entry => {
          if (entry.id !== existing.id) return entry;
          const shots = [...entry.screenshots];
          shots[0] = fileDataUrl;
          return {
            ...entry,
            scannedImageUrl: fileDataUrl,
            screenshots: shots,
            trades: [trade, ...entry.trades],
          };
        });
      }
      const created = createEmptyEntry(date, rulesTemplate);
      created.scannedImageUrl = fileDataUrl;
      created.screenshots[0] = fileDataUrl;
      created.trades = [trade];
      nextSelectedId = created.id;
      return [created, ...prev];
    });
    if (nextSelectedId) {
      setSelectedEntryId(nextSelectedId);
    }
    const scannedMonth = parseDate(date);
    setMonthCursor(new Date(scannedMonth.getFullYear(), scannedMonth.getMonth(), 1));
    setActiveTradeId(trade.id);
  }, [mutateEntries, rulesTemplate, selectedEntryId, setMonthCursor]);

  const handleScanFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setScanError('Upload an image file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setScanError('File is larger than 10MB.');
      return;
    }

    setScanError('');
    setIsScanning(true);
    const tradeDate = inferTradeDateFromFileName(file.name) ?? selectedEntry?.date ?? getTodayIso(preferences.timezone);
    const tradeTime = getNowTime();
    let scanSucceeded = false;

    try {
      const fileDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.readAsDataURL(file);
      });
      setScanPreviewUrl(fileDataUrl);

      const { focusImages, scannerContext, uploadImage } = await buildScannerAssets(file);
      const colors = preferences.scannerColors;
      const context = {
        ...(scannerContext ?? {}),
        scanner_colors: {
          entryZone: { hex: colors?.entry ?? '#E67E22' },
          supplyStopZone: { hex: colors?.stopLoss ?? '#C0392B' },
          targetDemandZone: { hex: colors?.takeProfit ?? '#1A6B5A' },
        },
      };
      const extracted = await scanChart(uploadImage, tradeDate, tradeTime, focusImages, context);

      const normalizedSymbol = normalizeResolvedSymbol(extracted.symbol) ?? inferSymbolFromFileName(file.name) ?? 'NQ';
      const direction: TradeDirection = extracted.direction === 'Short' ? 'SHORT' : 'LONG';
      const scannerEntry = parsePrice(extracted.entry_price ?? undefined);
      const scannerTp = parsePrice(extracted.tp_price ?? undefined);
      const scannerSl = parsePrice(extracted.sl_price ?? undefined);
      if (scannerEntry === undefined || scannerTp === undefined || scannerSl === undefined) {
        const warningSuffix = Array.isArray(extracted.warnings) && extracted.warnings.length > 0
          ? ` ${extracted.warnings[0]}`
          : '';
        throw new Error(`Scanner could not read entry/stop/target from this chart.${warningSuffix}`);
      }
      const scannerExit = extracted.exit_reason === 'SL' ? scannerSl : extracted.exit_reason === 'TP' ? scannerTp : undefined;
      const entryPrice = scannerEntry ?? 0;
      const exitPrice = scannerExit ?? 0;
      const entryTime = typeof extracted.entry_time === 'string' ? extracted.entry_time.slice(0, 5) : tradeTime;
      const closeTime = typeof extracted.close_time === 'string'
        ? extracted.close_time.slice(0, 5)
        : addSecondsToTime(entryTime, extracted.trade_length_seconds ?? null) ?? entryTime;
      const durationFromSeconds = typeof extracted.trade_length_seconds === 'number'
        ? Math.max(1, Math.round(extracted.trade_length_seconds / 60))
        : null;
      const durationFromTimeRange = minutesBetweenTimes(entryTime, closeTime);
      const durationMinutes = durationFromSeconds ?? durationFromTimeRange;

      const screenshotUrl = user
        ? await uploadScreenshot(fileDataUrl, user.id)
        : fileDataUrl;

      const trade: JournalTrade = {
        id: crypto.randomUUID(),
        date: tradeDate,
        symbol: normalizedSymbol,
        direction,
        entryTime,
        exitTime: closeTime,
        durationMinutes,
        entryPrice,
        exitPrice,
        entry: scannerEntry,
        exit: scannerExit,
        sl: scannerSl,
        tp: scannerTp,
        priceLevelsSource: 'ai',
        priceLevelsEdited: false,
        contracts: 1,
        rr: 0,
        pnl: 0,
        result: 'open',
        screenshotUrl,
        confluences: [],
      };

      applyScannedTrade(screenshotUrl, withTradeDerivedValues(trade), tradeDate);
      scanSucceeded = true;
      pushToast({ tone: 'green', durationMs: 3000, message: 'Trade scanned and saved' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scan failed.';
      const lowered = message.toLowerCase();
      if (lowered.includes('503') || lowered.includes('high demand') || lowered.includes('service unavailable')) {
        setScanError('Scanner AI is temporarily busy. Please retry in 10-20 seconds.');
      } else if (lowered.includes('failed to fetch')) {
        setScanError('Could not reach the scanner service. Check that backend is running on http://localhost:3001, then scan again.');
      } else {
        setScanError(message);
      }
    } finally {
      setIsScanning(false);
      if (scanSucceeded) {
        setScanPreviewUrl('');
      }
    }
  }, [applyScannedTrade, preferences.scannerColors, selectedEntry?.date]);

  const deleteEntry = useCallback(() => {
    if (!selectedEntry) return;
    mutateEntries(prev => prev.filter(e => e.id !== selectedEntry.id));
    setDeleteEntryConfirm(false);
  }, [mutateEntries, selectedEntry]);

  const onShotPick = useCallback((index: number) => {
    screenshotSlotRef.current = index;
    screenshotInputRef.current?.click();
  }, []);

  const onShotFile = useCallback(async (file: File) => {
    if (!selectedEntry) return;
    const slot = screenshotSlotRef.current;
    if (slot === null) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('Could not read screenshot.'));
      reader.readAsDataURL(file);
    });
    const url = user ? await uploadScreenshot(dataUrl, user.id) : dataUrl;
    const currentTradeId = activeTradeId;
    mutateEntries(prev => prev.map(entry => {
      if (entry.id !== selectedEntry.id) return entry;
      const nextScreenshots = [...entry.screenshots];
      nextScreenshots[slot] = url;
      const nextTrades = entry.trades.map(t =>
        t.id === currentTradeId ? { ...t, screenshotUrl: url } : t
      );
      return { ...entry, screenshots: nextScreenshots, trades: nextTrades };
    }));
    screenshotSlotRef.current = null;
  }, [activeTradeId, mutateEntries, selectedEntry, user]);

  const onSupportingImageFile = useCallback(async (file: File) => {
    if (!activeTrade || !selectedEntry) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('Could not read image.'));
      reader.readAsDataURL(file);
    });
    const url = user ? await uploadScreenshot(dataUrl, user.id) : dataUrl;
    mutateTradeFields(activeTrade.id, {
      supportingImages: [...(activeTrade.supportingImages ?? []), url],
    });
    // navigate to the newly added image
    setViewingImageIndex((activeTrade.supportingImages?.length ?? 0) + 1);
  }, [activeTrade, mutateTradeFields, selectedEntry, user]);

  // Reset image carousel when switching trades
  useEffect(() => {
    setViewingImageIndex(0);
  }, [activeTradeId]);

  // Sync editable drafts when active trade changes
  useEffect(() => {
    setDraftEntryTime(activeTrade?.entryTime ?? '');
    setDraftDuration(activeTrade?.durationMinutes != null ? String(activeTrade.durationMinutes) : '');
  }, [activeTrade?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only show a screenshot when the entry has trades — don't surface the scanner
  // image on blank days where the AI found no trades.
  const primaryScreenshot = selectedEntry && selectedEntry.trades.length > 0
    ? (activeTrade?.screenshotUrl || selectedEntry.screenshots[0] || selectedEntry.scannedImageUrl || '')
    : '';

  const allTradeImages = [
    ...(primaryScreenshot ? [primaryScreenshot] : []),
    ...(activeTrade?.supportingImages ?? []),
  ];
  const clampedIndex = Math.min(viewingImageIndex, Math.max(0, allTradeImages.length - 1));
  const currentImage = allTradeImages[clampedIndex] ?? '';

  function navImage(dir: 'left' | 'right') {
    setSlideDir(dir);
    setViewingImageIndex(i =>
      dir === 'right' ? Math.min(i + 1, allTradeImages.length - 1) : Math.max(i - 1, 0),
    );
  }

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [dayPanelOpen, setDayPanelOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => {
    const handler = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setDayPanelOpen(true);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return (
    <div className="tj-shell">
      <input
        ref={screenshotInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void onShotFile(file);
          event.target.value = '';
        }}
      />
      <input
        ref={supportingImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void onSupportingImageFile(file);
          event.target.value = '';
        }}
      />

      {/* Mobile overlay backdrop */}
      {isMobile && dayPanelOpen && (
        <div
          onClick={() => setDayPanelOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 9988, background: 'rgba(0,0,0,0.45)' }}
        />
      )}

      {/* Persistent left-edge arrow tab (mobile only) */}
      {isMobile && (
        <button
          type="button"
          aria-label={dayPanelOpen ? 'Close day panel' : 'Open day panel'}
          onClick={() => setDayPanelOpen(prev => !prev)}
          style={{
            position: 'fixed',
            left: dayPanelOpen ? 260 : 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 9990,
            width: 20,
            height: 44,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderLeft: 'none',
            borderRadius: '0 6px 6px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'left 0.22s ease',
            padding: 0,
          }}
        >
          {dayPanelOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </button>
      )}

      <aside
        className="tj-day-panel"
        data-tour-id="scanner-day-panel"
        style={isMobile ? {
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: 260,
          zIndex: 9989,
          overflowY: 'auto',
          transform: dayPanelOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.22s ease',
        } : undefined}
      >
        <div className="tj-day-header">
          <div className="tj-day-top">
            <p className="tj-month-title">{formatMonth(monthCursor)}</p>
            <span className="tj-nav-group">
              <button type="button" className="tj-nav" onClick={() => setMonthCursor(prev => shiftMonth(prev, -1))}>
                <ChevronLeft size={13} />
              </button>
              <button type="button" className="tj-nav" onClick={() => setMonthCursor(prev => shiftMonth(prev, 1))}>
                <ChevronRight size={13} />
              </button>
            </span>
          </div>
          <button
            data-tour-id="scanner-import"
            type="button"
            className="tj-import-csv-btn"
            title="Import trades from Notion or broker CSV"
            onClick={() => setShowCSVImport(true)}
          >
            <Upload size={13} />
            <span>Import trades from CSV</span>
          </button>

          <div className="tj-month-grid">
            <div className="tj-month-cell">
              <div className="tj-month-label">Month P&amp;L</div>
              <div className={`tj-month-value ${monthSummary.monthPnl > 0 ? 'pos' : monthSummary.monthPnl < 0 ? 'neg' : 'zero'}`}>
                {formatSignedCurrency(monthSummary.monthPnl)}
              </div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Win Rate</div>
              <div className="tj-month-value">{toPercent(monthSummary.winRate)}</div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Days Traded</div>
              <div className="tj-month-value">{monthSummary.daysTraded}</div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Best Day</div>
              <div className={`tj-month-value ${(monthSummary.bestDay ?? 0) > 0 ? 'pos' : 'zero'}`}>
                {monthSummary.bestDay === null ? '--' : formatSignedCurrency(monthSummary.bestDay)}
              </div>
            </div>
          </div>
        </div>

        {/* Recent Form */}
        {recentForm.last10.length > 0 && (
          <div style={{ padding: '10px 14px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.015)', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' } as React.CSSProperties}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txt-3)', margin: '0 0 8px' }}>
              Recent Form
            </p>
            {/* Equity curve sparkline */}
            {recentForm.sparkPoints.length >= 2 && (
              <svg viewBox="0 0 240 48" width="100%" height={48} style={{ display: 'block', overflow: 'visible' }}>
                <defs>
                  <linearGradient id="rfSparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={recentForm.sparkPositive ? '#34d399' : '#f87171'} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={recentForm.sparkPositive ? '#34d399' : '#f87171'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                {/* Zero / breakeven line */}
                <line x1={4} y1={recentForm.sparkZeroY} x2={236} y2={recentForm.sparkZeroY} stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="3,3" />
                {/* Area fill */}
                <polygon
                  points={[
                    `${recentForm.sparkPoints[0].x.toFixed(1)},${recentForm.sparkZeroY.toFixed(1)}`,
                    ...recentForm.sparkPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
                    `${recentForm.sparkPoints[recentForm.sparkPoints.length - 1].x.toFixed(1)},${recentForm.sparkZeroY.toFixed(1)}`,
                  ].join(' ')}
                  fill="url(#rfSparkGrad)"
                />
                {/* Line */}
                <polyline
                  points={recentForm.sparkPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
                  fill="none"
                  stroke={recentForm.sparkPositive ? '#34d399' : '#f87171'}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {/* End dot */}
                <circle
                  cx={recentForm.sparkPoints[recentForm.sparkPoints.length - 1].x}
                  cy={recentForm.sparkPoints[recentForm.sparkPoints.length - 1].y}
                  r={2.5}
                  fill={recentForm.sparkPositive ? '#34d399' : '#f87171'}
                />
              </svg>
            )}
            {/* W/L count */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '6px 0 9px' }}>
              <span style={{ fontSize: 10, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'rgba(52,211,153,0.75)' }}>{recentForm.winsLast10}W</span>
              <span style={{ fontSize: 9, color: 'var(--txt-3)' }}>·</span>
              <span style={{ fontSize: 10, fontWeight: 500, fontFamily: 'var(--font-mono)', color: 'rgba(248,113,113,0.75)' }}>{recentForm.lossesLast10}L</span>
              <span style={{ fontSize: 9, color: 'var(--txt-3)', marginLeft: 2 }}>last {recentForm.last10.length}</span>
            </div>
            {/* 7-day stats */}
            {recentForm.total7d > 0 && (
              <div style={{ display: 'flex', gap: 12 }}>
                {recentForm.winRate7d !== null && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-mono)', lineHeight: 1.2, color: recentForm.winRate7d >= 50 ? 'rgba(52,211,153,0.75)' : 'rgba(248,113,113,0.75)' }}>
                      {recentForm.winRate7d.toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>7d WR</div>
                  </div>
                )}
                {recentForm.netPnl7d !== null && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-mono)', lineHeight: 1.2, color: recentForm.netPnl7d >= 0 ? 'rgba(52,211,153,0.75)' : 'rgba(248,113,113,0.75)' }}>
                      {formatSignedCurrency(recentForm.netPnl7d)}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>7d P&L</div>
                  </div>
                )}
                {recentForm.avgPnl7d !== null && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-mono)', lineHeight: 1.2, color: recentForm.avgPnl7d >= 0 ? 'rgba(52,211,153,0.75)' : 'rgba(248,113,113,0.75)' }}>
                      {formatSignedCurrency(recentForm.avgPnl7d)}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>avg/trade</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="tj-search-row" data-tour-id="scanner-search">
          <Search size={13} color="var(--txt-3)" />
          <input
            className="tj-search-input"
            placeholder="Search entries..."
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>

        <div className="tj-chip-row">
          {[
            { key: 'all', label: 'All' },
            { key: 'win', label: 'Win days' },
            { key: 'loss', label: 'Loss days' },
            { key: 'untagged', label: 'Untagged' },
          ].map(chip => (
            <button
              key={chip.key}
              type="button"
              className={`tj-chip ${dayFilter === chip.key ? 'sel' : ''}`}
              onClick={() => setDayFilter(chip.key as DayFilter)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="tj-day-list">
          {visibleEntries.length ? (
            visibleEntries.map(entry => {
              const stats = computeEntryStats(entry);
              const day = parseDate(entry.date).getDate();
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`tj-day-item ${selectedEntryId === entry.id ? 'active' : ''}`}
                  onClick={() => { setSelectedEntryId(entry.id); setShowScanner(false); if (isMobile) setDayPanelOpen(false); }}
                >
                  <div className="tj-date-col">
                    <div className="tj-day-num">{day}</div>
                    <div className="tj-weekday">{formatWeekday(entry.date)}</div>
                  </div>
                  <div className="tj-day-body">
                    {entry.trades.length > 0 ? (
                      <>
                        <div className={`tj-day-pnl ${stats.pnl > 0 ? 'pos' : stats.pnl < 0 ? 'neg' : ''}`}>{formatSignedCurrency(stats.pnl)}</div>
                        <div className="tj-day-meta">{`${stats.wins}W | ${stats.losses}L | ${stats.tradeCount} trades`}</div>
                      </>
                    ) : (
                      <>
                        <div className="tj-day-pnl" style={{ opacity: 0.35 }}>—</div>
                        <div className="tj-day-meta" style={{ opacity: 0.45 }}>No trades</div>
                      </>
                    )}
                  </div>
                  {(() => {
                    if (entry.trades.length === 0) return <div className="tj-day-grade g-none" style={{ opacity: 0.25 }}>—</div>;
                    const scored = entry.trades.map(t => computeProcessScore(t)).filter(s => s > 0);
                    const avgScore = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
                    const letter = scoreToGradeLetter(avgScore);
                    return <div className={`tj-day-grade g-${gradeCssKey(letter)}`}>{letter}</div>;
                  })()}
                </button>
              );
            })
          ) : (
            <div className="tj-day-empty">
              <div className="tj-day-empty-box">
                <div className="tj-day-empty-icon"><FileText size={16} /></div>
                <p className="tj-day-empty-title">No entries yet</p>
                <p className="tj-day-empty-sub">Log your first trade below.</p>
                <button type="button" className="tj-day-empty-btn" onClick={goToScanner}>
                  <Plus size={11} />
                  Log Trade
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <section className="tj-entry-panel" data-tour-id="scanner-entry-panel">
        {!showScanner && selectedEntry ? (
          <>
            <div className="tj-sticky-head">
              <div>
                <div className="tj-entry-title-row">
                  <p className="tj-entry-title">{formatDateTitle(selectedEntry.date)}</p>
                </div>
                <p className="tj-entry-sub">
                  {(() => {
                    // Use the globally selected account; fall back to the trade's own account
                    // when "All Accounts" is active or the selected account can't be found.
                    const resolvedId =
                      selectedAccountId && selectedAccountId !== DEFAULT_ACCOUNT_ID
                        ? selectedAccountId
                        : activeTrade?.accountId;
                    const acct = accounts.find(a => a.id === resolvedId);
                    return acct ? `${acct.name} | ${acct.type}` : null;
                  })()} | <strong>{formatSignedCurrency(computeEntryStats(selectedEntry).pnl)}</strong>
                </p>
                {activeTrade && !deleteEntryConfirm && (
                  <div className="tj-date-edit-row">
                    <span className="tj-entry-sub" style={{ margin: 0 }}>
                      Trade date: {getTradeDateValue(activeTrade, selectedEntry.date)}
                    </span>
                    <button
                      type="button"
                      className="tj-mini-btn"
                      onClick={() => {
                        setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
                        setIsTradeDateEditorOpen(true);
                      }}
                    >
                      Edit trade date
                    </button>
                  </div>
                )}
                {isTradeDateEditorOpen && activeTrade && !deleteEntryConfirm && (
                  <div className="tj-date-edit-row">
                    <DatePicker
                      className="tj-date-edit-input"
                      value={tradeDateDraft}
                      onChange={setTradeDateDraft}
                      compact
                      align="left"
                      max={getTodayIso(preferences.timezone)}
                    />
                    <button type="button" className="tj-mini-btn" onClick={saveTradeDate}>Save</button>
                    <button type="button" className="tj-mini-btn" onClick={() => {
                      setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
                      setIsTradeDateEditorOpen(false);
                    }}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div className="tj-head-actions">
                {deleteEntryConfirm ? (
                  <>
                    <span className="tj-delete-text">Delete this day?</span>
                    <button type="button" className="tj-mini-btn" onClick={() => setDeleteEntryConfirm(false)}>Cancel</button>
                    <button type="button" className="tj-mini-btn red" onClick={deleteEntry}>Delete</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="tj-btn-ghost" onClick={() => setDeleteEntryConfirm(true)}>
                      <Trash2 size={13} />
                      Delete
                    </button>
                    <button type="button" className="tj-btn-primary tj-btn-save" onClick={goToScanner} data-tour-id="scanner-log-trade-button">
                      <Plus size={13} />
                      Log trade
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="tj-entry-body">
              <div className="tj-stats" data-tour-id="scanner-trade-stats">
                <div className="tj-stat">
                  <div className="tj-stat-label">Net P&amp;L</div>
                  <div className={`tj-stat-value ${computeEntryStats(selectedEntry).pnl > 0 ? 'pos' : computeEntryStats(selectedEntry).pnl < 0 ? 'neg' : ''}`}>
                    {formatSignedCurrency(computeEntryStats(selectedEntry).pnl)}
                  </div>
                </div>
                <div className="tj-stat">
                  <div className="tj-stat-label">Win Rate</div>
                  <div className="tj-stat-value">{toPercent(computeEntryStats(selectedEntry).winRate)}</div>
                </div>
                <div className="tj-stat">
                  <div className="tj-stat-label">Avg R:R</div>
                  <div className="tj-stat-value">{toR(computeEntryStats(selectedEntry).avgRR)}</div>
                </div>
                <div className="tj-stat">
                  <div className="tj-stat-label">Trades</div>
                  <div className="tj-stat-value">{computeEntryStats(selectedEntry).tradeCount}</div>
                </div>
                <div className="tj-stat">
                  <div className="tj-stat-label">Trade Length</div>
                  {activeTrade ? (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                    <input
                      type="number"
                      className="tj-stat-value tj-stat-editable"
                      value={draftDuration}
                      min={0}
                      placeholder="—"
                      title="Duration in minutes"
                      onChange={e => setDraftDuration(e.target.value)}
                      onBlur={() => {
                        if (!activeTrade) return;
                        const mins = parseInt(draftDuration, 10);
                        mutateTradeFields(activeTrade.id, { durationMinutes: Number.isFinite(mins) && mins >= 0 ? mins : null });
                      }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--app-text-subtle)' }}>min</span>
                    </div>
                  ) : (
                    <div className="tj-stat-value">{formatDurationLabel(resolveTradeDurationMinutes(activeTrade))}</div>
                  )}
                </div>
                <div className="tj-stat">
                  <div className="tj-stat-label">Entry Time</div>
                  {activeTrade ? (
                    <input
                      type="time"
                      className="tj-stat-value tj-stat-editable"
                      value={draftEntryTime}
                      onChange={e => setDraftEntryTime(e.target.value)}
                      onBlur={() => {
                        if (activeTrade && draftEntryTime !== activeTrade.entryTime) {
                          mutateTradeFields(activeTrade.id, { entryTime: draftEntryTime });
                        }
                      }}
                    />
                  ) : (
                    <div className="tj-stat-value">--:--</div>
                  )}
                </div>
              </div>

              <div className="tj-section-head first">
                <span className="tj-section-title">Screenshot</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {allTradeImages.length > 1 && (
                    <span style={{ fontSize: 10, color: 'var(--txt-3)', fontVariantNumeric: 'tabular-nums' }}>
                      {clampedIndex + 1} / {allTradeImages.length}
                    </span>
                  )}
                  {activeTrade && (
                    <button
                      type="button"
                      className="tj-add-imgs-btn"
                      title="Add supporting image"
                      onClick={() => supportingImageInputRef.current?.click()}
                    >
                      <Plus size={10} />
                      Add image
                    </button>
                  )}
                </span>
              </div>

              {/* Image carousel wrapper */}
              <div className="tj-shot-viewer" data-tour-id="scanner-screenshot">
                {/* Main image button */}
                <button
                  type="button"
                  className="tj-shot tj-shot-single"
                  onClick={() => clampedIndex === 0 ? onShotPick(0) : undefined}
                >
                  {currentImage ? (
                    <>
                      <img
                        key={`${activeTradeId}-${clampedIndex}`}
                        src={currentImage}
                        alt="Trade chart"
                        className={`tj-shot-slide-${slideDir}`}
                      />
                      <span className="tj-shot-controls">
                        <button
                          type="button"
                          className="tj-shot-control-btn"
                          onClick={event => {
                            event.stopPropagation();
                            setIsScreenshotFullscreen(true);
                          }}
                          aria-label="Open screenshot fullscreen"
                        >
                          <Maximize2 size={14} />
                        </button>
                        {clampedIndex > 0 && activeTrade && (
                          <button
                            type="button"
                            className="tj-shot-control-btn"
                            title="Remove this image"
                            onClick={event => {
                              event.stopPropagation();
                              const newImgs = [...(activeTrade.supportingImages ?? [])];
                              newImgs.splice(clampedIndex - 1, 1);
                              mutateTradeFields(activeTrade.id, { supportingImages: newImgs });
                              setViewingImageIndex(v => Math.max(0, v - 1));
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </>
                  ) : (
                    <>
                      <ImageIcon size={18} />
                      <span className="tj-shot-label">Add chart</span>
                    </>
                  )}
                </button>

                {/* Right-side nav strip — only shown when supporting images exist */}
                {allTradeImages.length > 1 && (
                  <div className="tj-shot-side-nav">
                    {clampedIndex > 0 && (
                      <button
                        type="button"
                        className="tj-shot-side-btn"
                        onClick={() => navImage('left')}
                        aria-label="Previous image"
                        title="Back to main chart"
                      >
                        <ChevronLeft size={14} />
                      </button>
                    )}
                    <div className="tj-shot-side-dots">
                      {allTradeImages.map((_, i) => (
                        <button
                          key={i}
                          type="button"
                          className={`tj-side-dot${i === clampedIndex ? ' active' : ''}`}
                          onClick={() => { setSlideDir(i > clampedIndex ? 'right' : 'left'); setViewingImageIndex(i); }}
                          aria-label={`Image ${i + 1}`}
                        />
                      ))}
                    </div>
                    {clampedIndex < allTradeImages.length - 1 && (
                      <button
                        type="button"
                        className="tj-shot-side-btn"
                        onClick={() => navImage('right')}
                        aria-label="Next image"
                        title="View supporting image"
                      >
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="tj-section-head">
                <span className="tj-section-title">
                  Trades
                  {selectedTradeIds.size > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)', fontWeight: 600 }}>
                      {selectedTradeIds.size} selected
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {selectedTradeIds.size > 0 && !bulkDeleteConfirm && (
                    <button
                      type="button"
                      className="tj-mini-btn red"
                      onClick={() => setBulkDeleteConfirm(true)}
                    >
                      Delete {selectedTradeIds.size}
                    </button>
                  )}
                  {selectedTradeIds.size > 0 && (
                    <button
                      type="button"
                      className="tj-mini-btn"
                      onClick={() => { setSelectedTradeIds(new Set()); setBulkDeleteConfirm(false); }}
                    >
                      Clear
                    </button>
                  )}
                  <button type="button" className="tj-section-action" onClick={addManualTrade}>Add trade</button>
                </span>
              </div>
              {bulkDeleteConfirm && selectedTradeIds.size > 0 && (
                <div className="tj-delete-row">
                  <span className="tj-delete-text">Delete {selectedTradeIds.size} trade{selectedTradeIds.size !== 1 ? 's' : ''}?</span>
                  <span className="tj-delete-actions">
                    <button type="button" className="tj-mini-btn" onClick={() => setBulkDeleteConfirm(false)}>Cancel</button>
                    <button
                      type="button"
                      className="tj-mini-btn red"
                      onClick={async () => {
                        const ids = Array.from(selectedTradeIds);
                        const willBeEmpty = selectedEntry.trades.length === ids.length;
                        for (const id of ids) {
                          await deleteTradeEverywhere(id);
                        }
                        setSelectedTradeIds(new Set());
                        setBulkDeleteConfirm(false);
                        setDeleteTradeId(null);
                        if (willBeEmpty) {
                          const next = entries
                            .filter(e => e.id !== selectedEntry.id)
                            .sort((a, b) => b.date.localeCompare(a.date))
                            .find(e => e.trades.length > 0);
                          if (next) { setSelectedEntryId(next.id); setActiveTradeId(next.trades[0].id); }
                        }
                      }}
                    >
                      Confirm
                    </button>
                  </span>
                </div>
              )}
              <div className="tj-trade-list" data-tour-id="scanner-trade-list">
                {selectedEntry.trades.map(trade => (
                  deleteTradeId === trade.id ? (
                    <div key={trade.id} className="tj-delete-row">
                      <span className="tj-delete-text">Delete this trade?</span>
                      <span className="tj-delete-actions">
                        <button type="button" className="tj-mini-btn" onClick={() => setDeleteTradeId(null)}>Cancel</button>
                        <button
                          type="button"
                          className="tj-mini-btn red"
                          onClick={() => {
                            const willBeEmpty = selectedEntry.trades.length === 1;
                            void deleteTradeEverywhere(trade.id);
                            setDeleteTradeId(null);
                            if (willBeEmpty) {
                              const next = entries
                                .filter(e => e.id !== selectedEntry.id)
                                .sort((a, b) => b.date.localeCompare(a.date))
                                .find(e => e.trades.length > 0);
                              if (next) { setSelectedEntryId(next.id); setActiveTradeId(next.trades[0].id); }
                            }
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div
                      key={trade.id}
                      className={`tj-trade-card ${trade.result}${activeTradeId === trade.id ? ' active' : ''}${selectedTradeIds.has(trade.id) ? ' tj-trade-selected' : ''}`}
                      onClick={() => setActiveTradeId(trade.id)}
                      aria-current={activeTradeId === trade.id ? 'true' : undefined}
                    >
                      <button
                        type="button"
                        className="tj-check-btn"
                        aria-label={selectedTradeIds.has(trade.id) ? 'Deselect trade' : 'Select trade'}
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedTradeIds(prev => {
                            const next = new Set(prev);
                            if (next.has(trade.id)) next.delete(trade.id);
                            else next.add(trade.id);
                            return next;
                          });
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 14,
                            height: 14,
                            borderRadius: 3,
                            border: `1px solid ${selectedTradeIds.has(trade.id) ? 'var(--amber)' : 'var(--app-border)'}`,
                            background: selectedTradeIds.has(trade.id) ? 'var(--amber-dim)' : 'transparent',
                            flexShrink: 0,
                          }}
                        >
                          {selectedTradeIds.has(trade.id) && (
                            <span style={{ fontSize: 9, color: 'var(--amber)', lineHeight: 1 }}>✓</span>
                          )}
                        </span>
                      </button>
                      {(() => {
                        const s = computeProcessScore(trade);
                        const letter = scoreToGradeLetter(s);
                        return (
                          <span className={`tj-trade-grade g-${gradeCssKey(letter)}`}>
                            {letter}
                          </span>
                        );
                      })()}
                      <span className="tj-symbol">{trade.symbol}</span>
                      <span className={`tj-tc-badge ${trade.direction === 'LONG' ? 'b-long' : 'b-short'}`}>{trade.direction === 'LONG' ? 'LONG' : 'SHORT'}</span>
                      <button type="button" className="tj-trash-btn" onClick={e => { e.stopPropagation(); setDeleteTradeId(trade.id); }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                ))}
              </div>

              {selectedEntry.trades.length === 0 && (
                <BlankDayAccountSelector
                  entry={selectedEntry}
                  onMutate={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                />
              )}

              {activeTrade && (
                <>
                  <div className="tj-section-head">
                    <span className="tj-section-title">Contract Sizing</span>
                  </div>
                  {activeTrade.priceLevelsSource !== 'ai' && (
                    <DirectionSelectorBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}
                  <AccountSelectorBlock
                    trade={activeTrade}
                    onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                  />
                  <ContractSizingBlock
                    trade={activeTrade}
                    onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                  />

                </>
              )}

              {activeTrade && (
                <PriceLevelsBlock
                  trade={activeTrade}
                  onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                />
              )}

              {/* ── A. DAILY REFLECTION ── */}
              <SectionHead title="Daily Reflection" sectionKey="dailyReflection" collapsed={!!collapsed['dailyReflection']} onToggle={() => toggleSection('dailyReflection')} />
              {!collapsed['dailyReflection'] && (
                <DailyReflectionBlock
                  entry={selectedEntry}
                  onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                />
              )}

              {activeTrade && (
                <>
                  {/* ── B. PRE-ENTRY STATE ── */}
                  <SectionHead title="Pre-entry State" sectionKey="preEntry" collapsed={!!collapsed['preEntry']} onToggle={() => toggleSection('preEntry')} />
                  {!collapsed['preEntry'] && (
                    <PreEntryBlock
                      trade={activeTrade}
                      entry={selectedEntry}
                      allEntries={entries}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}

                  {/* ── C. TRADE THESIS ── */}
                  <SectionHead title="Trade Thesis" sectionKey="tradeTh" collapsed={!!collapsed['tradeTh']} onToggle={() => toggleSection('tradeTh')} />
                  {!collapsed['tradeTh'] && (
                    <TradeThesisBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}

                  {/* ── D. EXECUTION REVIEW ── */}
                  <SectionHead title="Execution Review" sectionKey="execReview" collapsed={!!collapsed['execReview']} onToggle={() => toggleSection('execReview')} />
                  {!collapsed['execReview'] && (
                    <ExecutionReviewBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}

                  {/* ── E. PSYCHOLOGY RATINGS ── */}
                  <SectionHead title="Psychology Ratings" sectionKey="psychRatings" collapsed={!!collapsed['psychRatings']} onToggle={() => toggleSection('psychRatings')} />
                  {!collapsed['psychRatings'] && (
                    <PsychologyRatingsBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}

                  {/* ── F. BEHAVIORAL FLAGS ── */}
                  <SectionHead title="Behavioral Flags" sectionKey="behavFlags" collapsed={!!collapsed['behavFlags']} onToggle={() => toggleSection('behavFlags')} />
                  {!collapsed['behavFlags'] && (
                    <BehavioralFlagsBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  )}
                </>
              )}

              {/* ── G. STATE OF MIND ── */}
              <SectionHead title="State of Mind" sectionKey="stateOfMind" collapsed={!!collapsed['stateOfMind']} onToggle={() => toggleSection('stateOfMind')} />
              {!collapsed['stateOfMind'] && (
                <StateOfMindBlock
                  entry={selectedEntry}
                  activeTrade={activeTrade ?? null}
                  onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                  onMutateTrade={activeTrade ? (fields => mutateTradeFields(activeTrade.id, fields)) : undefined}
                />
              )}

              {/* ── H. PHYSICAL STATE ── */}
              <SectionHead title="Physical State" sectionKey="physState" collapsed={!!collapsed['physState']} onToggle={() => toggleSection('physState')} />
              {!collapsed['physState'] && (
                <PhysicalStateBlock
                  entry={selectedEntry}
                  onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                />
              )}

              {activeTrade && (
                <>
                  {/* ── I. PROCESS SCORE ── */}
                  <SectionHead title="Flyxa Process Score" sectionKey="processScore" collapsed={!!collapsed['processScore']} onToggle={() => toggleSection('processScore')} />
                  {!collapsed['processScore'] && (
                    <ProcessScoreBlock
                      trade={activeTrade}
                      entries={entries}
                      navigate={navigate}
                      onSaveEntries={() => mutateEntries(p => p)}
                    />
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <ScannerDropZone
            isScanning={isScanning}
            scanError={scanError}
            scanPreviewUrl={scanPreviewUrl}
            onScanFile={(file) => { void handleScanFile(file); }}
            onAddBlankDay={addBlankDay}
            isMobile={isMobile}
          />
        )}
      </section>

      {isScreenshotFullscreen && currentImage && (
        <div
          className="tj-shot-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Trade screenshot fullscreen"
          onClick={() => setIsScreenshotFullscreen(false)}
        >
          <button
            type="button"
            className="tj-shot-modal-close"
            onClick={() => setIsScreenshotFullscreen(false)}
            aria-label="Close fullscreen screenshot"
          >
            <X size={16} />
          </button>
          <img
            src={currentImage}
            alt="Trade chart fullscreen"
            className="tj-shot-modal-image"
            onClick={event => event.stopPropagation()}
          />
        </div>
      )}

      {showCSVImport && (
        <CSVImportModal
          onClose={() => setShowCSVImport(false)}
          onImport={async (trades) => {
            await handleCSVImport(trades);
            setShowCSVImport(false);
          }}
        />
      )}
    </div>
  );
}
