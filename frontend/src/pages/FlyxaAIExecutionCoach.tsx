import { CSSProperties, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, ShieldAlert, TrendingDown, WalletCards } from 'lucide-react';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Trade } from '../types/index.js';

type GateStatus = 'clear' | 'caution' | 'blocked';
type MistakeKey = 'offPlan' | 'tilt' | 'overtrade' | 'postLoss' | 'poorRR';

type MistakeRow = {
  key: MistakeKey;
  label: string;
  description: string;
  trades: Trade[];
  cost: number;
  tone: 'red' | 'amber' | 'green';
  rule: string;
};

const C = {
  d0: '#0e0d0d',
  d1: '#141312',
  d2: '#1a1917',
  d3: '#201f1d',
  d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)',
  b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc',
  t1: '#8a8178',
  t2: '#5c5751',
  acc: '#f59e0b',
  grn: '#34d399',
  red: '#f87171',
  blu: '#60a5fa',
  mono: 'var(--font-mono)',
  sans: 'var(--font-sans)',
};

const cardStyle: CSSProperties = {
  border: `1px solid ${C.b0}`,
  background: C.d2,
  borderRadius: 8,
};

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function parseTradeDate(trade: Trade): Date | null {
  const raw = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTradeDateTime(trade: Trade): Date | null {
  const rawDate = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!rawDate) return null;
  const rawTime = trade.trade_time || '00:00:00';
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${rawDate}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfWeek(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const dow = start.getDay();
  start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1));
  return start;
}

