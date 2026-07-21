import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import { RiskSettings, Trade } from '../types/index.js';
import { PatternItem } from './FlyxaAIPatterns.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry, RiskRule } from '../store/types.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';
import { publishPreSessionSync } from '../utils/preSessionSync.js';
import { getTimeZoneParts } from '../utils/calendarTime.js';
import { saveGuardSessionTrades } from '../hooks/useGuardSessionTrades.js';
import { generateNextSessionPrescriptions } from '../utils/performanceLoop.js';
import { buildPlanAdherenceReport } from '../utils/planAdherence.js';
import { isLivePreSession } from '../utils/sessionLifecycle.js';
import { evaluateEntryRules } from '../utils/tradingRules.js';
import { getMarketTiming } from '../utils/marketHours.js';
import { C } from '../utils/theme.js';

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

const OATH_HOLD_MS = 900;



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

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function tradeDateKey(trade: Trade): string {
  if (trade.trade_date && /^\d{4}-\d{2}-\d{2}/.test(trade.trade_date)) {
    return trade.trade_date.slice(0, 10);
  }
  if (trade.created_at && /^\d{4}-\d{2}-\d{2}/.test(trade.created_at)) {
    return trade.created_at.slice(0, 10);
  }
  const parsed = parseTradeDate(trade);
  return parsed ? localDateKey(parsed) : '';
}

function tradeNetPnl(trade: Trade): number {
  return Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);
}

import { formatUsd0 as formatCurrency } from '../utils/format.js';

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

