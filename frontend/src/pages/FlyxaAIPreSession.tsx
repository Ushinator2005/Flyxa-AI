import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import { riskApi } from '../services/api.js';
import { RiskSettings, Trade } from '../types/index.js';
import { PatternItem } from './FlyxaAIPatterns.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';
import { getTimeZoneParts } from '../utils/calendarTime.js';
import { saveGuardSessionTrades } from '../hooks/useGuardSessionTrades.js';

type BiasValue = 'Bull' | 'Bear' | 'Neutral';
type BiasState = Record<'ES' | 'NQ', BiasValue>;
type ChecklistState = Record<string, boolean>;

type ChecklistItem = {
  id: string;
  label: string;
  source?: string;
  autoFromEmotion?: boolean;
};

type SessionPlanRow = {
  id: string;
  source: 'Primary focus' | 'Avoid today' | 'Hard stop';
  rule: string;
};

const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const MARKET_CLOSE_MINUTES = 16 * 60;
const OATH_CHECK_DELAY_MS = 3000;

const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252',
};


const emotions = ['Frustrated', 'Anxious', 'Neutral', 'Focused', 'Confident'] as const;
const biasOptions: BiasValue[] = ['Bear', 'Neutral', 'Bull'];

const oathChecklistItems: ChecklistItem[] = [
  { id: 'oath-plan-only', label: 'I will only take trades that match my plan' },
  { id: 'oath-no-revenge', label: 'I will not trade to recover, prove, or force a green day' },
  { id: 'oath-risk-stop', label: 'I will respect my max loss, max trades, and size limits' },
  { id: 'oath-no-trade-valid', label: 'I accept that no trade is a successful session outcome' },
  { id: 'oath-journal-honestly', label: 'I will record the trade honestly after it closes' },
];

const mentalChecklistItems: ChecklistItem[] = [
  { id: 'mental-sleep', label: 'My mind is clear enough to follow rules' },
  { id: 'mental-emotion', label: 'Pre-open emotion logged', autoFromEmotion: true },
  { id: 'mental-recover', label: 'I am not carrying yesterday into today' },
  { id: 'mental-distractions', label: 'My trading window is free from distractions' },
];

const baseTechnicalChecklistItems: ChecklistItem[] = [
  { id: 'technical-overnight-levels', label: 'Key levels, liquidity, and invalidation are marked' },
  { id: 'technical-platform-ready', label: 'Platform, account, contracts, and order settings are checked' },
];


