import { siInstagram, siTiktok, siSnapchat, siDiscord, siX } from 'simple-icons';
import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, Share2, Download, Copy, Check } from 'lucide-react';
import { toPng } from 'html-to-image';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry, RiskRule } from '../store/types.js';
import { normalizeConfluenceTags } from '../utils/confluenceTags.js';
import { buildPlanAdherenceReport } from '../utils/planAdherence.js';
import './FlyxaAIWeeklyReport.css';

// ─── Design tokens ────────────────────────────────────────────────
const C = {
  bg:  '#090807',
  s1:  '#100f0e',
  s2:  '#171614',
  s3:  '#1e1c1a',
  b0:  'rgba(255,255,255,0.055)',
  b1:  'rgba(255,255,255,0.10)',
  b2:  'rgba(255,255,255,0.16)',
  t0:  '#eae4dc',
  t1:  '#857e74',
  t2:  '#4e4b46',
  acc: '#f59e0b',
  grn: '#22d68a',
  red: '#f05252',
  mono: "'DM Mono', ui-monospace, monospace",
} as const;

// ─── Helpers ──────────────────────────────────────────────────────
function addDays(date: Date, days: number): Date {
  const d = new Date(date); d.setDate(d.getDate() + days); return d;
}
function weekMonday(offset = 0): Date {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const dow = t.getDay();
  t.setDate(t.getDate() - (dow === 0 ? 6 : dow - 1) - offset * 7);
  return t;
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
function fmtCompact(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 10000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return fmtSigned(v);
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
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// ─── Stats types / computation ────────────────────────────────────
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

interface DayBar   { day: string; pnl: number; trades: number }
interface ConfStat { label: string; trades: number; winRate: number }
interface FlagStat { flag: string; count: number }
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

function computeWeekStats(
  trades: Trade[], offset: number,
  entries: StoreJournalEntry[] = [], riskRules: RiskRule[] = [],
): WeekStats {
  const mon  = weekMonday(offset);
  const sun  = addDays(mon, 6); sun.setHours(23, 59, 59, 999);
  const weekKey   = mon.toISOString().slice(0, 10);
  const weekLabel = `${fmtShort(mon)} – ${fmtShort(addDays(mon, 4))}, ${mon.getFullYear()}`;

  const wt = trades.filter(t => {
    const ds = tradeDate(t); if (!ds) return false;
    const d  = new Date(`${ds}T00:00:00`);
    return d >= mon && d <= sun;
  });
  const winners    = wt.filter(t => Number(t.pnl ?? 0) > 0);
  const losers     = wt.filter(t => Number(t.pnl ?? 0) < 0);
  const netPnl     = wt.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const netR       = wt.reduce((s, t) => s + tradeR(t), 0);
  const winRate    = wt.length > 0 ? Math.round(winners.length / wt.length * 100) : 0;
  const avgWinPnl  = winners.length > 0 ? winners.reduce((s, t) => s + Number(t.pnl ?? 0), 0) / winners.length : 0;
  const avgLossPnl = losers.length  > 0 ? losers.reduce( (s, t) => s + Number(t.pnl ?? 0), 0) / losers.length  : 0;
  const avgWinR    = winners.length > 0 ? winners.reduce((s, t) => s + tradeR(t), 0) / winners.length : 0;
  const avgLossR   = losers.length  > 0 ? losers.reduce( (s, t) => s + tradeR(t), 0) / losers.length  : 0;

  const dayMap     = new Map<number, { pnl: number; trades: number }>();
  wt.forEach(t => {
    const ds  = tradeDate(t); if (!ds) return;
    const dow = new Date(`${ds}T00:00:00`).getDay();
    const idx = dow === 0 ? 6 : dow - 1;
    if (idx < 5) {
      const cur = dayMap.get(idx) ?? { pnl: 0, trades: 0 };
      dayMap.set(idx, { pnl: cur.pnl + Number(t.pnl ?? 0), trades: cur.trades + 1 });
    }
  });

  const dailyPnl: DayBar[] = DOW.map((day, i) => {
    const d = dayMap.get(i);
    return { day, pnl: d?.pnl ?? 0, trades: d?.trades ?? 0 };
  });

  const activeDays = dailyPnl.filter(d => d.trades > 0);
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
    normalizeConfluenceTags(t.confluences).forEach(c => {
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

  const withScore  = wt.filter(t => typeof t.plan_score === 'number');
  const withPlan   = wt.filter(t => typeof t.followed_plan === 'boolean');
  const ruleReport = buildPlanAdherenceReport(entries, riskRules, { bounds: [dateKey(mon), dateKey(sun)] });
  const planAdherence = ruleReport.checked > 0
    ? ruleReport.pct
    : withScore.length > 0
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
    items.push(`"${label}" hit ${winRate}% on ${trades} trades — lead with this setup next week.`);
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

// ─── Background decoration ────────────────────────────────────────
function BgGrid() {
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="wkr-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0 L0 0 0 40" fill="none" stroke="rgba(255,255,255,0.028)" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wkr-grid)" />
    </svg>
  );
}

// ─── Slide shell: content wrapper only, no label ─────────────────
function SlideShell({ children, center = false }: { children: React.ReactNode; center?: boolean }) {
  return (
    <div style={{
      position: 'relative',
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      padding: 'clamp(24px, 4vh, 44px) clamp(24px, 4vw, 60px)',
      boxSizing: 'border-box',
      overflow: 'hidden',
      ...(center ? { alignItems: 'center', justifyContent: 'center' } : {}),
    }}>
      <BgGrid />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%', ...(center ? { alignItems: 'center', justifyContent: 'center' } : {}) }}>
        {children}
      </div>
    </div>
  );
}

// ─── Slide 1: Cover ───────────────────────────────────────────────
function SlideCover({ stats }: { stats: WeekStats }) {
  const positive = stats.netPnl >= 0;
  const pnlColor = positive ? C.grn : C.red;
  const avgR     = stats.tradeCount > 0 ? stats.netR / stats.tradeCount : 0;

  if (stats.tradeCount === 0) {
    return (
      <SlideShell center>
        <p style={{ fontSize: 22, color: C.t1, textAlign: 'center', fontWeight: 600, marginBottom: 10 }}>No trades this week</p>
        <p style={{ fontSize: 13, color: C.t2, textAlign: 'center', maxWidth: 340, lineHeight: 1.7 }}>
          Use ← to view a prior week, or log trades to see your report here.
        </p>
      </SlideShell>
    );
  }

  return (
    <SlideShell center>
      {/* Ambient glow blob behind numbers */}

      <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', width: '100%', maxWidth: 600, margin: '0 auto' }}>
        {/* Outcome chip */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '5px 16px', borderRadius: 24,
          background: `${pnlColor}10`, border: `1px solid ${pnlColor}25`,
          marginBottom: 'clamp(18px, 3.5vh, 32px)',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: pnlColor }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: pnlColor }}>
            {positive ? 'Profitable week' : 'Losing week'}
          </span>
        </div>

        {/* Hero P&L */}
        <div style={{
          fontSize: 'clamp(46px, 10vw, 104px)',
          fontWeight: 800, color: pnlColor,
          letterSpacing: '-0.045em', lineHeight: 1,
          fontFamily: C.mono,
          marginBottom: 'clamp(6px, 1.2vh, 14px)',
        }}>
          {fmtSigned(stats.netPnl)}
        </div>

        {/* Avg R sub-label */}
        <div style={{ fontSize: 'clamp(12px, 1.8vw, 17px)', color: avgR >= 0 ? C.grn : C.red, fontFamily: C.mono, marginBottom: 'clamp(28px, 5vh, 52px)', opacity: 0.75 }}>
          {fmtR(avgR)} avg R per trade
        </div>

        {/* Thin divider */}
        <div style={{ height: 1, width: '50%', margin: '0 auto clamp(24px, 4.5vh, 44px)', background: C.b0 }} />

        {/* 4-stat row */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(20px, 6vw, 64px)' }}>
          {[
            { v: stats.tradeCount,    label: 'Trades',   c: C.t0 },
            { v: `${stats.winRate}%`, label: 'Win Rate', c: stats.winRate >= 50 ? C.grn : C.red },
            { v: stats.losses,        label: 'Losses',   c: C.red },
            { v: stats.sessionCount,  label: 'Sessions', c: C.t0 },
          ].map(item => (
            <div key={item.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 'clamp(22px, 4.5vw, 40px)', fontWeight: 800, color: item.c, lineHeight: 1, fontFamily: C.mono }}>{item.v}</div>
              <div style={{ fontSize: 9.5, color: C.t2, marginTop: 8, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{item.label}</div>
            </div>
          ))}
        </div>

        {/* W/L bar */}
        {(stats.wins + stats.losses) > 0 && (
          <div style={{ marginTop: 'clamp(22px, 4vh, 38px)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <span style={{ fontSize: 11, color: C.t2, fontFamily: C.mono }}>{stats.wins}W</span>
            <div style={{ width: 'clamp(100px, 22vw, 180px)', height: 2, background: C.s3, borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
              <div style={{ flex: stats.wins,   background: C.grn, opacity: 0.7 }} />
              {stats.wins > 0 && stats.losses > 0 && <div style={{ width: 1, background: C.bg }} />}
              <div style={{ flex: stats.losses, background: C.red, opacity: 0.7 }} />
            </div>
            <span style={{ fontSize: 11, color: C.t2, fontFamily: C.mono }}>{stats.losses}L</span>
          </div>
        )}
      </div>
    </SlideShell>
  );
}

// ─── Slide 2: Numbers ─────────────────────────────────────────────
function NumbersChart({ dailyPnl }: { dailyPnl: DayBar[] }) {
  const W = 900, H = 240, midY = 114, usableH = midY - 28, PAD_X = 16;
  const count  = dailyPnl.length || 1;
  const slotW  = (W - PAD_X * 2) / count;
  const barW   = slotW * 0.3;
  const maxAbs = Math.max(...dailyPnl.map(d => Math.abs(d.pnl)), 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="ng-pos" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.grn} stopOpacity="0.85" />
          <stop offset="100%" stopColor={C.grn} stopOpacity="0.08" />
        </linearGradient>
        <linearGradient id="ng-neg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={C.red} stopOpacity="0.08" />
          <stop offset="100%" stopColor={C.red} stopOpacity="0.85" />
        </linearGradient>
      </defs>
      {[0.5, 1].map(f => (
        <line key={f} x1={PAD_X} y1={midY - usableH * f} x2={W - PAD_X} y2={midY - usableH * f}
          stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
      ))}
      <line x1={PAD_X} y1={midY} x2={W - PAD_X} y2={midY} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      {dailyPnl.map((d, i) => {
        const cx    = PAD_X + i * slotW + slotW / 2;
        const isPos = d.pnl >= 0;
        const color = d.pnl === 0 ? C.t2 : isPos ? C.grn : C.red;
        const barH  = d.pnl !== 0 ? Math.max(8, Math.abs(d.pnl) / maxAbs * usableH) : 0;
        const barY  = isPos ? midY - barH : midY;
        const x     = cx - barW / 2;
        return (
          <g key={d.day}>
            {d.pnl !== 0 && (
              <>
                <rect x={x} y={barY} width={barW} height={barH} rx={5}
                  fill={isPos ? 'url(#ng-pos)' : 'url(#ng-neg)'} />
                <rect x={x} y={isPos ? barY : barY + barH - 3} width={barW} height={3} rx={2} fill={color} opacity={0.9} />
              </>
            )}
            {d.pnl !== 0 && (
              <text x={cx} y={isPos ? barY - 9 : barY + barH + 19}
                textAnchor="middle" fill={color}
                fontSize={12} fontFamily="DM Mono,ui-monospace,monospace" fontWeight="700">
                {fmtCompact(d.pnl)}
              </text>
            )}
            {d.pnl === 0 && (
              <text x={cx} y={midY - 10} textAnchor="middle" fill={C.t2} fontSize={20}>—</text>
            )}
            <text x={cx} y={H - 4} textAnchor="middle"
              fill={d.pnl !== 0 ? C.t0 : C.t2}
              fontSize={14} fontFamily="var(--font-sans)" fontWeight={d.pnl !== 0 ? '700' : '400'}>
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
    return (
      <SlideShell center>
        <p style={{ fontSize: 14, color: C.t2 }}>No trade data for this week.</p>
      </SlideShell>
    );
  }
  const positive = stats.netPnl >= 0;
  const heroColor = positive ? C.grn : C.red;
  const avgR = stats.tradeCount > 0 ? stats.netR / stats.tradeCount : 0;

  return (
    <SlideShell>
      {/* Header row: hero P&L + quick stats */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexShrink: 0, marginBottom: 'clamp(14px, 2.5vh, 26px)' }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.t2, marginBottom: 5 }}>Net P&L</div>
          <div style={{ fontSize: 'clamp(32px, 5.5vw, 68px)', fontWeight: 800, fontFamily: C.mono, color: heroColor, lineHeight: 1, letterSpacing: '-0.04em' }}>
            {fmtSigned(stats.netPnl)}
          </div>
          <div style={{ fontSize: 11, color: C.t2, marginTop: 6 }}>{positive ? '↑ Profitable week' : '↓ Losing week'}</div>
        </div>
        <div style={{ display: 'flex', gap: 0, flexShrink: 0, alignSelf: 'center' }}>
          {[
            { label: 'Win Rate', value: `${stats.winRate}%`, sub: `${stats.wins}W · ${stats.losses}L`, color: stats.winRate >= 50 ? C.grn : C.red },
            { label: 'Avg R',   value: fmtR(avgR),           sub: undefined,                           color: avgR >= 0 ? C.grn : C.red },
            { label: 'Trades',  value: String(stats.tradeCount), sub: `${stats.sessionCount} sessions`, color: C.t0 },
          ].map(s => (
            <div key={s.label} style={{ padding: '0 clamp(14px, 2.5vw, 30px)', borderLeft: `1px solid ${C.b0}`, textAlign: 'center' }}>
              <div style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.t2, marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 'clamp(16px, 2.8vw, 26px)', fontWeight: 800, fontFamily: C.mono, color: s.color, lineHeight: 1 }}>{s.value}</div>
              {s.sub && <div style={{ fontSize: 9.5, color: C.t2, marginTop: 4 }}>{s.sub}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* W/L bar */}
      {(stats.wins + stats.losses) > 0 && (
        <div style={{ flexShrink: 0, height: 2, borderRadius: 2, background: C.s3, overflow: 'hidden', display: 'flex', marginBottom: 'clamp(10px, 2vh, 18px)' }}>
          <div style={{ flex: stats.wins,   background: C.grn, opacity: 0.65 }} />
          {stats.wins > 0 && stats.losses > 0 && <div style={{ width: 1, background: C.bg, flexShrink: 0 }} />}
          <div style={{ flex: stats.losses, background: C.red, opacity: 0.65 }} />
        </div>
      )}

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <NumbersChart dailyPnl={stats.dailyPnl} />
      </div>

      {/* Bottom stat strip */}
      <div style={{
        flexShrink: 0, display: 'grid',
        gridTemplateColumns: `repeat(${stats.planAdherence !== null ? 5 : 4}, 1fr)`,
        borderTop: `1px solid ${C.b0}`, paddingTop: 'clamp(10px, 1.8vh, 16px)', marginTop: 'clamp(8px, 1.5vh, 14px)',
      }}>
        {[
          { label: 'Avg Winner', value: stats.wins   ? fmtCurrency(stats.avgWinPnl)               : '—', color: C.grn, sub: stats.wins   ? `${fmtR(stats.avgWinR)} avg`  : undefined },
          { label: 'Avg Loser',  value: stats.losses ? fmtCurrency(Math.abs(stats.avgLossPnl))    : '—', color: C.red, sub: stats.losses ? `${Math.abs(stats.avgLossR).toFixed(2)}R avg` : undefined },
          { label: 'Best Day',   value: stats.bestDayLabel,  color: C.grn, sub: stats.bestDayLabel  !== '—' ? fmtSigned(stats.bestDayPnl)  : undefined },
          { label: 'Worst Day',  value: stats.worstDayLabel, color: C.red, sub: stats.worstDayLabel !== '—' ? fmtSigned(stats.worstDayPnl) : undefined },
          ...(stats.planAdherence !== null
            ? [{ label: 'Plan',  value: `${stats.planAdherence}%`, color: stats.planAdherence >= 70 ? C.grn : stats.planAdherence >= 40 ? C.acc : C.red, sub: undefined }]
            : []),
        ].map((item, i) => (
          <div key={item.label} style={{ padding: '0 10px', borderLeft: i > 0 ? `1px solid ${C.b0}` : 'none' }}>
            <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.t2, marginBottom: 3 }}>{item.label}</div>
            <div style={{ fontSize: 'clamp(11px, 1.4vw, 14px)', fontWeight: 700, fontFamily: C.mono, color: item.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.value}</div>
            {item.sub && <div style={{ fontSize: 9, color: C.t2, marginTop: 2 }}>{item.sub}</div>}
          </div>
        ))}
      </div>
    </SlideShell>
  );
}

// ─── Slide 3: Daily (day cards) ───────────────────────────────────
function DayCard({ d, maxAbs }: { d: DayBar; maxAbs: number }) {
  const active = d.trades > 0;
  const green  = d.pnl > 0;
  const color  = active ? (green ? C.grn : C.red) : C.t2;
  const barPct = active ? Math.max(5, Math.round(Math.abs(d.pnl) / maxAbs * 100)) : 0;

  return (
    <div style={{
      flex: 1, minWidth: 0,
      display: 'flex', flexDirection: 'column',
      borderRadius: 14,
      background: active ? `${color}08` : C.s1,
      border: `1px solid ${active ? `${color}22` : C.b0}`,
      borderTop: `3px solid ${active ? `${color}60` : C.b0}`,
      padding: 'clamp(14px, 2.5vh, 22px) clamp(10px, 1.8vw, 18px)',
      gap: 10,
    }}>
      {/* Day label */}
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: active ? C.t1 : C.t2 }}>
        {d.day}
      </div>

      {/* P&L */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
        {active ? (
          <div style={{
            fontSize: 'clamp(18px, 2.8vw, 32px)',
            fontWeight: 800, fontFamily: C.mono, color, lineHeight: 1,
            letterSpacing: '-0.03em',
          }}>
            {fmtCompact(d.pnl)}
          </div>
        ) : (
          <div style={{ fontSize: 28, color: C.t2, opacity: 0.3, lineHeight: 1 }}>—</div>
        )}
      </div>

      {/* Mini bar fill */}
      <div style={{ height: 3, borderRadius: 2, background: C.s3, overflow: 'hidden' }}>
        {active && <div style={{ width: `${barPct}%`, height: '100%', background: color, opacity: 0.6, borderRadius: 2 }} />}
      </div>

      {/* Trade count */}
      <div style={{ fontSize: 10, color: active ? C.t2 : C.t2, opacity: active ? 0.8 : 0.4 }}>
        {active ? `${d.trades} trade${d.trades !== 1 ? 's' : ''}` : 'No trades'}
      </div>
    </div>
  );
}

function SlideDaily({ stats }: { stats: WeekStats }) {
  const maxAbs = Math.max(...stats.dailyPnl.map(d => Math.abs(d.pnl)), 1);
  const totalActiveDays = stats.dailyPnl.filter(d => d.trades > 0).length;

  return (
    <SlideShell>
      {/* Section title */}
      <div style={{ flexShrink: 0, marginBottom: 'clamp(14px, 2.5vh, 28px)' }}>
        <div style={{ fontSize: 'clamp(20px, 3vw, 32px)', fontWeight: 700, color: C.t0, letterSpacing: '-0.02em', marginBottom: 4 }}>
          Day by Day
        </div>
        <div style={{ fontSize: 11, color: C.t2 }}>
          {totalActiveDays} active {totalActiveDays === 1 ? 'day' : 'days'} · {stats.weekLabel}
        </div>
      </div>

      {/* 5-column day cards */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 'clamp(8px, 1.5vw, 16px)' }}>
        {stats.dailyPnl.map(d => <DayCard key={d.day} d={d} maxAbs={maxAbs} />)}
      </div>

      {/* Summary row */}
      {stats.tradeCount > 0 && (
        <div style={{
          flexShrink: 0,
          display: 'flex', gap: 'clamp(14px, 3vw, 32px)',
          alignItems: 'center',
          marginTop: 'clamp(14px, 2.5vh, 22px)',
          paddingTop: 'clamp(12px, 2vh, 20px)',
          borderTop: `1px solid ${C.b0}`,
        }}>
          {stats.bestDayLabel !== '—' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.t2 }}>Best</span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: C.mono, color: C.grn }}>{stats.bestDayLabel} · {fmtSigned(stats.bestDayPnl)}</span>
            </div>
          )}
          {stats.worstDayLabel !== '—' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: C.t2 }}>Worst</span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: C.mono, color: C.red }}>{stats.worstDayLabel} · {fmtSigned(stats.worstDayPnl)}</span>
            </div>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 11, color: C.t2, fontFamily: C.mono }}>
            Net: <span style={{ color: stats.netPnl >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtSigned(stats.netPnl)}</span>
          </div>
        </div>
      )}
    </SlideShell>
  );
}