function enabledPlanRuleValue(rules: RiskRule[], kind: NonNullable<RiskRule['kind']>): number | null {
  const rule = rules.find(item => (item.kind ?? 'manual') === kind && item.enabled !== false);
  if (!rule) return null;
  const value = Number(rule.value);
  return Number.isFinite(value) && value > 0 ? value : null;
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
  const { filterTradesBySelectedAccount, preferences, selectedAccountId } = useAppSettings();
  const { settings } = useRisk();

  const storedPreSession = useFlyxaStore(state => state.preSession);
  const setPreSessionAction = useFlyxaStore(state => state.setPreSession);
  const setPreSessionForDate = useFlyxaStore(state => state.setPreSessionForDate);
  const storedOathItems = useFlyxaStore(state => state.oathItems);
  const setOathItemsAction = useFlyxaStore(state => state.setOathItems);
  const journalEntries = useFlyxaStore(state => state.entries);
  const riskRules = useFlyxaStore(state => state.riskRules);

  const [now, setNow] = useState(() => new Date());
  const todayIso = useMemo(() => getTimeZoneParts(now, preferences.timezone).date, [now, preferences.timezone]);
  const [emotion, setEmotion] = useState<string>(() => (storedPreSession?.emotion ?? ''));
  const [note, setNote] = useState<string>(() => (storedPreSession?.note ?? ''));
  const [premortem, setPremortem] = useState<string>(() => (storedPreSession?.premortem ?? ''));
  const [bias, setBias] = useState<BiasState>(() => (storedPreSession?.bias as BiasState ?? { ES: 'Neutral', NQ: 'Neutral' }));
  const [checklistState, setChecklistState] = useState<ChecklistState>(() => (storedPreSession?.checklistState as ChecklistState ?? {}));
  const [storedRiskSettings] = useState(() => parseRiskSettingsFromStorage());
  const [sessionMaxLoss] = useState<string>(() =>
    storedPreSession?.sessionMaxLoss != null ? String(storedPreSession.sessionMaxLoss) : ''
  );
  const [sessionTarget, setSessionTarget] = useState<string>(() =>
    storedPreSession?.dailyTarget != null ? String(storedPreSession.dailyTarget) : ''
  );
  const [oathEditOpen, setOathEditOpen] = useState(false);
  const [oathDraft, setOathDraft] = useState<Array<{ id: string; label: string }>>([]);
  const [maxWinStored] = useState<number | null>(() => parseMaxWinFromStorage());
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [launching, setLaunching] = useState(false);

  // Direction of the last step change — drives the slide animation.
  const prevStepRef = useRef<1 | 2 | 3 | 4>(1);
  const slideDirection = step >= prevStepRef.current ? 'fwd' : 'back';
  useEffect(() => { prevStepRef.current = step; }, [step]);

  useEffect(() => {
    // 1s tick keeps the market-open countdown alive; rthTiming itself is
    // minute-resolution, seconds are derived from the wall clock.
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );

  const lastSession = useMemo(() => {
    const grouped = accountTrades.reduce<Map<string, Trade[]>>((map, trade) => {
      const key = tradeDateKey(trade);
      if (!key || key >= todayIso) return map;
      map.set(key, [...(map.get(key) || []), trade]);
      return map;
    }, new Map());

    const latestDate = Array.from(grouped.keys()).sort((a, b) => b.localeCompare(a))[0];
    if (!latestDate) return null;
    const latestTrades = grouped.get(latestDate) || [];
    const netPnl = latestTrades.reduce((sum, trade) => sum + tradeNetPnl(trade), 0);
    return {
      date: latestDate,
      tradeCount: latestTrades.length,
      netPnl,
    };
  }, [accountTrades, todayIso]);

  const recentBehavior = useMemo(() => {
    const recentTrades = [...accountTrades]
      .filter(trade => {
        const date = tradeDateKey(trade);
        return Boolean(date) && date < todayIso;
      })
      .sort((a, b) => {
        const dateCompare = tradeDateKey(b).localeCompare(tradeDateKey(a));
        return dateCompare !== 0 ? dateCompare : (b.trade_time ?? '').localeCompare(a.trade_time ?? '');
      })
      .slice(0, 20);
    const withScore = recentTrades.filter(trade => typeof trade.plan_score === 'number');
    const planLogged = withScore.length > 0 ? withScore : recentTrades.filter(trade => typeof trade.followed_plan === 'boolean');
    const recentEntries = [...(journalEntries as StoreJournalEntry[])]
      .filter(entry => entry.date < todayIso)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20);
    const ruleReport = buildPlanAdherenceReport(recentEntries, riskRules, { accountId: selectedAccountId });
    const planAdherence = ruleReport.checked > 0
      ? ruleReport.pct
      : withScore.length > 0
      ? Math.round(withScore.reduce((s, t) => s + (t.plan_score as number), 0) / withScore.length)
      : planLogged.length > 0
        ? Math.round((planLogged.filter(trade => trade.followed_plan === true).length / planLogged.length) * 100)
        : null;
    const revengeTagged = recentTrades.filter(trade => (trade.emotional_state ?? '').toLowerCase().includes('revenge')).length;
    const emotionTagged = recentTrades.filter(trade => Boolean(trade.emotional_state?.trim())).length;

    return {
      sampleSize: recentTrades.length,
      planLogged: ruleReport.checked > 0 ? ruleReport.checked : planLogged.length,
      planAdherence,
      revengeTagged,
      emotionTagged,
    };
  }, [accountTrades, journalEntries, riskRules, selectedAccountId, todayIso]);

  const priorFlow = useMemo(
    () => getMostRecentDailyFlowBefore(accountTrades, todayIso),
    [accountTrades, todayIso]
  );

  // Which limits does this trader actually break? Evaluated over the last 10
  // traded sessions with the same rule engine the journal uses — the strip
  // shows the rules, this shows the rap sheet.
  const limitBreaches = useMemo(() => {
    const recent = [...(journalEntries as StoreJournalEntry[])]
      .filter(entry => entry.date < todayIso && (entry.trades?.length ?? 0) > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10);
    if (recent.length === 0) return null;
    const counts = new Map<string, { label: string; fails: number }>();
    for (const entry of recent) {
      for (const check of evaluateEntryRules(entry as never, riskRules)) {
        if (check.source !== 'automatic') continue;
        const current = counts.get(check.ruleId) ?? { label: check.label, fails: 0 };
        if (check.state === 'fail') current.fails += 1;
        counts.set(check.ruleId, current);
      }
    }
    const breached = [...counts.values()].filter(item => item.fails > 0).sort((a, b) => b.fails - a.fails);
    return { sessions: recent.length, breached };
  }, [journalEntries, riskRules, todayIso]);

  // Variance inoculation: from the trader's own win rate, how often is a
  // losing streak *expected*? Knowing "a 3-loss streak is normal every ~N
  // trades" before the session is what stops the third loss from reading as
  // "my edge is broken" — the trigger for most tilt spirals.
  const varianceCheck = useMemo(() => {
    const decided = [...accountTrades]
      .filter(trade => trade && Boolean(tradeDateKey(trade)) && (trade.pnl - (trade.commission ?? 0)) !== 0)
      .sort((a, b) => {
        const dateCompare = tradeDateKey(a).localeCompare(tradeDateKey(b));
        return dateCompare !== 0 ? dateCompare : (a.trade_time ?? '').localeCompare(b.trade_time ?? '');
      })
      .slice(-30);
    if (decided.length < 10) return null;
    const wins = decided.filter(trade => (trade.pnl - (trade.commission ?? 0)) > 0).length;
    const winRate = wins / decided.length;
    const lossRate = 1 - winRate;
    if (winRate <= 0 || winRate >= 1) return null;
    const streak = 3;
    // Expected number of trades until a run of `streak` consecutive losses.
    const expectedEvery = Math.round((1 - Math.pow(lossRate, streak)) / (winRate * Math.pow(lossRate, streak)));
    return {
      winRatePct: Math.round(winRate * 100),
      streak,
      expectedEvery,
      sample: decided.length,
    };
  }, [accountTrades]);

  const riskLimits = useMemo(() => {
    const planDailyLoss = enabledPlanRuleValue(riskRules, 'max_daily_loss');
    const planMaxTrades = enabledPlanRuleValue(riskRules, 'max_trades');
    const planMaxContracts = enabledPlanRuleValue(riskRules, 'max_contracts');
    const dailyLoss = planDailyLoss ?? (Number.isFinite(settings?.daily_loss_limit) ? settings?.daily_loss_limit : storedRiskSettings.daily_loss_limit);
    const maxTrades = planMaxTrades ?? (Number.isFinite(settings?.max_trades_per_day) ? settings?.max_trades_per_day : storedRiskSettings.max_trades_per_day);
    const maxContracts = planMaxContracts ?? (Number.isFinite(settings?.max_contracts_per_trade) ? settings?.max_contracts_per_trade : storedRiskSettings.max_contracts_per_trade);
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
  }, [settings, storedRiskSettings, maxWinStored, riskRules]);

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

  const prescriptions = useMemo(
    () => generateNextSessionPrescriptions(accountTrades, {
      dailyLossLimit: riskLimits.noLossLimit ? 0 : riskLimits.maxDailyLoss,
      maxTrades: riskLimits.maxTrades,
      maxContracts: riskLimits.maxContracts,
    }),
    [accountTrades, riskLimits.maxContracts, riskLimits.maxDailyLoss, riskLimits.maxTrades, riskLimits.noLossLimit],
  );

  const baseSessionPlan = useMemo<SessionPlanRow[]>(() => {
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
      ...prescriptions.map(item => ({
        id: item.id,
        source: (item.type === 'post_loss_pause' || item.type === 'plan_only'
          ? 'Avoid today'
          : item.type === 'max_trades' || item.type === 'daily_loss_limit'
            ? 'Hard stop'
            : 'Primary focus') as SessionPlanRow['source'],
        rule: `${item.label}. ${item.reason}`,
      })),
      // Hard stop: always data-driven
      {
        id: 'hard-stop',
        source: 'Hard stop' as const,
        rule: riskLimits.noLossLimit
          ? `Stop after ${riskLimits.maxTrades} trades or when you feel the session is done.`
          : `Stop at ${formatCurrency(-riskLimits.maxDailyLoss)} loss or after ${riskLimits.maxTrades} trades — whichever comes first.`,
      },
    ].slice(0, 4);
  }, [activeRiskPatterns, confirmedEdgePatterns, prescriptions, priorFlow, recentBehavior.planAdherence, recentBehavior.revengeTagged, riskLimits.maxDailyLoss, riskLimits.maxTrades]);

  const sessionPlan = baseSessionPlan;

  const rthTiming = useMemo(() => getMarketTiming(now, preferences.marketClock ?? 'equities'), [now, preferences.marketClock]);
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

  // Sync freshly-computed readiness to the store after every re-render that changes it.
  // Without this, toggleChecklist saves the stale (pre-render) readiness because React
  // hasn't re-run the memo yet when the setState updater runs.
  useEffect(() => {
    const stored = useFlyxaStore.getState().preSessionHistory[todayIso];
    if (!stored) return;
    if (stored.readiness?.score === readiness.score && stored.readiness?.status === readiness.status) {
      publishPreSessionSync(todayIso, stored);
      return;
    }
    setPreSessionForDate(todayIso, { ...stored, readiness });
    const active = useFlyxaStore.getState().preSession;
    if (active) setPreSessionAction({ ...active, readiness });
  }, [readiness, todayIso, setPreSessionForDate, setPreSessionAction]);

  const persistPreSession = (updates: Partial<{ emotion: string; note: string; premortem: string; bias: BiasState; checklistState: ChecklistState; startedAt: string | null; sessionMaxLoss: number | null; dailyTarget: number | null }>) => {
    const parsedLoss = parseFloat(sessionMaxLoss);
    const parsedTarget = parseFloat(sessionTarget);
    const data = {
      emotion: updates.emotion ?? emotion,
      note: updates.note ?? note,
      premortem: updates.premortem ?? premortem,
      bias: updates.bias ?? bias,
      checklistState: updates.checklistState ?? checklistState,
      startedAt: updates.startedAt ?? storedPreSession?.startedAt ?? null,
      readiness,
      sessionPlan,
      prescriptions,
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

  const setPremortemAndPersist = (next: string) => {
    setPremortem(next);
    persistPreSession({ premortem: next });
  };

  const setNoteAndPersist = (nextNote: string) => {
    setNote(nextNote);
    persistPreSession({ note: nextNote });
  };

  const setBiasAndPersist = (value: BiasValue) => {
    const next: BiasState = { ES: value, NQ: value };
    setBias(next);
    persistPreSession({ bias: next });
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

  const sessionAlreadyStarted = useMemo(() => {
    if (!isLivePreSession(storedPreSession)) return false;
    return getTimeZoneParts(new Date(storedPreSession.startedAt), preferences.timezone).date === todayIso;
  }, [storedPreSession, todayIso, preferences.timezone]);

  const startSession = () => {
    if (sessionAlreadyStarted) { navigate('/session'); return; }
    const committedAt = new Date().toISOString();
    const parsedLoss = parseFloat(sessionMaxLoss);
    const parsedTarget = parseFloat(sessionTarget);
    const sessionData = {
      emotion,
      note,
      premortem,
      bias,
      checklistState,
      startedAt: committedAt,
      sessionStartedAt: committedAt,
      endedAt: null,
      postSessionStartedAt: null,
      readiness,
      sessionPlan,
      prescriptions,
      commitment: {
        committedAt,
        emotion,
        note,
        bias,
        checklistState,
        readiness,
        sessionPlan,
        prescriptions,
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
          {/* Market-open countdown */}
          <div style={{ textAlign: 'right', minWidth: 96 }}>
            {rthTiming.marketOpenNow ? (
              <div style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: C.grn, lineHeight: 1 }}>Market open</div>
            ) : (
              <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600, color: C.t0, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                {rthTiming.minutesUntilOpen >= 90
                  ? `${Math.floor(rthTiming.minutesUntilOpen / 60)}h ${String(rthTiming.minutesUntilOpen % 60).padStart(2, '0')}m`
                  : `${String(Math.max(0, rthTiming.minutesUntilOpen - 1)).padStart(2, '0')}:${String(59 - now.getSeconds()).padStart(2, '0')}`}
              </div>
            )}
            <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.t2, marginTop: 4 }}>
              {rthTiming.marketOpenNow ? 'Regular hours' : 'Until open'} · {etDateLabel(now)}
            </div>
          </div>
        </div>
      </header>

      {/* ── Step indicator + live readiness ── */}
      <div style={{ position: 'relative', padding: '0 16px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'stretch' }}>
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

        {/* Live readiness — quiet label + mono score that ticks as inputs change */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.t2 }}>
            Readiness
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: readinessColor }}>
            <AnimatedScore value={readiness.score} />
          </span>
        </div>

        {/* Progress bar — fills as the pre-flight advances */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: 'transparent' }}>
          <div style={{ height: '100%', width: `${(step / 4) * 100}%`, background: C.acc, opacity: 0.85, transition: 'width 0.35s ease' }} />
        </div>
      </div>

      {/* ── Step content ── */}
      <main style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px' }}>
        <div style={{ width: '100%', maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div key={step} className={slideDirection === 'fwd' ? 'ps-step-fwd' : 'ps-step-back'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* ─── STEP 1: Mindset ─── */}
          {step === 1 && (
            <>
              <div data-tour-id="pre-session-mindset" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '11px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>State of mind</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>How are you coming into the session?</p>
                </div>
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', borderRadius: 5, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
                    {emotions.map((em, i) => {
                      const sel = emotion === em;
                      const ec = em === 'Frustrated' ? C.red : em === 'Anxious' ? '#f97316' : em === 'Neutral' ? '#94a3b8' : em === 'Focused' ? '#60a5fa' : C.grn;
                      return (
                        <button key={em} type="button" onClick={() => setEmotionAndPersist(em)} style={{
                          flex: 1, padding: '9px 4px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          border: 'none', borderRight: i < emotions.length - 1 ? `1px solid ${C.b0}` : 'none',
                          backgroundColor: sel ? `${ec}18` : 'transparent',
                          color: sel ? ec : C.t2,
                          fontSize: 11, fontWeight: sel ? 700 : 400, cursor: 'pointer',
                          transition: 'background-color 0.15s ease, color 0.15s ease',
                        }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: ec, opacity: sel ? 1 : 0.35, flexShrink: 0, transition: 'opacity 0.15s ease' }} />
                          {em}
                        </button>
                      );
                    })}
                  </div>
                  <textarea value={note} onChange={e => setNoteAndPersist(e.target.value)}
                    style={{
                      width: '100%', height: 52, resize: 'none',
                      borderRadius: 5, border: `1px solid ${C.b0}`,
                      backgroundColor: C.d2, color: C.t0,
                      fontSize: 12, padding: '9px 11px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5,
                    }}
                    placeholder="One thing to watch before entry..."
                  />
                </div>
              </div>

              <div data-tour-id="pre-session-risk" style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '11px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Market bias</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>What direction are you leaning for today?</p>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', borderRadius: 5, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
                    {biasOptions.map((opt, i) => {
                      const sel = bias.ES === opt;
                      const oc = opt === 'Bull' ? C.grn : opt === 'Bear' ? C.red : C.acc;
                      return (
                        <button key={opt} type="button" onClick={() => setBiasAndPersist(opt)} style={{
                          flex: 1, padding: '8px 0',
                          border: 'none', borderRight: i < biasOptions.length - 1 ? `1px solid ${C.b0}` : 'none',
                          backgroundColor: sel ? `${oc}18` : 'transparent',
                          fontSize: 12, fontWeight: sel ? 700 : 400,
                          color: sel ? oc : C.t2, cursor: 'pointer',
                          transition: 'background-color 0.15s ease, color 0.15s ease',
                        }}>{opt}</button>
                      );
                    })}
                  </div>
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

              {/* ── Variance check — losing streaks are scheduled by the math,
                    not caused by a broken edge. The focal number forces the
                    read; a sentence would get skimmed. ── */}
              {varianceCheck && (
                <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, display: 'flex', alignItems: 'stretch', overflow: 'hidden' }}>
                  <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, borderRight: `1px solid ${C.b0}`, flexShrink: 0, minWidth: 118 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 30, fontWeight: 700, color: C.acc, lineHeight: 1 }}>
                      ~{varianceCheck.expectedEvery.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.t1, textAlign: 'center', lineHeight: 1.5 }}>
                      trades between<br />{varianceCheck.streak}-loss streaks
                    </span>
                  </div>
                  <div style={{ padding: '13px 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, maxWidth: 520 }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: C.t0, lineHeight: 1.5 }}>
                      A {varianceCheck.streak}-loss streak is normal for you about every {varianceCheck.expectedEvery.toLocaleString()} trades.
                    </p>
                    <p style={{ fontSize: 11.5, color: C.t1, lineHeight: 1.6 }}>
                      Based on your {varianceCheck.winRatePct}% win rate over the last {varianceCheck.sample} trades.
                      When it happens, it's the math working — not your edge failing.
                    </p>
                  </div>
                </div>
              )}

              {/* ── Pre-mortem — prospective hindsight. Imagining the failure
                    as already-happened surfaces the risks confidence hides,
                    and post-session compares the prediction to what actually
                    happened. ── */}
              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                <div style={{ padding: '11px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Pre-mortem</h2>
                  <p style={{ fontSize: 11, color: C.t2 }}>
                    The session has ended and finished red. What was the reason this most likely happened? Name it now — catch it live.
                  </p>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <textarea value={premortem} onChange={e => setPremortemAndPersist(e.target.value)}
                    style={{
                      width: '100%', height: 48, resize: 'none',
                      borderRadius: 5, border: `1px solid ${C.b0}`,
                      backgroundColor: C.d2, color: C.t0,
                      fontSize: 12, padding: '9px 11px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5,
                    }}
                    placeholder="e.g. I got chopped at the open, forced a revenge trade, and sized up to recover..."
                  />
                </div>
              </div>
            </>
          )}

          {/* ─── STEP 2: Risk ─── */}
          {step === 2 && (
            <>
              <div style={{ border: `1px solid ${C.b0}`, borderRadius: 8, backgroundColor: C.d1, overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: `1px solid ${C.b0}` }}>
                  <div>
                    <h2 style={{ fontSize: 13, fontWeight: 700, color: C.t0, marginBottom: 3 }}>Today&apos;s risk limits</h2>
                    <p style={{ fontSize: 11, color: C.t2 }}>These are the terms of today's session. Accept them before you trade them.</p>
                  </div>
                  <button type="button" onClick={() => navigate('/trading-plan')}
                    style={{ fontSize: 11, color: C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
                    edit rules →
                  </button>
                </div>

                {/* Rules as stat tiles — value first, meaning underneath */}
                {(() => {
                  const activeRules = riskRules.filter(r => r.enabled !== false && r.kind && r.kind !== 'manual');

                  if (activeRules.length === 0) {
                    return (
                      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
                        <p style={{ fontSize: 12, color: C.t2, marginBottom: 10 }}>No active risk rules.</p>
                        <button type="button" onClick={() => navigate('/trading-plan')}
                          style={{ fontSize: 11, color: C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                          Set up rules in Trading Plan →
                        </button>
                      </div>
                    );
                  }

                  const tiles = activeRules.map(rule => {
                    const kind = rule.kind!;
                    let label: string = kind;
                    let value = '—';
                    let valueColor = C.t0;

                    if (kind === 'max_daily_loss') {
                      const v = Number(rule.value);
                      label = 'Max daily loss';
                      if (Number.isFinite(v) && v > 0) { value = formatCurrency(-v); valueColor = C.red; }
                      else { value = 'No limit'; valueColor = C.t2; }
                    } else if (kind === 'max_trades') {
                      const v = Number(rule.value);
                      label = 'Max trades';
                      if (Number.isFinite(v) && v > 0) value = String(v);
                    } else if (kind === 'max_contracts') {
                      const limits = rule.contractLimits;
                      const v = Number(rule.value);
                      label = 'Max size';
                      if (limits && Object.keys(limits).length > 0) {
                        value = Object.entries(limits).map(([sym, max]) => `${max} ${sym}`).join(' · ');
                      } else if (Number.isFinite(v) && v > 0) {
                        value = String(v);
                      }
                    } else if (kind === 'min_rr') {
                      const v = Number(rule.value);
                      label = 'Min R:R';
                      if (Number.isFinite(v) && v > 0) value = `1:${v}`;
                    } else if (kind === 'time_window') {
                      label = 'Trade window';
                      value = `${rule.startTime ?? '09:30'}–${rule.endTime ?? '16:00'}`;
                    } else if (kind === 'cooldown_after_loss') {
                      const v = Number(rule.value);
                      label = 'Loss cooldown';
                      if (Number.isFinite(v) && v > 0) value = `${v} min`;
                    }

                    return { id: rule.id, label, value, valueColor };
                  });

                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: `1px solid ${C.b0}` }}>
                      {tiles.map((tile, i) => (
                        <div key={tile.id} style={{
                          flex: '1 1 auto',
                          padding: '10px 16px',
                          borderLeft: i === 0 ? 'none' : `1px solid ${C.b0}`,
                          minWidth: 0,
                        }}>
                          <p style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.t2, marginBottom: 4 }}>{tile.label}</p>
                          <p style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600, color: tile.valueColor, lineHeight: 1, whiteSpace: 'nowrap' }}>{tile.value}</p>
                        </div>
                      ))}
                      {/* Daily profit target — powers the target gauge on the live session view */}
                      <div style={{ flex: '1 1 auto', padding: '7px 16px 8px', borderLeft: `1px solid ${C.b0}`, minWidth: 0 }}>
                        <p style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.t2, marginBottom: 4 }}>Daily target</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 13, color: C.t2 }}>$</span>
                          <input
                            type="number" min={0} value={sessionTarget}
                            onChange={e => setSessionTarget(e.target.value)}
                            onBlur={() => persistPreSession({})}
                            placeholder="—"
                            style={{
                              width: 84, boxSizing: 'border-box',
                              borderRadius: 4, border: `1px solid ${C.b0}`,
                              backgroundColor: C.d2, color: C.t0,
                              fontFamily: 'monospace', fontSize: 13, padding: '3px 7px', outline: 'none',
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Which limits actually get broken — the rap sheet from the
                    last 10 traded sessions, same engine as journal verification.
                    One row per broken rule: label, per-session breach bar, count. */}
                {limitBreaches && (
                  <div style={{ padding: '10px 16px 11px', borderBottom: `1px solid ${C.b0}` }}>
                    <p style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.t2, marginBottom: limitBreaches.breached.length > 0 ? 8 : 0 }}>
                      Broken in your last {limitBreaches.sessions} sessions
                    </p>
                    {limitBreaches.breached.length === 0 ? (
                      <p style={{ fontSize: 11, color: C.t2, marginTop: 4 }}>
                        No limit breaches detected. Keep it that way.
                      </p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {limitBreaches.breached.map(item => (
                          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{
                              width: 180, flexShrink: 0, fontSize: 11, color: C.t1,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                              {item.label}
                            </span>
                            <div style={{ flex: 1, display: 'flex', gap: 2 }}>
                              {Array.from({ length: limitBreaches.sessions }).map((_, i) => (
                                <span key={i} style={{
                                  flex: 1, height: 4, borderRadius: 1,
                                  backgroundColor: i < item.fails ? `${C.red}c0` : 'rgba(255,255,255,0.07)',
                                }} />
                              ))}
                            </div>
                            <span style={{
                              flexShrink: 0, width: 38, textAlign: 'right',
                              fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: C.red,
                            }}>
                              {item.fails}/{limitBreaches.sessions}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Risk acceptance — a limit you've signed is different from a
                    limit you were told about. Un-accepted risk is where tilt
                    comes from. */}
                {riskRules.some(r => r.enabled !== false && r.kind && r.kind !== 'manual') && (
                  checklistState['risk-accepted'] ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.grn }}>
                        ✓ Risk accepted — whatever today costs, it's already priced in.
                      </span>
                      <button type="button" onClick={() => toggleChecklist({ id: 'risk-accepted', label: 'Risk accepted' })}
                        style={{ background: 'none', border: 'none', color: C.t2, fontSize: 10, cursor: 'pointer', padding: 0 }}>
                        reset
                      </button>
                    </div>
                  ) : (
                    <HoldToCommit
                      key={`risk-accept-${todayIso}`}
                      label="Hold to hold yourself accountable"
                      onCommit={() => toggleChecklist({ id: 'risk-accepted', label: 'Risk accepted' })}
                    />
                  )
                )}
              </div>
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

                  {/* Hold-to-commit — card footer. Keyed by item so each new
                      commitment starts from an empty hold. */}
                  {activeOathIdx !== -1 && (
                    <HoldToCommit
                      key={activeOathItems[activeOathIdx].id}
                      label="Hold to commit"
                      onCommit={() => toggleChecklist(activeOathItems[activeOathIdx])}
                    />
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
                {/* Score + status + summary — the score number is the only
                    colored element on this card; everything else stays neutral */}
                <div style={{ padding: '14px 18px 16px', borderBottom: readiness.reasons.length > 0 ? `1px solid ${C.b0}` : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 40, fontWeight: 500, color: readinessColor, lineHeight: 1, letterSpacing: '-0.04em' }}>{readiness.score}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.t2 }}>/100</span>
                    <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{readiness.status}</span>
                  </div>
                  <p style={{ fontSize: 12, color: C.t1, lineHeight: 1.6 }}>{readiness.summary}</p>
                </div>
                {/* Reasons */}
                {readiness.reasons.map((r, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 18px', borderTop: `1px solid ${C.b0}` }}>
                    <span style={{ width: 3, height: 3, borderRadius: '50%', flexShrink: 0, backgroundColor: C.t2, marginTop: 6, opacity: 0.7 }} />
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
                  {sessionPlan.map((row, i) => (
                    <div key={row.id} style={{
                      padding: '12px 16px',
                      borderTop: i === 0 ? 'none' : `1px solid ${C.b0}`,
                    }}>
                      <p style={{ fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 5 }}>{row.source}</p>
                      <p style={{ fontSize: 12, lineHeight: 1.55, color: C.t0 }}>{row.rule}</p>
                    </div>
                  ))}
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
                            fontSize: 8, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase',
                            color: C.t2, border: `1px solid ${C.b0}`, borderRadius: 3, padding: '2px 6px',
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

              {/* ── Ignition ── */}
              <div data-tour-id="pre-session-begin">
                {sessionAlreadyStarted ? (
                  <button type="button" onClick={() => navigate('/session')} style={{
                    width: '100%', padding: '16px 20px', borderRadius: 10,
                    border: `1px solid ${C.grn}50`, backgroundColor: `${C.grn}12`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    color: C.grn, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                    <span>Continue session</span>
                    <span style={{ fontSize: 15, opacity: 0.8 }}>→</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={launching}
                      onClick={() => {
                        setLaunching(true);
                        window.setTimeout(() => startSession(), 650);
                      }}
                      style={{
                        width: '100%', padding: '15px 20px', borderRadius: 8,
                        border: 'none',
                        background: C.acc,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                        color: '#000', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
                        cursor: launching ? 'default' : 'pointer',
                        transition: 'transform 0.12s ease',
                      }}
                      onMouseDown={event => { (event.currentTarget as HTMLElement).style.transform = 'scale(0.99)'; }}
                      onMouseUp={event => { (event.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
                      onMouseLeave={event => { (event.currentTarget as HTMLElement).style.transform = 'scale(1)'; }}
                    >
                      <span>Begin session</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                        {readiness.score}
                      </span>
                    </button>
                    {readiness.status === 'Stand Down' && (
                      <p style={{ marginTop: 8, fontSize: 11, color: C.t2, textAlign: 'center' }}>
                        Your readiness score says stand down — launching anyway is a choice you're making.
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}

        </div>{/* end slide wrapper */}

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

      {/* ── Wizard motion + ignition styles ── */}
      <style>{`
        @keyframes ps-slide-fwd {
          from { opacity: 0; transform: translateX(28px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes ps-slide-back {
          from { opacity: 0; transform: translateX(-28px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .ps-step-fwd  { animation: ps-slide-fwd 0.26s ease both; }
        .ps-step-back { animation: ps-slide-back 0.26s ease both; }
        @keyframes ps-launch-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .ps-launch-overlay { animation: ps-launch-in 0.4s ease both; }
        @media (prefers-reduced-motion: reduce) {
          .ps-step-fwd, .ps-step-back, .ps-launch-overlay { animation: none; }
        }
      `}</style>

      {/* ── Ignition overlay: score locks in, then the session begins ── */}
      {launching && (
        <div className="ps-launch-overlay" style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(10, 9, 8, 0.94)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <span style={{ fontFamily: 'monospace', fontSize: 64, fontWeight: 600, color: readinessColor, lineHeight: 1, letterSpacing: '-0.03em' }}>
            {readiness.score}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.3em', textTransform: 'uppercase', color: C.t2 }}>
            Session armed
          </span>
        </div>
      )}
    </div>
  );

}

// Press-and-hold commitment button. The fill sweeps left→right while held;
// releasing early resets. Completing the hold fires onCommit once. This
// replaces a click + cooldown timer with an interaction that mechanically
// enforces the pause an oath is supposed to create.
function HoldToCommit({ label, onCommit }: { label: string; onCommit: () => void }) {
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const stop = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    startRef.current = null;
    if (!firedRef.current) setProgress(0);
  };

  useEffect(() => stop, []);

  const begin = () => {
    if (firedRef.current) return;
    startRef.current = performance.now();
    const tick = (nowTs: number) => {
      if (startRef.current === null) return;
      const ratio = Math.min(1, (nowTs - startRef.current) / OATH_HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        firedRef.current = true;
        setDone(true);
        onCommit();
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  return (
    <button
      type="button"
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={event => event.preventDefault()}
      style={{
        position: 'relative', width: '100%', padding: '14px 16px',
        border: 'none', borderTop: `1px solid ${C.b0}`,
        backgroundColor: C.d3, overflow: 'hidden',
        color: done ? C.grn : progress > 0 ? '#000' : C.acc,
        fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        cursor: 'pointer', userSelect: 'none', touchAction: 'none',
      }}
    >
      {/* Fill sweep */}
      <span style={{
        position: 'absolute', inset: 0,
        width: `${progress * 100}%`,
        background: done ? C.grn : C.acc,
        transition: progress === 0 ? 'width 0.18s ease' : 'none',
      }} />
      <span style={{ position: 'relative' }}>
        {done ? 'Committed ✓' : progress > 0 ? 'Keep holding…' : label}
      </span>
    </button>
  );
}

// Tweened readiness score — the number visibly ticks when inputs change it.
function AnimatedScore({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const previousRef = useRef(value);

  useEffect(() => {
    const from = previousRef.current;
    const to = value;
    previousRef.current = value;
    if (from === to) return;
    const started = performance.now();
    const duration = 420;
    let frame = 0;
    const tick = (nowTs: number) => {
      const t = Math.min(1, (nowTs - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <span style={{ display: 'inline-block', fontFamily: 'monospace', fontWeight: 700 }}>{display}</span>;
}