function parseTradeDate(trade: Trade): Date | null {
  if (trade.trade_date) {
    const parsed = new Date(`${trade.trade_date}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (trade.created_at) {
    const parsed = new Date(trade.created_at);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setHours(0, 0, 0, 0);
      return parsed;
    }
  }
  return null;
}

function formatCurrency(value: number) {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

function parseRiskSettingsFromStorage(): Partial<RiskSettings> {
  if (typeof window === 'undefined') return {};
  const keys = ['risk.settings', 'tw_risk_settings', 'riskSettings', 'tw-risk-settings'];
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null) continue;
      return {
        daily_loss_limit: Number(parsed.daily_loss_limit),
        max_trades_per_day: Number(parsed.max_trades_per_day),
        max_contracts_per_trade: Number(parsed.max_contracts_per_trade),
        account_size: Number(parsed.account_size),
        risk_percentage: Number(parsed.risk_percentage),
      };
    } catch {
      // Ignore malformed risk settings cache.
    }
  }
  return {};
}

function parseMaxWinFromStorage(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('flyxa.risk.maxWin');
    if (!raw) return null;
    const val = Number(raw);
    return Number.isFinite(val) && val > 0 ? val : null;
  } catch { return null; }
}

function getEtParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: byType.weekday ?? 'Mon',
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function formatDuration(minutes: number) {
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getRthTiming(now: Date) {
  const et = getEtParts(now);
  const weekdayIndexMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayIndex = weekdayIndexMap[et.weekday] ?? 1;
  const isWeekday = dayIndex >= 1 && dayIndex <= 5;
  const currentMinutes = (et.hour * 60) + et.minute;
  const marketOpenNow = isWeekday && currentMinutes >= MARKET_OPEN_MINUTES && currentMinutes < MARKET_CLOSE_MINUTES;

  let minutesUntilOpen = 0;
  if (marketOpenNow) {
    minutesUntilOpen = 0;
  } else if (isWeekday && currentMinutes < MARKET_OPEN_MINUTES) {
    minutesUntilOpen = MARKET_OPEN_MINUTES - currentMinutes;
  } else {
    let daysAhead = 1;
    let nextDayIndex = (dayIndex + 1) % 7;
    while (nextDayIndex === 0 || nextDayIndex === 6) {
      daysAhead += 1;
      nextDayIndex = (nextDayIndex + 1) % 7;
    }
    const minutesToMidnight = (24 * 60) - currentMinutes;
    minutesUntilOpen = minutesToMidnight + ((daysAhead - 1) * 24 * 60) + MARKET_OPEN_MINUTES;
  }

  return {
    marketOpenToday: isWeekday,
    marketOpenNow,
    minutesUntilOpen,
  };
}

function etDateLabel(now: Date) {
  return now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function confidenceSorted(patterns: PatternItem[]) {
  return [...patterns].sort((a, b) => b.confidence - a.confidence);
}

function buildPatternInstruction(pattern: PatternItem, mode: 'watch' | 'protect') {
  if (mode === 'watch') {
    return `If ${pattern.title.toLowerCase()} shows up in ${pattern.session}, reduce one size tier and wait for full confirmation before entry.`;
  }
  return `Lean into ${pattern.title.toLowerCase()} during ${pattern.session} on ${pattern.instrument}, and keep execution exactly to your confirmed model.`;
}



export default function FlyxaAIPreSession() {
  const navigate = useNavigate();
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, preferences } = useAppSettings();
  const { settings, refreshSettings } = useRisk();

  const storedPreSession = useFlyxaStore(state => state.preSession);
  const setPreSessionAction = useFlyxaStore(state => state.setPreSession);
  const setPreSessionForDate = useFlyxaStore(state => state.setPreSessionForDate);
  const storedOathItems = useFlyxaStore(state => state.oathItems);
  const setOathItemsAction = useFlyxaStore(state => state.setOathItems);

  const [now, setNow] = useState(() => new Date());
  const todayIso = useMemo(() => getTimeZoneParts(now, preferences.timezone).date, [now, preferences.timezone]);
  const [emotion, setEmotion] = useState<string>(() => (storedPreSession?.emotion ?? ''));
  const [note, setNote] = useState<string>(() => (storedPreSession?.note ?? ''));
  const [bias, setBias] = useState<BiasState>(() => (storedPreSession?.bias as BiasState ?? { ES: 'Neutral', NQ: 'Neutral' }));
  const [checklistState, setChecklistState] = useState<ChecklistState>(() => (storedPreSession?.checklistState as ChecklistState ?? {}));
  const [storedRiskSettings] = useState(() => parseRiskSettingsFromStorage());
  const [sessionMaxLoss] = useState<string>(() =>
    storedPreSession?.sessionMaxLoss != null ? String(storedPreSession.sessionMaxLoss) : ''
  );
  const [sessionTarget] = useState<string>(() =>
    storedPreSession?.dailyTarget != null ? String(storedPreSession.dailyTarget) : ''
  );
  const [oathEditOpen, setOathEditOpen] = useState(false);
  const [oathDraft, setOathDraft] = useState<Array<{ id: string; label: string }>>([]);
  const [oathCooldownUntil, setOathCooldownUntil] = useState(0);
  const [oathCooldownNow, setOathCooldownNow] = useState(() => Date.now());
  const [riskEditOpen, setRiskEditOpen] = useState(false);
  const [riskSaving, setRiskSaving] = useState(false);
  const [riskSaveError, setRiskSaveError] = useState('');
  const [riskDraft, setRiskDraft] = useState({
    daily_loss_limit: '',
    daily_profit_limit: '',
    max_trades_per_day: '',
    max_contracts_per_trade: '',
    account_size: '',
    risk_percentage: '',
  });
  const [maxWinStored, setMaxWinStored] = useState<number | null>(() => parseMaxWinFromStorage());
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!oathCooldownUntil) return;
    setOathCooldownNow(Date.now());

    const interval = window.setInterval(() => {
      const timestamp = Date.now();
      setOathCooldownNow(timestamp);
      if (timestamp >= oathCooldownUntil) {
        setOathCooldownUntil(0);
        window.clearInterval(interval);
      }
    }, 250);

    return () => window.clearInterval(interval);
  }, [oathCooldownUntil]);

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );

  const lastSession = useMemo(() => {
    const grouped = accountTrades.reduce<Map<string, Trade[]>>((map, trade) => {
      const date = parseTradeDate(trade);
      if (!date) return map;
      const key = date.toISOString().slice(0, 10);
      map.set(key, [...(map.get(key) || []), trade]);
      return map;
    }, new Map());

    const latestDate = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a))[0];
    if (!latestDate) return null;
    const latestTrades = grouped.get(latestDate) || [];
    const netPnl = latestTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    return {
      date: latestDate,
      tradeCount: latestTrades.length,
      netPnl,
    };
  }, [accountTrades]);

  const recentBehavior = useMemo(() => {
    const recentTrades = [...accountTrades]
      .sort((a, b) => {
        const aDate = parseTradeDate(a)?.getTime() ?? 0;
        const bDate = parseTradeDate(b)?.getTime() ?? 0;
        return bDate - aDate;
      })
      .slice(0, 20);
    const withScore = recentTrades.filter(trade => typeof trade.plan_score === 'number');
    const planLogged = withScore.length > 0 ? withScore : recentTrades.filter(trade => typeof trade.followed_plan === 'boolean');
    const planAdherence = withScore.length > 0
      ? Math.round(withScore.reduce((s, t) => s + (t.plan_score as number), 0) / withScore.length)
      : planLogged.length > 0
        ? Math.round((planLogged.filter(trade => trade.followed_plan === true).length / planLogged.length) * 100)
        : null;
    const revengeTagged = recentTrades.filter(trade => (trade.emotional_state ?? '').toLowerCase().includes('revenge')).length;
    const emotionTagged = recentTrades.filter(trade => Boolean(trade.emotional_state?.trim())).length;

    return {
      sampleSize: recentTrades.length,
      planLogged: planLogged.length,
      planAdherence,
      revengeTagged,
      emotionTagged,
    };
  }, [accountTrades]);

  const priorFlow = useMemo(
    () => getMostRecentDailyFlowBefore(accountTrades, todayIso),
    [accountTrades, todayIso]
  );

  const riskLimits = useMemo(() => {
    const dailyLoss = Number.isFinite(settings?.daily_loss_limit) ? settings?.daily_loss_limit : storedRiskSettings.daily_loss_limit;
    const maxTrades = Number.isFinite(settings?.max_trades_per_day) ? settings?.max_trades_per_day : storedRiskSettings.max_trades_per_day;
    const maxContracts = Number.isFinite(settings?.max_contracts_per_trade) ? settings?.max_contracts_per_trade : storedRiskSettings.max_contracts_per_trade;
    const accountSize = Number.isFinite(settings?.account_size) ? settings?.account_size : storedRiskSettings.account_size;
    const riskPct = Number.isFinite(settings?.risk_percentage) ? settings?.risk_percentage : storedRiskSettings.risk_percentage;

    const dailyLossValue = dailyLoss != null && dailyLoss >= 0 ? dailyLoss : 500;
    const maxTradesValue = maxTrades && maxTrades > 0 ? maxTrades : 10;
    const maxContractsValue = maxContracts && maxContracts > 0 ? maxContracts : 2;
    const accountSizeValue = accountSize && accountSize > 0 ? accountSize : 10000;
    const riskPctValue = riskPct && riskPct > 0 ? riskPct : 1;
    const riskPerTrade = (accountSizeValue * riskPctValue) / 100;
    const computedTarget = Math.max(riskPerTrade * 3, dailyLossValue * 0.6);
    const maxWin = maxWinStored ?? computedTarget;

    return {
      maxDailyLoss: dailyLossValue,
      noLossLimit: dailyLossValue === 0,
      maxTrades: maxTradesValue,
      riskPerTrade,
      target: computedTarget,
      maxWin,
      maxContracts: maxContractsValue,
      riskPct: riskPctValue,
      accountSize: accountSizeValue,
    };
  }, [settings, storedRiskSettings, maxWinStored]);

  const openRiskEditor = () => {
    setRiskDraft({
      daily_loss_limit: riskLimits.noLossLimit ? '0' : String(Math.round(riskLimits.maxDailyLoss)),
      daily_profit_limit: String(Math.round(riskLimits.maxWin)),
      max_trades_per_day: String(riskLimits.maxTrades),
      max_contracts_per_trade: String(riskLimits.maxContracts),
      account_size: String(Math.round(riskLimits.accountSize)),
      risk_percentage: String(riskLimits.riskPct),
    });
    setRiskSaveError('');
    setRiskEditOpen(true);
  };

  const updateRiskDraft = (field: keyof typeof riskDraft, value: string) => {
    setRiskDraft(current => ({ ...current, [field]: value }));
  };

  const saveRiskLimits = async () => {
    const lossRaw  = riskDraft.daily_loss_limit.trim();
    const loss     = lossRaw === '' ? null : Number(lossRaw);
    const trades   = Number(riskDraft.max_trades_per_day);

    if (!Number.isFinite(trades) || trades <= 0) {
      setRiskSaveError('Enter a positive number for max trades.');
      return;
    }
    if (loss !== null && (!Number.isFinite(loss) || loss < 0)) {
      setRiskSaveError('Max loss must be 0 (no limit) or a positive number.');
      return;
    }

    // Save max win to localStorage (not sent to API)
    const win = Number(riskDraft.daily_profit_limit);
    if (Number.isFinite(win) && win > 0) {
      window.localStorage.setItem('flyxa.risk.maxWin', String(win));
      setMaxWinStored(win);
    } else {
      window.localStorage.removeItem('flyxa.risk.maxWin');
      setMaxWinStored(null);
    }

    const next: Record<string, number> = { max_trades_per_day: trades };
    if (loss !== null) next.daily_loss_limit = loss;

    const contracts = Number(riskDraft.max_contracts_per_trade);
    if (Number.isFinite(contracts) && contracts > 0) next.max_contracts_per_trade = contracts;

    const size = Number(riskDraft.account_size);
    if (Number.isFinite(size) && size > 0) next.account_size = size;

    const pct = Number(riskDraft.risk_percentage);
    if (Number.isFinite(pct) && pct > 0) next.risk_percentage = pct;

    setRiskSaving(true);
    setRiskSaveError('');
    try {
      await riskApi.updateSettings(next);
      await refreshSettings();
      setRiskEditOpen(false);
    } catch {
      setRiskSaveError('Could not save risk limits. Try again.');
    } finally {
      setRiskSaving(false);
    }
  };

  const activePatterns = useMemo(
    () => [] as PatternItem[],
    []
  );
  const activeRiskPatterns = useMemo(
    () => confidenceSorted(activePatterns.filter(pattern => pattern.type === 'Risk' && pattern.status === 'Active')),
    [activePatterns]
  );
  const confirmedEdgePatterns = useMemo(
    () => confidenceSorted(activePatterns.filter(pattern => pattern.type === 'Edge' && pattern.status === 'Confirmed')),
    [activePatterns]
  );

  const technicalChecklistItems = useMemo<ChecklistItem[]>(
    () => [
      ...baseTechnicalChecklistItems,
      ...(recentBehavior.planAdherence !== null && recentBehavior.planAdherence < 80
        ? [{
            id: 'technical-plan-adherence',
            label: 'Every entry must clear your full trade plan before execution',
            source: `${recentBehavior.planAdherence}% recent plan adherence`,
          }]
        : []),
      ...activePatterns.map(pattern => ({
        id: `technical-pattern-${pattern.id}`,
        label: pattern.type === 'Risk' ? `Guard against: ${pattern.title}` : `Execute when seen: ${pattern.title}`,
        source: pattern.title,
      })),
    ],
    [activePatterns, recentBehavior.planAdherence]
  );

  const mentalChecklistWithAdaptiveItems = useMemo<ChecklistItem[]>(
    () => [
      ...mentalChecklistItems,
      ...(recentBehavior.revengeTagged > 0
        ? [{
            id: 'mental-revenge-reset',
            label: 'If frustration spikes, take a five-minute reset before re-entry',
            source: `${recentBehavior.revengeTagged} recent revenge-tagged trade${recentBehavior.revengeTagged === 1 ? '' : 's'}`,
          }]
        : []),
      ...(lastSession && lastSession.netPnl < 0
        ? [{
            id: 'mental-first-loss-pause',
            label: 'After the first red trade, pause before placing the next order',
            source: `Last session ${formatSignedCurrency(lastSession.netPnl)}`,
          }]
        : []),
    ],
    [lastSession, recentBehavior.revengeTagged]
  );

  const sessionPlan = useMemo<SessionPlanRow[]>(() => {
    const topEdge = confirmedEdgePatterns[0];
    const topRisk = activeRiskPatterns[0];
    const recentPlanDrag = recentBehavior.planAdherence !== null && recentBehavior.planAdherence < 80;
    const recentEmotionDrag = recentBehavior.revengeTagged > 0;
    return [
      // Carry-forward: only when there's an actual behavioral leak
      ...(priorFlow?.biggestLeak ? [{
        id: 'tomorrow-rule',
        source: 'Hard stop' as const,
        rule: priorFlow.tomorrowRule,
      }] : []),
      // Primary focus: only when there's a confirmed edge pattern
      ...(topEdge ? [{
        id: 'focus',
        source: 'Primary focus' as const,
        rule: `Prioritize ${topEdge.session} entries in ${topEdge.instrument}; this is your highest-confidence edge window today.`,
      }] : []),
      // Avoid today: only when there's real behavioral data
      ...(topRisk ? [{
        id: 'avoid-risk',
        source: 'Avoid today' as const,
        rule: `Avoid ${topRisk.title.toLowerCase()} by pausing after the first loss and requiring full checklist confirmation.`,
      }] : recentEmotionDrag ? [{
        id: 'avoid-emotion',
        source: 'Avoid today' as const,
        rule: 'Do not chase recovery trades. If frustration shows up, step away before the next entry.',
      }] : recentPlanDrag ? [{
        id: 'avoid-plan',
        source: 'Avoid today' as const,
        rule: `Plan adherence is ${recentBehavior.planAdherence}%. Every entry must clear your written plan before execution.`,
      }] : []),
      // Hard stop: always data-driven
      {
        id: 'hard-stop',
        source: 'Hard stop',
        rule: riskLimits.noLossLimit
          ? `Stop after ${riskLimits.maxTrades} trades or when you feel the session is done.`
          : `Stop at ${formatCurrency(-riskLimits.maxDailyLoss)} loss or after ${riskLimits.maxTrades} trades — whichever comes first.`,
      },
    ];
  }, [activeRiskPatterns, confirmedEdgePatterns, priorFlow, recentBehavior.planAdherence, recentBehavior.revengeTagged, riskLimits.maxDailyLoss, riskLimits.maxTrades]);

  const rthTiming = useMemo(() => getRthTiming(now), [now]);
  const emotionLogged = emotion.trim().length > 0;
  const activeOathItems: ChecklistItem[] = storedOathItems ?? oathChecklistItems;

  const checklistTotals = useMemo(() => {
    const rows = [...activeOathItems, ...mentalChecklistWithAdaptiveItems, ...technicalChecklistItems];
    const completed = rows.filter(item => (
      item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id])
    )).length;
    return {
      completed,
      total: rows.length,
      pct: rows.length > 0 ? Math.round((completed / rows.length) * 100) : 100,
    };
  }, [activeOathItems, checklistState, emotionLogged, mentalChecklistWithAdaptiveItems, technicalChecklistItems]);

  const readiness = useMemo(() => {
    let score = 100;
    const reasons: string[] = [];

    if (!emotionLogged) {
      score -= 18;
      reasons.push('Emotion not logged yet.');
    }
    if (emotion === 'Frustrated') {
      score -= 24;
      reasons.push('Frustration is elevated before the open.');
    } else if (emotion === 'Anxious') {
      score -= 14;
      reasons.push('Anxiety is present; tighter entry discipline is warranted.');
    }
    if (checklistTotals.pct < 70) {
      score -= 28;
      reasons.push(`Only ${checklistTotals.completed}/${checklistTotals.total} readiness checks are complete.`);
    } else if (checklistTotals.pct < 100) {
      score -= 12;
      reasons.push(`Readiness checklist is ${checklistTotals.pct}% complete.`);
    }
    if (recentBehavior.planAdherence !== null && recentBehavior.planAdherence < 80) {
      score -= 12;
      reasons.push(`Recent plan adherence is ${recentBehavior.planAdherence}%.`);
    }
    if (recentBehavior.revengeTagged > 0) {
      score -= 14;
      reasons.push('Recent revenge-tagged behavior deserves an explicit reset rule.');
    }
    if (lastSession && lastSession.netPnl < 0) {
      score -= 10;
      reasons.push(`Last session closed at ${formatSignedCurrency(lastSession.netPnl)}.`);
    }

    const normalizedScore = Math.max(0, Math.min(100, score));
    const status = normalizedScore >= 82 ? 'Ready' : normalizedScore >= 58 ? 'Caution' : 'Stand Down';
    const summary = status === 'Ready'
      ? 'You have a clear plan and enough preparation to trade selectively.'
      : status === 'Caution'
        ? 'The plan is usable, but one or two risk conditions deserve attention before sizing up.'
        : 'Pause before the session. Reduce pressure, finish the checks, and protect capital first.';

    return {
      status,
      score: normalizedScore,
      summary,
      reasons: reasons.slice(0, 3),
    } as const;
  }, [checklistTotals.completed, checklistTotals.pct, checklistTotals.total, emotion, emotionLogged, lastSession, recentBehavior.planAdherence, recentBehavior.revengeTagged]);

  const persistPreSession = (updates: Partial<{ emotion: string; note: string; bias: BiasState; checklistState: ChecklistState; startedAt: string | null; sessionMaxLoss: number | null; dailyTarget: number | null }>) => {
    const parsedLoss = parseFloat(sessionMaxLoss);
    const parsedTarget = parseFloat(sessionTarget);
    const data = {
      emotion: updates.emotion ?? emotion,
      note: updates.note ?? note,
      bias: updates.bias ?? bias,
      checklistState: updates.checklistState ?? checklistState,
      startedAt: updates.startedAt ?? storedPreSession?.startedAt ?? null,
      readiness,
      sessionPlan,
      commitment: storedPreSession?.commitment,
      sessionMaxLoss: 'sessionMaxLoss' in updates ? updates.sessionMaxLoss : (isFinite(parsedLoss) && parsedLoss > 0 ? parsedLoss : null),
      dailyTarget: 'dailyTarget' in updates ? updates.dailyTarget : (isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null),
    };
    setPreSessionAction(data);
    setPreSessionForDate(todayIso, data);
  };

  const setEmotionAndPersist = (nextEmotion: string) => {
    setEmotion(nextEmotion);
    persistPreSession({ emotion: nextEmotion });
  };

  const setNoteAndPersist = (nextNote: string) => {
    setNote(nextNote);
    persistPreSession({ note: nextNote });
  };

  const setBiasAndPersist = (instrument: keyof BiasState, value: BiasValue) => {
    setBias(current => {
      const next = { ...current, [instrument]: value };
      persistPreSession({ bias: next });
      return next;
    });
  };

  const openOathEditor = () => {
    setOathDraft(activeOathItems.map(item => ({ id: item.id, label: item.label })));
    setOathEditOpen(true);
  };

  const saveOathItems = () => {
    const filtered = oathDraft.filter(item => item.label.trim() !== '');
    setOathItemsAction(filtered.length > 0 ? filtered : null);
    setOathEditOpen(false);
  };

  const toggleChecklist = (item: ChecklistItem) => {
    if (item.autoFromEmotion) return;
    setChecklistState(current => {
      const next = { ...current, [item.id]: !current[item.id] };
      persistPreSession({ checklistState: next });
      return next;
    });
  };

  const oathCooldownRemaining = Math.max(0, Math.ceil((oathCooldownUntil - oathCooldownNow) / 1000));
  const oathCooldownActive = oathCooldownRemaining > 0;

  const toggleOathChecklist = (item: ChecklistItem) => {
    if (oathCooldownActive) return;
    toggleChecklist(item);
    setOathCooldownUntil(Date.now() + OATH_CHECK_DELAY_MS);
  };

  const sessionAlreadyStarted = useMemo(() => {
    if (!storedPreSession?.startedAt) return false;
    return getTimeZoneParts(new Date(storedPreSession.startedAt), preferences.timezone).date === todayIso;
  }, [storedPreSession?.startedAt, todayIso, preferences.timezone]);

  const startSession = () => {
    if (sessionAlreadyStarted) { navigate('/session'); return; }
    const committedAt = new Date().toISOString();
    const parsedLoss = parseFloat(sessionMaxLoss);
    const parsedTarget = parseFloat(sessionTarget);
    const sessionData = {
      emotion,
      note,
      bias,
      checklistState,
      startedAt: committedAt,
      readiness,
      sessionPlan,
      commitment: {
        committedAt,
        emotion,
        note,
        bias,
        checklistState,
        readiness,
        sessionPlan,
      },
      sessionMaxLoss: isFinite(parsedLoss) && parsedLoss > 0 ? parsedLoss : null,
      dailyTarget: isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null,
    };
    setPreSessionAction(sessionData);
    setPreSessionForDate(todayIso, sessionData);
    saveGuardSessionTrades([], committedAt);
    navigate('/session');
  };

  if (loading) {
    return (
      <div className="animate-fade-in flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl" style={{ backgroundColor: C.d0 }}>
        <LoadingSpinner size="lg" label="Preparing your pre-session brief..." />
      </div>
    );
  }

  const readinessColor = readiness.status === 'Ready' ? C.grn : readiness.status === 'Caution' ? C.acc : C.red;
  const oathCompleted = activeOathItems.filter(item => Boolean(checklistState[item.id])).length;
  const activeOathIdx = activeOathItems.findIndex(item => !Boolean(checklistState[item.id]));
  const mentalCompleted = mentalChecklistWithAdaptiveItems.filter(item => item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id])).length;
  const technicalCompleted = technicalChecklistItems.filter(item => Boolean(checklistState[item.id])).length;
  const visiblePatterns = [...activeRiskPatterns.slice(0, 2), ...confirmedEdgePatterns.slice(0, 2)];


  const stepLabels: { n: 1 | 2 | 3 | 4; label: string }[] = [
    { n: 1, label: 'Mindset' },
    { n: 2, label: 'Risk' },
    { n: 3, label: 'Checklist' },
    { n: 4, label: 'Session Brief' },
  ];

  return (
    <div style={{ height: 'calc(100vh - 3.5rem)', backgroundColor: C.d0, color: C.t0, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

      {/* ── Header ── */}
      <header data-tour-id="pre-session-header" style={{ padding: '10px 16px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 10, color: C.t2, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 1 }}>Session</p>
          <h1 style={{ fontSize: 14, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}>Pre-Session</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', borderRadius: 4, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
            {([
              { label: 'Pre-session', to: '/pre-session' },
              { label: 'Post-session', to: '/post-session' },
            ] as const).map((tab, i) => (
              <button key={tab.to} type="button" onClick={() => navigate(tab.to)} style={{
                fontSize: 11, fontWeight: tab.to === '/pre-session' ? 600 : 400,
                color: tab.to === '/pre-session' ? C.t0 : C.t2,
                backgroundColor: tab.to === '/pre-session' ? C.d3 : 'transparent',
                border: 'none', borderRight: i === 0 ? `1px solid ${C.b0}` : 'none',
                padding: '5px 12px', cursor: 'pointer',
              }}>{tab.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.t2 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: rthTiming.marketOpenToday ? C.grn : C.t2, flexShrink: 0 }} />
            <span style={{ color: C.t1 }}>{rthTiming.marketOpenToday ? 'RTH open' : `RTH in ${formatDuration(rthTiming.minutesUntilOpen)}`}</span>
            <span>·</span>
            <span>{etDateLabel(now)}</span>
          </div>
        </div>
      </header>

      {/* ── Step indicator ── */}
      <div style={{ padding: '0 16px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'stretch' }}>
        {stepLabels.map((s, i) => {
          const isActive = step === s.n;
          const isDone = step > s.n;
          return (
            <button key={s.n} type="button" onClick={() => setStep(s.n)} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 14px',
              background: 'none', border: 'none',
              borderBottom: isActive ? `2px solid ${C.acc}` : '2px solid transparent',
              marginBottom: -1,
              cursor: 'pointer',
              opacity: isDone ? 0.7 : isActive ? 1 : 0.4,
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700,
                backgroundColor: isDone ? C.grn : isActive ? C.acc : C.b0,
                color: isDone || isActive ? C.d0 : C.t2,
              }}>
                {isDone ? '✓' : s.n}
              </span>
              <span style={{ fontSize: 11, fontWeight: isActive ? 600 : 400, color: isActive ? C.t0 : C.t2, whiteSpace: 'nowrap' }}>{s.label}</span>
              {i < stepLabels.length - 1 && (
                <span style={{ marginLeft: 6, fontSize: 10, color: C.t2, opacity: 0.4 }}>›</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Step content ── */}
      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 16px' }}>
        <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ─── STEP 1: Mindset ─── */}
          {step === 1 && (
            <>
              <div data-tour-id="pre-session-mindset" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>State of mind</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>How are you coming into the session?</p>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', borderRadius: 5, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
                    {emotions.map((em, i) => {
                      const sel = emotion === em;
                      const ec = em === 'Frustrated' ? C.red : em === 'Anxious' ? '#f97316' : em === 'Neutral' ? '#94a3b8' : em === 'Focused' ? '#60a5fa' : C.grn;
                      return (
                        <button key={em} type="button" onClick={() => setEmotionAndPersist(em)} style={{
                          flex: 1, padding: '9px 4px',
                          border: 'none', borderRight: i < emotions.length - 1 ? `1px solid ${C.b0}` : 'none',
                          backgroundColor: sel ? `${ec}18` : 'transparent',
                          color: sel ? ec : C.t2,
                          fontSize: 11, fontWeight: sel ? 700 : 400, cursor: 'pointer',
                        }}>{em}</button>
                      );
                    })}
                  </div>
                  <textarea value={note} onChange={e => setNoteAndPersist(e.target.value)}
                    style={{
                      width: '100%', height: 68, resize: 'none',
                      borderRadius: 5, border: `1px solid ${C.b0}`,
                      backgroundColor: C.d2, color: C.t0,
                      fontSize: 12, padding: '9px 11px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5,
                    }}
                    placeholder="One thing to watch before entry..."
                  />
                </div>
              </div>

              <div data-tour-id="pre-session-risk" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Market bias</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>What direction are you leaning for today?</p>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(['ES', 'NQ'] as const).map(instrument => (
                    <div key={instrument}>
                      <p style={{ fontSize: 9, fontFamily: 'monospace', color: C.t2, marginBottom: 6, letterSpacing: '0.07em', fontWeight: 600 }}>{instrument}</p>
                      <div style={{ display: 'flex', borderRadius: 5, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
                        {biasOptions.map((opt, i) => {
                          const sel = bias[instrument] === opt;
                          const oc = opt === 'Bull' ? C.grn : opt === 'Bear' ? C.red : C.acc;
                          return (
                            <button key={opt} type="button" onClick={() => setBiasAndPersist(instrument, opt)} style={{
                              flex: 1, padding: '8px 0',
                              border: 'none', borderRight: i < biasOptions.length - 1 ? `1px solid ${C.b0}` : 'none',
                              backgroundColor: sel ? `${oc}18` : 'transparent',
                              fontSize: 12, fontWeight: sel ? 700 : 400,
                              color: sel ? oc : C.t2, cursor: 'pointer',
                            }}>{opt}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {(recentBehavior.planAdherence !== null || recentBehavior.revengeTagged > 0 || lastSession) && (
                <div data-tour-id="pre-session-behavior" style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.b0}`, backgroundColor: C.d1, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.07em', textTransform: 'uppercase', marginRight: 4 }}>Recent</span>
                  {recentBehavior.planAdherence !== null && (
                    <span style={{ fontSize: 11, color: recentBehavior.planAdherence < 80 ? C.acc : C.t1 }}>
                      Plan adherence <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{recentBehavior.planAdherence}%</span>
                    </span>
                  )}
                  {recentBehavior.revengeTagged > 0 && (
                    <span style={{ fontSize: 11, color: C.red }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{recentBehavior.revengeTagged}</span> revenge tag{recentBehavior.revengeTagged > 1 ? 's' : ''}
                    </span>
                  )}
                  {lastSession && (
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: lastSession.netPnl < 0 ? C.red : C.grn, marginLeft: 'auto' }}>
                      Last session {formatSignedCurrency(lastSession.netPnl)}
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {/* ─── STEP 2: Risk ─── */}
          {step === 2 && (
            <>
              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <div>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Today&apos;s risk limits</h2>
                    <p style={{ fontSize: 11, color: C.t2 }}>Confirm or adjust before you start.</p>
                  </div>
                  <button type="button" onClick={riskEditOpen ? () => setRiskEditOpen(false) : openRiskEditor}
                    style={{ fontSize: 11, color: riskEditOpen ? C.t2 : C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {riskEditOpen ? 'cancel' : 'edit'}
                  </button>
                </div>

                {/* Stat row — no inner boxes, just dividers */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                  {[
                    { label: 'Max loss', value: riskLimits.noLossLimit ? 'No limit' : formatCurrency(-riskLimits.maxDailyLoss), color: riskLimits.noLossLimit ? C.t2 : C.red },
                    { label: 'Max win', value: formatCurrency(riskLimits.maxWin), color: C.grn },
                    { label: 'Max trades', value: String(riskLimits.maxTrades), color: C.t1 },
                    { label: 'Contracts', value: String(riskLimits.maxContracts), color: C.t1 },
                  ].map((stat, i) => (
                    <div key={stat.label} style={{ padding: '16px 18px', borderRight: i < 3 ? `1px solid ${C.b0}` : 'none' }}>
                      <p style={{ fontFamily: 'monospace', fontSize: 17, fontWeight: 500, color: stat.color, lineHeight: 1, marginBottom: 6, letterSpacing: '-0.02em' }}>{stat.value}</p>
                      <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.03em' }}>{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Edit form */}
                {riskEditOpen && (
                  <div style={{ borderTop: `1px solid ${C.b0}`, padding: '16px' }}>
                    {/* Primary row: Max Loss + Max Win */}
                    <p style={{ fontSize: 10, fontWeight: 600, color: C.t2, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>Loss &amp; Profit limits</p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                      {([
                        ['daily_loss_limit',   'Max loss',  '$', 'Stop trading at this loss (0 = no limit)'],
                        ['daily_profit_limit', 'Max win',   '$', 'Stop trading when profit hits this'],
                      ] as const).map(([field, label, , hint]) => (
                        <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: C.t1 }}>{label}</span>
                          <div style={{ display: 'flex', alignItems: 'center', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2, padding: '0 10px' }}>
                            <span style={{ color: C.t2, fontSize: 12, marginRight: 4 }}>$</span>
                            <input type="number" min="0" step="1" placeholder="0" value={riskDraft[field]} onChange={e => updateRiskDraft(field, e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 14, color: C.t0, padding: '9px 0', minWidth: 0 }} />
                          </div>
                          <span style={{ fontSize: 10, color: C.t2 }}>{hint}</span>
                        </label>
                      ))}
                    </div>

                    {/* Secondary row: Trades + Contracts */}
                    <p style={{ fontSize: 10, fontWeight: 600, color: C.t2, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>Session limits</p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                      {([
                        ['max_trades_per_day',      'Max trades',  'Max number of trades per session'],
                        ['max_contracts_per_trade', 'Contracts',   'Max contracts per single trade'],
                      ] as const).map(([field, label, hint]) => (
                        <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: C.t1 }}>{label}</span>
                          <input type="number" min="0" step="1" value={riskDraft[field]} onChange={e => updateRiskDraft(field, e.target.value)} style={{ borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2, outline: 'none', fontSize: 14, color: C.t0, padding: '9px 10px' }} />
                          <span style={{ fontSize: 10, color: C.t2 }}>{hint}</span>
                        </label>
                      ))}
                    </div>

                    {/* Optional: Account + Risk % */}
                    <details style={{ marginBottom: 14 }}>
                      <summary style={{ fontSize: 10, fontWeight: 600, color: C.t2, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>Advanced (optional)</span>
                      </summary>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                        {([
                          ['account_size',   'Account size', '$', '%'],
                          ['risk_percentage','Risk per trade','',  '%'],
                        ] as const).map(([field, label, prefix, suffix]) => (
                          <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: C.t1 }}>{label}</span>
                            <div style={{ display: 'flex', alignItems: 'center', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2, padding: '0 10px' }}>
                              {prefix === '$' && <span style={{ color: C.t2, fontSize: 12, marginRight: 4 }}>$</span>}
                              <input type="number" min="0" step={field === 'risk_percentage' ? '0.1' : '1'} placeholder="skip" value={riskDraft[field]} onChange={e => updateRiskDraft(field, e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 14, color: C.t0, padding: '9px 0', minWidth: 0 }} />
                              {suffix === '%' && field === 'risk_percentage' && <span style={{ color: C.t2, fontSize: 12 }}>%</span>}
                            </div>
                          </label>
                        ))}
                      </div>
                    </details>

                    {riskSaveError && <p style={{ fontSize: 11, color: C.red, marginBottom: 10 }}>{riskSaveError}</p>}
                    <button type="button" onClick={saveRiskLimits} disabled={riskSaving}
                      style={{ width: '100%', padding: '10px 0', borderRadius: 5, border: `1px solid ${C.acc}44`, backgroundColor: `${C.acc}10`, color: C.acc, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {riskSaving ? 'Saving...' : 'Save limits'}
                    </button>
                  </div>
                )}
              </div>

              {priorFlow?.biggestLeak && (
                <div style={{
                  padding: '14px 16px', borderRadius: 8,
                  border: `1px solid ${C.b0}`,
                  borderLeft: `3px solid ${priorFlow.biggestLeak ? C.red : C.grn}`,
                  backgroundColor: C.d1,
                }}>
                  <p style={{ fontSize: 9, fontWeight: 700, color: priorFlow.biggestLeak ? C.red : C.grn, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                    Carry-forward rule
                  </p>
                  <p style={{ fontSize: 13, fontWeight: 600, color: C.t0, lineHeight: 1.5, marginBottom: 5 }}>{priorFlow.tomorrowRule}</p>
                  <p style={{ fontSize: 11, color: C.t2, lineHeight: 1.45 }}>From {priorFlow.date}: {priorFlow.summary}</p>
                </div>
              )}
            </>
          )}

          {/* ─── STEP 3: Checklist ─── */}
          {step === 3 && (
            <>
              {/* Trader Oath — sequential commitment flow */}
              <div data-tour-id="pre-session-oath" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <div>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Trader Oath</h2>
                    <p style={{ fontSize: 11, color: C.t2 }}>
                      {activeOathIdx === -1 ? 'All commitments accepted.' : `${oathCompleted} of ${activeOathItems.length} accepted`}
                    </p>
                  </div>
                  <button type="button" onClick={oathEditOpen ? () => setOathEditOpen(false) : openOathEditor}
                    style={{ fontSize: 10, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {oathEditOpen ? 'cancel' : 'edit'}
                  </button>
                </div>

                {oathEditOpen ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px' }}>
                    {oathDraft.map((item, idx) => (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="text" value={item.label}
                          onChange={e => { const next = [...oathDraft]; next[idx] = { ...item, label: e.target.value }; setOathDraft(next); }}
                          style={{ flex: 1, borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t0, fontSize: 12, padding: '7px 10px', outline: 'none', fontFamily: 'inherit' }}
                        />
                        <button type="button" onClick={() => setOathDraft(oathDraft.filter((_, i) => i !== idx))}
                          style={{ width: 28, height: 28, borderRadius: 3, border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t2, fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setOathDraft([...oathDraft, { id: `oath-custom-${Date.now()}`, label: '' }])}
                      style={{ padding: '7px 0', borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: 'transparent', color: C.t2, fontSize: 11, cursor: 'pointer' }}>+ Add</button>
                    <button type="button" onClick={saveOathItems}
                      style={{ padding: '8px 0', borderRadius: 4, border: `1px solid ${C.acc}44`, backgroundColor: `${C.acc}10`, color: C.acc, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                  </div>
                ) : (
                  <>
                  <div style={{ padding: '18px 16px' }}>

                    {/* Completed items — collapsed, struck through */}
                    {oathCompleted > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: activeOathIdx !== -1 ? 18 : 0 }}>
                        {activeOathItems.filter(item => Boolean(checklistState[item.id])).map(item => (
                          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 9, opacity: 0.45 }}>
                            <span style={{
                              width: 15, height: 15, borderRadius: '50%', flexShrink: 0,
                              backgroundColor: `${C.grn}20`, border: `1px solid ${C.grn}50`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 7, color: C.grn,
                            }}>✓</span>
                            <p style={{ fontSize: 11, color: C.t2, lineHeight: 1.4, textDecoration: 'line-through' }}>{item.label}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {activeOathIdx === -1 ? (
                      /* All done */
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                        <span style={{ fontSize: 18, color: C.grn }}>✓</span>
                        <p style={{ fontSize: 13, fontWeight: 600, color: C.grn }}>Oath complete — you're committed.</p>
                      </div>
                    ) : (
                      <>
                        {/* Active commitment */}
                        <div style={{ borderLeft: `3px solid ${C.acc}`, paddingLeft: 14, marginBottom: activeOathItems.slice(activeOathIdx + 1).length > 0 ? 18 : 0 }}>
                          <p style={{ fontSize: 9, fontWeight: 700, color: C.acc, letterSpacing: '0.09em', textTransform: 'uppercase', marginBottom: 10 }}>
                            Commitment {activeOathIdx + 1} of {activeOathItems.length}
                          </p>
                          <p style={{ fontSize: 14, lineHeight: 1.7, color: C.t0, fontWeight: 500 }}>
                            {activeOathItems[activeOathIdx].label}
                          </p>
                        </div>

                        {/* Upcoming — faded queue */}
                        {activeOathItems.slice(activeOathIdx + 1).map((item, i) => (
                          <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: i < activeOathItems.slice(activeOathIdx + 1).length - 1 ? 10 : 0, opacity: Math.max(0.12, 0.35 - i * 0.08) }}>
                            <span style={{ width: 15, height: 15, borderRadius: '50%', border: `1px solid ${C.b0}`, flexShrink: 0, marginTop: 3 }} />
                            <p style={{ fontSize: 11.5, color: C.t2, lineHeight: 1.5 }}>{item.label}</p>
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Accept — card footer, always at bottom */}
                  {activeOathIdx !== -1 && (
                    <button
                      type="button"
                      disabled={oathCooldownActive}
                      onClick={() => toggleOathChecklist(activeOathItems[activeOathIdx])}
                      style={{
                        width: '100%', padding: '13px 16px',
                        border: 'none', borderTop: `1px solid ${C.b0}`,
                        backgroundColor: oathCooldownActive ? 'transparent' : C.d3,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        color: oathCooldownActive ? C.t2 : C.acc,
                        fontSize: 12, fontWeight: 600,
                        cursor: oathCooldownActive ? 'default' : 'pointer',
                      }}>
                      <span>{oathCooldownActive ? `Accepted — next in ${oathCooldownRemaining}s` : 'I accept this'}</span>
                      {!oathCooldownActive && <span style={{ fontSize: 14, opacity: 0.7 }}>→</span>}
                    </button>
                  )}
                  </>
                )}
              </div>

              {/* Readiness checks */}
              <div data-tour-id="pre-session-checklist" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <div>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Readiness checks</h2>
                    <p style={{ fontSize: 11, color: C.t2 }}>Mental clarity + platform setup.</p>
                  </div>
                  <span style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 600, color: mentalCompleted + technicalCompleted === mentalChecklistWithAdaptiveItems.length + technicalChecklistItems.length ? C.grn : C.t2 }}>
                    {mentalCompleted + technicalCompleted}/{mentalChecklistWithAdaptiveItems.length + technicalChecklistItems.length}
                  </span>
                </div>
                <div>
                  {[
                    { label: 'Mental', items: mentalChecklistWithAdaptiveItems, done: mentalCompleted === mentalChecklistWithAdaptiveItems.length },
                    { label: 'Technical', items: technicalChecklistItems, done: technicalCompleted === technicalChecklistItems.length },
                  ].map((group, gi) => (
                    <div key={group.label} style={{ borderTop: gi === 0 ? 'none' : `1px solid ${C.b0}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 16px 5px' }}>
                        <p style={{ fontSize: 9, fontWeight: 700, color: group.done ? C.grn : C.t2, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{group.label}</p>
                        {group.done && <span style={{ fontSize: 9, color: C.grn, fontFamily: 'monospace', letterSpacing: '0.04em' }}>ALL CLEAR</span>}
                      </div>
                      {(() => {
                        const allItems = [...mentalChecklistWithAdaptiveItems, ...technicalChecklistItems];
                        const nextUncheckedId = allItems.find(it => !(it.autoFromEmotion ? emotionLogged : Boolean(checklistState[it.id])))?.id ?? null;
                        return group.items.map((item, i) => {
                          const checked = item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id]);
                          const isNext = !checked && item.id === nextUncheckedId;
                          return (
                            <button key={item.id} type="button" onClick={() => toggleChecklist(item)} style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              gap: 12, padding: '11px 16px',
                              width: '100%', textAlign: 'left',
                              border: 'none',
                              borderTop: i === 0 ? 'none' : `1px solid ${C.b0}`,
                              borderLeft: `3px solid ${checked ? C.grn : isNext ? C.acc : 'transparent'}`,
                              backgroundColor: checked ? `${C.grn}06` : isNext ? `${C.acc}07` : 'transparent',
                              cursor: item.autoFromEmotion ? 'default' : 'pointer',
                              opacity: checked ? 0.5 : isNext ? 1 : 0.45,
                              transition: 'opacity 0.15s',
                            }}>
                              <div style={{ minWidth: 0 }}>
                                <p style={{ fontSize: 12, fontWeight: isNext ? 600 : 500, color: checked ? C.t2 : C.t0, lineHeight: 1.45 }}>{item.label}</p>
                                {item.source && (
                                  <p style={{ fontSize: 9, color: C.t2, marginTop: 2 }}>{item.source}</p>
                                )}
                              </div>
                              <span style={{ flexShrink: 0, fontSize: 10, fontFamily: 'monospace', fontWeight: 700, color: checked ? C.grn : isNext ? C.acc : C.t2 }}>
                                {checked ? '✓' : item.autoFromEmotion ? 'auto' : isNext ? 'tap' : '—'}
                              </span>
                            </button>
                          );
                        });
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ─── STEP 4: Session Brief ─── */}
          {step === 4 && (
            <>
              <div style={{ borderRadius: 8, border: `1px solid ${C.b0}`, backgroundColor: C.d1, overflow: 'hidden' }}>
                {/* Colored top bar */}
                <div style={{ height: 3, backgroundColor: `${readinessColor}30` }}>
                  <div style={{ height: '100%', width: `${readiness.score}%`, backgroundColor: readinessColor, transition: 'width 0.4s ease' }} />
                </div>
                {/* Score + status + summary */}
                <div style={{ padding: '14px 18px 16px', borderBottom: readiness.reasons.length > 0 ? `1px solid ${C.b0}` : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 40, fontWeight: 500, color: readinessColor, lineHeight: 1, letterSpacing: '-0.04em' }}>{readiness.score}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.t2 }}>/100</span>
                    <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: readinessColor, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.85 }}>{readiness.status}</span>
                  </div>
                  <p style={{ fontSize: 12, color: C.t1, lineHeight: 1.6 }}>{readiness.summary}</p>
                </div>
                {/* Reasons */}
                {readiness.reasons.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 18px', borderTop: `1px solid ${C.b0}` }}>
                    <span style={{ width: 3, height: 3, borderRadius: '50%', flexShrink: 0, backgroundColor: readinessColor, marginTop: 6, opacity: 0.7 }} />
                    <p style={{ fontSize: 11, color: C.t2, lineHeight: 1.5 }}>{r}</p>
                  </div>
                ))}
              </div>

              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Session plan</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>Your rules for today.</p>
                </div>
                <div>
                  {sessionPlan.map((row, i) => {
                    const bc = row.source === 'Primary focus' ? C.grn : row.source === 'Hard stop' ? C.red : C.acc;
                    return (
                      <div key={row.id} style={{
                        padding: '12px 16px',
                        borderTop: i === 0 ? 'none' : `1px solid ${C.b0}`,
                        borderLeft: `3px solid ${bc}`,
                      }}>
                        <p style={{ fontSize: 9, fontWeight: 700, color: bc, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 5 }}>{row.source}</p>
                        <p style={{ fontSize: 12, lineHeight: 1.55, color: C.t0 }}>{row.rule}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {visiblePatterns.length > 0 && (
                <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                  <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.b0}` }}>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0 }}>Pattern watch</h2>
                  </div>
                  <div>
                    {visiblePatterns.map((p, i) => {
                      const risk = activeRiskPatterns.some(item => item.id === p.id);
                      return (
                        <div key={p.id} style={{
                          display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 16px',
                          borderTop: i === 0 ? 'none' : `1px solid ${C.b0}`,
                        }}>
                          <span style={{
                            flexShrink: 0, marginTop: 1,
                            fontSize: 8, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
                            color: risk ? C.red : C.grn, border: `1px solid ${risk ? C.red : C.grn}38`, borderRadius: 3, padding: '2px 6px',
                          }}>{risk ? 'Watch' : 'Edge'}</span>
                          <div>
                            <p style={{ fontSize: 12, fontWeight: 600, color: C.t0, marginBottom: 3 }}>{p.title}</p>
                            <p style={{ fontSize: 11, color: C.t1, lineHeight: 1.45 }}>{buildPatternInstruction(p, risk ? 'watch' : 'protect')}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div data-tour-id="pre-session-begin" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                {sessionAlreadyStarted ? (
                  <button type="button" onClick={() => navigate('/session')} style={{
                    width: '100%', padding: '14px 16px',
                    border: 'none', backgroundColor: 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    color: C.grn, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                    <span>Continue session</span>
                    <span style={{ fontSize: 15, opacity: 0.8 }}>→</span>
                  </button>
                ) : (
                  <button type="button" onClick={startSession} style={{
                    width: '100%', padding: '14px 16px',
                    border: 'none', backgroundColor: C.d3,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    color: C.acc, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                    <span>Begin session</span>
                    <span style={{ fontSize: 15, opacity: 0.8 }}>→</span>
                  </button>
                )}
              </div>
            </>
          )}

          {/* ── Step navigation ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: `1px solid ${C.b0}` }}>
            <button type="button"
              onClick={() => { if (step > 1) setStep((step - 1) as 1 | 2 | 3 | 4); }}
              style={{
                visibility: step > 1 ? 'visible' : 'hidden',
                padding: '8px 16px', borderRadius: 5, border: `1px solid ${C.b0}`,
                backgroundColor: 'transparent', color: C.t2, fontSize: 12, cursor: 'pointer',
              }}>← Back</button>
            <div style={{ display: 'flex', gap: 8 }}>
              {step < 4 && (
                <button type="button"
                  onClick={() => { if (step < 4) setStep((step + 1) as 1 | 2 | 3 | 4); }}
                  style={{
                    padding: '8px 22px', borderRadius: 5,
                    border: `1px solid ${C.acc}40`,
                    backgroundColor: `${C.acc}12`, color: C.acc, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>Continue →</button>
              )}
              {step === 4 && (
                <button type="button" onClick={() => navigate('/')} style={{
                  padding: '8px 14px', borderRadius: 5, border: `1px solid ${C.b0}`,
                  backgroundColor: 'transparent', color: C.t2, fontSize: 11, cursor: 'pointer',
                }}>Dashboard</button>
              )}
            </div>
          </div>

        </div>
      </main>
    </div>
  );

}
