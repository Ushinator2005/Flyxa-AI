import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import useFlyxaStore, { DEFAULT_ACCOUNT_ID } from '../store/flyxaStore.js';
import type { Account, Trade } from '../store/types.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { aiApi } from '../services/api.js';
import type { EvaluationProgress, EvaluationAgentAlert } from '../utils/evaluationCoach.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  computeMllSeries,
  inferEvaluationTemplate,
  resolveMaxDrawdown,
  tradesForAccount,
} from '../utils/evaluationCoach.js';
import { getFirmPayoutPaths, getPathById, resolveBySize, computeWithdrawableAmount } from '../data/fundedPayoutPaths.js';
import type { FundedPath } from '../data/fundedPayoutPaths.js';
import { computePayoutReadiness } from '../utils/payoutReadiness.js';
import './EvaluationCoach.css';

const money = (value: number) => (Number.isFinite(value) ? value : 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

const tradeNet = (trade: Trade) => Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);

const shortDay = (slice: string) => {
  const d = new Date(`${slice}T00:00:00`);
  return Number.isNaN(d.getTime()) ? slice : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const roundTo = (value: number, step = 25) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(step, Math.round(value / step) * step);
};

const STATUS_COLOR: Record<string, string> = {
  Blown: '#ef4444', Passed: '#22c55e', Funded: '#22c55e', Live: '#f59e0b', Eval: 'var(--cobalt)',
};

const DD_TYPE_LABEL: Record<string, string> = {
  static: 'static',
  eod_trailing: 'EOD trailing',
  intraday_trailing: 'real-time trailing',
};

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Behavioral warnings ──────────────────────────────────────────────────────

