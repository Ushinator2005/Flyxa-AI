import React, { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Send, RotateCcw, Sparkles, X, ArrowRight } from 'lucide-react';
import { useTrades, toApiTrade } from '../hooks/useTrades.js';
import { computeAllStats, QUICK_QUESTIONS } from '../utils/askFlyxa.js';
import { api, aiApi } from '../services/api.js';
import type { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}
function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}
function normalizeConfluences(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') { try { const p = JSON.parse(value); return Array.isArray(p) ? p.filter((v): v is string => typeof v === 'string') : []; } catch { return []; } }
  return [];
}

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  d0: 'var(--d0, #0e0d0d)',
  d1: 'var(--d1, #141312)',
  d2: 'var(--d2, #1a1917)',
  d3: 'var(--d3, #201f1d)',
  d4: 'var(--d4, #27251f)',
  b0: 'var(--b0, rgba(255,255,255,0.07))',
  b1: 'var(--b1, rgba(255,255,255,0.12))',
  t0: 'var(--t0, #e8e3dc)',
  t1: 'var(--t1, #8a8178)',
  t2: 'var(--t2, #5c5751)',
  acc: 'var(--acc, #f59e0b)',
  grn: 'var(--grn, #22d68a)',
  red: 'var(--red, #f05252)',
  sans: 'var(--font-sans, Inter, sans-serif)',
};

// ─── Trade review renderer ──────────────────────────────────────────────────────
// Wraps numbers/percentages/ratios in styled chips
function inlineChips(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|-?\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%|\b\d+\.\d+x\b|\b\d+(?:\.\d+)?R\b)/);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ color: C.t0, fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    if (/^-?\$[\d,]+(?:\.\d+)?$/.test(part) || /^\d+(?:\.\d+)?%$/.test(part) || /^\d+\.\d+x$/.test(part) || /^\d+(?:\.\d+)?R$/.test(part)) {
      return (
        <span key={i} style={{
          display: 'inline', padding: '1px 5px', margin: '0 1px',
          background: 'rgba(245,158,11,0.11)', border: '1px solid rgba(245,158,11,0.22)',
          borderRadius: 4, color: C.acc, fontWeight: 700,
          fontSize: 12, fontVariantNumeric: 'tabular-nums',
          fontFamily: 'var(--font-mono, monospace)',
        }}>{part}</span>
      );
    }
    return part;
  });
}

interface ReviewSection { label: string; verdict: string | null; bullets: string[]; insights: string[]; prose: string[]; tags: string[]; rule: string | null; }

