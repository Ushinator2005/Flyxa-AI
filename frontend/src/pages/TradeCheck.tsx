import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Newspaper } from 'lucide-react';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Trade } from '../types/index.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';

type GateStatus = 'clear' | 'caution' | 'blocked';

const C = {
  bg: 'transparent',
  border: 'rgba(255,255,255,0.05)',
  text: '#e8e3dc',
  muted: 'rgba(138,129,120,0.8)',
  subtle: 'rgba(92,87,81,0.7)',
  amber: '#f59e0b',
  green: '#34d399',
  red: '#f87171',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
};

// Abbreviated emotion labels for compact display
const EMOTIONS: Array<{ full: string; short: string }> = [
  { full: 'Calm',          short: 'Clm'  },
  { full: 'Focused',       short: 'Foc'  },
  { full: 'Rushed',        short: 'Rush' },
  { full: 'FOMO',          short: 'FOMO' },
  { full: 'Revenge',       short: 'Rev'  },
  { full: 'Anxious',       short: 'Anx'  },
  { full: 'Overconfident', short: 'OC'   },
];

function todayKey() { return new Date().toISOString().slice(0, 10); }

function parseTradeDateTime(trade: Trade): Date | null {
  const rawDate = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!rawDate) return null;
  const rawTime = trade.trade_time || '00:00:00';
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${rawDate}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMoney(value: number) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function isTiltEmotion(value: string) {
  return /revenge|fomo|rushed|anxious|overconfident|angry|frustrated|tilt/i.test(value);
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
  try {
    const raw = window.localStorage.getItem('flyxa_calendar_cache_v4');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string; date?: string; time?: string; impact?: string; actual?: string }> };
    if (!Array.isArray(parsed.events)) return null;
    const today = todayKey();
    const next = parsed.events
      .filter(e => e.impact === 'high' && e.date === today && !e.actual)
      .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')))[0];
    return next?.event ? `${next.event}${next.time ? ` at ${next.time}` : ''}` : null;
  } catch { return null; }
}

type CachedNewsItem = { headline?: string; source?: string; timestamp?: string; impact?: string; isBreaking?: boolean };

