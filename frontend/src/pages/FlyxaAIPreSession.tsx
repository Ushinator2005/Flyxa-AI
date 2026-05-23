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

const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252',
};


const emotions = ['Frustrated', 'Anxious', 'Neutral', 'Focused', 'Confident'] as const;
const biasOptions: BiasValue[] = ['Bull', 'Bear', 'Neutral'];

const preTradeReminderItems = [
  'The goal is not to trade. The goal is to protect capital and execute only when the setup is clean.',
  'No screenshot, plan, or confirmation means no trade.',
  'A missed trade is acceptable. A forced trade is not.',
  'After a loss, the next decision must be slower, smaller, and cleaner.',
];

const oathChecklistItems: ChecklistItem[] = [
  { id: 'oath-plan-only', label: 'I will only trade a setup that matches my plan' },
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
  const { filterTradesBySelectedAccount } = useAppSettings();
  const { settings, refreshSettings } = useRisk();

  const storedPreSession = useFlyxaStore(state => state.preSession);
  const setPreSessionAction = useFlyxaStore(state => state.setPreSession);
  const setPreSessionForDate = useFlyxaStore(state => state.setPreSessionForDate);
  const storedOathItems = useFlyxaStore(state => state.oathItems);
  const setOathItemsAction = useFlyxaStore(state => state.setOathItems);

  const [now, setNow] = useState(() => new Date());
  const [emotion, setEmotion] = useState<string>(() => (storedPreSession?.emotion ?? ''));
  const [note, setNote] = useState<string>(() => (storedPreSession?.note ?? ''));
  const [bias, setBias] = useState<BiasState>(() => (storedPreSession?.bias as BiasState ?? { ES: 'Neutral', NQ: 'Neutral' }));
  const [checklistState, setChecklistState] = useState<ChecklistState>(() => (storedPreSession?.checklistState as ChecklistState ?? {}));
  const [storedRiskSettings] = useState(() => parseRiskSettingsFromStorage());
  const [oathEditOpen, setOathEditOpen] = useState(false);
  const [oathDraft, setOathDraft] = useState<Array<{ id: string; label: string }>>([]);
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
    const planLogged = recentTrades.filter(trade => typeof trade.followed_plan === 'boolean');
    const planAdherence = planLogged.length > 0
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
    const next = {
      daily_loss_limit: Number(riskDraft.daily_loss_limit),
      max_trades_per_day: Number(riskDraft.max_trades_per_day),
      max_contracts_per_trade: Number(riskDraft.max_contracts_per_trade),
      account_size: Number(riskDraft.account_size),
      risk_percentage: Number(riskDraft.risk_percentage),
    };

    if (
      !Number.isFinite(next.daily_loss_limit) || next.daily_loss_limit <= 0 ||
      !Number.isFinite(next.max_trades_per_day) || next.max_trades_per_day <= 0 ||
      !Number.isFinite(next.max_contracts_per_trade) || next.max_contracts_per_trade <= 0 ||
      !Number.isFinite(next.account_size) || next.account_size <= 0 ||
      !Number.isFinite(next.risk_percentage) || next.risk_percentage <= 0
    ) {
      setRiskSaveError('Enter positive numbers for every risk limit.');
      return;
    }

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
      {
        id: 'focus',
        source: 'Primary focus',
        rule: topEdge
          ? `Prioritize ${topEdge.session} setups in ${topEdge.instrument}; this is your highest-confidence edge window today.`
          : 'Prioritize your cleanest A+ continuation setup window and skip marginal entries.',
      },
      {
        id: 'avoid',
        source: 'Avoid today',
        rule: topRisk
          ? `Avoid ${topRisk.title.toLowerCase()} by pausing after the first loss and requiring full checklist confirmation.`
          : recentEmotionDrag
            ? 'Do not chase recovery trades. If frustration shows up, step away before taking another setup.'
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
  }, [activeRiskPatterns, confirmedEdgePatterns, recentBehavior.planAdherence, recentBehavior.revengeTagged, riskLimits.maxDailyLoss, riskLimits.maxTrades]);

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

  const persistPreSession = (updates: Partial<{ emotion: string; note: string; bias: BiasState; checklistState: ChecklistState; startedAt: string | null }>) => {
    const data = {
      emotion: updates.emotion ?? emotion,
      note: updates.note ?? note,
      bias: updates.bias ?? bias,
      checklistState: updates.checklistState ?? checklistState,
      startedAt: updates.startedAt ?? storedPreSession?.startedAt ?? null,
      readiness,
      sessionPlan,
      commitment: storedPreSession?.commitment,
    };
    setPreSessionAction(data);
    setPreSessionForDate(now.toISOString().slice(0, 10), data);
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

  const startSession = () => {
    const committedAt = new Date().toISOString();
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
    };
    setPreSessionAction(sessionData);
    setPreSessionForDate(now.toISOString().slice(0, 10), sessionData);
    navigate('/journal');
  };

  if (loading) {
    return (
      <div className="animate-fade-in flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl" style={{ backgroundColor: C.d0 }}>
        <LoadingSpinner size="lg" label="Preparing your pre-session brief..." />
      </div>
    );
  }

  const readinessColor = readiness.status === 'Ready' ? C.grn : readiness.status === 'Caution' ? C.acc : C.red;

  return (
    <div style={{ height: 'calc(100vh - 3.5rem)', backgroundColor: C.d0, color: C.t0, borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

      {/* ─── Header ─────────────────────────────────────────────── */}
      <header style={{ padding: '11px 20px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500 }}>Pre-Session</p>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: C.t0, letterSpacing: '-0.02em', marginTop: 2 }}>Trader Oath</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: C.t1 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: rthTiming.marketOpenToday ? C.grn : C.t2, flexShrink: 0 }} />
            <span>{rthTiming.marketOpenToday ? 'RTH open' : `RTH in ${formatDuration(rthTiming.minutesUntilOpen)}`}</span>
            <span style={{ color: C.t2 }}>·</span>
            <span>{etDateLabel(now)}</span>
            {lastSession && (
              <>
                <span style={{ color: C.t2 }}>·</span>
                <span style={{ color: lastSession.netPnl >= 0 ? C.grn : C.red }}>last {formatSignedCurrency(lastSession.netPnl)}</span>
              </>
            )}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 5,
            border: `1px solid ${readinessColor}40`, backgroundColor: `${readinessColor}10`,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: readinessColor }}>{readiness.status}</span>
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: C.t0 }}>{readiness.score}</span>
          </div>
        </div>
      </header>

      {/* ─── Body ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* Left sidebar — inputs */}
        <aside style={{
          width: 268, flexShrink: 0, borderRight: `1px solid ${C.b0}`,
          overflowY: 'auto', padding: '18px 14px',
          display: 'flex', flexDirection: 'column', gap: 0,
        }}>

          {/* State of mind */}
          <div style={{ marginBottom: 18 }}>
            <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 8 }}>State of mind</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {emotions.map(em => {
                const sel = emotion === em;
                const ec = em === 'Frustrated' ? C.red : em === 'Anxious' ? '#f97316' : em === 'Confident' ? C.grn : C.acc;
                return (
                  <button key={em} type="button" onClick={() => setEmotionAndPersist(em)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 5,
                    border: `1px solid ${sel ? ec + '50' : C.b0}`,
                    backgroundColor: sel ? ec + '12' : 'transparent',
                    color: sel ? ec : C.t1, fontSize: 12, fontWeight: sel ? 500 : 400,
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, backgroundColor: sel ? ec : C.b1 }} />
                    {em}
                  </button>
                );
              })}
            </div>
            <textarea
              id="presession-note" value={note}
              onChange={e => setNoteAndPersist(e.target.value)}
              style={{
                marginTop: 8, width: '100%', height: 64, resize: 'none', borderRadius: 5,
                border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t0,
                fontSize: 12, padding: '7px 10px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
              placeholder="Pre-open note..."
            />
          </div>

          <div style={{ height: 1, backgroundColor: C.b0, marginBottom: 18 }} />

          {/* Market bias */}
          <div style={{ marginBottom: 18 }}>
            <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 10 }}>Market bias</p>
            {(['ES', 'NQ'] as const).map(instrument => (
              <div key={instrument} style={{ marginBottom: 10 }}>
                <p style={{ fontSize: 10, fontFamily: 'monospace', color: C.t2, marginBottom: 5, letterSpacing: '0.06em' }}>{instrument}</p>
                <div style={{ display: 'flex', gap: 3 }}>
                  {biasOptions.map(opt => {
                    const sel = bias[instrument] === opt;
                    const oc = opt === 'Bull' ? C.grn : opt === 'Bear' ? C.red : C.acc;
                    return (
                      <button key={opt} type="button" onClick={() => setBiasAndPersist(instrument, opt)} style={{
                        flex: 1, padding: '5px 0', borderRadius: 4,
                        border: `1px solid ${sel ? oc + '55' : C.b0}`,
                        backgroundColor: sel ? oc + '18' : 'transparent',
                        fontSize: 11, fontWeight: sel ? 600 : 400,
                        color: sel ? oc : C.t2, cursor: 'pointer',
                      }}>{opt}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ height: 1, backgroundColor: C.b0, marginBottom: 18 }} />

          {/* Risk limits */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500 }}>Risk limits</p>
              <button type="button" onClick={riskEditOpen ? () => setRiskEditOpen(false) : openRiskEditor}
                style={{ fontSize: 10, color: riskEditOpen ? C.t2 : C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >{riskEditOpen ? 'cancel' : 'edit'}</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {[
                { label: 'max loss', value: formatCurrency(-riskLimits.maxDailyLoss), color: C.red },
                { label: 'max trades', value: String(riskLimits.maxTrades), color: C.t0 },
                { label: 'contracts', value: String(riskLimits.maxContracts), color: C.t0 },
                { label: 'target', value: formatCurrency(riskLimits.target), color: C.grn },
              ].map(stat => (
                <div key={stat.label} style={{ padding: '8px 10px', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                  <p style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: stat.color }}>{stat.value}</p>
                  <p style={{ fontSize: 10, color: C.t2, marginTop: 2 }}>{stat.label}</p>
                </div>
              ))}
            </div>
            {riskEditOpen && (
              <div style={{ marginTop: 8, padding: 12, borderRadius: 6, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {([
                    ['daily_loss_limit', 'Max loss', '$'],
                    ['max_trades_per_day', 'Max trades', ''],
                    ['max_contracts_per_trade', 'Contracts', ''],
                    ['account_size', 'Account size', '$'],
                    ['risk_percentage', 'Risk %', '%'],
                  ] as const).map(([field, label, suffix]) => (
                    <label key={field} style={{ fontSize: 10, color: C.t2 }}>
                      {label}
                      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d3, padding: '0 7px' }}>
                        {suffix === '$' && <span style={{ color: C.t2, fontSize: 11 }}>$</span>}
                        <input type="number" min="0" step={field === 'risk_percentage' ? '0.1' : '1'}
                          value={riskDraft[field]}
                          onChange={e => updateRiskDraft(field, e.target.value)}
                          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 11, color: C.t0, padding: '5px 0', minWidth: 0 }}
                        />
                        {suffix === '%' && <span style={{ color: C.t2, fontSize: 11 }}>%</span>}
                      </div>
                    </label>
                  ))}
                </div>
                {riskSaveError && <p style={{ fontSize: 11, color: C.red, marginTop: 5 }}>{riskSaveError}</p>}
                <button type="button" onClick={saveRiskLimits} disabled={riskSaving}
                  style={{ marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 4, border: `1px solid rgba(245,158,11,0.3)`, backgroundColor: 'rgba(245,158,11,0.09)', color: C.acc, fontSize: 11, fontWeight: 500, cursor: 'pointer' }}
                >{riskSaving ? 'Saving...' : 'Save limits'}</button>
              </div>
            )}
          </div>

          <div style={{ height: 1, backgroundColor: C.b0, marginBottom: 18 }} />

          {/* Behavior scan */}
          <div>
            <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 10 }}>Behavior scan</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: C.t2 }}>Plan adherence</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: recentBehavior.planAdherence !== null && recentBehavior.planAdherence < 80 ? C.acc : C.t0 }}>
                  {recentBehavior.planAdherence === null ? '—' : `${recentBehavior.planAdherence}%`}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: C.t2 }}>Revenge tags</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: recentBehavior.revengeTagged > 0 ? C.red : C.t0 }}>{recentBehavior.revengeTagged}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: C.t2 }}>Checks done</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: C.t0 }}>{checklistTotals.completed}/{checklistTotals.total}</span>
              </div>
            </div>
            {readiness.reasons.length > 0 && (
              <div style={{ marginTop: 10, padding: '9px 10px', borderRadius: 5, border: `1px solid ${readinessColor}28`, backgroundColor: `${readinessColor}08` }}>
                <p style={{ fontSize: 11, color: C.t1, lineHeight: 1.65 }}>{readiness.summary}</p>
              </div>
            )}
          </div>
        </aside>

        {/* ─── Main content ─────────────────────────────────────── */}
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 26 }}>

          {/* Trader oath */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ fontSize: 13, fontWeight: 600, color: C.t0, letterSpacing: '-0.01em' }}>Trader Oath</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.t2 }}>
                  {activeOathItems.filter(item => Boolean(checklistState[item.id])).length}/{activeOathItems.length}
                </span>
                <button type="button" onClick={oathEditOpen ? () => setOathEditOpen(false) : openOathEditor}
                  style={{ fontSize: 11, color: oathEditOpen ? C.t2 : C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >{oathEditOpen ? 'cancel' : 'edit'}</button>
              </div>
            </div>
            {oathEditOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {oathDraft.map((item, idx) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="text" value={item.label}
                      onChange={e => { const next = [...oathDraft]; next[idx] = { ...item, label: e.target.value }; setOathDraft(next); }}
                      style={{ flex: 1, borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t0, fontSize: 12, padding: '8px 10px', outline: 'none', fontFamily: 'inherit' }}
                    />
                    <button type="button" onClick={() => setOathDraft(oathDraft.filter((_, i) => i !== idx))}
                      style={{ width: 28, height: 28, borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d2, color: C.t2, fontSize: 12, cursor: 'pointer', flexShrink: 0 }}
                      aria-label="Remove">✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => setOathDraft([...oathDraft, { id: `oath-custom-${Date.now()}`, label: '' }])}
                  style={{ padding: '7px 0', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: 'transparent', color: C.t2, fontSize: 12, cursor: 'pointer' }}
                >+ Add</button>
                <button type="button" onClick={saveOathItems}
                  style={{ padding: '7px 0', borderRadius: 5, border: `1px solid rgba(245,158,11,0.35)`, backgroundColor: 'rgba(245,158,11,0.1)', color: C.acc, fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                >Save</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {activeOathItems.map((item, idx) => {
                  const checked = Boolean(checklistState[item.id]);
                  return (
                    <button key={item.id} type="button" onClick={() => toggleChecklist(item)} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 14px',
                      borderRadius: 5, border: `1px solid ${checked ? 'rgba(245,158,11,0.22)' : C.b0}`,
                      backgroundColor: checked ? 'rgba(245,158,11,0.06)' : C.d2,
                      cursor: 'pointer', textAlign: 'left', width: '100%',
                    }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: checked ? C.acc : C.t2, flexShrink: 0, marginTop: 3 }}>{String(idx + 1).padStart(2, '0')}</span>
                      {customCheckbox(checked)}
                      <p style={{ fontSize: 13, lineHeight: 1.6, color: checked ? C.t0 : C.t1, flex: 1 }}>{item.label}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ height: 1, backgroundColor: C.b0 }} />

          {/* Before you trade */}
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: C.t0, letterSpacing: '-0.01em', marginBottom: 10 }}>Before you trade</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {preTradeReminderItems.map((item, idx) => (
                <div key={item} style={{ display: 'flex', gap: 14, padding: '9px 12px', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 10, color: C.t2, flexShrink: 0, marginTop: 2 }}>{String(idx + 1).padStart(2, '0')}</span>
                  <p style={{ fontSize: 12, lineHeight: 1.65, color: C.t1 }}>{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div style={{ height: 1, backgroundColor: C.b0 }} />

          {/* Checklist */}
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: C.t0, letterSpacing: '-0.01em', marginBottom: 12 }}>Pre-session checklist</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, fontWeight: 500 }}>Mental</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {mentalChecklistWithAdaptiveItems.map(item => {
                    const checked = item.autoFromEmotion ? emotionLogged : Boolean(checklistState[item.id]);
                    return (
                      <button key={item.id} type="button" onClick={() => toggleChecklist(item)} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
                        borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d2,
                        cursor: 'pointer', textAlign: 'left', width: '100%',
                      }}>
                        {customCheckbox(checked)}
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 11.5, color: C.t0, lineHeight: 1.45 }}>{item.label}</p>
                          {(item.autoFromEmotion || item.source) && (
                            <p style={{ fontSize: 9.5, color: C.t2, marginTop: 1 }}>{item.autoFromEmotion ? 'auto-linked to emotion' : item.source}</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p style={{ fontSize: 10, color: C.t2, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, fontWeight: 500 }}>Technical</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {technicalChecklistItems.map(item => {
                    const checked = Boolean(checklistState[item.id]);
                    return (
                      <button key={item.id} type="button" onClick={() => toggleChecklist(item)} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
                        borderRadius: 4, border: `1px solid ${C.b0}`, backgroundColor: C.d2,
                        cursor: 'pointer', textAlign: 'left', width: '100%',
                      }}>
                        {customCheckbox(checked)}
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 11.5, color: C.t0, lineHeight: 1.45 }}>{item.label}</p>
                          {item.source && <p style={{ fontSize: 9.5, color: C.t2, marginTop: 1 }}>{item.source}</p>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div style={{ height: 1, backgroundColor: C.b0 }} />

          {/* Session plan */}
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: C.t0, letterSpacing: '-0.01em', marginBottom: 10 }}>Session plan</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {sessionPlan.map((row, idx) => (
                <div key={row.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '10px 12px', borderRadius: 5, border: `1px solid ${C.b0}`, backgroundColor: C.d2 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 10, color: C.t2, flexShrink: 0, marginTop: 3 }}>{idx + 1}</span>
                  <p style={{ flex: 1, fontSize: 12, lineHeight: 1.65, color: C.t0 }}>{row.rule}</p>
                  <span style={{ ...sourceBadgeStyle(row.source), flexShrink: 0, borderRadius: 4, padding: '3px 8px', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{row.source}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pattern watch — only renders if patterns are active */}
          {(activeRiskPatterns.length > 0 || confirmedEdgePatterns.length > 0) && (
            <>
              <div style={{ height: 1, backgroundColor: C.b0 }} />
              <div>
                <h2 style={{ fontSize: 13, fontWeight: 600, color: C.t0, letterSpacing: '-0.01em', marginBottom: 10 }}>Pattern watch</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {activeRiskPatterns.map(p => (
                    <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '3px 1fr', borderRadius: 5, overflow: 'hidden', border: `1px solid rgba(240,82,82,0.2)` }}>
                      <div style={{ backgroundColor: C.red }} />
                      <div style={{ padding: '9px 12px', backgroundColor: C.d2 }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: C.red }}>Watch: {p.title}</p>
                        <p style={{ fontSize: 11, color: C.t1, marginTop: 2, lineHeight: 1.6 }}>{buildPatternInstruction(p, 'watch')}</p>
                      </div>
                    </div>
                  ))}
                  {confirmedEdgePatterns.map(p => (
                    <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '3px 1fr', borderRadius: 5, overflow: 'hidden', border: `1px solid rgba(34,214,138,0.2)` }}>
                      <div style={{ backgroundColor: C.grn }} />
                      <div style={{ padding: '9px 12px', backgroundColor: C.d2 }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: C.grn }}>Lean in: {p.title}</p>
                        <p style={{ fontSize: 11, color: C.t1, marginTop: 2, lineHeight: 1.6 }}>{buildPatternInstruction(p, 'protect')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* CTA */}
          <div style={{ borderTop: `1px solid ${C.b0}`, paddingTop: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" onClick={startSession}
              style={{
                height: 36, padding: '0 22px', borderRadius: 5,
                border: `1px solid ${C.acc}`, backgroundColor: C.acc,
                color: '#0e0d0d', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', letterSpacing: '-0.01em',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.87'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              Accept oath — begin session
            </button>
            <button type="button" onClick={() => navigate('/')}
              style={{
                height: 36, padding: '0 16px', borderRadius: 5,
                border: `1px solid ${C.b1}`, backgroundColor: 'transparent',
                color: C.t1, fontSize: 12, cursor: 'pointer',
              }}
            >
              Skip to dashboard
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