function parseReviewSections(text: string): ReviewSection[] {
  const sections: ReviewSection[] = [];
  let current: ReviewSection | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { label: line.slice(3).trim(), verdict: null, bullets: [], insights: [], prose: [], tags: [], rule: null };
    } else if (current) {
      const trimmed = line.trim();
      if (/^\*\*.*\*\*$/.test(trimmed) && !current.verdict) {
        current.verdict = trimmed.slice(2, -2);
      } else if (/^> /.test(line)) {
        current.insights.push(line.replace(/^> /, '').trim());
      } else if (/^TAGS:/i.test(trimmed)) {
        current.tags = trimmed.replace(/^TAGS:\s*/i, '').split(',').map(t => t.trim()).filter(Boolean);
      } else if (/^RULE:/i.test(trimmed)) {
        current.rule = trimmed.replace(/^RULE:\s*/i, '');
      } else if (/^[-*] /.test(line)) {
        current.bullets.push(line.replace(/^[-*] /, ''));
      } else if (trimmed) {
        current.prose.push(trimmed);
      }
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ── Score computation ──────────────────────────────────────────────────────────
function computeTradeScores(trade: Trade) {
  const t = trade as unknown as Record<string, unknown>;
  const entryPrice = Number(t.entry_price ?? 0);
  const slPrice = Number(t.sl_price ?? 0);
  const tpPrice = Number(t.tp_price ?? 0);
  const pnl = Number(t.pnl ?? 0);
  const contracts = Number(t.contract_size ?? 1);
  const pointValue = Number(t.point_value ?? 1);
  const rr = slPrice && entryPrice && tpPrice ? Math.abs(tpPrice - entryPrice) / Math.abs(slPrice - entryPrice) : 0;
  const emotion = String(t.emotional_state ?? '');
  const followed = t.followed_plan === true;
  const confs = Array.isArray(t.confluences) ? (t.confluences as string[]).length : 0;
  const confidence = Number(t.confidence_level ?? 5);
  const exitReason = String(t.exit_reason ?? '');
  const hasPreNotes = Boolean(t.pre_trade_notes);
  const hasPostNotes = Boolean(t.post_trade_notes);

  const emotionBonus: Record<string, number> = { Calm: 28, Confident: 22, Tired: 10, Anxious: 6, 'Overconfident': 5, FOMO: 2, 'Revenge Trading': 0 };
  const process = Math.min(100, Math.round(
    (followed ? 44 : 8) + (emotionBonus[emotion] ?? 12) + (hasPreNotes ? 14 : 0) + (hasPostNotes ? 8 : 0) + Math.min(6, confidence * 0.6)
  ));

  const setupQuality = Math.min(100, Math.round(
    Math.min(42, confs * 9) + (rr >= 3 ? 38 : rr >= 2 ? 30 : rr >= 1.5 ? 22 : rr >= 1 ? 14 : 5) + Math.min(20, confidence * 2)
  ));

  const execBase: Record<string, number> = { TP: 82, BE: 52, SL: 22 };
  const execution = Math.min(100, Math.round((execBase[exitReason] ?? 22) + Math.min(18, confidence * 1.8)));

  const stopDist = Math.abs(slPrice - entryPrice);
  const riskAmt = stopDist * contracts * pointValue;
  const rrAchieved = riskAmt > 0 ? Math.abs(pnl) / riskAmt : 0;
  const rrAchievedDisplay = pnl > 0 ? `${rrAchieved.toFixed(2)}R` : `0/${rr.toFixed(2)}R`;

  return { process, setupQuality, execution, rrAchievedDisplay, rrTarget: rr, rrAchieved };
}

// ── Behavioral tags from trade data ───────────────────────────────────────────
function getDataTags(trade: Trade): string[] {
  const t = trade as unknown as Record<string, unknown>;
  const tags: string[] = [];
  if (t.followed_plan === false) tags.push('Plan drifted');
  const emotion = String(t.emotional_state ?? '');
  if (emotion === 'Revenge Trading') tags.push('Revenge pattern');
  if (emotion === 'FOMO') tags.push('FOMO entry');
  if (emotion === 'Overconfident') tags.push('Overconfident');
  if (['Revenge Trading', 'FOMO'].includes(emotion) && t.followed_plan === false) tags.push('Emotional override');
  if (Array.isArray(t.behavioral_flags)) tags.push(...(t.behavioral_flags as string[]));
  return [...new Set(tags)];
}

const SECTION_META = [
  { key: 'your stats',      num: '01', label: 'Your Stats'    },
  { key: 'what happened',   num: '02', label: 'What Happened' },
  { key: 'the rule',        num: '03', label: 'The Rule'      },
  // legacy keys so cached responses still render correctly
  { key: 'your pattern',    num: '01', label: 'Your Stats'    },
  { key: 'this trade',      num: '02', label: 'What Happened' },
  { key: 'edge adjustment', num: '03', label: 'The Rule'      },
];

function renderReviewSections(text: string): React.ReactNode {
  const sections = parseReviewSections(text);
  if (sections.length === 0) return <p style={{ fontSize: 12, color: C.t1, lineHeight: 1.7 }}>{text}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sections.map((section, si) => {
        const meta = SECTION_META.find(m => m.key === section.label.toLowerCase()) ?? { num: String(si+1).padStart(2,'0'), label: section.label };
        const isLast = si === sections.length - 1;
        return (
          <div key={si} style={{ padding: '14px 0', borderBottom: isLast ? 'none' : `1px solid rgba(255,255,255,0.05)` }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
              <span style={{
                fontSize: 15, fontWeight: 800, color: C.acc,
                fontFamily: 'var(--font-mono, monospace)', letterSpacing: '-0.02em', lineHeight: 1,
              }}>{meta.num}</span>
              <span style={{ width: 1, height: 14, background: 'rgba(245,158,11,0.25)', flexShrink: 0 }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase', color: C.t0 }}>{meta.label}</span>
              <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
            </div>

            {/* Verdict */}
            {section.verdict && (
              <p style={{ fontSize: 14, fontWeight: 700, color: C.t0, lineHeight: 1.45, margin: '0 0 12px', letterSpacing: '-0.02em' }}>
                {inlineChips(section.verdict)}
              </p>
            )}

            {/* Rule callout (Edge Adjustment) */}
            {section.rule && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 10px', padding: '8px 10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: C.acc, letterSpacing: '0.1em', textTransform: 'uppercase', paddingTop: 1, flexShrink: 0, fontFamily: 'var(--font-mono, monospace)' }}>RULE</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.t0, lineHeight: 1.55 }}>{section.rule}</span>
              </div>
            )}

            {/* Bullets — data rows (stats section) */}
            {section.bullets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {section.bullets.map((b, bi) => (
                  <div key={bi} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '5px 0', borderTop: `1px solid rgba(255,255,255,0.04)` }}>
                    <span style={{ flexShrink: 0, marginTop: 7, width: 3, height: 3, borderRadius: '50%', background: C.acc, opacity: 0.5 }} />
                    <span style={{ fontSize: 12, color: C.t1, lineHeight: 1.65 }}>{inlineChips(b)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Insight blocks — What Happened section */}
            {section.insights.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                {section.insights.map((ins, ii) => (
                  <div key={ii} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 10px', background: ii % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent', borderRadius: 5, borderLeft: `2px solid rgba(245,158,11,${0.15 + ii * 0.07})` }}>
                    <span style={{ fontSize: 12.5, color: C.t0, lineHeight: 1.6, fontWeight: 450 }}>{inlineChips(ins)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Behavioral tags */}
            {section.tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
                {section.tags.map((tag, ti) => (
                  <span key={ti} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.22)', color: C.acc, letterSpacing: '0.02em' }}>{tag}</span>
                ))}
              </div>
            )}

            {/* Prose fallback (if AI didn't use > format) */}
            {section.prose.length > 0 && section.insights.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                {section.prose.map((p, pi) => (
                  <div key={pi} style={{ padding: '7px 10px', borderLeft: `2px solid rgba(245,158,11,${0.15 + pi * 0.07})`, borderRadius: 5, background: pi % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                    <span style={{ fontSize: 12.5, color: C.t0, lineHeight: 1.6 }}>{inlineChips(p)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Response item ─────────────────────────────────────────────────────────────
interface AIReply {
  question: string;
  reply: string;
  sampleSize: number;
  error?: boolean;
}

function ResponseCard({ r, onNavigate }: { r: AIReply; onNavigate: (path: string) => void }) {
  // Format the reply: split on double newlines for paragraphs
  const paragraphs = r.reply.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${r.error ? C.red + '30' : C.b0}`,
      background: C.d2,
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      {/* Top accent bar */}
      <div style={{
        height: 2,
        background: r.error ? C.red : C.acc,
        opacity: 0.6,
      }} />

      <div style={{ padding: '14px 16px' }}>
        {/* Question label */}
        <div style={{
          fontSize: 11, fontWeight: 500, color: C.t2, marginBottom: 6,
        }}>
          Your question
        </div>
        <div style={{
          fontSize: 12.5, color: C.t1, marginBottom: 14,
          paddingBottom: 12, borderBottom: `1px solid ${C.b0}`,
        }}>
          "{r.question}"
        </div>

        {/* Flyxa's answer */}
        <div style={{ marginBottom: 14 }}>
          {paragraphs.map((para, i) => (
            <p key={i} style={{
              fontSize: 13.5,
              color: r.error ? C.red : C.t0,
              lineHeight: 1.7,
              margin: '0 0 10px',
              fontWeight: i === 0 ? 540 : 400,
            }}>
              {para}
            </p>
          ))}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {/* Sample size badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 5,
            background: `${C.acc}10`, border: `1px solid ${C.acc}25`,
          }}>
            <Sparkles size={9} style={{ color: C.acc }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: C.acc, letterSpacing: '0.04em' }}>
              Flyxa AI · {r.sampleSize} trade{r.sampleSize !== 1 ? 's' : ''} analysed
            </span>
          </div>

          {!r.error && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => onNavigate('/flyxa-ai/patterns')}
                style={{ fontSize: 11, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, fontFamily: C.sans }}
              >
                Pattern library →
              </button>
              <button
                type="button"
                onClick={() => onNavigate('/flyxa-ai')}
                style={{ fontSize: 11, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2, fontFamily: C.sans }}
              >
                Debrief →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
const themeVars = {
  '--d0': '#0e0d0d', '--d1': '#141312', '--d2': '#1a1917',
  '--d3': '#201f1d', '--d4': '#27251f',
  '--b0': 'rgba(255,255,255,0.07)', '--b1': 'rgba(255,255,255,0.12)',
  '--t0': '#e8e3dc', '--t1': '#8a8178', '--t2': '#5c5751',
  '--acc': '#f59e0b', '--grn': '#22d68a', '--red': '#f05252',
} as CSSProperties;

export default function FlyxaAIAsk() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { trades } = useTrades();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<AIReply[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);

  // ── Trade review ──────────────────────────────────────────────────────────
  const [tradeAnalysisById, setTradeAnalysisById] = useState<Record<string, string>>({});
  const [tradeAnalysisLoadingId, setTradeAnalysisLoadingId] = useState<string | null>(null);
  const [tradeAnalysisError, setTradeAnalysisError] = useState<string | null>(null);

  const storeEntries = useFlyxaStore(state => state.entries);

  const focusedTradeId = searchParams.get('tradeId');
  const focusedTrade = useMemo<Trade | null>(() => {
    if (!focusedTradeId) return null;
    // Primary: search ApiTrade list (already converted)
    const byApiId = (trades as Trade[]).find(t => t.id === focusedTradeId);
    if (byApiId) return byApiId;
    // Fallback: search raw store entries in case of async hydration or ID edge cases
    for (const entry of storeEntries) {
      for (const rawTrade of entry.trades) {
        if ((rawTrade as { id?: string }).id === focusedTradeId) {
          return toApiTrade(rawTrade) as Trade;
        }
      }
    }
    return null;
  }, [focusedTradeId, trades, storeEntries]);
  const focusedTradePnl = useMemo(() => (focusedTrade ? Number(focusedTrade.pnl ?? 0) : null), [focusedTrade]);
  const focusedTradeConfluences = useMemo(() => normalizeConfluences(focusedTrade?.confluences), [focusedTrade]);
  const focusedTradeAnalysis = focusedTradeId ? tradeAnalysisById[focusedTradeId] : null;
  const focusedTradeAnalysisLoading = Boolean(focusedTradeId && tradeAnalysisLoadingId === focusedTradeId);

  useEffect(() => {
    let cancelled = false;
    if (!focusedTradeId || !focusedTrade || tradeAnalysisById[focusedTradeId]) return;
    setTradeAnalysisLoadingId(focusedTradeId);
    setTradeAnalysisError(null);
    aiApi.analyzeTradeById(focusedTradeId, focusedTrade)
      .then(({ analysis }) => { if (!cancelled) setTradeAnalysisById(prev => ({ ...prev, [focusedTradeId]: analysis })); })
      .catch(err => { if (!cancelled) setTradeAnalysisError(err instanceof Error ? err.message : 'Unable to analyse this trade.'); })
      .finally(() => { if (!cancelled) setTradeAnalysisLoadingId(cur => cur === focusedTradeId ? null : cur); });
    return () => { cancelled = true; };
  }, [focusedTradeId, focusedTrade, tradeAnalysisById]);

  const clearFocus = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('tradeId');
    setSearchParams(next);
    setTradeAnalysisError(null);
  };

  useEffect(() => {
    if (history.length > 0) {
      historyEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [history.length]);

  const submitQuestion = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setInput('');

    const stats = computeAllStats(trades);
    const sampleSize = trades.length;

    try {
      const { reply } = await api.post<{ reply: string }>('/api/ai/ask-flyxa-data', {
        question: trimmed,
        stats,
      });
      setHistory(prev => [{ question: trimmed, reply, sampleSize }, ...prev]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setHistory(prev => [{
        question: trimmed,
        reply: msg,
        sampleSize,
        error: true,
      }, ...prev]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitQuestion(input); }
  };

  const clearHistory = () => setHistory([]);

  return (
    <div
      className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl"
      style={{ ...themeVars, backgroundColor: C.d0, color: C.t0, fontFamily: C.sans }}
    >
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[178px_minmax(0,1fr)_252px]">

        {/* ── Left sub-nav ── */}
        <aside className="min-h-0 overflow-y-auto border-r px-2 py-4" style={{ backgroundColor: C.d1, borderColor: C.b0 }}>
          <div className="px-2">
            <p className="text-[14px] font-bold tracking-[0.1em]" style={{ color: C.t0 }}>FLYXA</p>
            <p className="mt-0.5 text-[9.5px]" style={{ color: C.t2 }}>Trading Intelligence</p>
          </div>
          <nav className="mt-4 space-y-0.5">
            {[
              { label: 'Debrief', to: '/flyxa-ai' },
              { label: 'Pattern library', to: '/flyxa-ai/patterns' },
              { label: 'Post-session', to: '/flyxa-ai/post-session' },
              { label: 'Ask Flyxa', to: '/flyxa-ai/ask', active: true },
            ].map(item => (
              <button
                key={item.to}
                type="button"
                onClick={() => navigate(item.to)}
                className="block w-full px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-white/[0.04]"
                style={{
                  borderLeft: `2px solid ${item.active ? C.acc : 'transparent'}`,
                  borderTop: 'none', borderRight: 'none', borderBottom: 'none',
                  backgroundColor: item.active ? 'rgba(245,158,11,0.07)' : 'transparent',
                  color: item.active ? C.acc : C.t1,
                  fontFamily: C.sans,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* ── Main content ── */}
        <main className="min-h-0 overflow-hidden flex flex-col" style={{ backgroundColor: C.d0 }}>

          {/* Header */}
          <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${C.b0}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: C.t2, marginBottom: 6,
                }}>
                  Ask Flyxa AI
                </div>
                <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: C.t0, margin: 0 }}>
                  Query your trade data
                </h1>
                <p style={{ fontSize: 12.5, color: C.t1, marginTop: 4 }}>
                  Ask anything in plain English — Flyxa AI analyses your actual trade history and thinks through the numbers.
                </p>
              </div>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={clearHistory}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '6px 12px', borderRadius: 7,
                    border: `1px solid ${C.b0}`, background: 'transparent',
                    color: C.t2, fontSize: 11.5, cursor: 'pointer', fontFamily: C.sans,
                  }}
                >
                  <RotateCcw size={12} /> Clear
                </button>
              )}
            </div>

            {/* Input */}
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. When do I trade best? Do I follow my plan? Am I improving?"
                  autoFocus
                  disabled={loading}
                  style={{
                    width: '100%', height: 42, borderRadius: 8,
                    border: `1px solid ${input ? C.acc + '50' : C.b0}`,
                    background: C.d2, color: C.t0,
                    padding: '0 14px', fontSize: 13, fontFamily: C.sans,
                    outline: 'none', boxSizing: 'border-box',
                    transition: 'border-color 0.15s',
                    opacity: loading ? 0.6 : 1,
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => void submitQuestion(input)}
                disabled={!input.trim() || loading}
                style={{
                  width: 42, height: 42, borderRadius: 8, border: 'none', flexShrink: 0,
                  background: input.trim() && !loading ? C.acc : `${C.acc}35`,
                  color: '#0a0806', cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s',
                }}
              >
                <Send size={16} />
              </button>
            </div>

            {/* Quick questions */}
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {QUICK_QUESTIONS.slice(0, 8).map(q => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void submitQuestion(q)}
                  disabled={loading}
                  style={{
                    padding: '4px 10px', borderRadius: 20,
                    border: `1px solid ${C.b0}`, background: C.d3,
                    color: C.t1, fontSize: 11, cursor: loading ? 'not-allowed' : 'pointer',
                    fontFamily: C.sans, whiteSpace: 'nowrap',
                    opacity: loading ? 0.5 : 1,
                    transition: 'border-color 0.12s, color 0.12s',
                  }}
                  onMouseEnter={e => { if (!loading) { e.currentTarget.style.borderColor = `${C.acc}50`; e.currentTarget.style.color = C.t0; } }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.b0; e.currentTarget.style.color = C.t1; }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Trade Review */}
          {focusedTradeId && (() => {
            const ft = focusedTrade as unknown as Record<string, unknown> | null;
            const scores = ft ? computeTradeScores(focusedTrade!) : null;
            const dataTags = ft ? getDataTags(focusedTrade!) : [];
            const followed = ft?.followed_plan === true;
            const followedLogged = typeof ft?.followed_plan === 'boolean';

            const ScoreCard = ({ label, value, total, display, tooltip }: { label: string; value: number; total: number; display?: string; tooltip?: string }) => {
              const pct = Math.round((value / total) * 100);
              const color = pct >= 70 ? C.grn : pct >= 40 ? C.acc : C.red;
              const [tip, setTip] = React.useState(false);
              return (
                <div style={{ flex: 1, minWidth: 0, padding: '8px 10px', background: 'rgba(255,255,255,0.025)', border: `1px solid rgba(255,255,255,0.07)`, borderRadius: 7, position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                    <p style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2, margin: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
                    {tooltip && (
                      <span
                        onMouseEnter={() => setTip(true)}
                        onMouseLeave={() => setTip(false)}
                        style={{ flexShrink: 0, width: 13, height: 13, borderRadius: '50%', border: `1px solid rgba(255,255,255,0.18)`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 8, fontWeight: 700, color: C.t2, lineHeight: 1 }}
                      >?</span>
                    )}
                    {tip && tooltip && (
                      <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, minWidth: 220, background: '#1a1917', border: `1px solid rgba(255,255,255,0.14)`, borderRadius: 7, padding: '10px 12px', zIndex: 50, pointerEvents: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
                        <p style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.acc, margin: '0 0 7px' }}>How it's scored</p>
                        {tooltip.split('\n').map((line, li) => (
                          <div key={li} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderTop: li > 0 ? `1px solid rgba(255,255,255,0.05)` : 'none' }}>
                            <span style={{ fontSize: 11, color: C.t1 }}>{line.split(':')[0]}</span>
                            <span style={{ fontSize: 11, color: C.t0, fontWeight: 600, whiteSpace: 'nowrap' }}>{line.split(':').slice(1).join(':').trim()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <p style={{ fontSize: 15, fontWeight: 700, color, margin: '0 0 5px', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono, monospace)', lineHeight: 1 }}>{display ?? `${value}/${total}`}</p>
                  <div style={{ height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.07)' }}>
                    <div style={{ height: '100%', borderRadius: 99, width: `${Math.min(100, pct)}%`, background: color, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              );
            };
            const confidence = Number((ft?.confidence_level as number | undefined) ?? 5);

            return (
              <div style={{ borderBottom: `1px solid ${C.b0}` }}>
                {/* ── Top bar ── */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 24px', background: 'rgba(245,158,11,0.05)', borderBottom: `1px solid rgba(245,158,11,0.15)` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.acc, fontFamily: 'var(--font-mono, monospace)' }}>+ Flyxa AI Review</span>
                  </div>
                  <button type="button" onClick={clearFocus} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t2, padding: 2, display: 'flex' }}>
                    <X size={13} />
                  </button>
                </div>

                <div style={{ padding: '12px 24px 16px' }}>
                  {/* ── Trade identity + tags ── */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}>
                        {ft ? `${String(ft.symbol ?? 'N/A')} ${String(ft.direction ?? '')} · ${String(ft.trade_date ?? '')}` : 'Loading...'}
                      </span>
                      {focusedTradePnl !== null && (
                        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono, monospace)', color: focusedTradePnl >= 0 ? C.grn : C.red }}>
                          {formatSignedCurrency(focusedTradePnl)}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {followedLogged && (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: followed ? 'rgba(34,214,138,0.1)' : 'rgba(245,158,11,0.12)', border: `1px solid ${followed ? 'rgba(34,214,138,0.25)' : 'rgba(245,158,11,0.28)'}`, color: followed ? C.grn : C.acc }}>
                          {followed ? 'Plan Followed' : 'Plan Drifted'}
                        </span>
                      )}
                      {focusedTradeConfluences.map((c, i) => (
                        <span key={i} style={{ fontSize: 10, fontWeight: 500, padding: '2px 7px', borderRadius: 4, background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(255,255,255,0.09)`, color: C.t1 }}>{c}</span>
                      ))}
                      {dataTags.filter(t => t !== 'Plan drifted').map((tag, i) => (
                        <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(240,82,82,0.09)', border: '1px solid rgba(240,82,82,0.2)', color: C.red }}>{tag}</span>
                      ))}
                    </div>
                  </div>

                  {/* ── Score cards ── */}
                  {scores && (
                    <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                      <ScoreCard label="Process" value={scores.process} total={100} tooltip={"Plan followed: +44 pts\nCalm / Confident: +28 / +22 pts\nTired / Anxious: +10 / +6 pts\nFOMO / Revenge: +2 / +0 pts\nPre-trade notes: +14 pts\nPost-trade notes: +8 pts\nConfidence (1–10): up to +6 pts"} />
                      <ScoreCard label="Setup Quality" value={scores.setupQuality} total={100} />
                      <ScoreCard label="Execution" value={scores.execution} total={100} />
                      <ScoreCard label="Confidence" value={confidence} total={10} display={`${confidence}/10`} />
                    </div>
                  )}

                  {/* ── Loading ── */}
                  {focusedTradeAnalysisLoading && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <svg width="20" height="20" viewBox="0 0 64 64" fill="none" style={{ flexShrink: 0, animation: 'flyxa-logo-pulse 1.4s ease-in-out infinite' }}>
                          <line x1="5" y1="42" x2="22" y2="42" stroke="#B45309" strokeWidth="2.2" strokeLinecap="round"/>
                          <line x1="22" y1="42" x2="38" y2="26" stroke="#F59E0B" strokeWidth="2.6" strokeLinecap="round"/>
                          <line x1="38" y1="26" x2="59" y2="26" stroke="#F59E0B" strokeWidth="2.6" strokeLinecap="round"/>
                          <circle cx="22" cy="42" r="4.4" fill="#F59E0B"/>
                        </svg>
                        <p style={{ fontSize: 11.5, color: C.t1, margin: 0 }}>Cross-referencing {trades.length} trades...</p>
                        <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
                          {[0,1,2].map(i => <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: C.acc, display: 'block', animation: `analysing-pulse 1s ease-in-out ${i*0.16}s infinite` }} />)}
                        </div>
                      </div>
                      {[86, 70, 92].map((w, i) => (
                        <div key={w} style={{ height: 4, borderRadius: 99, marginBottom: 6, width: `${w}%`, background: 'linear-gradient(90deg,rgba(255,255,255,0.04),rgba(245,158,11,0.16),rgba(255,255,255,0.04))', backgroundSize: '220% 100%', animation: `analysing-shimmer 1.35s linear ${i*0.12}s infinite` }} />
                      ))}
                    </div>
                  )}

                  {/* ── Error ── */}
                  {tradeAnalysisError && !focusedTradeAnalysisLoading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <p style={{ fontSize: 12, color: C.red, margin: 0, flex: 1 }}>{tradeAnalysisError}</p>
                      <button type="button" onClick={() => {
                        if (!focusedTradeId) return;
                        setTradeAnalysisError(null); setTradeAnalysisLoadingId(null);
                        setTradeAnalysisById(prev => { const n = {...prev}; delete n[focusedTradeId]; return n; });
                      }} style={{ fontSize: 10.5, fontWeight: 600, color: C.acc, background: 'none', border: `1px solid ${C.b1}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontFamily: C.sans }}>
                        Retry
                      </button>
                    </div>
                  )}

                  {/* ── Review content ── */}
                  {focusedTradeAnalysis && !focusedTradeAnalysisLoading && (
                    <>
                      <div style={{ maxHeight: 620, overflowY: 'auto', paddingRight: 2 }}>
                        {renderReviewSections(focusedTradeAnalysis)}
                      </div>
                      {/* Footer */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 10, borderTop: `1px solid rgba(255,255,255,0.05)` }}>
                        <span style={{ fontSize: 10.5, color: C.t2 }}>Based on {trades.length} logged trade{trades.length !== 1 ? 's' : ''}</span>
                        <button type="button" onClick={() => {}} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: C.sans }}>
                          View full pattern history <ArrowRight size={11} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Responses */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
            {/* Loading card */}
            {loading && (
              <div style={{
                borderRadius: 10, border: `1px solid ${C.b0}`, background: C.d2,
                padding: '16px', marginBottom: 12,
              }}>
                <div style={{ height: 2, background: C.acc, opacity: 0.4, marginBottom: 14, borderRadius: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{
                        width: 6, height: 6, borderRadius: '50%', background: C.acc,
                        animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                      }} />
                    ))}
                  </div>
                  <span style={{ fontSize: 12.5, color: C.t1 }}>Flyxa is thinking through your trade data…</span>
                </div>
              </div>
            )}

            {/* Empty state */}
            {history.length === 0 && !loading && (
              <div style={{ textAlign: 'center', paddingTop: 48 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  background: `${C.acc}12`, border: `1px solid ${C.acc}25`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 16px',
                }}>
                  <Sparkles size={20} style={{ color: C.acc }} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.t0, marginBottom: 6 }}>
                  Ask anything about your trading
                </div>
                <div style={{ fontSize: 12.5, color: C.t2, maxWidth: 380, margin: '0 auto', lineHeight: 1.6 }}>
                  Flyxa AI reads your actual trade data and reasons over it to give you genuine, personalised insights — not generic advice.
                </div>
                <div style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {QUICK_QUESTIONS.slice(8).map(q => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => void submitQuestion(q)}
                      style={{
                        padding: '5px 12px', borderRadius: 20,
                        border: `1px solid ${C.b0}`, background: C.d2,
                        color: C.t1, fontSize: 11.5, cursor: 'pointer', fontFamily: C.sans,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = `${C.acc}50`; e.currentTarget.style.color = C.t0; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = C.b0; e.currentTarget.style.color = C.t1; }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Response history */}
            {history.map((r, i) => (
              <ResponseCard key={i} r={r} onNavigate={navigate} />
            ))}
            <div ref={historyEndRef} />
          </div>
        </main>

        {/* ── Right panel ── */}
        <aside className="min-h-0 overflow-y-auto border-l px-4 py-[18px]" style={{ backgroundColor: C.d1, borderColor: C.b0 }}>

          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: C.t2, marginBottom: 10,
            }}>
              What you can ask
            </div>
            {[
              { topic: 'Sessions', examples: ['When do I trade best?', 'How do I do in London?'] },
              { topic: 'Days', examples: ['What\'s my best day of week?', 'How do I do on Fridays?'] },
              { topic: 'Plan adherence', examples: ['Do I follow my plan?', 'What happens when I break rules?'] },
              { topic: 'Emotions', examples: ['How does mood affect me?', 'When am I most disciplined?'] },
              { topic: 'Overtrading', examples: ['Am I overtrading?', 'Do more trades hurt me?'] },
              { topic: 'Post-loss', examples: ['How do I trade after a loss?', 'Do I revenge trade?'] },
              { topic: 'Progress', examples: ['Am I improving?', 'How have I done lately?'] },
              { topic: 'Signals', examples: ['Which confluences work?', 'What conditions work best?'] },
              { topic: 'Instruments', examples: ['What\'s my best instrument?', 'How do I do on NQ?'] },
              { topic: 'Duration', examples: ['How long do I hold trades?', 'Do I let losers run?'] },
              { topic: 'Streaks', examples: ['What\'s my longest win streak?', 'Consecutive losses?'] },
            ].map(cat => (
              <div key={cat.topic} style={{ marginBottom: 12 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
                  textTransform: 'uppercase', color: C.acc, marginBottom: 4,
                }}>
                  {cat.topic}
                </div>
                {cat.examples.map(ex => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => { void submitQuestion(ex); inputRef.current?.focus(); }}
                    disabled={loading}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '4px 0', background: 'none', border: 'none',
                      fontSize: 11.5, color: C.t2, cursor: loading ? 'not-allowed' : 'pointer',
                      fontFamily: C.sans, lineHeight: 1.5,
                      transition: 'color 0.1s',
                    }}
                    onMouseEnter={e => { if (!loading) e.currentTarget.style.color = C.t0; }}
                    onMouseLeave={e => { e.currentTarget.style.color = C.t2; }}
                  >
                    "{ex}"
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: `${C.acc}0a`, border: `1px solid ${C.acc}20`,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
              textTransform: 'uppercase', color: C.acc, marginBottom: 4,
            }}>
              Powered by Flyxa AI
            </div>
            <div style={{ fontSize: 11, color: C.t1, lineHeight: 1.6 }}>
              Flyxa reads your full trading statistics and reasons over them to give you genuine, personalised insights — not keyword-matched templates.
            </div>
          </div>
        </aside>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        @keyframes analysing-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes analysing-shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes flyxa-logo-pulse {
          0%, 100% { opacity: 0.22; filter: drop-shadow(0 0 0px rgba(245,158,11,0)); }
          50% { opacity: 1; filter: drop-shadow(0 0 7px rgba(245,158,11,0.7)); }
        }
      `}</style>
    </div>
  );
}
