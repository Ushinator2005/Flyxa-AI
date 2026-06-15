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
function MetricCard({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div style={{
      padding: '22px 20px',
      background: C.d2,
      border: `1px solid ${C.b0}`,
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <span style={{ fontSize: 9.5, color: C.t2, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 28, fontWeight: 700, color: valueColor ?? C.t0, fontFamily: C.mono, lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11.5, color: C.t2 }}>{sub}</span>}
    </div>
  );
}

function SlideNumbers({ stats }: { stats: WeekStats }) {
  if (stats.tradeCount === 0) {
    return (
      <SlideEmpty label="By the Numbers" message="No trade data for this week." />
    );
  }

  const cards = [
    { label: 'Net P&L',       value: fmtSigned(stats.netPnl),               sub: undefined,                                                          valueColor: stats.netPnl >= 0 ? C.grn : C.red },
    { label: 'Net R',          value: fmtR(stats.netR),                       sub: undefined,                                                          valueColor: stats.netR   >= 0 ? C.grn : C.red },
    { label: 'Win Rate',       value: `${stats.winRate}%`,                    sub: `${stats.wins}W · ${stats.losses}L`,                                valueColor: stats.winRate >= 50 ? C.grn : C.red },
    { label: 'Sessions',       value: String(stats.sessionCount),             sub: `${stats.tradeCount} trades`,                                       valueColor: C.t0 },
    { label: 'Avg Winner',     value: stats.wins ? fmtCurrency(stats.avgWinPnl) : '—',       sub: stats.wins ? `${stats.avgWinR.toFixed(2)}R avg` : undefined,     valueColor: stats.wins ? C.grn : C.t2 },
    { label: 'Avg Loser',      value: stats.losses ? fmtCurrency(Math.abs(stats.avgLossPnl)) : '—', sub: stats.losses ? `${Math.abs(stats.avgLossR).toFixed(2)}R avg` : undefined, valueColor: stats.losses ? C.red : C.t2 },
    { label: 'Best Day',       value: stats.bestDayLabel,                     sub: stats.bestDayLabel  !== '—' ? fmtSigned(stats.bestDayPnl)  : undefined, valueColor: stats.bestDayLabel  !== '—' ? C.grn : C.t2 },
    { label: 'Worst Day',      value: stats.worstDayLabel,                    sub: stats.worstDayLabel !== '—' ? fmtSigned(stats.worstDayPnl) : undefined, valueColor: stats.worstDayLabel !== '—' ? C.red : C.t2 },
    ...(stats.planAdherence !== null
      ? [{ label: 'Plan Adherence', value: `${stats.planAdherence}%`, sub: undefined, valueColor: stats.planAdherence >= 70 ? C.grn : stats.planAdherence >= 40 ? C.amb : C.red }]
      : []),
  ];

  return (
    <SlideLayout label="By the Numbers">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 }}>
        {cards.map(c => <MetricCard key={c.label} {...c} />)}
      </div>
    </SlideLayout>
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
        inset: 0,
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
