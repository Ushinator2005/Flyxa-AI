import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Brain, ClipboardList, LineChart as LineChartIcon, Moon, Target, Zap } from 'lucide-react';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry, Trade as StoreTrade } from '../store/types.js';
import { formatCurrency } from '../utils/calculations.js';
import './PsychologyTracker.css';

type Tone = 'green' | 'amber' | 'red' | 'cobalt' | 'neutral';

type RichTrade = StoreTrade & {
  preEntry?: {
    confidenceAtEntry?: number;
    emotionalState?: string;
    hesitated?: boolean | null;
  };
  executionReview?: Record<string, boolean | null | string | undefined>;
  psychologyRatings?: {
    setupQuality?: number;
    discipline?: number;
    execution?: number;
    patience?: number;
    riskManagement?: number;
    emotionalControl?: number;
  };
  behavioralFlags?: string[];
  stateOfMind?: Array<{ label: string; valence: 'positive' | 'caution' | 'negative' }>;
  processScore?: number;
};

const RISK_EMOTIONS = ['revenge', 'fomo', 'fearful', 'frustrated', 'bored', 'impatient', 'overconfident', 'distracted'];
const FLAG_LABELS: Record<string, string> = {
  'chased-entry':    'Chased entry',
  'no-confirmation': 'Jumped in early',
  'incorrect-stop-loss': 'Incorrect stop loss',
  'plan-deviation':  'Plan deviation',
  'sized-up':        'Oversized',
  'added-losing':    'Added to loser',
  'be-too-early':    'BE too early',
  'overtraded':      'Overtraded',
  'moved-stop':      'Widened stop',
  'exit-early':      'Exited early',
  'moved-target':    'Moved / ignored TP',
  'past-inval':      'Held past invalidation',
  'boredom-trade':   'Boredom trade',
  'revenge':         'Revenge trade',
  'reentry-stop':    'Re-entered after stop',
};

// Weighted penalties matching TradeJournal
const FLAG_PENALTIES: Record<string, number> = {
  'sized-up':       20,
  'revenge':        20,
  'added-losing':   20,
  'incorrect-stop-loss': 12,
  'plan-deviation': 12,
  'reentry-stop':   12,
  'past-inval':     12,
  'moved-stop':     12,
  'boredom-trade':  12,
  'chased-entry':    6,
  'no-confirmation': 6,
  'overtraded':      6,
  'exit-early':      6,
  'moved-target':    6,
  'be-too-early':    4,
};

function toneForPct(value: number): Tone {
  if (value >= 75) return 'green';
  if (value >= 55) return 'amber';
  return 'red';
}

function scoreTone(score: number | null): Tone {
  if (score === null) return 'neutral';
  if (score >= 75) return 'green';
  if (score >= 55) return 'amber';
  return 'red';
}

function computeProcessScore(trade: RichTrade): number | null {
  if (typeof trade.processScore === 'number' && trade.processScore > 0) return trade.processScore;

  const ratings = trade.psychologyRatings;
  const scores = ratings
    ? [ratings.setupQuality, ratings.discipline, ratings.execution, ratings.patience, ratings.riskManagement, ratings.emotionalControl]
        .filter((value): value is number => typeof value === 'number' && value > 0)
    : [];

  if (scores.length === 0) return null;
  const avg = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const flagPenalty = (trade.behavioralFlags ?? []).reduce((total, id) => total + (FLAG_PENALTIES[id] ?? 8), 0);
  return Math.max(0, Math.min(100, Math.round(avg * 20 - flagPenalty)));
}

function hasRiskEmotion(trade: RichTrade): boolean {
  const state = trade.preEntry?.emotionalState?.toLowerCase() ?? '';
  const tags = trade.stateOfMind ?? [];
  return RISK_EMOTIONS.some(label => state.includes(label))
    || tags.some(tag => tag.valence === 'negative' || tag.valence === 'caution');
}