function formatCurrency(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatSignedCurrency(value: number) {
  if (Math.abs(value) < 0.005) return '$0';
  return `${value > 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

function pct(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function riskReward(trade: Trade): number | null {
  const risk = Math.abs(Number(trade.entry_price) - Number(trade.sl_price));
  const reward = Math.abs(Number(trade.tp_price) - Number(trade.entry_price));
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0) return null;
  return reward / risk;
}

function isTiltEmotion(value: string | null | undefined) {
  const emotion = (value ?? '').toLowerCase();
  return ['revenge', 'fomo', 'angry', 'anger', 'frustrated', 'fear', 'anxious', 'greed', 'overconfident', 'tilt']
    .some(term => emotion.includes(term));
}

function groupByDate(trades: Trade[]) {
  const grouped = new Map<string, Trade[]>();
  trades.forEach((trade) => {
    const key = trade.trade_date || trade.created_at?.slice(0, 10) || 'unknown';
    grouped.set(key, [...(grouped.get(key) ?? []), trade]);
  });
  return grouped;
}

function getConsecutiveLosses(trades: Trade[]) {
  let losses = 0;
  const ordered = [...trades].sort((a, b) => (parseTradeDateTime(b)?.getTime() ?? 0) - (parseTradeDateTime(a)?.getTime() ?? 0));
  for (const trade of ordered) {
    if (trade.pnl < 0) losses += 1;
    else if (trade.pnl > 0) break;
  }
  return losses;
}

function getHighImpactWarning(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('flyxa_calendar_cache_v4');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string; date?: string; time?: string; impact?: string; actual?: string }> };
    if (!Array.isArray(parsed.events)) return null;
    const today = dateOnly(new Date());
    const next = parsed.events
      .filter(event => event.impact === 'high' && event.date === today && !event.actual)
      .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')))[0];
    return next?.event ? `${next.event}${next.time ? ` at ${next.time}` : ''}` : null;
  } catch {
    return null;
  }
}

function buildMistakeRows(trades: Trade[]): MistakeRow[] {
  const byDate = groupByDate(trades);
  const overtradeIds = new Set<string>();
  const postLossIds = new Set<string>();

  byDate.forEach((dayTrades) => {
    const ordered = [...dayTrades].sort((a, b) => (parseTradeDateTime(a)?.getTime() ?? 0) - (parseTradeDateTime(b)?.getTime() ?? 0));
    ordered.slice(2).forEach(trade => overtradeIds.add(trade.id));
    ordered.forEach((trade, index) => {
      const prev = ordered[index - 1];
      if (!prev || prev.pnl >= 0) return;
      const prevTime = parseTradeDateTime(prev);
      const tradeTime = parseTradeDateTime(trade);
      if (!prevTime || !tradeTime) return;
      const mins = (tradeTime.getTime() - prevTime.getTime()) / 60_000;
      if (mins >= 0 && mins <= 20) postLossIds.add(trade.id);
    });
  });

  const makeRow = (
    key: MistakeKey,
    label: string,
    description: string,
    matches: Trade[],
    rule: string,
  ): MistakeRow => {
    const net = matches.reduce((sum, trade) => sum + trade.pnl, 0);
    const cost = Math.max(0, -net);
    return {
      key,
      label,
      description,
      trades: matches,
      cost,
      tone: cost > 0 ? 'red' : matches.length > 0 ? 'amber' : 'green',
      rule,
    };
  };

  return [
    makeRow(
      'offPlan',
      'Off-plan trades',
      'Trades where the plan flag was logged as false.',
      trades.filter(trade => trade.followed_plan === false),
      'No new position until the setup matches the written playbook.',
    ),
    makeRow(
      'tilt',
      'Tilt-state trades',
      'Trades taken while emotional state looked like revenge, fear, FOMO, anger, or overconfidence.',
      trades.filter(trade => isTiltEmotion(trade.emotional_state)),
      'If tilt is present, wait 15 minutes and retag the state before entry.',
    ),
    makeRow(
      'overtrade',
      'Trade 3+ in a day',
      'Trades taken after the first two entries of the same trading day.',
      trades.filter(trade => overtradeIds.has(trade.id)),
      'After two trades, require an A+ setup or stop for the session.',
    ),
    makeRow(
      'postLoss',
      'Fast re-entry after loss',
      'Trades taken within 20 minutes after a losing trade.',
      trades.filter(trade => postLossIds.has(trade.id)),
      'After any loss, enforce a 20-minute cooldown before the next order.',
    ),
    makeRow(
      'poorRR',
      'Weak reward/risk',
      'Trades planned below 1.2R based on stop and target distance.',
      trades.filter(trade => {
        const rr = riskReward(trade);
        return rr !== null && rr < 1.2;
      }),
      'Skip trades below 1.2R unless there is a documented scalp rule.',
    ),
  ].sort((a, b) => b.cost - a.cost);
}

function toneColor(tone: MistakeRow['tone']) {
  if (tone === 'red') return C.red;
  if (tone === 'amber') return C.acc;
  return C.grn;
}

export default function FlyxaAIExecutionCoach() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const { dailyStatus, riskLevel } = useRisk();
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);
  const accountTrades = useMemo(() => filterTradesBySelectedAccount(trades), [filterTradesBySelectedAccount, trades]);

  const todayKey = dateOnly(new Date());
  const todayTrades = useMemo(
    () => accountTrades.filter(trade => (trade.trade_date || trade.created_at?.slice(0, 10)) === todayKey),
    [accountTrades, todayKey],
  );

  const weekTrades = useMemo(() => {
    const start = startOfWeek();
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return accountTrades.filter((trade) => {
      const date = parseTradeDate(trade);
      return date ? date >= start && date < end : false;
    });
  }, [accountTrades]);

  const gate = useMemo(() => {
    const reasons: Array<{ status: GateStatus; label: string; detail: string }> = [];
    const todayPnl = todayTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const todayLoss = Math.max(0, -todayPnl);
    const maxTrades = dailyStatus?.maxTradesPerDay ?? dailyStatus?.settings?.max_trades_per_day ?? 0;
    const dailyLossLimit = dailyStatus?.dailyLossLimit ?? dailyStatus?.settings?.daily_loss_limit ?? 0;
    const lossPct = dailyStatus?.lossUsedPercent ?? (dailyLossLimit > 0 ? (todayLoss / dailyLossLimit) * 100 : 0);
    const highImpact = getHighImpactWarning();
    const todayPreSession = preSessionHistory[todayKey];
    const losses = getConsecutiveLosses(todayTrades);
    const recentTilt = todayTrades.slice(-3).some(trade => isTiltEmotion(trade.emotional_state));

    if (dailyStatus?.isLocked || riskLevel === 'locked' || lossPct >= 100) {
      reasons.push({ status: 'blocked', label: 'Daily loss limit reached', detail: 'Trading should be closed for the day.' });
    } else if (lossPct >= 80) {
      reasons.push({ status: 'caution', label: 'Daily loss pressure', detail: `${Math.round(lossPct)}% of daily loss limit is used.` });
    }

    if (maxTrades > 0 && todayTrades.length >= maxTrades) {
      reasons.push({ status: 'blocked', label: 'Max trades reached', detail: `${todayTrades.length}/${maxTrades} trades logged today.` });
    } else if (maxTrades > 0 && todayTrades.length === maxTrades - 1) {
      reasons.push({ status: 'caution', label: 'Last allowed trade', detail: `One trade remains before the daily cap of ${maxTrades}.` });
    }

    if (losses >= 2) {
      reasons.push({ status: 'blocked', label: 'Loss streak active', detail: `${losses} consecutive losses today.` });
    } else if (losses === 1) {
      reasons.push({ status: 'caution', label: 'Post-loss cooldown', detail: 'Last result was a loss. Reconfirm the plan before entry.' });
    }

    if (recentTilt) {
      reasons.push({ status: 'caution', label: 'Tilt emotion detected', detail: 'Recent trade emotion suggests reduced decision quality.' });
    }

    if (todayPreSession?.readiness?.status === 'Stand Down') {
      reasons.push({ status: 'blocked', label: 'Pre-session says stand down', detail: todayPreSession.readiness.summary });
    } else if (todayPreSession?.readiness?.status === 'Caution') {
      reasons.push({ status: 'caution', label: 'Pre-session caution', detail: todayPreSession.readiness.summary });
    } else if (!todayPreSession) {
      reasons.push({ status: 'caution', label: 'No pre-session brief', detail: 'Record readiness before the first entry.' });
    }

    if (highImpact) {
      reasons.push({ status: 'caution', label: 'High-impact news ahead', detail: highImpact });
    }

    const status: GateStatus = reasons.some(reason => reason.status === 'blocked')
      ? 'blocked'
      : reasons.some(reason => reason.status === 'caution')
        ? 'caution'
        : 'clear';

    return {
      status,
      reasons,
      todayPnl,
      todayTrades: todayTrades.length,
      lossPct: Math.round(lossPct),
      dailyLossLimit,
    };
  }, [dailyStatus, preSessionHistory, riskLevel, todayKey, todayTrades]);

  const weekly = useMemo(() => {
    const wins = weekTrades.filter(trade => trade.pnl > 0);
    const losses = weekTrades.filter(trade => trade.pnl < 0);
    const net = weekTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const planLogged = weekTrades.filter(trade => typeof trade.followed_plan === 'boolean');
    const planRate = pct(planLogged.filter(trade => trade.followed_plan === true).length, planLogged.length);
    const tiltTrades = weekTrades.filter(trade => isTiltEmotion(trade.emotional_state));
    const mistakeRows = buildMistakeRows(weekTrades);
    const worstMistake = mistakeRows[0];
    const bestSession = Array.from(
      weekTrades.reduce((map, trade) => {
        map.set(trade.session, (map.get(trade.session) ?? 0) + trade.pnl);
        return map;
      }, new Map<string, number>()),
    ).sort((a, b) => b[1] - a[1])[0];

    const focus = [
      worstMistake && worstMistake.cost > 0
        ? `Primary leak: ${worstMistake.label.toLowerCase()} cost ${formatCurrency(worstMistake.cost)}.`
        : 'Primary leak: no negative mistake bucket dominated this week.',
      planLogged.length < Math.max(3, weekTrades.length * 0.7)
        ? 'Data gap: log followed-plan on every trade so coaching can get sharper.'
        : `Plan adherence is ${planRate}%; protect the conditions that produced it.`,
      bestSession
        ? `Best session by P&L: ${bestSession[0]} at ${formatSignedCurrency(bestSession[1])}.`
        : 'Best session: not enough trades yet.',
    ];

    return {
      net,
      count: weekTrades.length,
      winRate: pct(wins.length, wins.length + losses.length),
      planRate,
      tiltCount: tiltTrades.length,
      focus,
      mistakeRows,
    };
  }, [weekTrades]);

  const gateCopy = gate.status === 'blocked'
    ? { label: 'Blocked', color: C.red, icon: CircleSlash, detail: 'Do not take another trade until this condition resets.' }
    : gate.status === 'caution'
      ? { label: 'Caution', color: C.acc, icon: AlertTriangle, detail: 'Trade only if the setup is clean and the rule below is satisfied.' }
      : { label: 'Clear', color: C.grn, icon: CheckCircle2, detail: 'No major execution blockers detected from current data.' };
  const GateIcon = gateCopy.icon;

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl" style={{ background: C.d0, color: C.t0 }}>
        Analyzing execution...
      </div>
    );
  }

  return (
    <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ background: C.d0, color: C.t0, fontFamily: C.sans }}>
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[178px_minmax(0,1fr)]">
        <FlyxaNav />

        <main className="min-h-0 overflow-y-auto">
          <section className="border-b px-6 py-5" style={{ borderColor: C.b0 }}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: C.t2 }}>Execution coach</p>
                <h1 className="mt-1 text-[20px] font-semibold">Stop repeating the trade that ruins the week</h1>
                <p className="mt-1 max-w-[720px] text-[12.5px] leading-relaxed" style={{ color: C.t1 }}>
                  A live permission check, weekly coach summary, and mistake-cost ledger built from your journal.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[8px] border" style={{ borderColor: C.b0, background: C.b0 }}>
                {[
                  ['Week P&L', formatSignedCurrency(weekly.net), weekly.net >= 0 ? C.grn : C.red],
                  ['Win rate', `${weekly.winRate}%`, C.t0],
                  ['Plan rate', weekly.planRate ? `${weekly.planRate}%` : '--', weekly.planRate >= 70 ? C.grn : C.acc],
                ].map(([label, value, color]) => (
                  <div key={label} className="px-4 py-2.5" style={{ background: C.d1 }}>
                    <p className="text-[9px] uppercase tracking-[0.12em]" style={{ color: C.t2 }}>{label}</p>
                    <p className="mt-1 text-[15px] font-semibold" style={{ color, fontFamily: C.mono }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <div className="grid gap-4 p-5 xl:grid-cols-[1.05fr_1.2fr]">
            <section style={cardStyle}>
              <div className="border-b px-4 py-3" style={{ borderColor: C.b0 }}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: C.t2 }}>Pre-trade risk gate</p>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-[8px] border" style={{ borderColor: gateCopy.color, background: `${gateCopy.color}18` }}>
                        <GateIcon size={21} color={gateCopy.color} />
                      </div>
                      <div>
                        <p className="text-[24px] font-semibold leading-none" style={{ color: gateCopy.color }}>{gateCopy.label}</p>
                        <p className="mt-1 text-[12px]" style={{ color: C.t1 }}>{gateCopy.detail}</p>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase tracking-[0.12em]" style={{ color: C.t2 }}>Today</p>
                    <p className="mt-1 text-[16px] font-semibold" style={{ color: gate.todayPnl >= 0 ? C.grn : C.red, fontFamily: C.mono }}>{formatSignedCurrency(gate.todayPnl)}</p>
                    <p className="mt-1 text-[11px]" style={{ color: C.t2 }}>{gate.todayTrades} trades</p>
                  </div>
                </div>
              </div>

              <div className="space-y-2 p-4">
                {gate.reasons.length > 0 ? gate.reasons.map(reason => (
                  <div key={`${reason.label}-${reason.detail}`} className="rounded-[7px] border px-3 py-2.5" style={{ borderColor: reason.status === 'blocked' ? 'rgba(248,113,113,0.28)' : 'rgba(245,158,11,0.28)', background: reason.status === 'blocked' ? 'rgba(248,113,113,0.07)' : 'rgba(245,158,11,0.06)' }}>
                    <div className="flex items-start gap-2">
                      <ShieldAlert size={14} color={reason.status === 'blocked' ? C.red : C.acc} style={{ marginTop: 1, flexShrink: 0 }} />
                      <div>
                        <p className="text-[12px] font-semibold" style={{ color: reason.status === 'blocked' ? C.red : C.acc }}>{reason.label}</p>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: C.t1 }}>{reason.detail}</p>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-[7px] border px-3 py-3" style={{ borderColor: 'rgba(52,211,153,0.26)', background: 'rgba(52,211,153,0.06)' }}>
                    <p className="text-[12px] font-semibold" style={{ color: C.grn }}>No active blockers</p>
                    <p className="mt-0.5 text-[11.5px]" style={{ color: C.t1 }}>Still take only trades that match the written plan.</p>
                  </div>
                )}
              </div>
            </section>

            <section style={cardStyle}>
              <div className="border-b px-4 py-3" style={{ borderColor: C.b0 }}>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: C.t2 }}>Weekly coach summary</p>
                <h2 className="mt-1 text-[15px] font-semibold">This week's execution read</h2>
              </div>
              <div className="grid gap-px border-b sm:grid-cols-4" style={{ borderColor: C.b0, background: C.b0 }}>
                {[
                  ['Trades', String(weekly.count), C.t0],
                  ['Tilt trades', String(weekly.tiltCount), weekly.tiltCount > 0 ? C.acc : C.grn],
                  ['Mistake cost', formatCurrency(weekly.mistakeRows.reduce((sum, row) => sum + row.cost, 0)), C.red],
                  ['Loss limit used', `${gate.lossPct}%`, gate.lossPct >= 80 ? C.red : gate.lossPct >= 50 ? C.acc : C.t0],
                ].map(([label, value, color]) => (
                  <div key={label} className="px-4 py-3" style={{ background: C.d2 }}>
                    <p className="text-[9px] uppercase tracking-[0.12em]" style={{ color: C.t2 }}>{label}</p>
                    <p className="mt-1 text-[15px] font-semibold" style={{ color, fontFamily: C.mono }}>{value}</p>
                  </div>
                ))}
              </div>
              <div className="space-y-3 p-4">
                {weekly.focus.map((item, index) => (
                  <div key={item} className="flex gap-3">
                    <span className="mt-0.5 w-6 shrink-0 text-[11px] font-semibold" style={{ color: C.acc, fontFamily: C.mono }}>{String(index + 1).padStart(2, '0')}</span>
                    <p className="text-[12.5px] leading-relaxed" style={{ color: C.t1 }}>{item}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="px-5 pb-6">
            <div style={cardStyle}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: C.b0 }}>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: C.t2 }}>Mistake cost tracker</p>
                  <h2 className="mt-1 text-[15px] font-semibold">What your repeat behaviors are costing</h2>
                </div>
                <p className="text-[12px]" style={{ color: C.t1 }}>
                  Costs are net negative P&L inside each behavior bucket.
                </p>
              </div>

              <div className="grid gap-px overflow-hidden" style={{ background: C.b0 }}>
                {weekly.mistakeRows.map(row => (
                  <article key={row.key} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.2fr)_140px_minmax(240px,0.9fr)]" style={{ background: C.d2 }}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <TrendingDown size={14} color={toneColor(row.tone)} />
                        <h3 className="text-[13px] font-semibold">{row.label}</h3>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: C.t1 }}>{row.description}</p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase tracking-[0.12em]" style={{ color: C.t2 }}>Cost / sample</p>
                      <p className="mt-1 text-[16px] font-semibold" style={{ color: toneColor(row.tone), fontFamily: C.mono }}>
                        {row.cost > 0 ? `-${formatCurrency(row.cost)}` : '$0'}
                      </p>
                      <p className="mt-1 text-[11px]" style={{ color: C.t2 }}>{row.trades.length} trade{row.trades.length === 1 ? '' : 's'}</p>
                    </div>
                    <div className="rounded-[6px] border px-3 py-2" style={{ borderColor: C.b0, background: C.d3 }}>
                      <div className="flex items-start gap-2">
                        <WalletCards size={13} color={C.acc} style={{ marginTop: 1, flexShrink: 0 }} />
                        <p className="text-[11.5px] leading-relaxed" style={{ color: C.t1 }}>{row.rule}</p>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
