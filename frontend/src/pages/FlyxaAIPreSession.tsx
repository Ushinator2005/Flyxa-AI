import { CSSProperties, useEffect, useMemo, useState } from 'react';
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
const biasOptions: BiasValue[] = ['Bull', 'Bear', 'Neutral'];

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

function sourceBadgeStyle(source: SessionPlanRow['source']): CSSProperties {
  if (source === 'Primary focus') return { color: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)' };
  if (source === 'Avoid today') return { color: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' };
  return { color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)' };
}

function customCheckbox(checked: boolean) {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] border"
      style={{
        borderColor: checked ? '#22c55e' : 'rgba(255,255,255,0.2)',
        backgroundColor: checked ? '#22c55e' : 'transparent',
      }}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 5.1L4.1 7.2L8 3.2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
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
    max_trades_per_day: '',
    max_contracts_per_trade: '',
    account_size: '',
    risk_percentage: '',
  });

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

    const dailyLossValue = dailyLoss && dailyLoss > 0 ? dailyLoss : 500;
    const maxTradesValue = maxTrades && maxTrades > 0 ? maxTrades : 10;
    const maxContractsValue = maxContracts && maxContracts > 0 ? maxContracts : 2;
    const accountSizeValue = accountSize && accountSize > 0 ? accountSize : 10000;
    const riskPctValue = riskPct && riskPct > 0 ? riskPct : 1;
    const riskPerTrade = (accountSizeValue * riskPctValue) / 100;
    const target = Math.max(riskPerTrade * 3, dailyLossValue * 0.6);

    return {
      maxDailyLoss: dailyLossValue,
      maxTrades: maxTradesValue,
      riskPerTrade,
      target,
      maxContracts: maxContractsValue,
      riskPct: riskPctValue,
      accountSize: accountSizeValue,
    };
  }, [settings, storedRiskSettings]);

  const openRiskEditor = () => {
    setRiskDraft({
      daily_loss_limit: String(Math.round(riskLimits.maxDailyLoss)),
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
    const loss     = Number(riskDraft.daily_loss_limit);
    const trades   = Number(riskDraft.max_trades_per_day);

    // Only daily loss limit and max trades are required
    if (!Number.isFinite(loss) || loss <= 0 || !Number.isFinite(trades) || trades <= 0) {
      setRiskSaveError('Enter a positive number for max loss and max trades.');
      return;
    }

    const next: Record<string, number> = { daily_loss_limit: loss, max_trades_per_day: trades };

    // Optional fields — include only when a valid positive number is provided
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
      ...(priorFlow ? [{
        id: 'tomorrow-rule',
        source: 'Hard stop' as const,
        rule: priorFlow.tomorrowRule,
      }] : []),
      {
        id: 'focus',
        source: 'Primary focus',
        rule: topEdge
          ? `Prioritize ${topEdge.session} entries in ${topEdge.instrument}; this is your highest-confidence edge window today.`
          : 'Prioritize your cleanest A+ continuation window and skip marginal entries.',
      },
      {
        id: 'avoid',
        source: 'Avoid today',
        rule: topRisk
          ? `Avoid ${topRisk.title.toLowerCase()} by pausing after the first loss and requiring full checklist confirmation.`
          : recentEmotionDrag
            ? 'Do not chase recovery trades. If frustration shows up, step away before taking another entry.'
            : recentPlanDrag
              ? 'Do not take trades that skip your plan confirmation; recent execution drift says this matters today.'
              : 'Avoid unplanned entries and keep the session narrow enough to protect your best execution.',
      },
      {
        id: 'hard-stop',
        source: 'Hard stop',
        rule: `Walk away for the day at ${formatCurrency(-riskLimits.maxDailyLoss)} or after ${riskLimits.maxTrades} trades, whichever comes first.`,
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
  const mentalCompleted = mentalChecklistWithAdaptiveItems.filter(item => item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id])).length;
  const technicalCompleted = technicalChecklistItems.filter(item => Boolean(checklistState[item.id])).length;
  const primaryPlanRows = sessionPlan.filter(row => row.source === 'Primary focus').slice(0, 2);
  const protectionPlanRows = sessionPlan.filter(row => row.source !== 'Primary focus').slice(0, 3);
  const visiblePatterns = [...activeRiskPatterns.slice(0, 2), ...confirmedEdgePatterns.slice(0, 2)];

  return (
    <div style={{ height: 'calc(100vh - 3.5rem)', backgroundColor: C.d0, color: C.t0, borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <header data-tour-id="pre-session-header" style={{ padding: '13px 20px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 11, color: C.t2, fontWeight: 500 }}>Session</p>
          <h1 style={{ fontSize: 18, fontWeight: 800, color: C.t0, letterSpacing: '-0.02em', marginTop: 2 }}>Session Command Center</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {/* Session tab toggle */}
          <div style={{ display: 'flex', gap: 2, padding: 2, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 7, border: `1px solid ${C.b0}` }}>
            {([
              { label: 'Pre-session', to: '/pre-session' },
              { label: 'Post-session', to: '/post-session' },
            ] as const).map(tab => (
              <button
                key={tab.to}
                type="button"
                onClick={() => navigate(tab.to)}
                style={{
                  fontSize: 11,
                  fontWeight: tab.to === '/pre-session' ? 600 : 500,
                  color: tab.to === '/pre-session' ? C.acc : C.t2,
                  backgroundColor: tab.to === '/pre-session' ? 'rgba(245,158,11,0.10)' : 'transparent',
                  border: 'none', borderRadius: 5, padding: '4px 10px', cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.t1 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: rthTiming.marketOpenToday ? C.grn : C.t2, flexShrink: 0 }} />
            <span>{rthTiming.marketOpenToday ? 'RTH open' : `RTH in ${formatDuration(rthTiming.minutesUntilOpen)}`}</span>
            <span style={{ color: C.t2 }}>·</span>
            <span>{etDateLabel(now)}</span>
          </div>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.65fr) minmax(320px, 0.85fr)', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <section style={{ border: '1px solid rgba(255,255,255,0.065)', backgroundColor: `${readinessColor}07`, borderRadius: 14, padding: '18px 20px', display: 'grid', gridTemplateColumns: '210px minmax(0,1fr)', gap: 24, alignItems: 'center', boxShadow: '0 2px 18px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.04) inset' }}>
              {/* Score side */}
              <div>
                <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 6, backgroundColor: `${readinessColor}18`, border: `1px solid ${readinessColor}40`, color: readinessColor, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {readiness.status}
                </span>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 10 }}>
                  <span style={{ fontSize: 48, fontWeight: 800, color: C.t0, lineHeight: 1, letterSpacing: '-0.04em' }}>{readiness.score}</span>
                  <span style={{ fontSize: 13, color: C.t2, letterSpacing: '-0.01em' }}>/100</span>
                </div>
                <div style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 999, overflow: 'hidden', margin: '10px 0 9px' }}>
                  <div style={{ height: '100%', width: `${readiness.score}%`, backgroundColor: readinessColor, borderRadius: 999, transition: 'width 0.55s cubic-bezier(0.4,0,0.2,1)' }} />
                </div>
                <p style={{ fontSize: 11.5, color: C.t1, lineHeight: 1.55, letterSpacing: '-0.01em' }}>{readiness.summary}</p>
              </div>
              {/* Metric cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                {[
                  { label: 'Checks', value: `${checklistTotals.completed}/${checklistTotals.total}`, color: checklistTotals.completed === checklistTotals.total ? C.grn : C.acc },
                  { label: 'Oath', value: `${oathCompleted}/${activeOathItems.length}`, color: oathCompleted === activeOathItems.length ? C.grn : C.acc },
                  { label: 'Plan', value: String(sessionPlan.length), color: C.t0 },
                  { label: 'Last', value: lastSession ? formatSignedCurrency(lastSession.netPnl) : '--', color: lastSession && lastSession.netPnl < 0 ? C.red : C.grn },
                ].map(item => (
                  <article key={item.label} style={{ borderRadius: 10, backgroundColor: C.d1, padding: '13px 14px', border: '1px solid rgba(255,255,255,0.055)', boxShadow: '0 1px 8px rgba(0,0,0,0.22)' }}>
                    <p style={{ fontSize: 11, color: C.t2, fontWeight: 500, marginBottom: 9 }}>{item.label}</p>
                    <p style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 20, color: item.color, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{item.value}</p>
                  </article>
                ))}
              </div>
            </section>

            <section data-tour-id="pre-session-begin" style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 14, alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: 13, fontWeight: 800, color: C.t0 }}>Today&apos;s operating mode</p>
                <p style={{ marginTop: 4, fontSize: 12, color: C.t1, lineHeight: 1.6 }}>
                  {readiness.status === 'Ready'
                    ? 'Green light only for planned trades. Keep execution narrow and measurable.'
                    : readiness.status === 'Caution'
                      ? 'Trade smaller and slower. One clean trade is better than a busy session.'
                      : 'Stand down until the blockers are cleared. Capital protection is the win condition.'}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {sessionAlreadyStarted ? (
                  <button type="button" onClick={() => navigate('/session')} style={{ height: 36, padding: '0 18px', borderRadius: 6, border: `1px solid ${C.grn}55`, backgroundColor: `${C.grn}12`, color: C.grn, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
                    Session open — continue →
                  </button>
                ) : (
                  <button type="button" onClick={startSession} style={{ height: 36, padding: '0 18px', borderRadius: 6, border: `1px solid ${C.acc}`, backgroundColor: C.acc, color: '#0e0d0d', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
                    Accept oath — begin
                  </button>
                )}
                <button type="button" onClick={() => navigate('/')} style={{ height: 36, padding: '0 14px', borderRadius: 6, border: `1px solid ${C.b1}`, backgroundColor: 'transparent', color: C.t1, fontSize: 12, cursor: 'pointer' }}>
                  Dashboard
                </button>
              </div>
            </section>

            {priorFlow && (
              <section style={{ border: `1px solid ${priorFlow.biggestLeak ? `${C.red}55` : `${C.grn}44`}`, borderRadius: 10, backgroundColor: priorFlow.biggestLeak ? 'rgba(239,68,68,0.075)' : 'rgba(34,197,94,0.065)', padding: 14 }}>
                <p style={{ fontSize: 11, color: priorFlow.biggestLeak ? C.red : C.grn, fontWeight: 700 }}>Tomorrow&apos;s Rule</p>
                <p style={{ marginTop: 7, fontSize: 15, fontWeight: 800, color: C.t0, lineHeight: 1.45 }}>{priorFlow.tomorrowRule}</p>
                <p style={{ marginTop: 6, fontSize: 12, color: C.t1, lineHeight: 1.55 }}>
                  From {priorFlow.date}: {priorFlow.summary}
                  {priorFlow.worstState && priorFlow.bestState && priorFlow.worstState.label !== priorFlow.bestState.label
                    ? ` Best state was ${priorFlow.bestState.label}; weakest was ${priorFlow.worstState.label}.`
                    : ''}
                </p>
              </section>
            )}

            <section data-tour-id="pre-session-oath" style={{ border: '1px solid rgba(255,255,255,0.065)', borderRadius: 14, backgroundColor: C.d1, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.25)' }}>
              {/* Header */}
              <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <p style={{ fontSize: 11, color: C.t2, fontWeight: 500, marginBottom: 3 }}>Pre-session commitment</p>
                  <h2 style={{ fontSize: 15, fontWeight: 700, color: C.t0, letterSpacing: '-0.02em' }}>Trader Oath</h2>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {oathCooldownActive && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', color: C.t2, fontFamily: 'monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.02em' }}>
                      read next · {oathCooldownRemaining}s
                    </span>
                  )}
                  <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 9px', borderRadius: 6, backgroundColor: oathCompleted === activeOathItems.length ? 'rgba(34,214,138,0.12)' : 'rgba(245,158,11,0.1)', border: `1px solid ${oathCompleted === activeOathItems.length ? 'rgba(34,214,138,0.3)' : 'rgba(245,158,11,0.25)'}`, color: oathCompleted === activeOathItems.length ? C.grn : C.acc, fontFamily: 'monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em' }}>
                    {oathCompleted}/{activeOathItems.length}
                  </span>
                  <button type="button" onClick={oathEditOpen ? () => setOathEditOpen(false) : openOathEditor}
                    style={{ fontSize: 10, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.02em' }}
                  >{oathEditOpen ? 'cancel' : 'edit'}</button>
                </div>
              </div>
              {/* Progress track */}
              <div style={{ margin: '12px 18px 0', height: 2, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${activeOathItems.length > 0 ? (oathCompleted / activeOathItems.length) * 100 : 0}%`, backgroundColor: oathCompleted === activeOathItems.length ? C.grn : C.acc, borderRadius: 999, transition: 'width 0.45s cubic-bezier(0.4,0,0.2,1)' }} />
              </div>
              {oathEditOpen ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 18px 16px' }}>
                  {oathDraft.map((item, idx) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="text" value={item.label}
                        onChange={e => { const next = [...oathDraft]; next[idx] = { ...item, label: e.target.value }; setOathDraft(next); }}
                        style={{ flex: 1, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: C.d2, color: C.t0, fontSize: 12, padding: '8px 10px', outline: 'none', fontFamily: 'inherit' }}
                      />
                      <button type="button" onClick={() => setOathDraft(oathDraft.filter((_, i) => i !== idx))}
                        style={{ width: 28, height: 28, borderRadius: 5, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: C.d2, color: C.t2, fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                        aria-label="Remove">✕</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setOathDraft([...oathDraft, { id: `oath-custom-${Date.now()}`, label: '' }])}
                    style={{ padding: '7px 0', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)', backgroundColor: 'transparent', color: C.t2, fontSize: 12, cursor: 'pointer' }}
                  >+ Add</button>
                  <button type="button" onClick={saveOathItems}
                    style={{ padding: '8px 0', borderRadius: 6, border: '1px solid rgba(245,158,11,0.35)', backgroundColor: 'rgba(245,158,11,0.1)', color: C.acc, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >Save</button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '10px 14px 14px' }}>
                  {activeOathItems.map(item => {
                    const checked = Boolean(checklistState[item.id]);
                    const locked = oathCooldownActive;
                    return (
                      <button key={item.id} type="button" disabled={locked} onClick={() => toggleOathChecklist(item)} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 14px',
                        borderRadius: 9,
                        border: `1px solid ${checked ? 'rgba(245,158,11,0.18)' : 'transparent'}`,
                        borderLeft: `2px solid ${checked ? C.acc : 'transparent'}`,
                        backgroundColor: checked ? 'rgba(245,158,11,0.05)' : 'transparent',
                        cursor: locked ? 'not-allowed' : 'pointer', textAlign: 'left', width: '100%',
                        opacity: locked && !checked ? 0.58 : 1,
                        transition: 'background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease',
                      }}>
                        {customCheckbox(checked)}
                        <p style={{ fontSize: 12.5, lineHeight: 1.6, color: checked ? C.t1 : C.t0, flex: 1, letterSpacing: '-0.01em', transition: 'color 0.15s ease' }}>{item.label}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section data-tour-id="pre-session-checklist" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                  <h2 style={{ fontSize: 13, fontWeight: 800, color: C.t0 }}>Readiness Checks</h2>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: C.t2 }}>{mentalCompleted + technicalCompleted}/{mentalChecklistWithAdaptiveItems.length + technicalChecklistItems.length}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {[
                    { label: 'Mental', items: mentalChecklistWithAdaptiveItems },
                    { label: 'Technical', items: technicalChecklistItems },
                  ].map(group => (
                    <div key={group.label}>
                      <p style={{ fontSize: 11, color: C.t2, marginBottom: 7, fontWeight: 600 }}>{group.label}</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {group.items.map(item => {
                          const checked = item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id]);
                          return (
                            <button key={item.id} type="button" onClick={() => toggleChecklist(item)} style={{
                              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 9px',
                              borderRadius: 6, border: `1px solid ${checked ? 'rgba(34,214,138,0.22)' : C.b0}`, backgroundColor: checked ? 'rgba(34,214,138,0.05)' : C.d2,
                              cursor: 'pointer', textAlign: 'left', width: '100%',
                            }}>
                              {customCheckbox(checked)}
                              <div style={{ minWidth: 0 }}>
                                <p style={{ fontSize: 11.5, color: checked ? C.t0 : C.t1, lineHeight: 1.4 }}>{item.label}</p>
                                {(item.autoFromEmotion || item.source) && <p style={{ fontSize: 9.5, color: C.t2, marginTop: 1 }}>{item.autoFromEmotion ? 'auto-linked to emotion' : item.source}</p>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
                <h2 style={{ fontSize: 13, fontWeight: 800, color: C.t0, marginBottom: 10 }}>Session Plan</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {primaryPlanRows.map(row => (
                    <article key={row.id} style={{ border: '1px solid rgba(34,214,138,0.22)', backgroundColor: 'rgba(34,214,138,0.06)', borderRadius: 8, padding: 11 }}>
                      <span style={{ ...sourceBadgeStyle(row.source), borderRadius: 4, padding: '3px 7px', fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.source}</span>
                      <p style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.55, color: C.t0 }}>{row.rule}</p>
                    </article>
                  ))}
                  {protectionPlanRows.map(row => (
                    <article key={row.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 9, alignItems: 'start', border: `1px solid ${C.b0}`, backgroundColor: C.d2, borderRadius: 8, padding: 10 }}>
                      <span style={{ ...sourceBadgeStyle(row.source), borderRadius: 4, padding: '3px 6px', fontSize: 8.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{row.source}</span>
                      <p style={{ fontSize: 12, lineHeight: 1.5, color: C.t1 }}>{row.rule}</p>
                    </article>
                  ))}
                </div>
              </div>
            </section>

            {visiblePatterns.length > 0 && (
              <section style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
                <h2 style={{ fontSize: 13, fontWeight: 800, color: C.t0, marginBottom: 10 }}>Pattern Watch</h2>
                <div style={{ display: 'grid', gap: 7 }}>
                  {visiblePatterns.map(p => {
                    const risk = activeRiskPatterns.some(item => item.id === p.id);
                    return (
                      <article key={p.id} style={{ display: 'grid', gridTemplateColumns: '3px 1fr', borderRadius: 7, overflow: 'hidden', border: `1px solid ${risk ? 'rgba(240,82,82,0.22)' : 'rgba(34,214,138,0.22)'}` }}>
                        <div style={{ backgroundColor: risk ? C.red : C.grn }} />
                        <div style={{ padding: '9px 10px', backgroundColor: C.d2 }}>
                          <p style={{ fontSize: 12, fontWeight: 800, color: risk ? C.red : C.grn }}>{risk ? 'Watch' : 'Lean in'}: {p.title}</p>
                          <p style={{ fontSize: 11, color: C.t1, marginTop: 2, lineHeight: 1.45 }}>{buildPatternInstruction(p, risk ? 'watch' : 'protect')}</p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          <aside data-tour-id="pre-session-inputs" style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }}>
            <section data-tour-id="pre-session-mindset" style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
              <p style={{ fontSize: 11, color: C.t2, fontWeight: 700, marginBottom: 8 }}>State of mind</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 4 }}>
                {emotions.map(em => {
                  const sel = emotion === em;
                  const ec = em === 'Frustrated' ? C.red : em === 'Anxious' ? '#f97316' : em === 'Confident' ? C.grn : C.acc;
                  return (
                    <button key={em} type="button" onClick={() => setEmotionAndPersist(em)} style={{
                      minHeight: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 3px', borderRadius: 6,
                      border: `1px solid ${sel ? ec + '50' : C.b0}`, backgroundColor: sel ? ec + '12' : 'transparent',
                      color: sel ? ec : C.t1, fontSize: 10.5, fontWeight: sel ? 800 : 500, cursor: 'pointer', textAlign: 'center', width: '100%',
                    }}>
                      {em}
                    </button>
                  );
                })}
              </div>
              <textarea
                id="presession-note" value={note}
                onChange={e => setNoteAndPersist(e.target.value)}
                style={{ marginTop: 8, width: '100%', height: 58, resize: 'none', borderRadius: 6, border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t0, fontSize: 12, padding: '7px 10px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                placeholder="One thing to watch before entry..."
              />
            </section>

            <section data-tour-id="pre-session-risk" style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
              <p style={{ fontSize: 11, color: C.t2, fontWeight: 700, marginBottom: 10 }}>Market bias</p>
              {(['ES', 'NQ'] as const).map(instrument => (
                <div key={instrument} style={{ marginBottom: 10 }}>
                  <p style={{ fontSize: 10, fontFamily: 'monospace', color: C.t2, marginBottom: 5, letterSpacing: '0.06em' }}>{instrument}</p>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {biasOptions.map(opt => {
                      const sel = bias[instrument] === opt;
                      const oc = opt === 'Bull' ? C.grn : opt === 'Bear' ? C.red : C.acc;
                      return (
                        <button key={opt} type="button" onClick={() => setBiasAndPersist(instrument, opt)} style={{ flex: 1, padding: '5px 0', borderRadius: 4, border: `1px solid ${sel ? oc + '55' : C.b0}`, backgroundColor: sel ? oc + '18' : 'transparent', fontSize: 11, fontWeight: sel ? 700 : 500, color: sel ? oc : C.t2, cursor: 'pointer' }}>{opt}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>

            <section style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <p style={{ fontSize: 11, color: C.t2, fontWeight: 700 }}>Risk limits</p>
                <button type="button" onClick={riskEditOpen ? () => setRiskEditOpen(false) : openRiskEditor} style={{ fontSize: 10, color: riskEditOpen ? C.t2 : C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{riskEditOpen ? 'cancel' : 'edit'}</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {[
                  { label: 'max loss', value: formatCurrency(-riskLimits.maxDailyLoss), color: C.red },
                  { label: 'max trades', value: String(riskLimits.maxTrades), color: C.t0 },
                  { label: 'contracts', value: String(riskLimits.maxContracts), color: C.t0 },
                  { label: 'target', value: formatCurrency(riskLimits.target), color: C.grn },
                ].map(stat => (
                  <div key={stat.label} style={{ padding: '8px 10px', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                    <p style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: stat.color }}>{stat.value}</p>
                    <p style={{ fontSize: 10, color: C.t2, marginTop: 2 }}>{stat.label}</p>
                  </div>
                ))}
              </div>
              {riskEditOpen && (
                <div style={{ marginTop: 8, padding: 12, borderRadius: 6, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {([
                      ['daily_loss_limit',       'Max loss',     '$', true ],
                      ['max_trades_per_day',      'Max trades',   '',  true ],
                      ['max_contracts_per_trade', 'Contracts',    '',  false],
                      ['account_size',            'Account size', '$', false],
                      ['risk_percentage',         'Risk %',       '%', false],
                    ] as const).map(([field, label, suffix, required]) => (
                      <label key={field} style={{ fontSize: 10, color: C.t2 }}>
                        {label}{!required && <span style={{ opacity: 0.5 }}> (opt)</span>}
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d3, padding: '0 7px' }}>
                          {suffix === '$' && <span style={{ color: C.t2, fontSize: 11 }}>$</span>}
                          <input type="number" min="0" step={field === 'risk_percentage' ? '0.1' : '1'} placeholder={required ? '' : 'skip'} value={riskDraft[field]} onChange={e => updateRiskDraft(field, e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 11, color: C.t0, padding: '5px 0', minWidth: 0 }} />
                          {suffix === '%' && <span style={{ color: C.t2, fontSize: 11 }}>%</span>}
                        </div>
                      </label>
                    ))}
                  </div>
                  {riskSaveError && <p style={{ fontSize: 11, color: C.red, marginTop: 5 }}>{riskSaveError}</p>}
                  <button type="button" onClick={saveRiskLimits} disabled={riskSaving} style={{ marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 4, border: `1px solid rgba(245,158,11,0.3)`, backgroundColor: 'rgba(245,158,11,0.09)', color: C.acc, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>{riskSaving ? 'Saving...' : 'Save limits'}</button>
                </div>
              )}
            </section>

            <section data-tour-id="pre-session-behavior" style={{ border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, padding: 14 }}>
              <p style={{ fontSize: 11, color: C.t2, fontWeight: 700, marginBottom: 10 }}>Behavior scan</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {[
                  { label: 'Plan adherence', value: recentBehavior.planAdherence === null ? '-' : `${recentBehavior.planAdherence}%`, color: recentBehavior.planAdherence !== null && recentBehavior.planAdherence < 80 ? C.acc : C.t0 },
                  { label: 'Revenge tags', value: String(recentBehavior.revengeTagged), color: recentBehavior.revengeTagged > 0 ? C.red : C.t0 },
                  { label: 'Checks done', value: `${checklistTotals.completed}/${checklistTotals.total}`, color: C.t0 },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: C.t2 }}>{row.label}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: row.color }}>{row.value}</span>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );

}