// ─── Slide 4: Edge Analysis ────────────────────────────────────────
function InfoCard({ label, value, sub, color, filled = false }: { label: string; value: string; sub?: string; color: string; filled?: boolean }) {
  return (
    <div style={{
      padding: 'clamp(12px, 1.8vh, 18px) clamp(12px, 1.6vw, 18px)',
      background: filled ? `${color}0d` : C.s2,
      border: `1px solid ${filled ? `${color}25` : C.b0}`,
      borderRadius: 10, flex: 1,
    }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.t2, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 'clamp(18px, 2.5vw, 26px)', fontWeight: 800, fontFamily: C.mono, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.t2, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function FindingRow({ icon, text, accent }: { icon: string; text: string; accent: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '11px 14px',
      background: `${accent}07`,
      border: `1px solid ${accent}18`,
      borderLeft: `3px solid ${accent}50`,
      borderRadius: 9,
    }}>
      <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1, color: accent }}>{icon}</span>
      <span style={{ fontSize: 12.5, color: C.t0, lineHeight: 1.55 }}>{text}</span>
    </div>
  );
}

function SlidePatterns({ stats }: { stats: WeekStats }) {
  const avgR   = stats.tradeCount > 0 ? stats.netR / stats.tradeCount : 0;
  const rrRatio = stats.wins > 0 && stats.losses > 0 && Math.abs(stats.avgLossR) > 0
    ? Math.abs(stats.avgWinR / stats.avgLossR)
    : null;

  // build "clicked" and "cost" finding lists
  const clicked: { icon: string; text: string; accent: string }[] = [];
  const cost:    { icon: string; text: string; accent: string }[] = [];

  stats.topConfluences.filter(c => c.winRate >= 60).forEach(c =>
    clicked.push({ icon: '↑', text: `${c.label} — ${c.winRate}% win rate across ${c.trades} trades`, accent: C.grn }));
  stats.topConfluences.filter(c => c.winRate < 60).forEach(c =>
    cost.push({ icon: '↓', text: `${c.label} — only ${c.winRate}% win rate (${c.trades} trades)`, accent: C.red }));
  stats.behavioralFlags.forEach(f =>
    cost.push({ icon: '!', text: `"${f.flag}" flagged ${f.count}× this week`, accent: C.acc }));

  if (stats.bestDayLabel !== '—')
    clicked.push({ icon: '★', text: `Best day was ${stats.bestDayLabel} (${fmtSigned(stats.bestDayPnl)})`, accent: C.grn });
  if (stats.worstDayLabel !== '—')
    cost.push({ icon: '↓', text: `Worst day was ${stats.worstDayLabel} (${fmtSigned(stats.worstDayPnl)})`, accent: C.red });

  if (stats.wins > 0 && stats.losses > 0) {
    if (Math.abs(stats.avgLossPnl) > stats.avgWinPnl)
      cost.push({ icon: '≠', text: `Avg loss (${fmtCurrency(Math.abs(stats.avgLossPnl))}) exceeded avg win (${fmtCurrency(stats.avgWinPnl)}) — R:R needs work`, accent: C.red });
    else
      clicked.push({ icon: '✓', text: `Avg win (${fmtCurrency(stats.avgWinPnl)}) exceeded avg loss (${fmtCurrency(Math.abs(stats.avgLossPnl))}) — solid R:R`, accent: C.grn });
  }
  if (stats.planAdherence !== null) {
    if (stats.planAdherence >= 70)
      clicked.push({ icon: '✓', text: `Plan adherence: ${stats.planAdherence}% — stayed disciplined`, accent: C.grn });
    else
      cost.push({ icon: '!', text: `Plan adherence only ${stats.planAdherence}% — consistency needed`, accent: C.acc });
  }
  if (stats.winRate >= 60 && stats.tradeCount >= 3)
    clicked.push({ icon: '↑', text: `${stats.winRate}% win rate over ${stats.tradeCount} trades — above expectancy`, accent: C.grn });
  else if (stats.winRate < 40 && stats.tradeCount >= 3)
    cost.push({ icon: '↓', text: `${stats.winRate}% win rate over ${stats.tradeCount} trades — below threshold`, accent: C.red });

  if (clicked.length === 0)
    clicked.push({ icon: '—', text: 'Tag confluences on each trade to identify what setups work best for you.', accent: C.t2 });
  if (cost.length === 0)
    cost.push({ icon: '—', text: 'No issues flagged — keep logging to surface patterns over time.', accent: C.t2 });

  // Avg winner vs loser visual bar
  const maxBar = Math.max(stats.avgWinPnl, Math.abs(stats.avgLossPnl), 1);
  const winBarPct  = stats.wins   > 0 ? Math.round(stats.avgWinPnl            / maxBar * 100) : 0;
  const lossBarPct = stats.losses > 0 ? Math.round(Math.abs(stats.avgLossPnl) / maxBar * 100) : 0;

  return (
    <SlideShell>
      {/* Header */}
      <div style={{ flexShrink: 0, marginBottom: 'clamp(12px, 2vh, 20px)' }}>
        <div style={{ fontSize: 'clamp(20px, 3vw, 30px)', fontWeight: 700, color: C.t0, letterSpacing: '-0.02em', marginBottom: 3 }}>Edge Analysis</div>
        <div style={{ fontSize: 11, color: C.t2 }}>Performance breakdown for {stats.weekLabel}</div>
      </div>

      {/* Top stat cards */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 'clamp(8px, 1.2vw, 14px)', marginBottom: 'clamp(10px, 1.8vh, 18px)' }}>
        <InfoCard label="Win Rate"   value={`${stats.winRate}%`}                                          sub={`${stats.wins}W · ${stats.losses}L`}         color={stats.winRate >= 50 ? C.grn : C.red} filled />
        <InfoCard label="Avg Winner" value={stats.wins   > 0 ? fmtCurrency(stats.avgWinPnl)            : '—'} sub={stats.wins   > 0 ? `${fmtR(stats.avgWinR)} avg`  : undefined} color={C.grn} filled />
        <InfoCard label="Avg Loser"  value={stats.losses > 0 ? fmtCurrency(Math.abs(stats.avgLossPnl)) : '—'} sub={stats.losses > 0 ? `${Math.abs(stats.avgLossR).toFixed(2)}R avg` : undefined} color={C.red} filled />
        <InfoCard label="Avg R"      value={stats.tradeCount > 0 ? fmtR(avgR) : '—'}                        sub={rrRatio !== null ? `${rrRatio.toFixed(2)}:1 R:R` : undefined}  color={avgR >= 0 ? C.grn : C.red} filled />
        {stats.planAdherence !== null && (
          <InfoCard label="Plan" value={`${stats.planAdherence}%`} sub="adherence" color={stats.planAdherence >= 70 ? C.grn : stats.planAdherence >= 40 ? C.acc : C.red} filled />
        )}
      </div>

      {/* Winner vs Loser comparison bar */}
      {stats.wins > 0 && stats.losses > 0 && (
        <div style={{ flexShrink: 0, marginBottom: 'clamp(10px, 1.8vh, 18px)', padding: '10px 14px', background: C.s2, borderRadius: 10, border: `1px solid ${C.b0}` }}>
          <div style={{ fontSize: 8.5, color: C.t2, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 8 }}>Avg Winner vs Avg Loser</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 56, fontSize: 10, color: C.grn, textAlign: 'right', flexShrink: 0, fontFamily: C.mono }}>Win</span>
              <div style={{ flex: 1, height: 10, background: C.s3, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${winBarPct}%`, height: '100%', background: `${C.grn}70`, borderRadius: 3, borderRight: `2px solid ${C.grn}` }} />
              </div>
              <span style={{ width: 80, fontSize: 11, color: C.grn, fontFamily: C.mono, fontWeight: 700, flexShrink: 0 }}>{fmtCurrency(stats.avgWinPnl)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 56, fontSize: 10, color: C.red, textAlign: 'right', flexShrink: 0, fontFamily: C.mono }}>Loss</span>
              <div style={{ flex: 1, height: 10, background: C.s3, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${lossBarPct}%`, height: '100%', background: `${C.red}70`, borderRadius: 3, borderRight: `2px solid ${C.red}` }} />
              </div>
              <span style={{ width: 80, fontSize: 11, color: C.red, fontFamily: C.mono, fontWeight: 700, flexShrink: 0 }}>-{fmtCurrency(Math.abs(stats.avgLossPnl))}</span>
            </div>
          </div>
        </div>
      )}

      {/* Two columns of findings */}
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(12px, 2vw, 24px)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 }}>
          <div style={{ fontSize: 9, color: C.grn, marginBottom: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', flexShrink: 0 }}>What clicked</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            {clicked.map((f, i) => <FindingRow key={i} {...f} />)}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 }}>
          <div style={{ fontSize: 9, color: C.red, marginBottom: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', flexShrink: 0 }}>What cost you</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            {cost.map((f, i) => <FindingRow key={i} {...f} />)}
          </div>
        </div>
      </div>
    </SlideShell>
  );
}

// ─── Slide 5: Reflection ──────────────────────────────────────────
function SlideReflection({
  stats, reflection, onSave, textareaRef,
}: {
  stats: WeekStats; reflection: string; onSave: (v: string) => void; textareaRef: RefObject<HTMLTextAreaElement>;
}) {
  return (
    <SlideShell center>
      <div style={{ maxWidth: 560, width: '100%' }}>
        <div style={{ marginBottom: 'clamp(20px, 3.5vh, 32px)' }}>
          <div style={{ fontSize: 'clamp(20px, 3vw, 30px)', fontWeight: 700, color: C.t0, letterSpacing: '-0.02em', marginBottom: 8 }}>Reflection</div>
          <p style={{ fontSize: 'clamp(13px, 1.8vw, 16px)', color: C.t1, lineHeight: 1.6, margin: 0 }}>
            What is the one thing that needs to change for next week to be better?
          </p>
        </div>
        <textarea
          ref={textareaRef}
          value={reflection}
          onChange={e => onSave(e.target.value)}
          placeholder="Write your reflection here. Saved automatically."
          rows={5}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: C.s2, border: `1px solid ${C.b1}`,
            borderRadius: 12, padding: '16px 20px',
            color: C.t0, fontSize: 14, lineHeight: 1.8,
            resize: 'none', outline: 'none', fontFamily: 'inherit',
            transition: 'border-color 0.2s',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = `${C.acc}55`; }}
          onBlur={e  => { e.currentTarget.style.borderColor = C.b1; }}
        />
        <p style={{ fontSize: 10.5, color: C.t2, marginTop: 10 }}>
          {reflection ? `Saved · ${stats.weekLabel}` : 'Start typing — it saves automatically.'}
        </p>
      </div>
    </SlideShell>
  );
}

