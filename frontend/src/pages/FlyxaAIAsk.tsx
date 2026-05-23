import { CSSProperties, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, ChevronRight, AlertTriangle, TrendingUp, TrendingDown, Minus, RotateCcw } from 'lucide-react';
import { useTrades } from '../hooks/useTrades.js';
import { parseAndRespond, QUICK_QUESTIONS, type AskResponse, type AskDataRow } from '../utils/askFlyxa.js';

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
  mono: 'var(--font-mono, DM Mono, monospace)',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function confColor(c: AskResponse['confidence']) {
  return c === 'high' ? C.grn : c === 'medium' ? C.acc : C.t2;
}
function confLabel(c: AskResponse['confidence'], n: number) {
  return `${c.toUpperCase()} confidence · ${n} trade${n !== 1 ? 's' : ''} analysed`;
}
function toneColor(tone: AskDataRow['tone']) {
  return tone === 'pos' ? C.grn : tone === 'neg' ? C.red : C.t1;
}
function fmtPnl(v: number) {
  const abs = Math.abs(v);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`;
  return v >= 0 ? `+${s}` : `-${s}`;
}
function fmtPct(v: number) { return `${Math.round(v)}%`; }

// ─── Response card ────────────────────────────────────────────────────────────
function ResponseCard({ r, onNavigate }: { r: AskResponse; onNavigate: (path: string) => void }) {
  const isError = r.noData;

  const card: CSSProperties = {
    borderRadius: 10,
    border: `1px solid ${C.b0}`,
    background: C.d2,
    overflow: 'hidden',
    marginBottom: 12,
  };
  const topBar: CSSProperties = {
    height: 2,
    background: isError ? C.t2 : `linear-gradient(90deg, ${C.acc} 0%, ${C.grn} 100%)`,
  };

  return (
    <div style={card}>
      <div style={topBar} />
      <div style={{ padding: '14px 16px' }}>

        {/* Question */}
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, marginBottom: 8 }}>
          Your question
        </div>
        <div style={{ fontSize: 12.5, color: C.t1, marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${C.b0}` }}>
          "{r.question}"
        </div>

        {/* Answer headline */}
        <div style={{ fontSize: 15, fontWeight: 660, color: C.t0, lineHeight: 1.4, marginBottom: 8 }}>
          {r.answer}
        </div>

        {/* Detail */}
        <div style={{ fontSize: 12.5, color: C.t1, lineHeight: 1.65, marginBottom: r.rows?.length ? 14 : 0 }}>
          {r.detail}
        </div>

        {/* Data table */}
        {r.rows && r.rows.length > 0 && (
          <div style={{ marginBottom: 14, borderRadius: 7, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 70px 80px 54px',
              padding: '6px 12px', background: C.d3,
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2,
            }}>
              <span>Segment</span>
              <span style={{ textAlign: 'right' }}>Win rate</span>
              <span style={{ textAlign: 'right' }}>Net P&L</span>
              <span style={{ textAlign: 'right' }}>Trades</span>
            </div>
            {/* Rows */}
            {r.rows.map((row, i) => {
              const maxAbsNet = Math.max(...r.rows!.map(rr => Math.abs(rr.netPnl)), 1);
              const barW = Math.min(100, (Math.abs(row.netPnl) / maxAbsNet) * 100);
              return (
                <div
                  key={i}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 80px 54px',
                    padding: '8px 12px', alignItems: 'center',
                    borderTop: i > 0 ? `1px solid ${C.b0}` : 'none',
                    background: i % 2 === 0 ? 'transparent' : `${C.b0}50`,
                  }}
                >
                  {/* Label + mini bar */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {row.tone === 'pos'
                        ? <TrendingUp size={11} style={{ color: C.grn, flexShrink: 0 }} />
                        : row.tone === 'neg'
                          ? <TrendingDown size={11} style={{ color: C.red, flexShrink: 0 }} />
                          : <Minus size={11} style={{ color: C.t2, flexShrink: 0 }} />}
                      <span style={{ fontSize: 12, fontWeight: 500, color: C.t0 }}>{row.label}</span>
                    </div>
                    <div style={{ marginTop: 4, height: 2, borderRadius: 2, background: C.d4, width: '80%' }}>
                      <div style={{ height: 2, borderRadius: 2, width: `${barW}%`, background: toneColor(row.tone) }} />
                    </div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: toneColor(row.tone), textAlign: 'right', fontFamily: C.mono }}>
                    {fmtPct(row.winRate)}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: toneColor(row.tone), textAlign: 'right', fontFamily: C.mono }}>
                    {fmtPnl(row.netPnl)}
                  </span>
                  <span style={{ fontSize: 11, color: C.t2, textAlign: 'right', fontFamily: C.mono }}>
                    {row.trades}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Warning */}
        {r.warning && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '10px 12px', borderRadius: 7, marginBottom: 10,
            background: `${C.red}10`, border: `1px solid ${C.red}30`,
          }}>
            <AlertTriangle size={13} style={{ color: C.red, flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12, color: C.red, lineHeight: 1.5 }}>{r.warning}</span>
          </div>
        )}

        {/* Action */}
        {r.action && !isError && (
          <div style={{
            padding: '10px 12px', borderRadius: 7, marginBottom: 10,
            background: `${C.acc}0d`, border: `1px solid ${C.acc}28`,
            display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <ChevronRight size={13} style={{ color: C.acc, flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 12.5, color: C.acc, lineHeight: 1.5, fontWeight: 500 }}>{r.action}</span>
          </div>
        )}

        {/* Confidence + links */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 5,
            background: `${confColor(r.confidence)}14`,
            border: `1px solid ${confColor(r.confidence)}28`,
          }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: confColor(r.confidence) }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: confColor(r.confidence), letterSpacing: '0.04em' }}>
              {confLabel(r.confidence, r.sampleSize)}
            </span>
          </div>
          {!isError && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => onNavigate('/flyxa-ai/patterns')}
                style={{ fontSize: 11, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
              >
                Pattern library →
              </button>
              <button
                type="button"
                onClick={() => onNavigate('/flyxa-ai')}
                style={{ fontSize: 11, color: C.t2, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
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
  const { trades } = useTrades();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<AskResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);

  // Scroll to latest answer
  useEffect(() => {
    if (history.length > 0) {
      historyEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [history.length]);

  const submitQuestion = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setInput('');
    // Small delay so the loading state renders before the (sync) computation
    setTimeout(() => {
      const response = parseAndRespond(trimmed, trades);
      setHistory(prev => [response, ...prev]);
      setLoading(false);
    }, 120);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(input); }
  };

  const clearHistory = () => setHistory([]);

  return (
    <div
      className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl"
      style={{ ...themeVars, backgroundColor: C.d0, color: C.t0, fontFamily: C.sans }}
    >
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[178px_minmax(0,1fr)_252px]">

        {/* ── Left sub-nav (matches FlyxaAI layout) ── */}
        <aside className="min-h-0 overflow-y-auto border-r px-2 py-4" style={{ backgroundColor: C.d1, borderColor: C.b0 }}>
          <div className="px-2">
            <p className="text-[14px] font-bold tracking-[0.1em]" style={{ color: C.t0 }}>FLYXA</p>
            <p className="mt-0.5 text-[9.5px]" style={{ color: C.t2 }}>Trading Intelligence</p>
          </div>
          <nav className="mt-4 space-y-0.5">
            {[
              { label: 'Debrief', to: '/flyxa-ai' },
              { label: 'Pattern library', to: '/flyxa-ai/patterns' },
              { label: 'Emotional fingerprint', to: '/flyxa-ai/emotional-fingerprint' },
              { label: 'Post-session', to: '/flyxa-ai/post-session' },
              { label: 'Ask Flyxa', to: '/flyxa-ai/ask', active: true },
            ].map(item => (
              <button
                key={item.to}
                type="button"
                onClick={() => navigate(item.to)}
                className="block w-full border-l-2 px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-white/[0.04]"
                style={{
                  borderLeftColor: item.active ? C.acc : 'transparent',
                  backgroundColor: item.active ? 'rgba(245,158,11,0.07)' : 'transparent',
                  color: item.active ? C.acc : C.t1,
                  fontFamily: C.sans,
                  border: 'none',
                  borderLeft: `2px solid ${item.active ? C.acc : 'transparent'}`,
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
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2, marginBottom: 6 }}>
                  Ask Flyxa
                </div>
                <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: C.t0, margin: 0 }}>
                  Query your trade data
                </h1>
                <p style={{ fontSize: 12.5, color: C.t1, marginTop: 4 }}>
                  Ask anything in plain English — Flyxa runs it against your actual trade history.
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
              <div style={{ flex: 1, position: 'relative' }}>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. When do I trade best? Do I follow my plan? Am I improving?"
                  autoFocus
                  style={{
                    width: '100%', height: 42, borderRadius: 8,
                    border: `1px solid ${input ? C.acc + '50' : C.b0}`,
                    background: C.d2, color: C.t0,
                    padding: '0 14px', fontSize: 13, fontFamily: C.sans,
                    outline: 'none', boxSizing: 'border-box',
                    transition: 'border-color 0.15s',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => submitQuestion(input)}
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
                  onClick={() => submitQuestion(q)}
                  style={{
                    padding: '4px 10px', borderRadius: 20,
                    border: `1px solid ${C.b0}`, background: C.d3,
                    color: C.t1, fontSize: 11, cursor: 'pointer', fontFamily: C.sans,
                    transition: 'border-color 0.12s, color 0.12s',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = `${C.acc}50`; e.currentTarget.style.color = C.t0; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.b0; e.currentTarget.style.color = C.t1; }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>

          {/* Responses */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
            {loading && (
              <div style={{
                borderRadius: 10, border: `1px solid ${C.b0}`, background: C.d2,
                padding: '16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      width: 6, height: 6, borderRadius: '50%', background: C.acc,
                      animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }} />
                  ))}
                </div>
                <span style={{ fontSize: 12.5, color: C.t1 }}>Analysing your trade data…</span>
              </div>
            )}

            {history.length === 0 && !loading && (
              <div style={{ textAlign: 'center', paddingTop: 48 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  background: `${C.acc}12`, border: `1px solid ${C.acc}25`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 16px',
                }}>
                  <Send size={20} style={{ color: C.acc }} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.t0, marginBottom: 6 }}>Ask anything about your trades</div>
                <div style={{ fontSize: 12.5, color: C.t2, maxWidth: 360, margin: '0 auto', lineHeight: 1.6 }}>
                  Flyxa analyses your actual trade history to give you data-backed answers — no generic advice.
                </div>
                <div style={{ marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {QUICK_QUESTIONS.slice(8).map(q => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => submitQuestion(q)}
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

            {history.map((r, i) => (
              <ResponseCard key={i} r={r} onNavigate={navigate} />
            ))}
            <div ref={historyEndRef} />
          </div>
        </main>

        {/* ── Right panel: query guide ── */}
        <aside className="min-h-0 overflow-y-auto border-l px-4 py-[18px]" style={{ backgroundColor: C.d1, borderColor: C.b0 }}>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.t2, marginBottom: 10 }}>
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
              { topic: 'Setups', examples: ['What\'s my best setup?', 'Which confluences work?'] },
              { topic: 'Instruments', examples: ['What\'s my best instrument?', 'How do I do on NQ?'] },
              { topic: 'Duration', examples: ['How long do I hold trades?', 'Do I let losers run?'] },
              { topic: 'Streaks', examples: ['What\'s my longest win streak?', 'Consecutive losses?'] },
            ].map(cat => (
              <div key={cat.topic} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.acc, marginBottom: 4 }}>
                  {cat.topic}
                </div>
                {cat.examples.map(ex => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => { submitQuestion(ex); inputRef.current?.focus(); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '4px 0', background: 'none', border: 'none',
                      fontSize: 11.5, color: C.t2, cursor: 'pointer',
                      fontFamily: C.sans, lineHeight: 1.5,
                      transition: 'color 0.1s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = C.t0; }}
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
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.acc, marginBottom: 4 }}>
              How it works
            </div>
            <div style={{ fontSize: 11, color: C.t1, lineHeight: 1.6 }}>
              No AI hallucinations — every answer is calculated directly from your logged trades. More data = more reliable insights.
            </div>
          </div>
        </aside>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