function computeBehavioralWarnings(trades: Trade[]): EvaluationAgentAlert[] {
  if (trades.length < 5) return [];
  const warnings: EvaluationAgentAlert[] = [];

  const byDate = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = t.date ?? '';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }

  const overallWins = trades.filter(t => t.pnl > 0).length;
  const overallWR = trades.length ? (overallWins / trades.length) * 100 : 0;

  // Post-loss re-entry pattern
  const postLossTrades: Trade[] = [];
  for (const dayTrades of byDate.values()) {
    const sorted = [...dayTrades].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].pnl < 0) postLossTrades.push(sorted[i]);
    }
  }
  if (postLossTrades.length >= 4) {
    const plWins = postLossTrades.filter(t => t.pnl > 0).length;
    const plWR = (plWins / postLossTrades.length) * 100;
    const drop = overallWR - plWR;
    if (plWR < overallWR - 12) {
      warnings.push({
        id: 'behavioral-post-loss',
        severity: 'warning',
        title: `Post-loss WR drops ${Math.round(drop)}% on re-entry`,
        message: `After a losing trade, your win rate falls from ${Math.round(overallWR)}% to ${Math.round(plWR)}% across ${postLossTrades.length} post-loss trades in this evaluation.`,
        action: 'Mandatory 15-min break after any loss before re-entering.',
      });
    }
  }

  // Day-of-week pattern
  const byDow = new Map<string, number[]>();
  for (const t of trades) {
    if (!t.date) continue;
    const d = new Date(`${t.date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    const dow = DOW[d.getDay()];
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow)!.push(t.pnl);
  }
  const dowEntries = [...byDow.entries()].filter(([, ps]) => ps.length >= 3);
  if (dowEntries.length >= 2) {
    const dowNet = (ps: number[]) => ps.reduce((s, p) => s + p, 0);
    const worst = dowEntries.sort((a, b) => dowNet(a[1]) - dowNet(b[1]))[0];
    const worstNet = dowNet(worst[1]);
    if (worstNet < -200) {
      warnings.push({
        id: 'behavioral-worst-dow',
        severity: 'info',
        title: `${worst[0]}s: ${money(worstNet)} net drag`,
        message: `Your ${worst[0]} sessions are the weakest in this evaluation (${worst[1].length} sessions, ${money(worstNet)} net).`,
        action: `Reduce size or skip ${worst[0]} sessions until pattern reverses.`,
      });
    }
  }

  // Overtrading signal
  const dayTradeCounts = [...byDate.entries()];
  const highDays = dayTradeCounts.filter(([, ts]) => ts.length >= 4);
  const lowDays = dayTradeCounts.filter(([, ts]) => ts.length <= 2);
  if (highDays.length >= 3 && lowDays.length >= 3) {
    const avgWR = (days: [string, Trade[]][]) => {
      const all = days.flatMap(([, ts]) => ts);
      return all.length ? (all.filter(t => t.pnl > 0).length / all.length) * 100 : 0;
    };
    const highWR = avgWR(highDays);
    const lowWR = avgWR(lowDays);
    if (lowWR > highWR + 10) {
      warnings.push({
        id: 'behavioral-overtrading',
        severity: 'warning',
        title: `4+ trade days underperform by ${Math.round(lowWR - highWR)}% WR`,
        message: `Low-volume days (≤2 trades): ${Math.round(lowWR)}% WR. High-volume days (4+ trades): ${Math.round(highWR)}% WR. Selective trading is outperforming busy days.`,
        action: 'Cap at 3 trades per session and stop early on the third loss.',
      });
    }
  }

  return warnings;
}

// (computeDayVerdict imported from evaluationCoach.ts)

// ─── Sub-components ───────────────────────────────────────────────────────────


// Equity chart shared by every account state. Both series share ONE y-scale so
// the gap between the equity line and the MLL floor chasing it — the buffer — is
// literally the shaded band between them. An eval account also gets a dashed
// profit-target line; a funded account has none. Uniform-scale SVG (no
// preserveAspectRatio="none", which distorts text and stroke widths), so labels
// can live inside the SVG.
function EquityChart({ points, floors, dates, start, target, locked, biggest }: {
  points: number[]; floors: number[]; dates: string[]; start: number; target?: number;
  locked: boolean; biggest: { date: string; pnl: number; pct: number | null };
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (points.length < 2 || points.some(v => !Number.isFinite(v))) return null;
  const W = 1000, H = 300, X0 = 74, X1 = 944, Y0 = 34, Y1 = 246;
  const floorsSafe = floors.length === points.length && floors.every(v => Number.isFinite(v))
    ? floors : points.map(() => start);
  const hasTarget = typeof target === 'number' && Number.isFinite(target);
  const endValue = points[points.length - 1] - start;

  // Symmetric-ish scale around the starting balance, so START sits mid-plot and
  // the three gridlines read +half / START / −half like a signed axis. The
  // target, when shown, is pulled into the range so it is always on-screen.
  const vHi = Math.max(...points, ...(hasTarget ? [target as number] : []));
  const vLo = Math.min(...points, ...floorsSafe);
  const half = Math.max(vHi - start, start - vLo, 1) * 1.12;
  const top = start + half, bot = start - half;
  const y = (v: number) => Y0 + ((top - v) / (top - bot)) * (Y1 - Y0);
  const x = (i: number) => X0 + (i / (points.length - 1)) * (X1 - X0);

  const eqPath = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const flPath = floorsSafe.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // Band: down the equity line, back along the floor, closed.
  const bandPath = `${eqPath} ${floorsSafe.map((_, k) => {
    const i = points.length - 1 - k;
    return `L${x(i).toFixed(1)},${y(floorsSafe[i]).toFixed(1)}`;
  }).join(' ')} Z`;

  const last = points[points.length - 1];
  const floorMax = Math.max(...floorsSafe);
  const lockIdx = locked ? floorsSafe.findIndex(v => Math.abs(v - floorMax) < 1) : -1;
  const bIdx = biggest.pnl > 0 ? dates.indexOf(biggest.date) + 1 : -1;

  const fmtDate = (slice: string) => {
    const d = new Date(`${slice}T00:00:00`);
    return Number.isNaN(d.getTime()) ? slice : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  };

  return (
    <div className="ec-fc">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Equity is ${money(endValue)} relative to the starting balance, plotted against the maximum loss limit${locked ? ', which has locked' : ' trailing behind it'}.`}>
        <defs>
          <linearGradient id="ecfcband" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--amber)" stopOpacity="0.20" />
            <stop offset="1" stopColor="var(--amber)" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        <line className="ec-fc-gl" x1={X0} y1={y(top - half * 0.02)} x2={X1} y2={y(top - half * 0.02)} />
        <line className="ec-fc-gl zero" x1={X0} y1={y(start)} x2={X1} y2={y(start)} />
        <line className="ec-fc-gl" x1={X0} y1={y(bot + half * 0.02)} x2={X1} y2={y(bot + half * 0.02)} />
        <text className="ec-fc-ax" x={X0 - 8} y={y(top - half * 0.02) + 4} textAnchor="end">+{money(half * 0.98)}</text>
        <text className="ec-fc-ax" x={X0 - 8} y={y(start) + 4} textAnchor="end">START</text>
        <text className="ec-fc-ax" x={X0 - 8} y={y(bot + half * 0.02) + 4} textAnchor="end">&minus;{money(half * 0.98)}</text>

        {hasTarget && (target as number) < top && (
          <>
            <line className="ec-fc-target" x1={X0} y1={y(target as number)} x2={X1} y2={y(target as number)} />
            <text className="ec-fc-targetlbl" x={X0 + 4} y={y(target as number) - 6} textAnchor="start">
              Target {money((target as number) - start)}
            </text>
          </>
        )}

        <path className="ec-fc-band" d={bandPath} fill="url(#ecfcband)" />
        <path className="ec-fc-floor" d={flPath} />
        <path className="ec-fc-eq" d={eqPath} />

        {bIdx >= 1 && biggest.pct !== null && (
          <>
            <line className="ec-fc-spike" x1={x(bIdx)} y1={y(points[bIdx]) + 6} x2={x(bIdx)} y2={y(start) - 4} />
            <text className="ec-fc-note" x={x(bIdx) + 12} y={y(points[bIdx]) + 30}>
              +{money(biggest.pnl)} · {biggest.pct}% of profit
            </text>
          </>
        )}
        {lockIdx >= 0 && (
          <text className="ec-fc-note lock" x={x(lockIdx) + 12} y={y(floorMax) + 16}>MLL LOCKED</text>
        )}

        {points.map((v, i) => (i < points.length - 1
          ? <circle key={i} className="ec-fc-dot" cx={x(i)} cy={y(v)} r="3.4" />
          : null))}
        <circle className="ec-fc-end" cx={x(points.length - 1)} cy={y(last)} r="4" />
        <text className="ec-fc-val" x={X1 - 6} y={y(last) - 12} textAnchor="end">{money(endValue)}</text>

        {points.map((_, i) => (
          <text key={i} className="ec-fc-ax" x={x(i)} y={Y1 + 24}
            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
            {i === 0 ? 'OPEN' : fmtDate(dates[i - 1])}
          </text>
        ))}

        {/* Invisible hit-targets: hovering a notch reveals its value. Larger
            than the visible dot so the point is easy to land on. */}
        {points.map((v, i) => (
          <circle key={`hit-${i}`} cx={x(i)} cy={y(v)} r="20" fill="transparent" style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(h => (h === i ? null : h))} />
        ))}
        {hoverIdx !== null && (() => {
          const i = hoverIdx;
          const cx = x(i), cy = y(points[i]);
          const eq = points[i] - start;
          const fl = floorsSafe[i] - start;
          const sign = (n: number) => (n > 0 ? '+' : '') + money(n);
          const boxW = 168, boxH = 54;
          const bx = Math.min(Math.max(cx - boxW / 2, X0), X1 - boxW);
          const by = Math.max(cy - boxH - 16, 4);
          return (
            <g pointerEvents="none">
              <circle className="ec-fc-hoverdot" cx={cx} cy={cy} r="5.5" />
              <rect className="ec-fc-tipbox" x={bx} y={by} width={boxW} height={boxH} rx="7" />
              <text className="ec-fc-tipdate" x={bx + 13} y={by + 18}>{i === 0 ? 'OPEN' : fmtDate(dates[i - 1])}</text>
              <text className="ec-fc-tipeq" x={bx + 13} y={by + 35}>Equity {sign(eq)}</text>
              <text className="ec-fc-tipmll" x={bx + 13} y={by + 48}>MLL {sign(fl)}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// The pass screen as a statement document: left-aligned masthead, the verdict,
// three statement rows bound to the exact stats we render, the run as a chart,
// and the trader's own words from the passing day. Built to be worth
// screenshotting. Everything is derived from the same source as the figures.
function PassScreen({ account, progress, equity, quote, onDismiss, onMarkFunded }: {
  account: Account; progress: EvaluationProgress; onDismiss: () => void; onMarkFunded: () => void;
  equity?: { points: number[]; floors: number[]; target: number; start: number; dates: string[] };
  quote?: { date: string; text: string } | null;
}) {
  // When the floor is unlocked, used + remaining equals the configured max
  // drawdown exactly, a safe base even when account.maxDrawdown is unset.
  const buffer = account.maxDrawdown || (progress.drawdownUsed + progress.drawdownRemaining) || 0;
  const pct = Math.round((progress.drawdownUsed / (buffer || 1)) * 100);
  const targetProfit = equity ? equity.target - equity.start : Number(account.profitTarget ?? 0);

  const fmtDay = (slice: string, withYear = false) => {
    const d = new Date(`${slice}T00:00:00`);
    return Number.isNaN(d.getTime()) ? slice
      : d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  };
  const dateRange = equity && equity.dates.length
    ? `${fmtDay(equity.dates[0])} to ${fmtDay(equity.dates[equity.dates.length - 1], true)}`
    : '';

  // Closest the run came to the floor (the run minimum), from the two series.
  // This is a different quantity from drawdown-used-at-the-instant (pct above).
  let closest: { date: string; gap: number } | null = null;
  if (equity && equity.floors.length === equity.points.length) {
    for (let i = 1; i < equity.points.length; i += 1) {
      const gap = equity.points[i] - equity.floors[i];
      if (Number.isFinite(gap) && (closest === null || gap < closest.gap)) {
        closest = { date: equity.dates[i - 1], gap };
      }
    }
  }

  const claim = `You cleared the ${money(targetProfit)} target in ${progress.tradingDays} trading day${progress.tradingDays !== 1 ? 's' : ''} and finished with your ${money(buffer)} buffer ${pct === 0 ? 'fully intact' : `${pct}% used`}.`;

  return (
    <div className="ec-pd" data-tour-id="evaluation-overview">
      <div className="ec-pd-doc">
        <div className="ec-pd-mast">
          <span className="ec-pd-brand"><img src="/logo.svg" alt="" /><b>Flyxa</b></span>
          <span className="ec-pd-ref">{[account.firm, account.size ? money(account.size) : null].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="ec-pd-rule" />

        <div className="ec-pd-lede">
          <div className="ec-pd-kick">Evaluation complete</div>
          <h1 className="ec-pd-title">Passed.</h1>
          <p className="ec-pd-who">{account.name}{dateRange ? ` · ${dateRange}` : ''}</p>
          <p className="ec-pd-claim">{claim}</p>
        </div>
        <div className="ec-pd-rule" />

        <div className="ec-pd-stmt">
          <div className="ec-pd-row"><span className="ec-pd-k">Net profit</span><span className="ec-pd-rref">Target {money(targetProfit)}</span><span className="ec-pd-v g">{money(progress.netPnl)}</span></div>
          <div className="ec-pd-row"><span className="ec-pd-k">Trading days</span><span className="ec-pd-rref">Minimum {progress.minimumTradingDays}</span><span className="ec-pd-v">{progress.tradingDays}</span></div>
          <div className="ec-pd-row"><span className="ec-pd-k">Drawdown used</span><span className="ec-pd-rref">Of a {money(buffer)} buffer</span><span className="ec-pd-v">{pct}%</span></div>
        </div>
        <div className="ec-pd-rule" />

        {equity && equity.points.length >= 2 && (
          <>
            <div className="ec-pd-runhd"><span className="ec-pd-lbl">The run</span><span className="ec-pd-ok">Target cleared</span></div>
            <EquityChart points={equity.points} floors={equity.floors} dates={equity.dates} start={equity.start} target={equity.target} locked={progress.floorLocked} biggest={{ date: '', pnl: 0, pct: null }} />
            {closest && closest.gap > 0 && (
              <p className="ec-pd-cap">The run came closest to the floor on {fmtDay(closest.date)}, with <b>{money(closest.gap)}</b> still in hand.</p>
            )}
            <div className="ec-pd-rule" />
          </>
        )}

        {quote && quote.text && (
          <>
            <div className="ec-pd-words">
              <time>{fmtDay(quote.date).toUpperCase()}</time>
              <q>{quote.text}</q>
            </div>
            <div className="ec-pd-rule" />
          </>
        )}

        <div className="ec-pd-act">
          <button type="button" className="ec-pd-cta" onClick={onMarkFunded}>Move to funded account</button>
          <button type="button" className="ec-pd-stay" onClick={onDismiss}>Stay on this view</button>
        </div>
        <p className="ec-pd-note">Verify the result in your firm's dashboard before requesting a funded account.</p>
      </div>
    </div>
  );
}

function EmptyEvaluation() {
  return (
    <div className="ec-empty" data-tour-id="evaluation-overview">
      <ShieldCheck size={30} />
      <h2>No evaluation account found</h2>
      <p>Add an account with its type or phase set to evaluation. Flyxa will monitor its rules and progress.</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EvaluationCoach() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accounts = useFlyxaStore(state => state.accounts);
  const entries = useFlyxaStore(state => state.entries);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const updateAccount = useFlyxaStore(state => state.updateAccount);
  const { accounts: tradingAccounts, decorateTrades, selectedAccountId: appSelectedId, preferences, updateAccount: updateTradingAccount } = useAppSettings();

  // Funded payout-path choice, kept in a keyed store map (not on the account
  // object, which AppSettings rebuilds on every hydrate and would wipe).
  const payoutPaths = useFlyxaStore(state => state.payoutPaths);
  const setPayoutPath = useFlyxaStore(state => state.setPayoutPathFor);

  const statusById = useMemo(
    () => new Map(tradingAccounts.map(ta => [ta.id, ta.status])),
    [tradingAccounts],
  );

  const EVAL_STATUSES = new Set(['Eval', 'Passed', 'Blown', 'Funded', 'Live']);
  const evaluationAccounts = useMemo(
    () => accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && (EVAL_STATUSES.has(statusById.get(a.id) ?? '') || a.type === 'eval' || a.phase === 'eval')),
    [accounts, statusById],
  );

  const latestEntryDateForAccount = useCallback((accountId: string): string => {
    let latest = '';
    for (const entry of entries) {
      const accs = entry.accountIds?.length ? entry.accountIds : (entry.account ? [entry.account] : []);
      if (accs.includes(accountId) && entry.date > latest) latest = entry.date;
    }
    return latest;
  }, [entries]);

  const pickDefaultEvalAccount = useCallback(() => {
    const explicit = evaluationAccounts.find(a => a.id === appSelectedId)
      ?? evaluationAccounts.find(a => a.id === activeAccountId);
    if (explicit) return explicit;
    const sorted = [...evaluationAccounts].sort((a, b) => {
      const blownA = statusById.get(a.id) === 'Blown' ? 1 : 0;
      const blownB = statusById.get(b.id) === 'Blown' ? 1 : 0;
      if (blownA !== blownB) return blownA - blownB;
      return latestEntryDateForAccount(b.id).localeCompare(latestEntryDateForAccount(a.id));
    });
    return sorted[0] ?? null;
  }, [evaluationAccounts, appSelectedId, activeAccountId, statusById, latestEntryDateForAccount]);

  const [selectedId, setSelectedId] = useState(() => {
    const fromParam = searchParams.get('account');
    if (fromParam) return fromParam;
    return pickDefaultEvalAccount()?.id ?? '';
  });
  useEffect(() => {
    if (selectedId && evaluationAccounts.find(a => a.id === selectedId)) return;
    const preferred = pickDefaultEvalAccount();
    if (preferred) setSelectedId(preferred.id);
  }, [evaluationAccounts, pickDefaultEvalAccount]);

  const [dismissPass, setDismissPass] = useState(false);
  const [acctDropOpen, setAcctDropOpen] = useState(false);

  // Coaching state
  const [missionText, setMissionText] = useState('');
  const [missionLoading, setMissionLoading] = useState(false);
  const [missionLoadedFor, setMissionLoadedFor] = useState('');
  const [debriefWhat, setDebriefWhat] = useState('');
  const [debriefStatus, setDebriefStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debriefEditedRef = useRef(false);

  const acctDropRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOut = (e: MouseEvent) => {
      if (acctDropRef.current && !acctDropRef.current.contains(e.target as Node)) setAcctDropOpen(false);
    };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  const allTrades = useMemo(
    () => decorateTrades(entries.flatMap(e => e.trades)),
    [entries, decorateTrades],
  );

  const selected = evaluationAccounts.find(a => a.id === selectedId) ?? evaluationAccounts[0];

  const progress = useMemo(
    () => selected ? computeEvaluationProgress(selected, allTrades) : null,
    [allTrades, selected],
  );

  // MLL per trading day — plotted under the equity path so the rising floor
  // is visible, not just its current value.
  const mllSeries = useMemo(
    () => selected ? computeMllSeries(selected, allTrades) : [],
    [allTrades, selected],
  );

  const alerts = useMemo(
    () => selected && progress ? buildEvaluationAgentAlerts(selected, allTrades, progress, preferences.sessionTimes) : [],
    [allTrades, progress, selected, preferences.sessionTimes],
  );

  const accountTrades = useMemo(
    () => selected ? tradesForAccount(allTrades, selected.id) : [],
    [allTrades, selected],
  );

  // ── Day map (used in multiple places) ──────────────────────────
  const byDayMap = useMemo(() => {
    const m = new Map<string, number>();
    accountTrades.forEach(t => m.set(t.date, (m.get(t.date) ?? 0) + Number(t.pnl ?? 0) - Number(t.commission ?? 0)));
    return m;
  }, [accountTrades]);

  const dayDates = useMemo(() => [...byDayMap.keys()].sort().reverse(), [byDayMap]);

  const comparisons = useMemo(
    () => evaluationAccounts.map(a => ({
      account: a,
      progress: computeEvaluationProgress(a, allTrades),
      status: statusById.get(a.id) ?? 'Eval',
    })).sort((a, b) => {
      const order: Record<string, number> = { Eval: 0, Passed: 1, Blown: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    }),
    [allTrades, evaluationAccounts, statusById],
  );

  // ── Auto-blow on MLL breach ─────────────────────────────────────
  // A prop firm fails the account the moment its balance drops to or below the
  // Maximum Loss Limit, so reflect that here without manual action. Guarded on
  // drawdownUsed > 0 so a misconfigured account (no real MLL) never trips it.
  // Trades stay linked to the blown account. Self-terminating: once the status
  // is Blown the condition no longer matches.
  useEffect(() => {
    for (const { account, progress: p, status } of comparisons) {
      if (status === 'Eval' && p.drawdownUsed > 0 && p.drawdownRemaining <= 0) {
        updateTradingAccount(account.id, { status: 'Blown' });
      }
    }
  }, [comparisons, updateTradingAccount]);

  // ── Auto-fund on pass ───────────────────────────────────────────
  // When an eval account meets its pass criteria, move it to funded in place:
  // status Funded, balance re-based to 0 (funded profit tracks from zero), and
  // the eval's MLL dollar amount carried onto the account so the drawdown stays
  // the same. Guarded on the store phase so it can't loop while the status model
  // catches up; self-terminating once the account is funded.
  useEffect(() => {
    for (const { account, progress: p, status } of comparisons) {
      if (status === 'Eval' && account.phase !== 'funded' && p.status === 'passed') {
        const mll = resolveMaxDrawdown(account, inferEvaluationTemplate(account));
        updateAccount(account.id, { phase: 'funded', type: 'live', startingBalance: 0, maxDrawdown: mll });
        updateTradingAccount(account.id, { status: 'Funded' });
      }
    }
  }, [comparisons, updateAccount, updateTradingAccount]);

  // ── Behavioral warnings ─────────────────────────────────────────
  const behavioralWarnings = useMemo(() => computeBehavioralWarnings(accountTrades), [accountTrades]);

  // Recent journal post-sessions for this account. MUST live above the early
  // returns — a hook after a conditional return changes the hook count when a
  // passed account renders the PassScreen, and React throws.
  const recentJournalReflections = useMemo(() => {
    const accountId = selected?.id;
    if (!accountId) return [] as Array<{ date: string; post: string }>;
    return entries
      .filter(e => {
        const accs = e.accountIds?.length ? e.accountIds : (e.account ? [e.account] : []);
        return accs.includes(accountId) && Boolean(e.dailyReflection?.post?.trim());
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map(e => ({ date: e.date, post: (e.dailyReflection?.post ?? '').trim() }));
  }, [entries, selected?.id]);

  // ── Load debrief from saved account notes ───────────────────────
  useEffect(() => {
    debriefEditedRef.current = false;
    setDebriefStatus('idle');
    if (!selected?.coachingNotes) {
      setDebriefWhat('');
      return;
    }
    try {
      const saved = JSON.parse(selected.coachingNotes) as { what?: string; different?: string };
      setDebriefWhat(saved.what ?? '');
    } catch {
      setDebriefWhat('');
    }
  }, [selected?.id]);

  // ── Auto-save debrief ────────────────────────────────────────────
  useEffect(() => {
    if (!debriefEditedRef.current) return;
    setDebriefStatus('saving');
    const accountId = selectedId;
    const timer = setTimeout(() => {
      updateAccount(accountId, {
        coachingNotes: JSON.stringify({ what: debriefWhat, savedAt: new Date().toISOString() }),
      });
      debriefEditedRef.current = false;
      setDebriefStatus('saved');
      setTimeout(() => setDebriefStatus('idle'), 2000);
    }, 1500);
    return () => clearTimeout(timer);
  }, [debriefWhat, selectedId]);

  // ── Funded payout path: prompt on funding ────────────────────────
  // When an account is funded, it needs a payout path. Single-path firms (e.g.
  // Take Profit Trader) are auto-set silently; multi-path firms open a chooser
  // so the readiness view reflects the trader's actual funded plan, not a guess.
  // Hooks must precede the early returns below, so this reads status directly.
  const [pathModalOpen, setPathModalOpen] = useState(false);
  useEffect(() => {
    if (!selected) return;
    const st = statusById.get(selected.id) ?? 'Eval';
    const funded = st === 'Funded' || st === 'Live';
    if (!funded) { setPathModalOpen(false); return; }
    const fp = getFirmPayoutPaths(selected.firm);
    if (!fp) return;
    // Single-path firms have nothing to choose, so set it silently. Multi-path
    // firms are NOT auto-prompted: the choice is a one-time setup the trader
    // makes from the readiness card's controls (tabs / "change"), never a modal
    // that reappears on every visit.
    if (fp.paths.length === 1 && payoutPaths[selected.id] !== fp.paths[0].id) {
      setPayoutPath(selected.id, fp.paths[0].id);
    }
  }, [selected?.id, selected?.firm, statusById, setPayoutPath, payoutPaths]);

  if (!selected || !progress) return <EmptyEvaluation />;

  const currentStatus = statusById.get(selected.id) ?? 'Eval';
  const isFunded = currentStatus === 'Funded' || currentStatus === 'Live';

  // Funded accounts don't "pass" again; they chase payouts, so skip the eval
  // pass screen and reframe the view below.
  if (progress.status === 'passed' && !dismissPass && !isFunded) {
    // Rebuild the equity run here — the main-view series below is computed
    // after this early return.
    const passStart = Number(selected.size) > 0
      ? Number(selected.size)
      : progress.currentBalance - progress.netPnl;
    const passDates = [...byDayMap.keys()].sort();
    let passBal = passStart;
    const passPoints = [passBal];
    for (const d of passDates) { passBal += Number(byDayMap.get(d) ?? 0); passPoints.push(passBal); }
    const passTarget = passStart + Number(selected.profitTarget ?? inferEvaluationTemplate(selected).profitTarget);
    // The trader's own words from the passing day, if journaled (else the most
    // recent reflection). Dropped entirely when there is none, never faked.
    const passLastDate = passDates[passDates.length - 1];
    const passQuoteSrc = recentJournalReflections.find(r => r.date === passLastDate) ?? recentJournalReflections[0] ?? null;
    return (
      <PassScreen
        account={selected} progress={progress}
        equity={{ points: passPoints, floors: mllSeries, target: passTarget, start: passStart, dates: passDates }}
        quote={passQuoteSrc ? { date: passQuoteSrc.date, text: passQuoteSrc.post } : null}
        onDismiss={() => setDismissPass(true)}
        onMarkFunded={() => { updateAccount(selected.id, { phase: 'funded', type: 'live' }); setDismissPass(true); }}
      />
    );
  }

  const activeTemplate = inferEvaluationTemplate(selected);
  const target = selected.profitTarget ?? activeTemplate.profitTarget;
  // Funded accounts have no profit target to pass; only show one if the user
  // explicitly set a payout goal on the account.
  const showTarget = !isFunded || (selected.profitTarget != null && Number(selected.profitTarget) > 0);
  const maxDrawdown = resolveMaxDrawdown(selected, activeTemplate);
  const dailyLimit = selected.dailyLossLimit || activeTemplate.dailyLossLimit;

  const selStatus = currentStatus;
  const triggerColor = STATUS_COLOR[selStatus] ?? 'var(--txt-3)';
  const dropEval   = comparisons.filter(c => c.status === 'Eval');
  const dropFunded = comparisons.filter(c => c.status === 'Funded' || c.status === 'Live');
  const dropPassed = comparisons.filter(c => c.status === 'Passed');
  const dropBlown  = comparisons.filter(c => c.status === 'Blown');

  const ddTypeLabel = DD_TYPE_LABEL[progress.drawdownType] ?? progress.drawdownType;
  const firmMeta = [
    selected.firm,
    selected.size ? money(selected.size) : null,
    `${ddTypeLabel} MLL`,
  ].filter(Boolean).join(' · ');

  // ── Metric computations ─────────────────────────────────────────
  const targetProgressPct = Math.min(100, Math.round(progress.targetProgressPct));
  const drawdownRemainingPct = maxDrawdown > 0 ? Math.min(100, Math.round((progress.drawdownRemaining / maxDrawdown) * 100)) : 0;
  const drawdownUsedPct = 100 - drawdownRemainingPct;
  const dailyRemaining = dailyLimit > 0 ? Math.max(0, progress.dailyLossRemaining) : null;
  const dailyRemainingPct = dailyLimit > 0 ? Math.min(100, Math.round((Math.max(0, progress.dailyLossRemaining) / dailyLimit) * 100)) : 0;
  const dailyUsedPct = 100 - dailyRemainingPct;
  const daysMet = progress.tradingDays >= progress.minimumTradingDays;

  // ── Pass probability ────────────────────────────────────────────
  const probLabel = progress.passProbability >= 65 ? 'Strong path' : progress.passProbability >= 40 ? 'Recoverable' : 'High risk';
  const probColor = progress.passProbability >= 65 ? 'var(--green)' : progress.passProbability >= 40 ? 'var(--amber)' : 'var(--red)';

  // ── Equity path (hero chart) ────────────────────────────────────
  // Derive the baseline from progress (currentBalance − netPnl = the exact
  // starting balance) so the equity line shares the MLL series' anchor —
  // using account.size here desyncs the chart whenever size ≠ startingBalance.
  const startBalance = progress.currentBalance - progress.netPnl;
  const equityDates = [...byDayMap.keys()].sort();
  const equityPoints = (() => {
    let bal = startBalance;
    const pts = [bal];
    for (const d of equityDates) { bal += Number(byDayMap.get(d) ?? 0); pts.push(bal); }
    return pts;
  })();
  const targetBalance = startBalance + Number(target);

  // ── Funded payout view (path-driven, real firm rules only) ──────
  // Payouts reset the cycle: taking a withdrawal draws the balance down and
  // restarts the winning-days / net-profit gates. Everything below is net of
  // payouts already taken, and the readiness gates count only the current cycle
  // (days after the last payout).
  const payouts = selected.payouts ?? [];
  const totalPayouts = payouts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const lastPayoutDate = payouts.reduce((m, p) => (p.date > m ? p.date : m), '');
  const balanceAfterPayouts = progress.currentBalance - totalPayouts;
  const drawdownRemainingNet = Math.max(0, progress.drawdownRemaining - totalPayouts);
  // Withdrawable = profit above the starting balance, minus payouts already taken.
  const withdrawable = Math.max(0, progress.currentBalance - startBalance - totalPayouts);
  const cycleEntries = [...byDayMap.entries()].filter(([date]) => !lastPayoutDate || date > lastPayoutDate);
  const cycleDayPnls = cycleEntries.map(([, pnl]) => pnl);
  const cycleProfit = cycleDayPnls.reduce((s, p) => s + p, 0);
  const cycleBiggestDay = cycleDayPnls.reduce((m, p) => Math.max(m, p), 0);
  const cycleConsistencyPct = cycleProfit > 0 ? Math.round((cycleBiggestDay / cycleProfit) * 100) : null;
  // Biggest single profitable day (whole history): what the pace copy references.
  const biggestDay = [...byDayMap.entries()].reduce<{ date: string; pnl: number }>(
    (best, [date, pnl]) => (pnl > best.pnl ? { date, pnl } : best),
    { date: '', pnl: 0 },
  );

  // The firm's funded payout paths and the trader's chosen one. Single-path
  // firms fall back to their only path; multi-path firms use the stored choice
  // (the effect above ensures one is set once the account is funded).
  const firmPayout = getFirmPayoutPaths(selected.firm);
  const availablePaths: FundedPath[] = firmPayout?.paths ?? [];
  const chosenPath = getPathById(selected.firm, payoutPaths[selected.id])
    ?? (availablePaths.length === 1 ? availablePaths[0] : null);

  // Readiness is scoped to the current payout cycle: winning days and net profit
  // reset after each withdrawal, so a fresh payout starts the count over.
  const payoutReadiness = isFunded && chosenPath
    ? computePayoutReadiness(chosenPath, {
        dayPnls: cycleDayPnls,
        tradingDays: cycleEntries.length,
        withdrawable,
        cycleProfit,
        drawdownRemaining: drawdownRemainingNet,
        size: Number(selected.size) || 0,
        consistencyActualPct: cycleConsistencyPct,
      })
    : null;

  const payoutReady = payoutReadiness ? payoutReadiness.payoutReady : false;
  // What the trader can actually take THIS payout: the split (e.g. 50% of profit)
  // capped at the per-payout maximum, and $0 until every gate is met.
  const withdrawableAmount = chosenPath
    ? computeWithdrawableAmount(chosenPath, { cycleProfit, size: Number(selected.size) || 0, ready: payoutReady })
    : 0;
  const heroPct = isFunded ? (payoutReadiness?.readyPct ?? 0) : progress.passProbability;
  const heroColor = heroPct >= 65 ? 'var(--green)' : heroPct >= 40 ? 'var(--amber)' : 'var(--red)';

  // Consistency profit gap (only when the chosen path has a consistency rule and
  // it is currently unmet): profit needed for the biggest day to fall under the
  // cap. biggestDay / cap% is the total profit at which that day equals the cap.
  const consistencyCap = chosenPath?.consistencyPct ?? null;
  const consistencyRow = payoutReadiness?.rows.find(r => r.key === 'consistency');
  const consistencyGap = consistencyCap && consistencyRow && !consistencyRow.met && progress.consistencyPct
    ? Math.max(0, Math.round(biggestDay.pnl / (consistencyCap / 100)) - withdrawable)
    : 0;

  // Verdict names the one requirement blocking the payout on the chosen path.
  const fundedVerdict = !chosenPath
    ? 'Choose your payout path'
    : payoutReady
      ? 'Payout ready'
      : payoutReadiness?.blocking
        ? `Blocked on ${payoutReadiness.blocking.toLowerCase()}`
        : 'Building toward payout';
  const heroLabel = isFunded ? fundedVerdict : probLabel;

  // ── Pace ────────────────────────────────────────────────────────
  const avgDailyPnl = progress.tradingDays > 0 ? progress.netPnl / progress.tradingDays : 0;
  const daysToTarget = avgDailyPnl > 0 && progress.targetRemaining > 0 ? Math.ceil(progress.targetRemaining / avgDailyPnl) : null;
  const sessionsLeft = avgDailyPnl > 0 && progress.targetRemaining > 0 ? daysToTarget : null;
  const paceNegative = progress.tradingDays > 0 && avgDailyPnl < 0;
  const s = (n: number) => n !== 1 ? 's' : '';

  // ── Path-to-pass context ───────────────────────────────────────
  const allAlerts = [...alerts, ...behavioralWarnings];
  // Resolved checklist row: the leaks card reads as a checklist, not a lone
  // warning, when the daily budget is actually being respected.
  const dailyRespectSessions = dailyLimit > 0 ? [...byDayMap.values()].filter(pnl => pnl > -dailyLimit).length : 0;
  const dailyOkRow = dailyLimit > 0 && byDayMap.size > 0 && dailyRespectSessions === byDayMap.size && !allAlerts.some(a => /daily/i.test(a.title))
    ? `${dailyRespectSessions} of ${byDayMap.size} session${byDayMap.size !== 1 ? 's' : ''} closed inside the ${money(dailyLimit)} daily budget.`
    : null;
  const remainingMinDays = Math.max(0, progress.minimumTradingDays - progress.tradingDays);
  const paceHeadline = progress.targetRemaining <= 0
    ? 'Target reached'
    : sessionsLeft !== null
      ? `~${sessionsLeft} session${s(sessionsLeft)}`
      : money(progress.targetRemaining);
  const paceDetail = progress.targetRemaining <= 0
    ? remainingMinDays > 0
      ? `${remainingMinDays} minimum trading day${s(remainingMinDays)} still required.`
      : 'Profit target and minimum days are complete.'
    : sessionsLeft !== null
      ? `Based on your current ${money(avgDailyPnl)}/session average.`
      : `Current average is ${money(avgDailyPnl)}/session, so there is no reliable pass pace yet.`;
  const avgLossAbs = (() => {
    const losses = accountTrades.filter(trade => tradeNet(trade) < 0);
    return losses.length ? Math.abs(losses.reduce((sum, trade) => sum + tradeNet(trade), 0) / losses.length) : 0;
  })();
  // Hold-time asymmetry feeds the AI directive — only from known durations.
  const { avgWinHoldMin, avgLossHoldMin } = (() => {
    const holdOf = (trade: Trade): number | null => {
      if (typeof trade.duration === 'number' && trade.duration > 0) return trade.duration;
      if (typeof trade.durationMinutes === 'number' && trade.durationMinutes > 0) return trade.durationMinutes;
      return null;
    };
    const average = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
    return {
      avgWinHoldMin: average(accountTrades.filter(t => tradeNet(t) > 0).map(holdOf).filter((v): v is number => v !== null)),
      avgLossHoldMin: average(accountTrades.filter(t => tradeNet(t) < 0).map(holdOf).filter((v): v is number => v !== null)),
    };
  })();
  const riskFromDaily = dailyLimit > 0
    ? Math.max(0, Math.min(dailyRemaining ?? dailyLimit, dailyLimit * (drawdownRemainingPct < 40 ? 0.2 : 0.3)))
    : Infinity;
  const riskFromBuffer = progress.drawdownRemaining * (drawdownRemainingPct < 40 ? 0.1 : 0.15);
  const suggestedRiskCap = roundTo(Math.min(
    riskFromDaily,
    riskFromBuffer,
    avgLossAbs > 0 ? avgLossAbs : Math.max(100, dailyLimit > 0 ? dailyLimit * 0.25 : riskFromBuffer),
  ));
  const planLogged = accountTrades.filter(trade => typeof trade.reflection?.followedPlan === 'boolean');
  const planAdherencePct = planLogged.length
    ? Math.round((planLogged.filter(trade => trade.reflection?.followedPlan === true).length / planLogged.length) * 100)
    : null;
  // ── Probability drivers ────────────────────────────────────────
  const probabilityDrivers = [
    ...(showTarget ? [{ label: 'Target progress', value: progress.probabilityFactors.targetScore }] : []),
    { label: 'Buffer health', value: progress.probabilityFactors.survivalScore },
    { label: 'Recent win rate', value: progress.probabilityFactors.recentWinRate },
    { label: 'Green days', value: progress.probabilityFactors.dayQuality },
  ];
  const weakestDriver = [...probabilityDrivers].sort((a, b) => a.value - b.value)[0];
  const primaryLeak = allAlerts[0]?.title
    ?? (planAdherencePct !== null && planAdherencePct < 70 ? 'Plan adherence is holding back probability' : weakestDriver?.label);

  // ── AI mission (loaded async) ───────────────────────────────────
  const missionCacheKey = `${selected.id}-${new Date().toISOString().slice(0, 10)}-${progress.tradingDays}`;

  // Fallback static insight text (shown while mission loads or on error)
  const insightFallback = (() => {
    if (progress.tradingDays === 0) return 'No trades recorded yet. Add your first session to see coaching insights.';
    if (paceNegative && drawdownRemainingPct <= 30) {
      return `Buffer critical at ${drawdownRemainingPct}%. At current pace, the evaluation expires before target. Reduce risk to preserve the remaining buffer.`;
    }
    if (daysToTarget !== null) {
      return `Averaging ${money(avgDailyPnl)}/session. At this pace, approximately ${daysToTarget} more session${s(daysToTarget)} to reach the ${money(target)} target.`;
    }
    return `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${s(progress.tradingDays)}. ${money(progress.targetRemaining)} still needed.`;
  })();

  // ── Alert bar ───────────────────────────────────────────────────

  // ── All alerts (risk + behavioral) ─────────────────────────────
  function DropRow({ account }: { account: Account }) {
    const isSelected = account.id === selected.id;
    const st = statusById.get(account.id) ?? 'Eval';
    const col = STATUS_COLOR[st] ?? 'var(--txt-3)';
    return (
      <button type="button"
        className={`ec-acct-row${isSelected ? ' selected' : ''}${st === 'Blown' ? ' blown' : ''}`}
        onClick={() => { setSelectedId(account.id); setAcctDropOpen(false); }}
      >
        <div className="ec-acct-row-info">
          <strong>{account.name}</strong>
          {account.firm && <small>{account.firm}</small>}
        </div>
        <span className="ec-acct-pill" style={{ color: col, background: col + '18', borderColor: col + '40' }}>{st}</span>
      </button>
    );
  }

  // ── AI mission load ─────────────────────────────────────────────
  // Placed after early returns so it only fires when the page renders
  function loadMission() {
    // The early return above guarantees progress, but TS cannot narrow a
    // captured variable inside a nested function — re-check locally.
    if (!progress) return;
    if (missionLoadedFor === missionCacheKey || missionLoading) return;
    if (progress.tradingDays === 0) {
      setMissionText('');
      setMissionLoadedFor(missionCacheKey);
      return;
    }
    const last3 = dayDates.slice(0, 3).map(d => money(byDayMap.get(d) ?? 0)).join(', ');

    // Build coaching context from saved debrief notes + journal post-sessions
    const debriefNote = selected.coachingNotes ? (() => {
      try {
        const saved = JSON.parse(selected.coachingNotes!) as { what?: string; different?: string };
        return saved.what || saved.different
          ? `Coach note, What happened: "${saved.what}". Will improve: "${saved.different}".`
          : '';
      } catch { return ''; }
    })() : '';

    const journalContext = recentJournalReflections.length
      ? `Recent journal post-sessions:\n${recentJournalReflections.map(r => `${r.date}: "${r.post}"`).join('\n')}`
      : '';

    const prompt = `You are Flyxa's evaluation coaching system. Give this trader ONE pass-focused directive for the next session.

Account: ${selected.name} (${selected.firm})
Eval status: ${progress.status}, ${drawdownRemainingPct}% drawdown buffer remaining, ${targetProgressPct}% profit progress
MLL: balance must stay above ${money(progress.drawdownFloor)} (${ddTypeLabel}${progress.floorLocked ? ', locked' : progress.trailingStopsAt !== null ? `, locks at ${money(progress.trailingStopsAt)}` : ''})
${progress.consistencyLimitPct !== null && progress.consistencyPct !== null ? `Consistency: biggest day is ${progress.consistencyPct}% of profit (firm limit ${progress.consistencyLimitPct}%)${progress.consistencyPct > progress.consistencyLimitPct ? ', NOT met, needs steadier days' : ''}` : ''}
Sessions traded: ${progress.tradingDays} | Avg P&L/session: ${money(avgDailyPnl)} | Pass probability: ${progress.passProbability}%
Pace to target: ${paceHeadline} | ${paceDetail}
Suggested risk cap: ${suggestedRiskCap > 0 ? money(suggestedRiskCap) : 'stand down'} | Plan adherence: ${planAdherencePct !== null ? `${planAdherencePct}%` : 'not enough tagged data'}
${avgWinHoldMin > 0 && avgLossHoldMin > 0 ? `Hold time: winners avg ${Math.round(avgWinHoldMin)}m, losers ${Math.round(avgLossHoldMin)}m${avgLossHoldMin > avgWinHoldMin * 1.5 ? ', losers held too long' : ''}` : ''}
Main leak: ${primaryLeak ?? 'none detected'}
Last 3 sessions: ${last3 || 'none yet'}
${behavioralWarnings.length ? `Behavioral patterns: ${behavioralWarnings.map(w => w.title).join('; ')}` : ''}
${journalContext}
${debriefNote}

Write exactly ONE coaching directive sentence. Optimize for passing the evaluation without violating drawdown or daily loss rules. Start with an action verb (Focus on..., Limit entries to..., Avoid..., Cut size to..., Target..., etc.). Be specific to this account's current numbers. No greeting, no explanation, just the directive.`;

    setMissionLoading(true);
    aiApi.flyxaChat(prompt, [])
      .then(({ reply }) => {
        setMissionText(reply.trim());
        setMissionLoadedFor(missionCacheKey);
      })
      .catch(() => {
        setMissionText('');
        setMissionLoadedFor(missionCacheKey);
      })
      .finally(() => setMissionLoading(false));
  }

  // Call mission load on render (idempotent due to key check)
  if (missionLoadedFor !== missionCacheKey && !missionLoading && progress.tradingDays > 0) {
    loadMission();
  }

  const missionDisplay = missionLoading
    ? 'Loading today\'s directive…'
    : (missionText || insightFallback);

  return (
    <div className="ec-page" data-tour-id="evaluation-overview">

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="ec-body">

        {/* ── Page header: account + vitals in one meta row ──────────── */}
        <div className="ec-evhd">
          <div>
            <div ref={acctDropRef} className="ec-acct-drop">
              <button type="button" className="ec-acct-trigger ec-acct-trigger--h1" onClick={() => setAcctDropOpen(o => !o)}>
                <span className="ec-acct-dot" style={{ background: triggerColor }} />
                <span className="ec-acct-trigger-name">{selected.name}</span>
                <ChevronDown size={13} />
              </button>
              {acctDropOpen && (
                <div className="ec-acct-menu">
                  {dropEval.map(({ account }) => <DropRow key={account.id} account={account} />)}
                  {dropFunded.length > 0 && (<><div className="ec-acct-sep">Funded</div>{dropFunded.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                  {dropPassed.length > 0 && (<><div className="ec-acct-sep">Passed</div>{dropPassed.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                  {dropBlown.length > 0 && (<><div className="ec-acct-sep">Blown</div>{dropBlown.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                </div>
              )}
            </div>
            <div className="ec-evhd-meta">
              {firmMeta && <><span>{firmMeta}</span><em>·</em></>}
              <span>Balance <i>{money(isFunded ? balanceAfterPayouts : progress.currentBalance)}</i></span>
              <em>·</em>
              {showTarget && (<><span>Target <i>{money(targetBalance)}</i></span><em>·</em></>)}
              <span className="ec-evhd-mll" title={progress.floorLocked
                ? 'The MLL has stopped trailing. The account is closed if balance touches this.'
                : `${ddTypeLabel} MLL. The account is closed if balance touches this.`}
              >
                MLL <i>{money(progress.drawdownFloor)}{progress.floorLocked ? ' locked' : ''}</i>
              </span>
              <em>·</em>
              <span>Day {progress.tradingDays}</span>
            </div>
          </div>
          <span className="ec-phase" style={{ ['--phase-dot' as never]: probColor, color: probColor }}>
            {paceNegative ? 'AT RISK' : 'ON TRACK'}
          </span>
        </div>

        {/* ── Hero: pass probability + drivers | equity path ─────────── */}
        <div className="ec-hero">
          <div className="ec-prob">
            <span className="ec-metric-lbl ec-section-lbl">{isFunded ? 'Payout readiness' : 'Pass probability'}</span>
            <div className="ec-prob-big" style={{ color: heroColor }}>
              <b>{heroPct}</b><span>%</span>
            </div>
            <span className="ec-prob-verdict" style={{ color: heroColor }}>{heroLabel}</span>
            <div className="ec-prob-bar"><i style={{ width: `${heroPct}%`, background: heroColor }} /></div>
            {isFunded ? (
              <>
                {/* Path switcher: Topstep-style firms switch per cycle inline;
                    others show the chosen plan with a "change" affordance. */}
                {availablePaths.length > 1 && (
                  firmPayout?.switchablePerCycle ? (
                    <div className="ec-pr-tabs">
                      {availablePaths.map(p => (
                        <button key={p.id} type="button"
                          className={`ec-pr-tab${p.id === chosenPath?.id ? ' on' : ''}`}
                          onClick={() => setPayoutPath(selected.id, p.id)}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="ec-pr-plan">
                      <span>{chosenPath ? chosenPath.name : 'No path chosen'}</span>
                      <button type="button" className="ec-pr-change" onClick={() => setPathModalOpen(true)}>change</button>
                    </div>
                  )
                )}
                {payoutReadiness ? (
                  <>
                    <div className="ec-pr">
                      {payoutReadiness.rows.map((row, i) => {
                        const isBlocker = !row.met && payoutReadiness.rows.findIndex(r => !r.met) === i;
                        return (
                          <div key={row.key} className={`ec-pr-r${row.met ? ' ok' : ''}${isBlocker ? ' block' : ''}`}>
                            <span className="ec-pr-mk" aria-hidden="true">{row.met ? '✓' : ''}</span>
                            <span className="ec-pr-main">
                              <span className="ec-pr-n">{row.label}</span>
                              <span className="ec-pr-d">{row.detail}</span>
                            </span>
                            <span className="ec-pr-s">{row.met ? 'Met' : `${Math.round(row.progress * 100)}%`}</span>
                          </div>
                        );
                      })}
                    </div>
                    {consistencyGap > 0 && (
                      <p className="ec-rd-cap">Clearing consistency needs <b>{money(consistencyGap)}</b> more profit.</p>
                    )}
                    {chosenPath?.note && <p className="ec-pr-note">{chosenPath.note}</p>}
                  </>
                ) : (
                  <p className="ec-rd-cap">Choose your payout path to see readiness.</p>
                )}
              </>
            ) : (
              <div className="ec-drv">
                {probabilityDrivers.map(driver => (
                  <div key={driver.label} className={`ec-drv-r${driver === weakestDriver ? ' weak' : ''}`}>
                    {driver.label}
                    <b>{Math.round(driver.value)}%</b>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ec-hero-chart">
            <div className="ec-hero-chart-head">
              <span className="ec-metric-lbl ec-section-lbl">Equity path</span>
              <span className="ec-hero-chart-meta">
                {money((isFunded ? balanceAfterPayouts : progress.currentBalance) - progress.drawdownFloor)} above MLL ·{' '}
                <b>{isFunded ? `${money(withdrawableAmount)} withdrawable` : (progress.targetRemaining <= 0 ? 'target reached' : `${money(progress.targetRemaining)} to target`)}</b>
              </span>
            </div>
            {equityPoints.length < 2
              ? <p className="ec-no-data">No sessions recorded yet, the balance line starts with your first trade.</p>
              : <EquityChart points={equityPoints} floors={mllSeries} dates={equityDates} start={startBalance} target={showTarget ? targetBalance : undefined} locked={progress.floorLocked} biggest={{ date: biggestDay.date, pnl: biggestDay.pnl, pct: progress.consistencyPct }} />}
          </div>
        </div>

        {/* ── Ledger strip: the four numbers that decide the eval ────── */}
        <div className="ec-metric-grid">
          <div className="ec-metric-card ec-metric-card--primary">
            <span className="ec-metric-lbl">{isFunded ? 'Withdrawable amount' : 'Profit needed'}</span>
            <strong className="ec-metric-val">{money(isFunded ? withdrawableAmount : progress.targetRemaining)}</strong>
            {isFunded ? (
              <span className="ec-metric-sub">{payoutReady
                ? (chosenPath?.payoutSplitPct
                    ? `${chosenPath.payoutSplitPct}% of ${money(cycleProfit)} profit${chosenPath.payoutCap !== undefined ? `, cap ${money(resolveBySize(chosenPath.payoutCap, Number(selected.size) || 0))}` : ''}`
                    : 'Cleared to withdraw')
                : `Locked until you meet the ${(payoutReadiness?.blocking ?? 'requirements').toLowerCase()}`}</span>
            ) : (
              <>
                <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${targetProgressPct}%` }} /></div>
                <span className="ec-metric-sub">{targetProgressPct}% of {money(target)} target</span>
              </>
            )}
          </div>

          <div
            className="ec-metric-card"
            title={progress.drawdownType === 'static'
              ? 'Static, the MLL never moves.'
              : progress.floorLocked
                ? 'Locked, the MLL has stopped trailing.'
                : `${ddTypeLabel === 'EOD trailing' ? 'Rises with end-of-day balance highs' : 'Rises with every new balance high'}.`}
          >
            <span className="ec-metric-lbl">Room above MLL</span>
            <strong className="ec-metric-val" style={drawdownRemainingPct < 20 ? { color: 'var(--red)' } : undefined}>{money(isFunded ? drawdownRemainingNet : progress.drawdownRemaining)}</strong>
            <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${drawdownRemainingPct}%` }} /></div>
            <span className="ec-metric-sub">
              {drawdownUsedPct}% of buffer used{isFunded && progress.floorLocked
                ? '. Equals withdrawable once the floor locks.'
                : !progress.floorLocked && progress.trailingStopsAt !== null ? ` · locks at ${money(progress.trailingStopsAt)}` : ''}
            </span>
          </div>

          {isFunded && payoutReadiness && payoutReadiness.rows.length > 0 ? (
            /* Funded: the chosen path's primary payout gate, whatever it is
               (winning days, consistency, trading days, safety net…). Never the
               eval's minimum-days rule, which does not apply once funded. */
            (() => {
              const gate = payoutReadiness.rows[0];
              return (
                <div className="ec-metric-card">
                  <span className="ec-metric-lbl">{gate.label}</span>
                  <strong className="ec-metric-val" style={!gate.met ? { color: 'var(--amber)' } : undefined}>{gate.big}</strong>
                  <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${Math.round(gate.progress * 100)}%` }} /></div>
                  <span className="ec-metric-sub">{gate.met ? `${gate.label} requirement met` : gate.detail}</span>
                </div>
              );
            })()
          ) : dailyLimit > 0 ? (
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Daily budget left</span>
              <strong className="ec-metric-val" style={dailyRemainingPct < 35 ? { color: 'var(--red)' } : undefined}>{money(dailyRemaining ?? 0)}</strong>
              <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${dailyRemainingPct}%` }} /></div>
              <span className="ec-metric-sub">{dailyUsedPct}% used · {money(progress.dailyPnl)} today</span>
            </div>
          ) : (
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Trading days</span>
              <strong className="ec-metric-val">
                {progress.tradingDays}
                {progress.minimumTradingDays > 0 && <span className="ec-metric-denom">/{progress.minimumTradingDays}</span>}
              </strong>
              <div className="ec-metric-track">
                {progress.minimumTradingDays > 0 && (
                  <div className="ec-metric-fill" style={{ width: `${Math.min(100, (progress.tradingDays / progress.minimumTradingDays) * 100)}%` }} />
                )}
              </div>
              <span className="ec-metric-sub">
                {progress.minimumTradingDays > 0
                  ? daysMet ? 'Minimum day requirement met' : `${progress.minimumTradingDays - progress.tradingDays} more day${s(progress.minimumTradingDays - progress.tradingDays)} required`
                  : 'No minimum day requirement'}
              </span>
            </div>
          )}

          <div className="ec-metric-card">
            <span className="ec-metric-lbl">{isFunded ? 'Payout status' : 'Pace to target'}</span>
            <strong className="ec-metric-val">{isFunded ? (payoutReady ? 'Ready' : (payoutReadiness?.blocking ?? (chosenPath ? 'Building' : 'Pick path'))) : paceHeadline}</strong>
            <span className="ec-metric-sub">{isFunded
              ? (payoutReady
                ? `All ${chosenPath?.name ?? ''} payout requirements are met.`.replace('  ', ' ')
                : payoutReadiness
                  ? (() => {
                      const b = payoutReadiness.rows.find(r => !r.met);
                      if (!b) return 'Keep building withdrawable profit while staying above the MLL.';
                      if (b.key === 'consistency' && consistencyGap > 0) {
                        return `${biggestDay.date ? shortDay(biggestDay.date) : 'Your biggest day'} is ${progress.consistencyPct}% of profit; ${money(consistencyGap)} more clears the ${consistencyCap}% cap.`;
                      }
                      return `${b.label}: ${b.detail}.`;
                    })()
                  : 'Choose your payout path to track readiness.')
              : paceDetail}</span>
          </div>
        </div>

        {/* ── The directive: one branded callout, not a shouting headline ── */}
        <section className="ec-dir">
          <img src="/logo.svg" alt="" className="ec-dir-glyph" />
          <div className="ec-dir-body">
            <span className="ec-metric-lbl ec-section-lbl">Next session strategy</span>
            <p className={missionLoading ? 'loading' : undefined}>{missionDisplay}</p>
          </div>
          <button type="button" className="ec-dir-ask" onClick={() => navigate('/flyxa-ai/ask')}>
            Ask Flyxa
          </button>
        </section>

        {/* Bottom two-up: risk leaks beside the debrief */}
        <div className="ec-bottom-two">
          {(allAlerts.length > 0 || dailyOkRow) && (
            <div className="ec-alerts-card" ref={alertsRef}>
              <div className="ec-card-hdr">
                <span className="ec-card-hdr-title">Risk leaks to fix</span>
                <span className={`ec-leak-cnt${allAlerts.length === 0 ? ' clear' : ''}`}>
                  {allAlerts.length > 0 ? `${allAlerts.length} OPEN` : 'ALL CLEAR'}
                </span>
              </div>
              {allAlerts.map(alert => (
                <div key={alert.id} className="ec-leak">
                  <div className="ec-leak-t">
                    <b>
                      {alert.severity === 'critical' && <span className="ec-alert-severity critical">Critical · </span>}
                      {alert.title}
                    </b>
                    <p>{alert.message}</p>
                    <span className="ec-leak-fix">FIX → {alert.action}</span>
                  </div>
                </div>
              ))}
              {dailyOkRow && (
                <div className="ec-leak ok">
                  <div className="ec-leak-t">
                    <b>Daily loss limit respected</b>
                    <p>{dailyOkRow}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Session debrief — auto-saves */}
          <div className="ec-debrief-card">
            <div className="ec-card-hdr">
              <span className="ec-card-hdr-title">Session debrief</span>
              {debriefStatus !== 'idle' ? (
                <span className={`ec-debrief-status${debriefStatus === 'saved' ? ' saved' : ''}`}>
                  {debriefStatus === 'saving' ? 'Saving…' : 'Saved'}
                </span>
              ) : (
                <span className="ec-metric-lbl" style={{ marginBottom: 0 }}>Feeds tomorrow's coaching</span>
              )}
            </div>
            {recentJournalReflections.length > 0 && (
              <div className="ec-jq">
                <span className="ec-jq-d">
                  {new Date(recentJournalReflections[0].date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}
                </span>
                <p>&ldquo;{recentJournalReflections[0].post}&rdquo;</p>
              </div>
            )}
            <div className="ec-deb-in">
              <textarea
                className="ec-debrief-textarea"
                placeholder={recentJournalReflections.length > 0 ? 'Anything to flag for tomorrow\'s coaching…' : 'What happened in today\'s session? What will you do differently?'}
                value={debriefWhat}
                onChange={e => { setDebriefWhat(e.target.value); debriefEditedRef.current = true; }}
                rows={4}
              />
              <div className="ec-deb-rmeta">
                <span>FLYXA READS THIS · IT SHAPES YOUR NEXT DIRECTIVE</span>
                <span>AUTOSAVES</span>
              </div>
            </div>
          </div>
        </div>

        <p className="ec-disclaimer">
          Firm rules can change. Flyxa's presets are monitoring aids, not the legal source of truth. Verify every limit against your firm dashboard and agreement.
        </p>
      </div>

      {/* ── Payout path chooser (fires when a multi-path firm is funded) ── */}
      {pathModalOpen && availablePaths.length > 1 && (
        <div className="ec-pathmodal-backdrop" onClick={() => { if (chosenPath) setPathModalOpen(false); }}>
          <div className="ec-pathmodal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="ec-pathmodal-hd">
              <h2>Choose your payout path</h2>
              <p>{selected.firm} funds on more than one plan. Pick the one this account is on so Flyxa tracks the right payout rules.</p>
            </div>
            <div className="ec-pathmodal-list">
              {availablePaths.map(p => {
                const active = p.id === chosenPath?.id;
                const wdMin = p.winningDays ? resolveBySize(p.winningDays.min, Number(selected.size) || 0) : 0;
                return (
                  <button key={p.id} type="button"
                    className={`ec-pathmodal-opt${active ? ' on' : ''}`}
                    onClick={() => { setPayoutPath(selected.id, p.id); setPathModalOpen(false); }}>
                    <div className="ec-pathmodal-opt-hd">
                      <span className="ec-pathmodal-opt-name">{p.name}{p.legacy ? ' · legacy' : ''}</span>
                      <span className="ec-pathmodal-tags">
                        {p.winningDays && <span className="ec-pathmodal-tag">{p.winningDays.count} winning days{wdMin > 1 ? ` · ≥${money(wdMin)}` : ''}</span>}
                        {typeof p.minTradingDays === 'number' && <span className="ec-pathmodal-tag">{p.minTradingDays} days</span>}
                        {typeof p.consistencyPct === 'number' && <span className="ec-pathmodal-tag">{p.consistencyPct}% consistency</span>}
                        {p.buffer && <span className="ec-pathmodal-tag">safety net</span>}
                      </span>
                    </div>
                    <p className="ec-pathmodal-opt-blurb">{p.blurb}</p>
                  </button>
                );
              })}
            </div>
            <p className="ec-pathmodal-ft">You can change this anytime from the readiness card.</p>
          </div>
        </div>
      )}
    </div>
  );
}
