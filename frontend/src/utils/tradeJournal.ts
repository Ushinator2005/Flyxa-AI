// Pure data helpers extracted verbatim from pages/TradeJournal.tsx so the
// page component stays within TypeScript's control-flow-analysis budget.
import type { JournalEntry as StoreJournalEntry, RiskRule } from '../store/types.js';
import { getTimeZoneParts } from './calendarTime.js';
import { lookupContract } from '../constants/futuresContracts.js';
import { normalizeConfluenceTags } from './confluenceTags.js';
import { normalizeBehavioralFlags } from './behavioralFlags.js';
import { evaluateEntryRules, manualRules, summarizeRuleEvaluations } from './tradingRules.js';

export type RuleState = 'ok' | 'fail' | 'unchecked';
export type EmotionState = 'neutral' | 'green' | 'amber' | 'red';
export type TradeResult = 'win' | 'loss' | 'open' | 'be';
export type TradeDirection = 'LONG' | 'SHORT';
export type DayFilter = 'all' | 'win' | 'loss' | 'untagged';

export interface JournalTrade {
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

export interface JournalEntry {
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
  isBlankDay?: boolean;
}

export const DEFAULT_RULES = [
  'Followed daily loss limit',
  'Only took planned trades',
  'Respected position sizing rules',
  'No trading during lunch window',
  'Stopped after 3 consecutive losses',
];

export const STATE_OF_MIND_TAGS = {
  positive: ['In the zone', 'Calm', 'Focused', 'Patient', 'Confident', 'Clear-headed', 'Decisive', 'Composed'],
  caution: ['Slightly anxious', 'Slightly rushed', 'Mildly frustrated', 'Uncertain', 'Distracted', 'Tired', 'Impatient'],
  negative: ['Revenge trading', 'FOMO', 'Overconfident', 'Fearful', 'Reckless', 'Frustrated', 'Desperate', 'Emotionally numb'],
} as const;

export const TAGS = Array.from(new Set(Object.values(STATE_OF_MIND_TAGS).flat()));

export function getTodayIso(tz?: string) {
  if (tz) return getTimeZoneParts(new Date(), tz).date;
  return new Date().toISOString().split('T')[0];
}

export function getNowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function addSecondsToTime(time: string, seconds?: number | null): string | null {
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

export function minutesBetweenTimes(start: string, end: string): number | null {
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

export function formatDurationLabel(minutes?: number | null): string {
  if (!Number.isFinite(minutes ?? NaN) || (minutes ?? 0) <= 0) return '—';
  const m = Math.round(minutes ?? 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export function resolveTradeDurationMinutes(trade?: Partial<JournalTrade> | null): number | null {
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

export function parseDate(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function formatMonth(value: Date) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(value);
}

export function formatDateTitle(value: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parseDate(value));
}

export function formatWeekday(value: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(parseDate(value)).toUpperCase();
}

export function formatCurrency(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  });
}

export function formatSignedCurrency(value: number) {
  const abs = formatCurrency(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return formatCurrency(0);
}

export function toPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

export function toR(value: number) {
  return `${value.toFixed(2)}R`;
}

export function formatCurrencyFixed(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function parsePrice(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function normalizeConfluences(value: unknown): string[] {
  return normalizeConfluenceTags(value);
}

export function getTradeEntry(trade: JournalTrade): number | undefined {
  return parsePrice(trade.entry) ?? parsePrice(trade.entryPrice);
}

export function getTradeExit(trade: JournalTrade): number | undefined {
  return parsePrice(trade.exit) ?? parsePrice(trade.exitPrice);
}

export function computeTradePnl(trade: JournalTrade, entry?: number, exit?: number): number {
  if (entry === undefined || exit === undefined) return 0;
  const pointValue = lookupContract(trade.symbol)?.point_value ?? 1;
  const contracts = trade.contracts > 0 ? trade.contracts : 1;
  return trade.direction === 'LONG'
    ? (exit - entry) * contracts * pointValue
    : (entry - exit) * contracts * pointValue;
}

export function computeTradeRr(trade: JournalTrade, entry?: number): number {
  if (entry === undefined || trade.sl === undefined || trade.tp === undefined) return 0;
  const risk = trade.direction === 'LONG' ? entry - trade.sl : trade.sl - entry;
  const reward = trade.direction === 'LONG' ? trade.tp - entry : entry - trade.tp;
  if (risk <= 0 || reward <= 0) return 0;
  return reward / risk;
}

export function withTradeDerivedValues(trade: JournalTrade): JournalTrade {
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

export function getTradeDateValue(trade: JournalTrade | null | undefined, fallbackDate: string): string {
  if (!trade) return fallbackDate;
  if (typeof trade.date === 'string' && isValidIsoDate(trade.date)) return trade.date;
  return fallbackDate;
}

export function shiftMonth(current: Date, delta: number) {
  return new Date(current.getFullYear(), current.getMonth() + delta, 1);
}

export function inMonth(dateValue: string, monthValue: Date) {
  const parsed = parseDate(dateValue);
  return parsed.getFullYear() === monthValue.getFullYear() && parsed.getMonth() === monthValue.getMonth();
}


export function getRulesTemplate(rules: RiskRule[]) {
  const configured = manualRules(rules).map(rule => rule.label.trim()).filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_RULES;
}

export function createEmptyEntry(date: string, rulesTemplate: string[], account?: string, isBlankDay = false): JournalEntry {
  return {
    id: crypto.randomUUID(),
    date,
    account,
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
    ...(isBlankDay ? { isBlankDay: true } : {}),
  };
}

/** Converts a 0-100 process score to a letter grade. Returns '—' when score is 0 (no data). */
export function scoreToGradeLetter(score: number): string {
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
export function gradeCssKey(letter: string): string {
  return letter.replace('+', 'plus').replace('—', 'dash');
}

export function computeEntryStats(entry: JournalEntry, riskRules: RiskRule[] = []) {
  const pnl = entry.trades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0);
  const wins = entry.trades.filter(trade => trade.result === 'win').length;
  const losses = entry.trades.filter(trade => trade.result === 'loss').length;
  const tradeCount = entry.trades.length;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
  const avgRR = tradeCount ? entry.trades.reduce((sum, trade) => sum + trade.rr, 0) / tradeCount : 0;
  // Use full evaluation (auto + manual) when riskRules are provided so that
  // automatic rule violations affect the grade, not just manual confirmations.
  let okCount: number;
  let failCount: number;
  if (riskRules.length > 0) {
    const evs = evaluateEntryRules(entry as unknown as StoreJournalEntry, riskRules);
    const s = summarizeRuleEvaluations(evs);
    okCount = s.passed;
    failCount = s.failed;
  } else {
    okCount = entry.rules.filter(rule => rule.state === 'ok').length;
    failCount = entry.rules.filter(rule => rule.state === 'fail').length;
  }
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

export function findBestDay(entries: JournalEntry[]) {
  if (!entries.length) return null;
  let best = -Infinity;
  entries.forEach(entry => {
    const pnl = computeEntryStats(entry).pnl;
    if (pnl > best) best = pnl;
  });
  return Number.isFinite(best) ? best : null;
}

export function fromLegacyRecords(value: unknown[], rulesTemplate: string[]): JournalEntry[] {
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

export function normalizeEntries(value: unknown[], rulesTemplate: string[]): JournalEntry[] {
  if (!Array.isArray(value)) return [];
  const looksModern = value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return typeof record.date === 'string' && Array.isArray(record.trades);
  });
  if (!looksModern) return fromLegacyRecords(value, rulesTemplate);

  const seenTradeIds = new Set<string>();
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
        const tradeCommission = typeof trade.commission === 'number' ? trade.commission : 0;
        const netPnl = pnl - tradeCommission;
        const result: TradeResult = trade.result === 'win' || trade.result === 'loss' || trade.result === 'open' || trade.result === 'be'
          ? trade.result
          : pnl === 0 ? 'be' : netPnl > 0 ? 'win' : netPnl < 0 ? 'loss' : 'open';
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
          behavioralFlags: normalizeBehavioralFlags(trade.behavioralFlags),
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
      }).filter((trade) => {
        if (seenTradeIds.has(trade.id)) return false;
        seenTradeIds.add(trade.id);
        return true;
      });

      const reflectionRaw = (record.reflection ?? {}) as Record<string, unknown>;
      const reflection = {
        pre: typeof reflectionRaw.pre === 'string' ? reflectionRaw.pre : '',
        post: typeof reflectionRaw.post === 'string' ? reflectionRaw.post : '',
        lessons: typeof reflectionRaw.lessons === 'string' ? reflectionRaw.lessons : '',
      };

      const rulesRaw = Array.isArray(record.rules) ? record.rules : [];
      const savedRules = rulesRaw.length
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
        : [];
      const savedRuleMap = new Map(savedRules.map(rule => [rule.text, rule.state]));
      const rules = rulesTemplate.map(text => ({
        text,
        state: savedRuleMap.get(text) ?? 'unchecked' as RuleState,
      }));

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
        isBlankDay: record.isBlankDay === true ? true : undefined,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // The journal is day-based: consolidate duplicate rows for the same calendar
  // date and move trades whose internal date differs from their parent entry.
  const byDate = new Map<string, JournalEntry>();
  for (const entry of normalized) {
    const existing = byDate.get(entry.date);
    if (!existing) {
      byDate.set(entry.date, { ...entry, trades: [] });
    } else {
      const richer = entry.trades.length > existing.trades.length ? entry : existing;
      const fallback = richer === entry ? existing : entry;
      byDate.set(entry.date, {
        ...fallback,
        ...richer,
        date: entry.date,
        accountIds: Array.from(new Set([
          ...(existing.accountIds ?? []),
          ...(entry.accountIds ?? []),
        ])),
        screenshots: [0, 1, 2].map(
          index => richer.screenshots[index] || fallback.screenshots[index] || ''
        ),
        scannedImageUrl: richer.scannedImageUrl || fallback.scannedImageUrl,
        isBlankDay: richer.isBlankDay || fallback.isBlankDay || undefined,
        reflection: {
          pre: richer.reflection.pre || fallback.reflection.pre,
          post: richer.reflection.post || fallback.reflection.post,
          lessons: richer.reflection.lessons || fallback.reflection.lessons,
        },
        trades: existing.trades,
      });
    }
  }
  for (const entry of normalized) {
    for (const trade of entry.trades) {
      const tradeDate = trade.date ?? entry.date;
      if (!byDate.has(tradeDate)) byDate.set(tradeDate, createEmptyEntry(tradeDate, rulesTemplate));
      byDate.get(tradeDate)!.trades.push({ ...trade, date: tradeDate });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}


export const FLAG_PENALTIES: Record<string, number> = {
  // Critical — direct account risk / emotional breakdown
  'sized-up':       20,
  'revenge':        20,
  'added-losing':   20,
  // Serious — discipline failures that damage edge
  'incorrect-stop-loss': 12,
  'plan-deviation': 12,
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

// ── Helper: trade pattern detection ──────────────────────────────────────────
export function parseTimeToMinutes(t: string | null | undefined): number {
  if (!t || typeof t !== 'string') return -1;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function computeTradePatternFlags(
  trades: JournalTrade[],
  contractLimitsBySymbol: Record<string, number> = {}
): Map<string, string> {
  const flags = new Map<string, string>();

  // Rapid-fire cluster: flag the first trade of any window where 3+ trades
  // occur within 10 minutes.
  const rapidFireFlagged = new Set<string>();
  for (let i = 0; i < trades.length; i++) {
    const windowStart = parseTimeToMinutes(trades[i].entryTime);
    if (windowStart < 0) continue;
    let count = 1;
    for (let j = i + 1; j < trades.length; j++) {
      const t = parseTimeToMinutes(trades[j].entryTime);
      if (t >= 0 && t - windowStart < 10) count++;
      else break;
    }
    if (count >= 3 && !rapidFireFlagged.has(trades[i].id)) {
      flags.set(trades[i].id, `${count} trades in 10min`);
      rapidFireFlagged.add(trades[i].id);
    }
  }

  for (let i = 0; i < trades.length; i++) {
    const curr = trades[i];
    if (i < trades.length - 1) {
      const next = trades[i + 1];
      if (curr.symbol === next.symbol) {
        const tA = parseTimeToMinutes(curr.exitTime);
        const tB = parseTimeToMinutes(next.entryTime);
        const gap = tA >= 0 && tB >= 0 ? tB - tA : -1;
        if (gap >= 0 && gap < 5) {
          const n = Math.max(1, Math.round(gap));
          if (curr.direction !== next.direction) {
            if (!flags.has(curr.id)) flags.set(curr.id, `Reversed within ${n}min`);
          } else if (curr.result === 'loss') {
            if (!flags.has(next.id)) flags.set(next.id, `Re-entry after loss (${n}min)`);
          }
        }
      }
    }
    const hasPriorLoss = trades.slice(0, i).some(t => t.result === 'loss');
    if (hasPriorLoss) {
      const symMax = contractLimitsBySymbol[curr.symbol];
      if (symMax && curr.contracts > symMax && !flags.has(curr.id)) {
        flags.set(curr.id, 'Sized up after loss');
      }
    }
  }
  return flags;
}


// ── Helper: computeProcessScore ──────────────────────────────────────────────
export function computeProcessScore(trade: JournalTrade): number {
  const r = trade.psychologyRatings;
  const flags = trade.behavioralFlags ?? [];

  let baseScore: number;
  if (r) {
    const scores = [r.setupQuality, r.discipline, r.execution, r.patience, r.riskManagement, r.emotionalControl].filter(v => v > 0);
    baseScore = scores.length > 0
      ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 20
      : 75; // ratings object exists but empty — use neutral base
  } else if (flags.length > 0 || trade.executionReview || (trade.preEntry?.confidenceAtEntry ?? 0) > 0) {
    baseScore = 75; // no ratings but other process data present — use neutral base
  } else {
    return 0; // genuinely no data
  }

  let score = baseScore;
  score -= flags.reduce((total, id) => total + (FLAG_PENALTIES[id] ?? 8), 0);
  const er = trade.executionReview;
  if (er && er.enteredAtLevel && er.waitedForConfirmation && er.correctSize && er.exitedAtPlan && er.movedStopCorrectly && er.resistedEarlyExit) score += 5;
  if ((trade.preEntry?.confidenceAtEntry ?? 0) >= 4) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}


export const BEHAVIORAL_FLAGS_LEFT = [
  { id:'chased-entry',    label:'Chased entry — outside the zone' },
  { id:'no-confirmation', label:'Jumped in before confirmation' },
  { id:'incorrect-stop-loss', label:'Incorrect stop loss' },
  { id:'sized-up',        label:'Oversized position' },
  { id:'added-losing',    label:'Added to a losing position' },
  { id:'be-too-early',    label:'Moved to breakeven too early' },
  { id:'overtraded',      label:'Overtraded — too many setups' },
];
export const BEHAVIORAL_FLAGS_RIGHT = [
  { id:'moved-stop',    label:'Widened stop loss after entry' },
  { id:'exit-early',    label:'Exited too early (fear)' },
  { id:'moved-target',  label:'Moved or ignored take profit' },
  { id:'past-inval',    label:'Held past invalidation' },
  { id:'boredom-trade', label:'Traded out of boredom' },
  { id:'revenge',       label:'Revenge trade after a loss' },
  { id:'reentry-stop',  label:'Re-entered immediately after stop out' },
];



export const ALL_BEHAVIORAL_FLAGS = [...BEHAVIORAL_FLAGS_LEFT, ...BEHAVIORAL_FLAGS_RIGHT];
