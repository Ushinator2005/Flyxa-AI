import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import './FlyxaAIWeeklyReport.css';

// ─── Design tokens ───────────────────────────────────────────────
const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.11)', b2: 'rgba(255,255,255,0.17)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252', amb: '#f59e0b',
  mono: "'DM Mono', ui-monospace, monospace",
} as const;

// ─── Helpers ─────────────────────────────────────────────────────
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function weekMonday(offset = 0): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  today.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) - offset * 7);
  return today;
}

function fmtShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtCurrency(v: number): string {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? '+' : '-'}${fmtCurrency(Math.abs(v))}`;
}

function fmtR(r: number): string {
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

function tradeDate(t: Partial<Trade>): string {
  return t.trade_date ?? (t as unknown as { date?: string }).date ?? '';
}

function tradeR(t: Partial<Trade>): number {
  const entry = Number(t.entry_price ?? 0);
  const sl    = Number(t.sl_price ?? 0);
  const pnl   = Number(t.pnl ?? 0);
  const risk  = Math.abs(entry - sl);
  if (risk > 0) {
    const riskCash = risk * (Number(t.contract_size ?? 1) || 1) * (Number(t.point_value ?? 1) || 1);
    if (riskCash > 0) return pnl / riskCash;
  }
  return pnl > 0 ? 1 : pnl < 0 ? -1 : 0;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// ─── Stats computation ───────────────────────────────────────────
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

interface DayBar        { day: string; pnl: number }
interface ConfStat      { label: string; trades: number; winRate: number }
interface FlagStat      { flag: string; count: number }

interface WeekStats {
  weekLabel: string; weekKey: string;
  tradeCount: number; sessionCount: number;
  netPnl: number; netR: number; winRate: number; wins: number; losses: number;
  avgWinPnl: number; avgLossPnl: number; avgWinR: number; avgLossR: number;
  bestDayPnl: number; worstDayPnl: number; bestDayLabel: string; worstDayLabel: string;
  dailyPnl: DayBar[];
  topConfluences: ConfStat[];
  behavioralFlags: FlagStat[];
  planAdherence: number | null;
}

function computeWeekStats(trades: Trade[], offset: number): WeekStats {
  const mon  = weekMonday(offset);
  const sun  = addDays(mon, 6);
  sun.setHours(23, 59, 59, 999);
  const weekKey   = mon.toISOString().slice(0, 10);
  const weekLabel = `${fmtShort(mon)} – ${fmtShort(addDays(mon, 4))}, ${mon.getFullYear()}`;

  const wt = trades.filter(t => {
    const ds = tradeDate(t);
    if (!ds) return false;
    const d = new Date(`${ds}T00:00:00`);
    return d >= mon && d <= sun;
  });

  const winners    = wt.filter(t => Number(t.pnl ?? 0) > 0);
  const losers     = wt.filter(t => Number(t.pnl ?? 0) < 0);
  const netPnl     = wt.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const netR       = wt.reduce((s, t) => s + tradeR(t), 0);
  const winRate    = wt.length > 0 ? Math.round((winners.length / wt.length) * 100) : 0;
  const avgWinPnl  = winners.length > 0 ? winners.reduce((s, t) => s + Number(t.pnl ?? 0), 0) / winners.length : 0;
  const avgLossPnl = losers.length  > 0 ? losers.reduce( (s, t) => s + Number(t.pnl ?? 0), 0) / losers.length  : 0;
  const avgWinR    = winners.length > 0 ? winners.reduce((s, t) => s + tradeR(t), 0) / winners.length : 0;
  const avgLossR   = losers.length  > 0 ? losers.reduce( (s, t) => s + tradeR(t), 0) / losers.length  : 0;

  const dayMap = new Map<number, number>();
  wt.forEach(t => {
    const ds  = tradeDate(t);
    if (!ds) return;
    const dow = new Date(`${ds}T00:00:00`).getDay();
    const idx = dow === 0 ? 6 : dow - 1;
    if (idx < 5) dayMap.set(idx, (dayMap.get(idx) ?? 0) + Number(t.pnl ?? 0));
  });

  const dailyPnl: DayBar[] = DOW.map((day, i) => ({ day, pnl: dayMap.get(i) ?? 0 }));

  const activeDays = dailyPnl.filter((_, i) => dayMap.has(i));
  let bestDayPnl = 0, worstDayPnl = 0, bestDayLabel = '—', worstDayLabel = '—';
  if (activeDays.length > 0) {
    const best  = activeDays.reduce((a, b) => b.pnl > a.pnl ? b : a);
    const worst = activeDays.reduce((a, b) => b.pnl < a.pnl ? b : a);
    bestDayPnl = best.pnl;   bestDayLabel  = best.day;
    worstDayPnl = worst.pnl; worstDayLabel = worst.day;
  }

  const sessionDates = new Set(wt.map(tradeDate).filter(Boolean));

  const confMap = new Map<string, { wins: number; total: number }>();
  wt.forEach(t => {
    (Array.isArray(t.confluences) ? t.confluences : []).forEach(c => {
      if (!c) return;
      const e = confMap.get(c) ?? { wins: 0, total: 0 };
      e.total++; if (Number(t.pnl ?? 0) > 0) e.wins++;
      confMap.set(c, e);
    });
  });
  const topConfluences: ConfStat[] = Array.from(confMap.entries())
    .map(([label, { wins, total }]) => ({ label, trades: total, winRate: Math.round(wins / total * 100) }))
    .filter(c => c.trades >= 2).sort((a, b) => b.winRate - a.winRate).slice(0, 6);

  const flagMap = new Map<string, number>();
  wt.forEach(t => {
    const flags = (t as unknown as { behavioral_flags?: string[] }).behavioral_flags ?? [];
    if (Array.isArray(flags)) flags.forEach(f => flagMap.set(f, (flagMap.get(f) ?? 0) + 1));
  });
  const behavioralFlags: FlagStat[] = Array.from(flagMap.entries())
    .map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count).slice(0, 4);

  const withScore = wt.filter(t => typeof t.plan_score === 'number');
  const withPlan = wt.filter(t => typeof t.followed_plan === 'boolean');
  const planAdherence = withScore.length > 0
    ? Math.round(withScore.reduce((s, t) => s + (t.plan_score as number), 0) / withScore.length)
    : withPlan.length > 0
      ? Math.round(withPlan.filter(t => t.followed_plan).length / withPlan.length * 100)
      : null;

  return {
    weekLabel, weekKey,
    tradeCount: wt.length, sessionCount: sessionDates.size,
    netPnl, netR, winRate, wins: winners.length, losses: losers.length,
    avgWinPnl, avgLossPnl, avgWinR, avgLossR,
    bestDayPnl, worstDayPnl, bestDayLabel, worstDayLabel,
    dailyPnl, topConfluences, behavioralFlags, planAdherence,
  };
}

// ─── Action plan ─────────────────────────────────────────────────
function generateActionPlan(s: WeekStats): string[] {
  const items: string[] = [];

  if (s.planAdherence !== null && s.planAdherence < 70)
    items.push(`Plan adherence was ${s.planAdherence}% — before each trade, log your thesis and stop level.`);
  if (s.wins > 0 && s.losses > 0 && Math.abs(s.avgLossPnl) > s.avgWinPnl)
    items.push(`Avg loss (${fmtCurrency(Math.abs(s.avgLossPnl))}) exceeded avg win (${fmtCurrency(s.avgWinPnl)}) — cut losers earlier or hold winners longer.`);
  if (s.behavioralFlags.length > 0) {
    const { flag, count } = s.behavioralFlags[0];
    items.push(`"${flag}" appeared ${count} time${count > 1 ? 's' : ''} — review those trades and find the trigger.`);
  }
  if (s.winRate < 40 && s.tradeCount >= 4)
    items.push(`Win rate was ${s.winRate}% — scale back size until edge is confirmed.`);
  if (s.worstDayLabel !== '—' && s.worstDayPnl < -200)
    items.push(`${s.worstDayLabel} was your worst day (${fmtSigned(s.worstDayPnl)}) — set a hard daily loss limit.`);
  if (s.topConfluences[0]?.winRate >= 60) {
    const { label, winRate, trades } = s.topConfluences[0];
    items.push(`"${label}" hit ${winRate}% on ${trades} trades — lead with this setup in your pre-session plan.`);
  }

  if (s.tradeCount === 0)
    return [
      'No trades logged — start with one fully journaled session.',
      'Build a pre-session routine: thesis, key levels, and bias written before open.',
      'Tag confluences on every setup to unlock pattern analysis next week.',
    ];

  const fillers = [
    'Review your single best trade and document exactly what made the process clean.',
    'Run one backtest session to validate your highest-win confluence.',
    'Write a one-line market thesis each morning before opening your platform.',
    'Cap daily risk at 1% of account equity and enforce it without exceptions.',
  ];
  while (items.length < 3) { const f = fillers.shift(); if (f) items.push(f); else break; }
  return items.slice(0, 3);
}

// ─── Slides ───────────────────────────────────────────────────────
type SlideKey = 'cover' | 'numbers' | 'daily' | 'patterns' | 'reflection' | 'focus';
const SLIDES: SlideKey[] = ['cover', 'numbers', 'daily', 'patterns', 'reflection', 'focus'];
const SLIDE_LABELS: Record<SlideKey, string> = {
  cover:      'Overview',
  numbers:    'By the Numbers',
  daily:      'Day by Day',
  patterns:   'Edge Analysis',
  reflection: 'Reflection',
  focus:      'Action Plan',
};

// ── Slide 1: Cover ───────────────────────────────────────────────
function SlideCover({ stats }: { stats: WeekStats }) {
  const positive  = stats.netPnl >= 0;
  const glowColor = stats.tradeCount > 0 ? (positive ? C.grn : C.red) : 'transparent';
  const pnlColor  = positive ? C.grn : C.red;
  const rColor    = stats.netR >= 0 ? C.grn : C.red;

  return (
    <div
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: stats.tradeCount > 0
          ? `radial-gradient(ellipse 700px 480px at 50% 50%, ${glowColor}0e 0%, transparent 68%), ${C.d0}`
          : C.d0,
        padding: '0 clamp(8px, 4vw, 48px)',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: 10, letterSpacing: '0.22em', color: C.t2, textTransform: 'uppercase', marginBottom: 48 }}>
        AI Coach · Weekly Report
      </p>

      {stats.tradeCount === 0 ? (
        <>
          <p style={{ fontSize: 22, color: C.t1, marginBottom: 12, fontWeight: 500 }}>No trades logged this week</p>
          <p style={{ fontSize: 14, color: C.t2, maxWidth: 360 }}>
            Use the ← arrow above to view a previous week, or log trades to see your report here.
          </p>
        </>
      ) : (
        <>
          <div
            style={{
              fontSize: 'clamp(36px, 15vw, 88px)',
              fontWeight: 700,
              color: pnlColor,
              letterSpacing: '-0.04em',
              lineHeight: 1,
              fontFamily: C.mono,
              textShadow: `0 0 80px ${glowColor}40`,
            }}
          >
            {fmtSigned(stats.netPnl)}
          </div>

          <div style={{ fontSize: 'clamp(16px, 5vw, 26px)', color: rColor, fontFamily: C.mono, marginTop: 'clamp(8px, 2vh, 14px)', fontWeight: 600, opacity: 0.9 }}>
            {fmtR(stats.netR)}
          </div>

          {/* Divider */}
          <div style={{ width: 1, height: 'clamp(20px, 4vh, 40px)', background: C.b1, margin: 'clamp(16px, 4vh, 36px) auto' }} />

          {/* Stats row */}
          <div style={{ display: 'flex', gap: 'clamp(16px, 6vw, 52px)', alignItems: 'flex-end' }}>
            {[
              { value: stats.tradeCount,   label: 'Trades',   color: C.t0 },
              { value: stats.wins,          label: 'Wins',     color: C.grn },
              { value: stats.losses,        label: 'Losses',   color: C.red },
              { value: stats.sessionCount,  label: 'Sessions', color: C.t0 },
            ].map(item => (
              <div key={item.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 'clamp(22px, 8vw, 40px)', fontWeight: 700, color: item.color, lineHeight: 1, fontFamily: C.mono }}>{item.value}</div>
                <div style={{ fontSize: 11, color: C.t2, marginTop: 6, letterSpacing: '0.06em' }}>{item.label}</div>
              </div>
            ))}
          </div>

          {/* Win rate bar */}
          {stats.tradeCount > 0 && (
            <div style={{ marginTop: 'clamp(16px, 4vh, 36px)', display: 'flex', alignItems: 'center', gap: 12, maxWidth: '100%' }}>
              <div style={{ width: 'clamp(100px, 35vw, 200px)', height: 3, background: C.d3, borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
                <div style={{ width: `${stats.winRate}%`, height: '100%', background: stats.winRate >= 50 ? C.grn : C.red, borderRadius: 2, transition: 'width 0.6s ease' }} />
              </div>
              <span style={{ fontSize: 12, color: C.t2, fontFamily: C.mono, whiteSpace: 'nowrap' }}>{stats.winRate}% win rate</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Slide 2: Numbers ─────────────────────────────────────────────
function NumbersChart({ dailyPnl }: { dailyPnl: { day: string; pnl: number }[] }) {
  const W = 1000, H = 300;
  const midY = 148;
  const usableH = midY - 44;
  const PAD_X = 24;
  const count = dailyPnl.length || 1;
  const slotW = (W - PAD_X * 2) / count;
  const barW = slotW * 0.3;
  const maxAbs = Math.max(...dailyPnl.map(d => Math.abs(d.pnl)), 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="ng-pos" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={C.grn} stopOpacity="0.95" />
          <stop offset="100%" stopColor={C.grn} stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id="ng-neg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={C.red} stopOpacity="0.18" />
          <stop offset="100%" stopColor={C.red} stopOpacity="0.95" />
        </linearGradient>
      </defs>

      {/* Hairline grid */}
      {[0.4, 0.75, 1].map(f => (
        <line key={`gp${f}`} x1={PAD_X} y1={midY - usableH * f} x2={W - PAD_X} y2={midY - usableH * f}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} strokeDasharray="4 6" />
      ))}
      {[0.4, 0.75, 1].map(f => (
        <line key={`gn${f}`} x1={PAD_X} y1={midY + usableH * f} x2={W - PAD_X} y2={midY + usableH * f}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} strokeDasharray="4 6" />
      ))}

      {/* Zero baseline */}
      <line x1={PAD_X} y1={midY} x2={W - PAD_X} y2={midY} stroke="rgba(255,255,255,0.22)" strokeWidth={1} />

      {dailyPnl.map((d, i) => {
        const cx = PAD_X + i * slotW + slotW / 2;
        const isPos = d.pnl >= 0;
        const color = d.pnl === 0 ? C.t2 : isPos ? C.grn : C.red;
        const barH = d.pnl !== 0 ? Math.max(10, (Math.abs(d.pnl) / maxAbs) * usableH) : 0;
        const barY = isPos ? midY - barH : midY;
        const x = cx - barW / 2;

        return (
          <g key={d.day}>
            {d.pnl !== 0 && (
              <>
                {/* Wide soft glow behind bar */}
                <rect x={cx - barW * 1.6} y={barY - 8} width={barW * 3.2} height={barH + 16}
                  rx={16} fill={`${color}0e`} />
                {/* Gradient bar */}
                <rect x={x} y={barY} width={barW} height={barH}
                  rx={7} fill={isPos ? 'url(#ng-pos)' : 'url(#ng-neg)'} />
                {/* Bright cap at tip */}
                <rect
                  x={x} y={isPos ? barY : barY + barH - 3}
                  width={barW} height={3} rx={2}
                  fill={color} opacity={0.9}
                />
              </>
            )}

            {/* P&L value */}
            {d.pnl !== 0 && (
              <text
                x={cx} y={isPos ? barY - 13 : barY + barH + 22}
                textAnchor="middle" fill={color}
                fontSize={14} fontFamily="DM Mono,ui-monospace,monospace" fontWeight="700"
              >
                {fmtSigned(d.pnl)}
              </text>
            )}
            {d.pnl === 0 && (
              <text x={cx} y={midY - 14} textAnchor="middle" fill={C.t2} fontSize={26}>—</text>
            )}

            {/* Day label */}
            <text x={cx} y={H - 8} textAnchor="middle"
              fill={d.pnl !== 0 ? C.t0 : C.t2}
              fontSize={17} fontFamily="var(--font-sans)"
              fontWeight={d.pnl !== 0 ? '700' : '400'}
            >
              {d.day}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SlideNumbers({ stats }: { stats: WeekStats }) {
  if (stats.tradeCount === 0) {
    return <SlideEmpty label="By the Numbers" message="No trade data for this week." />;
  }

  const pnlPositive   = stats.netPnl >= 0;
  const heroColor     = pnlPositive ? C.grn : C.red;
  const totalResolved = stats.wins + stats.losses;

  const bottomStats = [
    { label: 'Avg Winner', value: stats.wins   ? `+${fmtCurrency(stats.avgWinPnl)}` : '—',                      sub: stats.wins   ? `${stats.avgWinR.toFixed(2)}R avg`            : undefined, color: C.grn },
    { label: 'Avg Loser',  value: stats.losses ? `-${fmtCurrency(Math.abs(stats.avgLossPnl))}` : '—',            sub: stats.losses ? `${Math.abs(stats.avgLossR).toFixed(2)}R avg`  : undefined, color: C.red },
    { label: 'Best Day',   value: stats.bestDayLabel,  sub: stats.bestDayLabel  !== '—' ? fmtSigned(stats.bestDayPnl)  : undefined, color: C.grn },
    { label: 'Worst Day',  value: stats.worstDayLabel, sub: stats.worstDayLabel !== '—' ? fmtSigned(stats.worstDayPnl) : undefined, color: C.red },
    ...(stats.planAdherence !== null
      ? [{ label: 'Plan', value: `${stats.planAdherence}%`, sub: undefined, color: stats.planAdherence >= 70 ? C.grn : stats.planAdherence >= 40 ? C.amb : C.red }]
      : []),
  ];

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* ── Hero: centered P&L with glow orb ── */}
      <div style={{ flexShrink: 0, position: 'relative', textAlign: 'center', paddingBottom: 10 }}>
        {/* Ambient glow behind number */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -60%)',
          width: '60%', height: '280%',
          background: `radial-gradient(ellipse, ${heroColor}1c 0%, transparent 68%)`,
          pointerEvents: 'none',
        }} />
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: C.t2, marginBottom: 8 }}>
            Net P&L
          </div>
          <div style={{
            fontSize: 'clamp(54px, 8.5vw, 92px)',
            fontWeight: 800, fontFamily: C.mono, color: heroColor,
            lineHeight: 1, letterSpacing: '-0.035em',
            textShadow: `0 0 120px ${heroColor}50, 0 0 50px ${heroColor}28`,
          }}>
            {fmtSigned(stats.netPnl)}
          </div>
          <div style={{ marginTop: 7, fontSize: 12.5, color: C.t2, letterSpacing: '0.04em' }}>
            {pnlPositive ? '↑ Profitable week' : '↓ Losing week'}
          </div>
        </div>
      </div>

      {/* ── Secondary stats row (centered) ── */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', paddingBottom: 10 }}>
        {([
          { value: `${stats.winRate}%`, label: 'Win Rate', color: stats.winRate >= 50 ? C.grn : C.red, sub: `${stats.wins}W · ${stats.losses}L` },
          { value: fmtR(stats.netR),    label: 'Net R',    color: stats.netR >= 0 ? C.grn : C.red,     sub: undefined },
          { value: String(stats.tradeCount), label: 'Trades', color: C.t0, sub: `${stats.sessionCount} sessions` },
        ] as const).map((s, i, arr) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ textAlign: 'center', padding: '0 clamp(16px, 3.5vw, 38px)' }}>
              <div style={{ fontSize: 'clamp(20px, 3vw, 30px)', fontWeight: 800, fontFamily: C.mono, color: s.color, lineHeight: 1, letterSpacing: '-0.01em' }}>
                {s.value}
              </div>
              <div style={{ fontSize: 9, color: C.t2, textTransform: 'uppercase', letterSpacing: '0.16em', marginTop: 4 }}>{s.label}</div>
              {s.sub && <div style={{ fontSize: 10, color: C.t2, fontFamily: C.mono, marginTop: 2 }}>{s.sub}</div>}
            </div>
            {i < arr.length - 1 && <div style={{ width: 1, height: 30, background: C.b1, flexShrink: 0 }} />}
          </div>
        ))}
      </div>

      {/* W/L ratio bar */}
      {totalResolved > 0 && (
        <div style={{ flexShrink: 0, height: 4, borderRadius: 2, background: C.d3, overflow: 'hidden', display: 'flex', marginBottom: 12 }}>
          <div style={{ flex: stats.wins,   background: C.grn, opacity: 0.8 }} />
          {stats.wins > 0 && stats.losses > 0 && <div style={{ width: 1, background: C.d0, flexShrink: 0 }} />}
          <div style={{ flex: stats.losses, background: C.red, opacity: 0.8 }} />
        </div>
      )}

      {/* Divider */}
      <div style={{ flexShrink: 0, height: 1, background: C.b0, marginBottom: 10 }} />

      {/* ── Daily bar chart ── */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <NumbersChart dailyPnl={stats.dailyPnl} />
      </div>

      {/* ── Bottom stat strip (left-accent style) ── */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 0, paddingTop: 12, borderTop: `1px solid ${C.b0}` }}>
        {bottomStats.map((item, i) => (
          <div key={item.label} style={{
            flex: 1, padding: '8px 14px',
            borderLeft: i > 0 ? `1px solid ${C.b0}` : 'none',
            minWidth: 0,
          }}>
            <div style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: '0.13em', textTransform: 'uppercase', color: C.t2, marginBottom: 4 }}>{item.label}</div>
            <div style={{ fontSize: 'clamp(12px, 1.6vw, 16px)', fontWeight: 700, fontFamily: C.mono, color: item.color, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.value}</div>
            {item.sub && <div style={{ fontSize: 9.5, color: C.t2, marginTop: 3 }}>{item.sub}</div>}
          </div>
        ))}
      </div>

    </div>
  );
}

// ── Slide 3: Daily ───────────────────────────────────────────────
function SlideDaily({ stats }: { stats: WeekStats }) {
  const maxAbs = Math.max(...stats.dailyPnl.map(d => Math.abs(d.pnl)), 1);

  return (
    <SlideLayout label="Day by Day">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 680, width: '100%', margin: '0 auto' }}>
        {stats.dailyPnl.map(d => {
          const active  = d.pnl !== 0;
          const green   = d.pnl >= 0;
          const barPct  = active ? Math.max(2, Math.round(Math.abs(d.pnl) / maxAbs * 100)) : 0;
          const barColor = green ? C.grn : C.red;

          return (
            <div key={d.day} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 130px', alignItems: 'center', gap: 16 }}>
              <span style={{ fontSize: 13.5, color: C.t1, fontWeight: 600 }}>{d.day}</span>
              <div style={{ height: 38, background: C.d3, borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
                {active && (
                  <div style={{
                    position: 'absolute', inset: '0 auto 0 0',
                    width: `${barPct}%`,
                    background: `${barColor}22`,
                    borderRight: `2.5px solid ${barColor}`,
                    borderRadius: 5,
                    transition: 'width 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
                  }} />
                )}
              </div>
              <span style={{ fontSize: 15, fontFamily: C.mono, color: active ? barColor : C.t2, textAlign: 'right', fontWeight: 600 }}>
                {active ? fmtSigned(d.pnl) : '—'}
              </span>
            </div>
          );
        })}

        {stats.tradeCount === 0 && (
          <p style={{ fontSize: 13, color: C.t2, textAlign: 'center', marginTop: 12 }}>No trades logged this week.</p>
        )}
      </div>
    </SlideLayout>
  );
}

// ── Slide 4: Patterns ────────────────────────────────────────────
function PatternCard({ label, sub, accent }: { label: string; sub: string; accent: string }) {
  return (
    <div style={{
      padding: '13px 16px',
      background: `${accent}0a`,
      border: `1px solid ${accent}22`,
      borderRadius: 8,
      marginBottom: 10,
    }}>
      <div style={{ fontSize: 13, color: C.t0, marginBottom: 4, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: accent }}>{sub}</div>
    </div>
  );
}

function SlidePatterns({ stats }: { stats: WeekStats }) {
  const best  = stats.topConfluences.filter(c => c.winRate >= 60);
  const worst = stats.topConfluences.filter(c => c.winRate <  60);
  const empty = stats.topConfluences.length === 0 && stats.behavioralFlags.length === 0;

  return (
    <SlideLayout label="Edge Analysis">
      {empty ? (
        <div style={{ padding: '32px 28px', background: C.d2, border: `1px solid ${C.b0}`, borderRadius: 10, maxWidth: 520 }}>
          <p style={{ fontSize: 14, color: C.t2, lineHeight: 1.65 }}>
            Not enough confluence data this week. Tag confluences on each trade to unlock pattern analysis here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, width: '100%', maxWidth: 780 }}>
          <div>
            <div style={{ fontSize: 11, color: C.grn, marginBottom: 16, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>What Clicked</div>
            {best.length > 0
              ? best.map(c => <PatternCard key={c.label} label={c.label} sub={`${c.winRate}% win rate · ${c.trades} trades`} accent={C.grn} />)
              : <p style={{ fontSize: 12.5, color: C.t2 }}>No high-win setups this week.</p>
            }
            {stats.bestDayLabel !== '—' && (
              <PatternCard label={`Best day: ${stats.bestDayLabel}`} sub={fmtSigned(stats.bestDayPnl)} accent={C.grn} />
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.red, marginBottom: 16, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>What Hurt</div>
            {worst.map(c => <PatternCard key={c.label} label={c.label} sub={`${c.winRate}% win rate · ${c.trades} trades`} accent={C.red} />)}
            {stats.behavioralFlags.map(f => <PatternCard key={f.flag} label={f.flag} sub={`${f.count}× this week`} accent={C.amb} />)}
            {worst.length === 0 && stats.behavioralFlags.length === 0 && stats.worstDayLabel !== '—' && (
              <PatternCard label={`Worst day: ${stats.worstDayLabel}`} sub={fmtSigned(stats.worstDayPnl)} accent={C.red} />
            )}
            {worst.length === 0 && stats.behavioralFlags.length === 0 && stats.worstDayLabel === '—' && (
              <p style={{ fontSize: 12.5, color: C.t2 }}>No flags or low-win setups found.</p>
            )}
          </div>
        </div>
      )}
    </SlideLayout>
  );
}

// ── Slide 5: Reflection ──────────────────────────────────────────
function SlideReflection({
  stats, reflection, onSave, textareaRef,
}: {
  stats: WeekStats;
  reflection: string;
  onSave: (v: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
}) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 48px' }}>
      <div style={{ maxWidth: 600, width: '100%' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.22em', color: C.t2, textTransform: 'uppercase', marginBottom: 28 }}>Reflection</div>
        <p style={{ fontSize: 26, color: C.t0, fontWeight: 600, lineHeight: 1.45, marginBottom: 32 }}>
          What is the one thing that needs to change for next week to be better?
        </p>
        <textarea
          ref={textareaRef}
          value={reflection}
          onChange={e => onSave(e.target.value)}
          placeholder="Write your reflection here. Saved automatically per week."
          rows={5}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: C.d2, border: `1px solid ${C.b1}`,
            borderRadius: 10, padding: '16px 18px',
            color: C.t0, fontSize: 15, lineHeight: 1.75,
            resize: 'none', outline: 'none', fontFamily: 'inherit',
          }}
          onFocus={e  => { e.currentTarget.style.borderColor = `${C.acc}55`; }}
          onBlur={e   => { e.currentTarget.style.borderColor = C.b1; }}
        />
        <p style={{ fontSize: 11, color: C.t2, marginTop: 10 }}>
          {reflection ? `Saved · ${stats.weekLabel}` : 'Start typing — it saves automatically.'}
        </p>
      </div>
    </div>
  );
}

// ── Slide 6: Focus ───────────────────────────────────────────────
function SlideFocus({ items, stats }: { items: string[]; stats: WeekStats }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 48px' }}>
      <div style={{ maxWidth: 600, width: '100%' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.22em', color: C.t2, textTransform: 'uppercase', marginBottom: 10 }}>Action Plan</div>
        <p style={{ fontSize: 14, color: C.t1, marginBottom: 36 }}>
          Based on {stats.weekLabel} — focus on these next week.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {items.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 18, padding: '18px 20px', background: C.d2, border: `1px solid ${C.b0}`, borderRadius: 10 }}>
              <span style={{
                flexShrink: 0, width: 28, height: 28,
                background: `${C.acc}18`, border: `1px solid ${C.acc}32`,
                borderRadius: '50%', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 13, fontWeight: 800, color: C.acc,
                fontFamily: C.mono,
              }}>
                {i + 1}
              </span>
              <p style={{ fontSize: 14.5, color: C.t0, lineHeight: 1.65, margin: 0 }}>{item}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Shared layout wrappers ───────────────────────────────────────
function SlideLayout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: '8px 0' }}>
      <div style={{ fontSize: 10, letterSpacing: '0.22em', color: C.t2, textTransform: 'uppercase', marginBottom: 28 }}>{label}</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
    </div>
  );
}

function SlideEmpty({ label, message }: { label: string; message: string }) {
  return (
    <SlideLayout label={label}>
      <p style={{ fontSize: 14, color: C.t2 }}>{message}</p>
    </SlideLayout>
  );
}

// ─── Main component ──────────────────────────────────────────────
export default function FlyxaAIWeeklyReport() {
  const navigate                          = useNavigate();
  const { trades, loading }               = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const [weekOffset, setWeekOffset]       = useState(0);
  const [slideIndex, setSlideIndex]       = useState(0);
  const [direction, setDirection]         = useState<'fwd' | 'bwd'>('fwd');
  const [animKey, setAnimKey]             = useState(0);
  const [reflection, setReflection]       = useState('');
  const textareaRef                       = useRef<HTMLTextAreaElement>(null);

  const accountTrades = useMemo(() => filterTradesBySelectedAccount(trades), [filterTradesBySelectedAccount, trades]);
  const safeTrades    = useMemo(() => accountTrades.filter((t): t is Trade => Boolean(t)), [accountTrades]);
  const stats         = useMemo(() => computeWeekStats(safeTrades, weekOffset), [safeTrades, weekOffset]);
  const actionPlan    = useMemo(() => generateActionPlan(stats), [stats]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('flyxa:collapse-sidebar'));
  }, []);

  const storageKey = `flyxa.weekly-reflection.${stats.weekKey}`;
  useEffect(() => {
    try { setReflection(localStorage.getItem(storageKey) ?? ''); } catch { /* ignore */ }
  }, [storageKey]);

  const saveReflection = useCallback((v: string) => {
    setReflection(v);
    try { localStorage.setItem(storageKey, v); } catch { /* ignore */ }
  }, [storageKey]);

  const goTo = useCallback((next: number) => {
    if (next === slideIndex) return;
    setDirection(next > slideIndex ? 'fwd' : 'bwd');
    setSlideIndex(next);
    setAnimKey(k => k + 1);
  }, [slideIndex]);

  const goPrev = () => goTo(Math.max(0, slideIndex - 1));
  const goNext = () => goTo(Math.min(SLIDES.length - 1, slideIndex + 1));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); goNext(); }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')                     { e.preventDefault(); goPrev(); }
      if (e.key === 'Escape') navigate('/flyxa-ai');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIndex]);

  const currentSlide = SLIDES[slideIndex];
  const animClass    = `wkr-enter-${direction}`;

  return (
    <div
      className="animate-fade-in"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 72,
        zIndex: 800,
        background: C.d0,
        color: C.t0,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* ── Top chrome ──────────────────────────────────────── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 clamp(10px, 3vw, 28px)',
        height: 52, borderBottom: `1px solid ${C.b0}`,
      }}>
        {/* Week nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={() => setWeekOffset(w => w + 1)} style={chromeBtnStyle}>←</button>
          <span style={{ fontSize: 12, color: C.t2, minWidth: 'clamp(80px, 25vw, 160px)', textAlign: 'center' }}>{stats.weekLabel}</span>
          <button
            type="button"
            onClick={() => setWeekOffset(w => Math.max(0, w - 1))}
            disabled={weekOffset === 0}
            style={{ ...chromeBtnStyle, opacity: weekOffset === 0 ? 0.3 : 1, cursor: weekOffset === 0 ? 'not-allowed' : 'pointer' }}
          >→</button>
        </div>

        {/* Slide dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {SLIDES.map((key, i) => (
            <button
              key={key}
              type="button"
              title={SLIDE_LABELS[key]}
              onClick={() => goTo(i)}
              style={{
                width: i === slideIndex ? 20 : 7, height: 7,
                borderRadius: 4,
                background: i === slideIndex ? C.acc : C.b1,
                border: 'none', padding: 0, cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            />
          ))}
        </div>

        {/* Exit */}
        <button
          type="button"
          onClick={() => navigate('/flyxa-ai')}
          title="Exit report (Esc)"
          style={{
            width: 32, height: 32, borderRadius: 6, border: `1px solid ${C.b0}`,
            background: 'transparent', color: C.t1, display: 'flex',
            alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <X size={15} />
        </button>
      </div>

      {/* ── Slide area ──────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Click zones */}
        <div
          onClick={goPrev}
          style={{ position: 'absolute', inset: '0 60% 0 0', zIndex: 1, cursor: slideIndex > 0 ? 'w-resize' : 'default' }}
        />
        <div
          onClick={goNext}
          style={{ position: 'absolute', inset: '0 0 0 60%', zIndex: 1, cursor: slideIndex < SLIDES.length - 1 ? 'e-resize' : 'default' }}
        />

        {/* Loading */}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, color: C.t2 }}>Loading trade data…</span>
          </div>
        )}

        {/* Slide */}
        {!loading && (
          <div
            key={animKey}
            className={animClass}
            style={{ position: 'absolute', inset: 0, padding: 'clamp(16px, 4vh, 40px) clamp(12px, 5vw, 64px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            {/* Slide label top-left */}
            <div style={{ fontSize: 10, letterSpacing: '0.22em', color: C.t2, textTransform: 'uppercase', marginBottom: 4, flexShrink: 0 }}>
              {SLIDE_LABELS[currentSlide]}
            </div>

            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              {currentSlide === 'cover'      && <SlideCover      stats={stats} />}
              {currentSlide === 'numbers'    && <SlideNumbers    stats={stats} />}
              {currentSlide === 'daily'      && <SlideDaily      stats={stats} />}
              {currentSlide === 'patterns'   && <SlidePatterns   stats={stats} />}
              {currentSlide === 'reflection' && (
                <SlideReflection
                  stats={stats}
                  reflection={reflection}
                  onSave={saveReflection}
                  textareaRef={textareaRef}
                />
              )}
              {currentSlide === 'focus'      && <SlideFocus      items={actionPlan} stats={stats} />}
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom chrome ───────────────────────────────────── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 clamp(10px, 3vw, 28px)',
        height: 52, borderTop: `1px solid ${C.b0}`,
      }}>
        <button
          type="button"
          onClick={goPrev}
          disabled={slideIndex === 0}
          style={{ ...chromeBtnStyle, gap: 6, display: 'flex', alignItems: 'center', opacity: slideIndex === 0 ? 0.25 : 1, cursor: slideIndex === 0 ? 'not-allowed' : 'pointer' }}
        >
          <ChevronLeft size={14} /> Prev
        </button>

        <span style={{ fontSize: 11, color: C.t2, fontFamily: C.mono }}>
          {pad2(slideIndex + 1)} / {pad2(SLIDES.length)}
        </span>

        <button
          type="button"
          onClick={goNext}
          disabled={slideIndex === SLIDES.length - 1}
          style={{ ...chromeBtnStyle, gap: 6, display: 'flex', alignItems: 'center', opacity: slideIndex === SLIDES.length - 1 ? 0.25 : 1, cursor: slideIndex === SLIDES.length - 1 ? 'not-allowed' : 'pointer' }}
        >
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Shared styles ───────────────────────────────────────────────
const chromeBtnStyle = {
  padding: '5px 13px',
  fontSize: 12,
  color: C.t1,
  background: 'transparent',
  border: `1px solid ${C.b0}`,
  borderRadius: 5,
  cursor: 'pointer',
} as const;