// ─── Slide 6: Action Plan ─────────────────────────────────────────
function SlideFocus({ items, stats }: { items: string[]; stats: WeekStats }) {
  return (
    <SlideShell center>
      <div style={{ maxWidth: 560, width: '100%' }}>
        <div style={{ marginBottom: 'clamp(20px, 3.5vh, 32px)' }}>
          <div style={{ fontSize: 'clamp(20px, 3vw, 30px)', fontWeight: 700, color: C.t0, letterSpacing: '-0.02em', marginBottom: 8 }}>Action Plan</div>
          <div style={{ fontSize: 11, color: C.t2 }}>Based on {stats.weekLabel} — focus on these next week.</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(10px, 1.8vh, 16px)' }}>
          {items.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, padding: 'clamp(14px, 2vh, 20px) clamp(14px, 2.5vw, 22px)', background: C.s2, border: `1px solid ${C.b0}`, borderRadius: 12 }}>
              <span style={{
                flexShrink: 0, width: 26, height: 26,
                background: `${C.acc}14`, border: `1px solid ${C.acc}2e`, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 800, color: C.acc, fontFamily: C.mono, marginTop: 2,
              }}>{i + 1}</span>
              <p style={{ fontSize: 'clamp(13px, 1.6vw, 15px)', color: C.t0, lineHeight: 1.65, margin: 0 }}>{item}</p>
            </div>
          ))}
        </div>
      </div>
    </SlideShell>
  );
}