function getTradeDateTime(trade: RichTrade): string {
  return `${trade.date ?? ''} ${trade.time ?? ''}`;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareTradeGroups(label: string, strongTrades: RichTrade[], weakTrades: RichTrade[]) {
  const describe = (trades: RichTrade[]) => {
    const closed = trades.filter(trade => trade.result !== 'open');
    return {
      count: closed.length,
      pnl: closed.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
      winRate: pct(closed.filter(trade => trade.result === 'win').length, closed.length),
    };
  };

  const strong = describe(strongTrades);
  const weak = describe(weakTrades);
  if (strong.count < 2 && weak.count < 2) return null;

  return {
    label,
    strong,
    weak,
    delta: strong.count > 0 && weak.count > 0 ? strong.pnl / strong.count - weak.pnl / weak.count : null,
  };
}

function KpiCard({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: Tone }) {
  return (
    <article className="psy-kpi">
      <p>{label}</p>
      <strong className={tone}>{value}</strong>
      <span>{sub}</span>
    </article>
  );
}

function InsightCard({ title, body, tone, icon: Icon }: { title: string; body: string; tone: Tone; icon: typeof Brain }) {
  return (
    <article className={`psy-insight ${tone}`}>
      <Icon size={15} />
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </article>
  );
}

export default function PsychologyTracker() {
  const navigate = useNavigate();
  const { trades } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const entries = useFlyxaStore(state => state.entries) as JournalEntry[];

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );
  const selectedIds = useMemo(() => new Set(accountTrades.map(trade => trade.id)), [accountTrades]);
  const richTrades = useMemo(
    () => entries
      .flatMap(entry => entry.trades.map(trade => ({ ...trade, date: trade.date || entry.date } as RichTrade)))
      .filter(trade => selectedIds.has(trade.id))
      .sort((a, b) => getTradeDateTime(a).localeCompare(getTradeDateTime(b))),
    [entries, selectedIds]
  );
  const selectedEntries = useMemo(
    () => entries.filter(entry => entry.trades.some(trade => selectedIds.has(trade.id))),
    [entries, selectedIds]
  );

  const metrics = useMemo(() => {
    const closed = richTrades.filter(trade => trade.result !== 'open');
    const withProcess = richTrades
      .map(computeProcessScore)
      .filter((value): value is number => value !== null);
    const avgProcess = avg(withProcess);
    const flaggedTrades = richTrades.filter(trade => (trade.behavioralFlags?.length ?? 0) > 0);
    const riskEmotionTrades = richTrades.filter(hasRiskEmotion);
    const followedPlanTrades = richTrades.filter(trade => typeof trade.reflection?.followedPlan === 'boolean');
    const planRate = pct(followedPlanTrades.filter(trade => trade.reflection.followedPlan).length, followedPlanTrades.length);
    const hesitationTrades = richTrades.filter(trade => trade.preEntry?.hesitated === true);
    const confidenceTrades = richTrades.filter(trade => (trade.preEntry?.confidenceAtEntry ?? 0) > 0);
    const highConfidence = confidenceTrades.filter(trade => (trade.preEntry?.confidenceAtEntry ?? 0) >= 4);
    const highConfidenceLosses = highConfidence.filter(trade => trade.result === 'loss');

    return {
      closed,
      avgProcess,
      flaggedTrades,
      riskEmotionTrades,
      planRate,
      planSample: followedPlanTrades.length,
      hesitationRate: pct(hesitationTrades.length, confidenceTrades.length || richTrades.length),
      highConfidenceLossRate: pct(highConfidenceLosses.length, highConfidence.length),
    };
  }, [richTrades]);

  const correlations = useMemo(() => {
    const highSleepEntries = selectedEntries.filter(entry => (entry.physicalState?.sleep ?? 0) >= 4);
    const lowSleepEntries = selectedEntries.filter(entry => {
      const sleep = entry.physicalState?.sleep ?? 0;
      return sleep > 0 && sleep <= 2;
    });
    const highEnergyEntries = selectedEntries.filter(entry => (entry.physicalState?.energy ?? 0) >= 4);
    const lowEnergyEntries = selectedEntries.filter(entry => {
      const energy = entry.physicalState?.energy ?? 0;
      return energy > 0 && energy <= 2;
    });

    const byEntry = (source: JournalEntry[]) => source.flatMap(entry => entry.trades as RichTrade[]).filter(trade => selectedIds.has(trade.id));
    const disciplineHigh = richTrades.filter(trade => (trade.psychologyRatings?.discipline ?? 0) >= 4);
    const disciplineLow = richTrades.filter(trade => {
      const value = trade.psychologyRatings?.discipline ?? 0;
      return value > 0 && value <= 2;
    });

    return [
      compareTradeGroups('Sleep quality', byEntry(highSleepEntries), byEntry(lowSleepEntries)),
      compareTradeGroups('Energy', byEntry(highEnergyEntries), byEntry(lowEnergyEntries)),
      compareTradeGroups('Discipline', disciplineHigh, disciplineLow),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [richTrades, selectedEntries, selectedIds]);

  const flagRows = useMemo(() => {
    const rows = new Map<string, { label: string; count: number; pnl: number }>();
    richTrades.forEach(trade => {
      (trade.behavioralFlags ?? []).forEach(flag => {
        const row = rows.get(flag) ?? { label: FLAG_LABELS[flag] ?? flag, count: 0, pnl: 0 };
        row.count += 1;
        row.pnl += trade.pnl - (trade.commission ?? 0);
        rows.set(flag, row);
      });
    });
    return [...rows.values()].sort((a, b) => a.pnl - b.pnl).slice(0, 8);
  }, [richTrades]);

  const emotionRows = useMemo(() => {
    const rows = new Map<string, { label: string; count: number; pnl: number }>();
    richTrades.forEach(trade => {
      const labels = new Set<string>();
      if (trade.preEntry?.emotionalState) labels.add(trade.preEntry.emotionalState);
      (trade.stateOfMind ?? []).forEach(tag => labels.add(tag.label));
      labels.forEach(label => {
        const row = rows.get(label) ?? { label, count: 0, pnl: 0 };
        row.count += 1;
        row.pnl += trade.pnl - (trade.commission ?? 0);
        rows.set(label, row);
      });
    });
    return [...rows.values()].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 10);
  }, [richTrades]);

  const recentFlags = useMemo(() => {
    const sorted = [...richTrades].sort((a, b) => getTradeDateTime(b).localeCompare(getTradeDateTime(a)));
    let losses = 0;
    for (const trade of sorted) {
      if (trade.result === 'loss') losses += 1;
      else break;
    }
    return {
      losses,
      lastRiskTrade: sorted.find(hasRiskEmotion),
      lastFlaggedTrade: sorted.find(trade => (trade.behavioralFlags?.length ?? 0) > 0),
    };
  }, [richTrades]);

  const guidance = useMemo(() => {
    const items: Array<{ title: string; body: string; tone: Tone; icon: typeof Brain }> = [];
    if (metrics.flaggedTrades.length > 0) {
      const cost = metrics.flaggedTrades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0);
      items.push({
        title: 'Behavioral Cost',
        body: `${metrics.flaggedTrades.length} flagged trade${metrics.flaggedTrades.length !== 1 ? 's' : ''} total ${formatCurrency(cost)}. Review the top flag before your next session.`,
        tone: cost < 0 ? 'red' : 'amber',
        icon: AlertTriangle,
      });
    }
    if (metrics.highConfidenceLossRate >= 35) {
      items.push({
        title: 'Confidence Leak',
        body: `${metrics.highConfidenceLossRate}% of high-confidence trades are losses. Require one extra confirmation before sizing up.`,
        tone: 'amber',
        icon: Zap,
      });
    }
    if (metrics.planSample > 0 && metrics.planRate < 70) {
      items.push({
        title: 'Plan Adherence',
        body: `Plan follow rate is ${metrics.planRate}%. The journal should be used as a pre-trade blocker, not just a post-trade review.`,
        tone: 'red',
        icon: ClipboardList,
      });
    }
    if (items.length === 0) {
      items.push({
        title: 'Journal More Context',
        body: 'Add pre-entry state, process ratings, and behavioral flags in Trade Journal to unlock stronger behavioral insights.',
        tone: 'cobalt',
        icon: Target,
      });
    }
    return items.slice(0, 3);
  }, [metrics]);

  const maxEmotionImpact = Math.max(...emotionRows.map(row => Math.abs(row.pnl)), 1);
  const positiveEmotionTotal = emotionRows.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const negativeEmotionTotal = emotionRows.filter(row => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0);
  const bestEmotion = emotionRows.find(row => row.pnl > 0);
  const worstEmotion = emotionRows.find(row => row.pnl < 0);
  const topEmotionRows = emotionRows
    .filter(row => row.label !== bestEmotion?.label && row.label !== worstEmotion?.label)
    .slice(0, 4);

  return (
    <div className="psy-page animate-fade-in">
      <header className="psy-header">
        <div>
          <h1>
            <Brain size={22} />
            Behavioral Edge
          </h1>
          <p>Psychology now lives in Trade Journal. This page reads those entries and shows the emotional patterns that are helping or hurting execution.</p>
        </div>
        <button type="button" className="psy-journal-btn" onClick={() => navigate('/journal')}>
          Open Trade Journal
        </button>
      </header>

      <section className="psy-kpi-grid">
        <KpiCard
          label="Process Score"
          value={metrics.avgProcess === null ? '--' : String(Math.round(metrics.avgProcess))}
          sub={`${metrics.closed.length} closed trades analyzed`}
          tone={scoreTone(metrics.avgProcess)}
        />
        <KpiCard
          label="Plan Follow"
          value={metrics.planSample === 0 ? '--' : `${metrics.planRate}%`}
          sub={`${metrics.planSample} trade${metrics.planSample !== 1 ? 's' : ''} with plan data`}
          tone={metrics.planSample === 0 ? 'neutral' : toneForPct(metrics.planRate)}
        />
        <KpiCard
          label="Risk Emotion Rate"
          value={`${pct(metrics.riskEmotionTrades.length, richTrades.length)}%`}
          sub={`${metrics.riskEmotionTrades.length} emotional-risk trades`}
          tone={metrics.riskEmotionTrades.length === 0 ? 'green' : pct(metrics.riskEmotionTrades.length, richTrades.length) >= 30 ? 'red' : 'amber'}
        />
        <KpiCard
          label="Hesitation Rate"
          value={`${metrics.hesitationRate}%`}
          sub="from pre-entry journal fields"
          tone={metrics.hesitationRate >= 35 ? 'amber' : 'green'}
        />
      </section>

      <section className="psy-insight-grid">
        {guidance.map(item => (
          <InsightCard key={item.title} {...item} />
        ))}
      </section>

      <main className="psy-layout">
        <div className="psy-stack">
          <section className="psy-card">
            <div className="psy-card-head">
              <h2>
                <LineChartIcon size={16} />
                Emotion Impact
              </h2>
              <span className="psy-head-tag">Trade Journal source</span>
            </div>
            {emotionRows.length === 0 ? (
              <div className="psy-empty">
                <p>No emotion tags yet. Add pre-entry state or state-of-mind tags in Trade Journal.</p>
              </div>
            ) : (
              <div className="psy-impact">
                <div className="psy-impact-hero">
                  <article className="green">
                    <span>Best state</span>
                    <strong>{bestEmotion?.label ?? 'No winning state yet'}</strong>
                    <em>{bestEmotion ? `${formatCurrency(bestEmotion.pnl)} across ${bestEmotion.count} trade${bestEmotion.count !== 1 ? 's' : ''}` : formatCurrency(positiveEmotionTotal)}</em>
                  </article>
                  <article className="red">
                    <span>Costly state</span>
                    <strong>{worstEmotion?.label ?? 'No costly state yet'}</strong>
                    <em>{worstEmotion ? `${formatCurrency(worstEmotion.pnl)} across ${worstEmotion.count} trade${worstEmotion.count !== 1 ? 's' : ''}` : formatCurrency(negativeEmotionTotal)}</em>
                  </article>
                </div>
                {topEmotionRows.length > 0 && (
                  <div className="psy-impact-list">
                    {topEmotionRows.map(row => {
                    const width = Math.max(5, Math.round((Math.abs(row.pnl) / maxEmotionImpact) * 100));
                    const tone = row.pnl >= 0 ? 'green' : 'red';
                    return (
                      <article key={row.label} className={`psy-impact-row ${tone}`}>
                        <div className="psy-impact-label">
                          <strong>{row.label}</strong>
                          <span>{row.count} trade{row.count !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="psy-impact-track" aria-hidden="true">
                          <div style={{ width: `${width}%` }} />
                        </div>
                        <span className="psy-impact-value">{formatCurrency(row.pnl)}</span>
                      </article>
                    );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="psy-card">
            <div className="psy-card-head">
              <h2>
                <Moon size={16} />
                Physical State Correlations
              </h2>
            </div>
            {correlations.length === 0 ? (
              <div className="psy-empty">
                <p>Add sleep, stress, energy, and discipline ratings in Trade Journal to compare conditions.</p>
              </div>
            ) : (
              <div className="psy-correlation-list">
                {correlations.map(item => (
                  <article key={item.label}>
                    <div>
                      <h3>{item.label}</h3>
                      <p>{item.strong.count} strong-signal trades vs {item.weak.count} weak-signal trades</p>
                    </div>
                    <div className="psy-correlation-metrics">
                      <span className={item.strong.pnl >= 0 ? 'green' : 'red'}>{formatCurrency(item.strong.pnl)}</span>
                      <span className={item.weak.pnl >= 0 ? 'green' : 'red'}>{formatCurrency(item.weak.pnl)}</span>
                      <em>{item.delta === null ? 'Need both samples' : `${formatCurrency(item.delta)} / trade edge`}</em>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="psy-stack">
          {/* ── Tilt Monitor ── */}
          <section className="psy-card">
            <div className="psy-card-head">
              <h2><AlertTriangle size={16} />Tilt Monitor</h2>
            </div>

            {/* Loss streak dots */}
            <div className="psy-streak-block">
              <div className="psy-streak-dots">
                {Array.from({ length: Math.max(5, recentFlags.losses) }).map((_, i) => {
                  const filled = i < recentFlags.losses;
                  const tone = recentFlags.losses >= 3 ? 'red' : recentFlags.losses >= 2 ? 'amber' : 'green';
                  return <div key={i} className={`psy-streak-dot${filled ? ` psy-streak-dot--${tone}` : ''}`} />;
                })}
              </div>
              <div className="psy-streak-text">
                <span className={`psy-streak-label psy-streak-label--${recentFlags.losses >= 3 ? 'red' : recentFlags.losses >= 2 ? 'amber' : 'green'}`}>
                  {recentFlags.losses >= 3 ? 'Tilt Risk' : recentFlags.losses >= 2 ? 'Caution' : 'Stable'}
                </span>
                <p>
                  {recentFlags.losses} consecutive loss{recentFlags.losses !== 1 ? 'es' : ''} —{' '}
                  {recentFlags.losses >= 2
                    ? 'reduce size and require full checklist confirmation'
                    : 'no active loss-streak pressure detected'}
                </p>
              </div>
            </div>

            {/* Stats */}
            <div className="psy-tilt-stats">
              <div className="psy-tilt-stat">
                <strong className={metrics.flaggedTrades.length > 0 ? 'amber' : 'green'}>{metrics.flaggedTrades.length}</strong>
                <span>flagged trades</span>
              </div>
              <div className="psy-tilt-stat-sep" />
              <div className="psy-tilt-stat">
                <strong className={metrics.highConfidenceLossRate >= 35 ? 'red' : 'green'}>{metrics.highConfidenceLossRate}%</strong>
                <span>high-confidence loss rate</span>
              </div>
            </div>
          </section>

          {/* ── Costliest Behavioral Flags ── */}
          <section className="psy-card">
            <div className="psy-card-head">
              <h2><ClipboardList size={16} />Costliest Behavioral Flags</h2>
            </div>
            {flagRows.length === 0 ? (
              <div className="psy-empty">
                <p>No behavioral flags logged yet. Mark mistakes directly on trades in the Journal.</p>
              </div>
            ) : (
              <div className="psy-flag-rows">
                {flagRows.map((row, i) => (
                  <div key={row.label} className="psy-flag-row">
                    <span className="psy-flag-rank">{i + 1}</span>
                    <div className="psy-flag-info">
                      <span className="psy-flag-name">{row.label}</span>
                      <span className="psy-flag-meta">{row.count}× triggered</span>
                    </div>
                    <span className={`psy-flag-pnl ${row.pnl >= 0 ? 'green' : 'red'}`}>{formatCurrency(row.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