function getMarketNewsRisk(): string | null {
  const readItems = (key: string): CachedNewsItem[] => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { items?: CachedNewsItem[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch { return []; }
  };
  const now = Date.now();
  const top = [...readItems('flyxa_breaking_cache_v1'), ...readItems('flyxa_news_cache_v2')]
    .filter(i => i.headline && i.timestamp)
    .filter(i => { const age = now - new Date(i.timestamp ?? '').getTime(); return Number.isFinite(age) && age <= 2 * 60 * 60 * 1000; })
    .filter(i => i.isBreaking === true || String(i.impact ?? '').toLowerCase() === 'high')
    .sort((a, b) => Number(b.isBreaking) - Number(a.isBreaking) || new Date(b.timestamp ?? '').getTime() - new Date(a.timestamp ?? '').getTime())[0];
  return top?.headline ? `${top.source ? `${top.source}: ` : ''}${top.headline}` : null;
}

function reason(status: GateStatus, label: string, detail: string) { return { status, label, detail }; }

export default function TradeCheck() {
  const { trades, loading } = useTrades();
  const { selectedAccountId, filterTradesBySelectedAccount } = useAppSettings();
  const { dailyStatus, riskLevel } = useRisk();
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);

  const [direction, setDirection] = useState<'Long' | 'Short'>('Long');
  const [riskAmount, setRiskAmount] = useState('');
  const [emotion, setEmotion] = useState('Calm');

  const scopedTrades = useMemo(() => {
    if (!selectedAccountId || selectedAccountId === ALL_ACCOUNTS_ID) return filterTradesBySelectedAccount(trades);
    return trades.filter((t) => {
      const ids = t.accountIds ?? [t.accountId, t.account_id].filter(Boolean) as string[];
      return ids.includes(selectedAccountId);
    });
  }, [filterTradesBySelectedAccount, selectedAccountId, trades]);

  const priorFlow = useMemo(
    () => getMostRecentDailyFlowBefore(scopedTrades, todayKey()),
    [scopedTrades]
  );

  const gate = useMemo(() => {
    const today = todayKey();
    const todayTrades = scopedTrades.filter(t => (t.trade_date || t.created_at?.slice(0, 10)) === today);
    const todayPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
    const todayLoss = Math.max(0, -todayPnl);
    const maxTrades = dailyStatus?.maxTradesPerDay ?? dailyStatus?.settings?.max_trades_per_day ?? 0;
    const dailyLossLimit = dailyStatus?.dailyLossLimit ?? dailyStatus?.settings?.daily_loss_limit ?? 0;
    const lossPct = dailyStatus?.lossUsedPercent ?? (dailyLossLimit > 0 ? (todayLoss / dailyLossLimit) * 100 : 0);
    const preSession = preSessionHistory[today];
    const tomorrowRule = priorFlow?.tomorrowRule;
    const losses = getConsecutiveLosses(todayTrades);
    const newsRisk = getMarketNewsRisk();
    const calRisk = getHighImpactWarning();
    const risk = Number(riskAmount);
    const reasons = [];

    if (dailyStatus?.isLocked || riskLevel === 'locked' || lossPct >= 100)
      reasons.push(reason('blocked', 'Daily loss limit hit', 'Close session for this account.'));
    else if (lossPct >= 80)
      reasons.push(reason('caution', `Loss at ${Math.round(lossPct)}%`, 'Approaching daily loss limit.'));

    if (maxTrades > 0 && todayTrades.length >= maxTrades)
      reasons.push(reason('blocked', 'Max trades reached', `${todayTrades.length}/${maxTrades} today.`));
    else if (maxTrades > 0 && todayTrades.length === maxTrades - 1)
      reasons.push(reason('caution', 'Last trade remaining', `Cap is ${maxTrades}/day.`));

    if (losses >= 2)
      reasons.push(reason('blocked', `${losses} consecutive losses`, 'Stand down.'));
    else if (losses === 1)
      reasons.push(reason('caution', 'Post-loss cooldown', 'Confirm plan before re-entry.'));

    if (isTiltEmotion(emotion))
      reasons.push(reason(emotion === 'Revenge' || emotion === 'FOMO' ? 'blocked' : 'caution', `${emotion} state`, 'Weak execution environment.'));

    if (preSession?.readiness?.status === 'Stand Down')
      reasons.push(reason('blocked', 'Stand down', preSession.readiness.summary));
    else if (preSession?.readiness?.status === 'Caution')
      reasons.push(reason('caution', 'Pre-session caution', preSession.readiness.summary));
    else if (!preSession)
      reasons.push(reason('caution', 'No pre-session brief', 'Log readiness first.'));

    if (tomorrowRule) {
      const ruleText = tomorrowRule.toLowerCase();
      if (ruleText.includes('max 2 trades') && todayTrades.length >= 2) {
        reasons.push(reason('blocked', 'Tomorrow rule', tomorrowRule));
      } else if (ruleText.includes('stop after 2 losses') && losses >= 2) {
        reasons.push(reason('blocked', 'Tomorrow rule', tomorrowRule));
      } else if (ruleText.includes('after any frustration') && isTiltEmotion(emotion)) {
        reasons.push(reason('blocked', 'Tomorrow rule', tomorrowRule));
      } else {
        reasons.push(reason('caution', 'Today rule', tomorrowRule));
      }
    }

    if (newsRisk)
      reasons.push(reason('caution', 'News risk', newsRisk));
    else if (calRisk)
      reasons.push(reason('caution', 'Calendar risk', calRisk));

    if (Number.isFinite(risk) && risk > 0 && dailyLossLimit > 0) {
      const remaining = Math.max(0, dailyLossLimit - todayLoss);
      if (risk > remaining)
        reasons.push(reason('blocked', 'Risk exceeds limit', `${formatMoney(risk)} > ${formatMoney(remaining)} left.`));
      else if (risk > remaining * 0.5)
        reasons.push(reason('caution', 'Large risk', `${formatMoney(risk)} uses >50% of remaining room.`));
    }

    const status: GateStatus = reasons.some(r => r.status === 'blocked') ? 'blocked'
      : reasons.some(r => r.status === 'caution') ? 'caution' : 'clear';
    const hasNewsRisk = newsRisk !== null || calRisk !== null;

    return { status, reasons, todayPnl, todayTrades: todayTrades.length, lossPct: Math.round(lossPct), hasNewsRisk };
  }, [dailyStatus, emotion, preSessionHistory, priorFlow, riskAmount, riskLevel, scopedTrades]);

  const sc = gate.status === 'blocked'
    ? { label: 'Blocked', color: C.red, Icon: CircleSlash }
    : gate.status === 'caution'
      ? { label: 'Caution', color: C.amber, Icon: AlertTriangle }
      : { label: 'Clear',   color: C.green, Icon: CheckCircle2 };
  const StatusIcon = sc.Icon;

  return (
    <main style={{ background: C.bg, color: C.text, fontFamily: C.sans, padding: '5px 6px', display: 'grid', gap: 5 }}>

      {/* Direction + Risk */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div>
          <p style={kicker}>Direction</p>
          <div style={{ display: 'flex', gap: 3 }}>
            {(['Long', 'Short'] as const).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                style={{
                  flex: 1, height: 22, borderRadius: 4, fontSize: 9.5, fontWeight: 600, cursor: 'pointer',
                  border: `1px solid ${direction === d ? (d === 'Long' ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)') : C.border}`,
                  background: direction === d ? (d === 'Long' ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)') : 'rgba(255,255,255,0.02)',
                  color: direction === d ? (d === 'Long' ? C.green : C.red) : C.muted,
                }}
              >{d}</button>
            ))}
          </div>
        </div>
        <div>
          <p style={kicker}>Risk $</p>
          <input
            value={riskAmount}
            onChange={e => setRiskAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Optional"
            style={{
              height: 22, width: '100%', borderRadius: 4, border: `1px solid ${C.border}`,
              background: 'rgba(255,255,255,0.03)', color: C.text, padding: '0 6px',
              fontSize: 9.5, outline: 'none', boxSizing: 'border-box', fontFamily: C.mono,
            }}
          />
        </div>
      </div>

      {/* Emotion pills */}
      <div>
        <p style={kicker}>State</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 2 }}>
          {EMOTIONS.map(({ full, short }) => {
            const active = emotion === full;
            const tilt = isTiltEmotion(full);
            return (
              <button
                key={full}
                type="button"
                title={full}
                onClick={() => setEmotion(full)}
                style={{
                  height: 20, borderRadius: 3, fontSize: 7.5, fontWeight: active ? 700 : 500,
                  cursor: 'pointer', padding: 0, overflow: 'hidden',
                  border: `1px solid ${active ? (tilt ? 'rgba(248,113,113,0.5)' : 'rgba(52,211,153,0.45)') : C.border}`,
                  background: active ? (tilt ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.08)') : 'rgba(255,255,255,0.02)',
                  color: active ? (tilt ? C.red : C.green) : C.muted,
                }}
              >{short}</button>
            );
          })}
        </div>
      </div>

      {/* Divider + news */}
      {priorFlow && (
        <div style={{ border: `1px solid ${priorFlow.biggestLeak ? 'rgba(248,113,113,0.18)' : 'rgba(52,211,153,0.16)'}`, background: priorFlow.biggestLeak ? 'rgba(248,113,113,0.035)' : 'rgba(52,211,153,0.035)', borderRadius: 4, padding: '4px 6px' }}>
          <p style={{ margin: 0, color: priorFlow.biggestLeak ? C.red : C.green, fontSize: 7.5, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800 }}>Today rule</p>
          <p style={{ margin: '2px 0 0', color: C.text, fontSize: 9, lineHeight: 1.25 }}>{priorFlow.tomorrowRule}</p>
        </div>
      )}

      {/* Divider + news */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, borderTop: `1px solid ${C.border}`, paddingTop: 5 }}>
        <Newspaper size={10} color={gate.hasNewsRisk ? C.amber : C.subtle} />
        <span style={{ fontSize: 9, color: gate.hasNewsRisk ? C.amber : C.subtle, flex: 1 }}>Market news</span>
        <span style={{ fontSize: 8.5, fontFamily: C.mono, fontWeight: 700, color: gate.hasNewsRisk ? C.amber : C.subtle, opacity: gate.hasNewsRisk ? 1 : 0.5 }}>
          {gate.hasNewsRisk ? 'RISK' : 'CLEAR'}
        </span>
      </div>

      {/* Status + stats */}
      {loading ? (
        <p style={{ margin: 0, color: C.muted, fontSize: 10 }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 24, height: 24, borderRadius: 5, display: 'grid', placeItems: 'center', border: `1px solid ${sc.color}40`, background: `${sc.color}12`, flexShrink: 0 }}>
              <StatusIcon size={13} color={sc.color} />
            </div>
            <div>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 760, lineHeight: 1, color: sc.color }}>{sc.label}</p>
            </div>
            {/* Mini stats inline */}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {[
                { v: gate.todayPnl >= 0 ? `+${formatMoney(gate.todayPnl)}` : `-${formatMoney(Math.abs(gate.todayPnl))}`, c: gate.todayPnl >= 0 ? C.green : C.red },
                { v: `${gate.todayTrades}t`, c: C.text },
                { v: `${gate.lossPct}%`, c: gate.lossPct >= 80 ? C.red : C.muted },
              ].map(({ v, c }) => (
                <span key={v} style={{ fontSize: 9, fontFamily: C.mono, fontWeight: 600, color: c }}>{v}</span>
              ))}
            </div>
          </div>

          {/* Reason cards — compact, label only */}
          {gate.reasons.length === 0 ? (
            <div style={{ border: '1px solid rgba(52,211,153,0.2)', background: 'rgba(52,211,153,0.04)', borderRadius: 4, padding: '4px 6px' }}>
              <p style={{ margin: 0, color: C.green, fontSize: 9.5, fontWeight: 700 }}>No blockers</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 3 }}>
              {gate.reasons.slice(0, 3).map(item => (
                <div
                  key={item.label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    border: `1px solid ${item.status === 'blocked' ? 'rgba(248,113,113,0.22)' : 'rgba(245,158,11,0.18)'}`,
                    background: item.status === 'blocked' ? 'rgba(248,113,113,0.05)' : 'rgba(245,158,11,0.04)',
                    borderRadius: 4, padding: '4px 7px',
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: item.status === 'blocked' ? C.red : C.amber, flexShrink: 0 }} />
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: item.status === 'blocked' ? C.red : C.amber, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.label}
                  </span>
                </div>
              ))}
              {gate.reasons.length > 3 && (
                <p style={{ margin: 0, color: C.subtle, fontSize: 8.5 }}>+{gate.reasons.length - 3} more</p>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

const kicker: React.CSSProperties = {
  margin: '0 0 3px',
  fontSize: 7.5,
  color: 'rgba(92,87,81,0.7)',
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
};