// ─── Share modal ──────────────────────────────────────────────────
const SHARE_PLATFORMS = [
  { id: 'instagram', name: 'Instagram', color: '#E1306C', bg: '#E1306C15' },
  { id: 'tiktok',   name: 'TikTok',    color: '#FE2C55', bg: '#FE2C5515' },
  { id: 'snapchat', name: 'Snapchat',  color: '#FFCA28', bg: '#FFCA2815' },
  { id: 'discord',  name: 'Discord',   color: '#5865F2', bg: '#5865F215' },
  { id: 'x',        name: 'X',         color: '#e8e8e8', bg: '#e8e8e810' },
] as const;

const SI_MAP: Record<string, { path: string; viewBox?: string }> = {
  instagram: siInstagram,
  tiktok:    siTiktok,
  snapchat:  siSnapchat,
  discord:   siDiscord,
  x:         siX,
};

function PlatformIcon({ id, color }: { id: string; color: string }) {
  const icon = SI_MAP[id];
  if (!icon) return null;
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} fill={color} aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}

function ShareModal({
  previewUrl, capturing, weekLabel, slideLabel, copyDone,
  onDownload, onCopy, onPlatform, onClose,
}: {
  previewUrl: string | null; capturing: boolean;
  weekLabel: string; slideLabel: string; copyDone: boolean;
  onDownload: () => void; onCopy: () => void;
  onPlatform: (id: string) => void; onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f0e0d',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 20, padding: '26px 26px 22px',
        width: 'min(94vw, 430px)',
        boxShadow: '0 32px 96px rgba(0,0,0,0.7)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}>Share your report</div>
            <div style={{ fontSize: 11, color: C.t2, marginTop: 3 }}>{slideLabel} · {weekLabel}</div>
          </div>
          <button type="button" onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 8, border: `1px solid ${C.b0}`,
            background: 'transparent', color: C.t1, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <X size={13} />
          </button>
        </div>

        {/* Slide preview */}
        <div style={{
          height: 132, borderRadius: 12, overflow: 'hidden',
          background: C.s2, border: `1px solid ${C.b0}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}>
          {capturing && <span style={{ fontSize: 12, color: C.t2 }}>Generating preview…</span>}
          {!capturing && previewUrl && (
            <img src={previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
          {!capturing && !previewUrl && (
            <span style={{ fontSize: 12, color: C.t2 }}>Preview unavailable</span>
          )}
        </div>

        {/* Platform buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 16 }}>
          {SHARE_PLATFORMS.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPlatform(p.id)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
                padding: '13px 4px 11px', borderRadius: 14,
                border: `1px solid ${p.color}20`,
                background: p.bg, cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = `${p.color}28`; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = p.bg; }}
            >
              <PlatformIcon id={p.id} color={p.color} />
              <span style={{ fontSize: 9.5, color: p.color, fontWeight: 600, letterSpacing: '0.02em' }}>{p.name}</span>
            </button>
          ))}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: C.b0, margin: '0 0 14px' }} />

        {/* Download + Copy row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onDownload} style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            padding: '10px 0', borderRadius: 10,
            border: `1px solid ${C.b1}`, background: C.s2,
            color: C.t0, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            <Download size={13} style={{ color: C.acc }} /> Download PNG
          </button>
          <button type="button" onClick={onCopy} style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            padding: '10px 0', borderRadius: 10,
            border: `1px solid ${copyDone ? `${C.grn}40` : C.b1}`,
            background: copyDone ? `${C.grn}0c` : C.s2,
            color: copyDone ? C.grn : C.t0, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', transition: 'all 0.2s',
          }}>
            {copyDone
              ? <><Check size={13} /> Copied!</>
              : <><Copy size={13} style={{ color: C.acc }} /> Copy image</>}
          </button>
        </div>

        {/* Hint */}
        <div style={{ fontSize: 10.5, color: C.t2, textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
          {typeof navigator.share === 'function'
            ? 'Tap a platform to open your share sheet'
            : 'Download the image, then upload to your platform'}
        </div>
      </div>
    </div>
  );
}

// ─── Slides registry ──────────────────────────────────────────────
type SlideKey = 'cover' | 'numbers' | 'daily' | 'patterns' | 'reflection' | 'focus';
const SLIDES: SlideKey[] = ['cover', 'numbers', 'daily', 'patterns', 'reflection', 'focus'];
const SLIDE_LABELS: Record<SlideKey, string> = {
  cover:      'Weekly Overview',
  numbers:    'By the Numbers',
  daily:      'Day by Day',
  patterns:   'Edge Analysis',
  reflection: 'Reflection',
  focus:      'Action Plan',
};

// ─── Main component ───────────────────────────────────────────────
export default function FlyxaAIWeeklyReport() {
  const navigate                          = useNavigate();
  const { trades, loading }               = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const entries                           = useFlyxaStore(state => state.entries);
  const riskRules                         = useFlyxaStore(state => state.riskRules);
  const [weekOffset, setWeekOffset]       = useState(0);
  const [slideIndex, setSlideIndex]       = useState(0);
  const [direction, setDirection]         = useState<'fwd' | 'bwd'>('fwd');
  const [animKey, setAnimKey]             = useState(0);
  const [reflection, setReflection]       = useState('');
  const [shareOpen, setShareOpen]         = useState(false);
  const [previewUrl, setPreviewUrl]       = useState<string | null>(null);
  const [capturing, setCapturing]         = useState(false);
  const [copyDone, setCopyDone]           = useState(false);
  const textareaRef                       = useRef<HTMLTextAreaElement>(null);
  const slideAreaRef                      = useRef<HTMLDivElement>(null);

  const accountTrades = useMemo(() => filterTradesBySelectedAccount(trades), [filterTradesBySelectedAccount, trades]);
  const safeTrades    = useMemo(() => accountTrades.filter((t): t is Trade => Boolean(t)), [accountTrades]);
  const stats         = useMemo(() => computeWeekStats(safeTrades, weekOffset, entries as StoreJournalEntry[], riskRules), [entries, riskRules, safeTrades, weekOffset]);
  const actionPlan    = useMemo(() => generateActionPlan(stats), [stats]);

  useEffect(() => { window.dispatchEvent(new CustomEvent('flyxa:collapse-sidebar')); }, []);

  const storageKey = `flyxa.weekly-reflection.${stats.weekKey}`;
  useEffect(() => {
    try { setReflection(localStorage.getItem(storageKey) ?? ''); } catch { /* ignore */ }
  }, [storageKey]);
  const saveReflection = useCallback((v: string) => {
    setReflection(v);
    try { localStorage.setItem(storageKey, v); } catch { /* ignore */ }
  }, [storageKey]);

  const captureSlide = useCallback(async (): Promise<{ blob: Blob; dataUrl: string } | null> => {
    const el = slideAreaRef.current;
    if (!el) return null;
    try {
      const dataUrl = await toPng(el, { cacheBust: true, pixelRatio: 2, backgroundColor: C.bg });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      return { blob, dataUrl };
    } catch { return null; }
  }, []);

  const openShare = useCallback(async () => {
    setShareOpen(true);
    setPreviewUrl(null);
    setCapturing(true);
    const captured = await captureSlide();
    setCapturing(false);
    if (captured) setPreviewUrl(captured.dataUrl);
  }, [captureSlide]);

  const triggerDownload = useCallback((dataUrl: string) => {
    const a = document.createElement('a');
    a.href     = dataUrl;
    a.download = `flyxa-${SLIDE_LABELS[SLIDES[slideIndex]].toLowerCase().replace(/\s+/g, '-')}-${stats.weekKey}.png`;
    a.click();
  }, [slideIndex, stats.weekKey]);

  const handleDownload = useCallback(async () => {
    const captured = previewUrl ? { dataUrl: previewUrl, blob: null } : await captureSlide();
    if (captured) triggerDownload(captured.dataUrl);
    setShareOpen(false);
  }, [captureSlide, previewUrl, triggerDownload]);

  const handleCopy = useCallback(async () => {
    const captured = await captureSlide();
    if (!captured) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': captured.blob })]);
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 2500);
    } catch { /* fallback */ }
  }, [captureSlide]);

  const handlePlatform = useCallback(async (platformId: string) => {
    const captured = await captureSlide();
    if (!captured) return;
    const file = new File([captured.blob], `flyxa-weekly-${stats.weekKey}.png`, { type: 'image/png' });

    // Mobile: open native share sheet (includes IG, TikTok, Snap, Discord, etc.)
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Flyxa Weekly Report', text: `${stats.weekLabel} · ${fmtSigned(stats.netPnl)}` });
        setShareOpen(false);
        return;
      } catch { /* cancelled or not available */ }
    }

    // Desktop fallbacks per platform
    if (platformId === 'discord') {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': captured.blob })]);
        setCopyDone(true);
        setTimeout(() => setCopyDone(false), 2500);
      } catch { triggerDownload(captured.dataUrl); }
    } else if (platformId === 'x') {
      triggerDownload(captured.dataUrl);
      const text = `My trading week: ${fmtSigned(stats.netPnl)} · ${stats.winRate}% win rate · ${stats.tradeCount} trades #trading`;
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
      setShareOpen(false);
    } else {
      // Instagram, TikTok, Snapchat — download and user uploads manually
      triggerDownload(captured.dataUrl);
      setShareOpen(false);
    }
  }, [captureSlide, stats, triggerDownload]);

  const goTo = useCallback((next: number) => {
    if (next === slideIndex) return;
    setDirection(next > slideIndex ? 'fwd' : 'bwd');
    setSlideIndex(next);
    setAnimKey(k => k + 1);
  }, [slideIndex]);
  const goPrev = () => goTo(Math.max(0, slideIndex - 1));
  const goNext = () => goTo(Math.min(SLIDES.length - 1, slideIndex + 1));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); goNext(); }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')                     { e.preventDefault(); goPrev(); }
      if (e.key === 'Escape') navigate('/flyxa-ai');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIndex]);

  const currentSlide = SLIDES[slideIndex];
  const animClass    = `wkr-enter-${direction}`;

  return (
    <div className="animate-fade-in" style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 72, zIndex: 800,
      background: C.bg, color: C.t0,
      display: 'flex', flexDirection: 'column',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* ── Top chrome: FLYXA brand · slide name · week · dots · X ── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        padding: '0 clamp(14px, 3vw, 32px)', height: 50,
        borderBottom: `1px solid ${C.b0}`,
        gap: 16,
      }}>
        {/* Flyxa logo + wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <img src="/logo.svg" alt="Flyxa" style={{ width: 26, height: 26, flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: C.t1, textTransform: 'uppercase', userSelect: 'none' }}>
            Flyxa
          </span>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 14, background: C.b0, flexShrink: 0 }} />

        {/* Slide name */}
        <span style={{ fontSize: 11, color: C.t0, fontWeight: 600, letterSpacing: '0.03em', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {SLIDE_LABELS[currentSlide]}
        </span>

        {/* Week nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button type="button" onClick={() => setWeekOffset(w => w + 1)} style={chromeBtnStyle}>←</button>
          <span style={{ fontSize: 10.5, color: C.t2, minWidth: 'clamp(80px, 18vw, 150px)', textAlign: 'center', fontFamily: C.mono }}>
            {stats.weekLabel}
          </span>
          <button type="button" onClick={() => setWeekOffset(w => Math.max(0, w - 1))} disabled={weekOffset === 0}
            style={{ ...chromeBtnStyle, opacity: weekOffset === 0 ? 0.2 : 1, cursor: weekOffset === 0 ? 'not-allowed' : 'pointer' }}>→</button>
        </div>

        {/* Dots */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {SLIDES.map((key, i) => (
            <button key={key} type="button" title={SLIDE_LABELS[key]} onClick={() => goTo(i)} style={{
              width: i === slideIndex ? 18 : 5, height: 5, borderRadius: 3,
              background: i === slideIndex ? C.acc : C.b1,
              border: 'none', padding: 0, cursor: 'pointer', transition: 'all 0.22s ease',
            }} />
          ))}
        </div>

        {/* Share button */}
        <button
          type="button"
          onClick={openShare}
          title="Share slide"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', height: 28, borderRadius: 6,
            border: `1px solid ${C.b1}`,
            background: 'transparent', color: C.t1,
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            flexShrink: 0, transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${C.acc}55`; (e.currentTarget as HTMLButtonElement).style.color = C.acc; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = C.b1; (e.currentTarget as HTMLButtonElement).style.color = C.t1; }}
        >
          <Share2 size={12} /> Share
        </button>

        {/* Exit */}
        <button type="button" onClick={() => navigate('/flyxa-ai')} title="Exit (Esc)"
          style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${C.b0}`, background: 'transparent', color: C.t1, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <X size={13} />
        </button>
      </div>

      {/* ── Slide area ────────────────────────────────────────────── */}
      <div ref={slideAreaRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div onClick={goPrev} style={{ position: 'absolute', inset: '0 65% 0 0', zIndex: 1, cursor: slideIndex > 0 ? 'w-resize' : 'default' }} />
        <div onClick={goNext} style={{ position: 'absolute', inset: '0 0 0 65%', zIndex: 1, cursor: slideIndex < SLIDES.length - 1 ? 'e-resize' : 'default' }} />

        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 13, color: C.t2 }}>Loading trade data…</span>
          </div>
        )}

        {!loading && (
          <div key={animKey} className={animClass}
            style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {currentSlide === 'cover'      && <SlideCover      stats={stats} />}
            {currentSlide === 'numbers'    && <SlideNumbers    stats={stats} />}
            {currentSlide === 'daily'      && <SlideDaily      stats={stats} />}
            {currentSlide === 'patterns'   && <SlidePatterns   stats={stats} />}
            {currentSlide === 'reflection' && (
              <SlideReflection stats={stats} reflection={reflection} onSave={saveReflection} textareaRef={textareaRef} />
            )}
            {currentSlide === 'focus'      && <SlideFocus      items={actionPlan} stats={stats} />}
          </div>
        )}
      </div>

      {/* ── Share modal ───────────────────────────────────────────── */}
      {shareOpen && (
        <ShareModal
          previewUrl={previewUrl}
          capturing={capturing}
          weekLabel={stats.weekLabel}
          slideLabel={SLIDE_LABELS[currentSlide]}
          copyDone={copyDone}
          onDownload={handleDownload}
          onCopy={handleCopy}
          onPlatform={handlePlatform}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* ── Bottom chrome ─────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 clamp(14px, 3vw, 32px)', height: 46,
        borderTop: `1px solid ${C.b0}`,
      }}>
        <button type="button" onClick={goPrev} disabled={slideIndex === 0}
          style={{ ...chromeBtnStyle, gap: 5, display: 'flex', alignItems: 'center', opacity: slideIndex === 0 ? 0.2 : 1, cursor: slideIndex === 0 ? 'not-allowed' : 'pointer' }}>
          <ChevronLeft size={12} /> Prev
        </button>
        <span style={{ fontSize: 10, color: C.t2, fontFamily: C.mono, letterSpacing: '0.06em' }}>
          {pad2(slideIndex + 1)} / {pad2(SLIDES.length)}
        </span>
        <button type="button" onClick={goNext} disabled={slideIndex === SLIDES.length - 1}
          style={{ ...chromeBtnStyle, gap: 5, display: 'flex', alignItems: 'center', opacity: slideIndex === SLIDES.length - 1 ? 0.2 : 1, cursor: slideIndex === SLIDES.length - 1 ? 'not-allowed' : 'pointer' }}>
          Next <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

const chromeBtnStyle = {
  padding: '5px 11px', fontSize: 11, color: C.t1,
  background: 'transparent', border: `1px solid ${C.b0}`,
  borderRadius: 5, cursor: 'pointer',
} as const;
