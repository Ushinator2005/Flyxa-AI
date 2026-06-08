import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Send, RotateCcw, Sparkles, X } from 'lucide-react';
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

// ─── Response item ─────────────────────────────────────────────────────────────
interface AIReply {
  question: string;
  reply: string;
  sampleSize: number;
  error?: boolean;
}

function ResponseCard({ r, onNavigate }: { r: AIReply; onNavigate: (path: string) => void }) {
  // Format Claude's reply: split on double newlines for paragraphs
  const paragraphs = r.reply.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${r.error ? C.red + '30' : C.b0}`,
      background: C.d2,
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      {/* Top gradient bar */}
      <div style={{
        height: 2,
        background: r.error
          ? C.red
          : `linear-gradient(90deg, ${C.acc} 0%, ${C.grn} 100%)`,
      }} />

      <div style={{ padding: '14px 16px' }}>
        {/* Question label */}
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: C.t2, marginBottom: 6,
        }}>
          Your question
        </div>
        <div style={{
          fontSize: 12.5, color: C.t1, marginBottom: 14,
          paddingBottom: 12, borderBottom: `1px solid ${C.b0}`,
        }}>
          "{r.question}"
        </div>

        {/* Claude's answer */}
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
              Claude AI · {r.sampleSize} trade{r.sampleSize !== 1 ? 's' : ''} analysed
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
                  Ask anything in plain English — Claude AI analyses your actual trade history and thinks for itself.
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
          {focusedTradeId && (
            <div style={{ padding: '12px 24px', borderBottom: `1px solid ${C.b0}` }}>
              <div style={{
                borderRadius: 10, border: `1px solid rgba(245,158,11,0.32)`,
                background: `rgba(245,158,11,0.04)`, padding: '14px 16px',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                  <div>
                    <p style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.acc, margin: 0 }}>Selected trade AI review</p>
                    <p style={{ fontSize: 15, fontWeight: 600, color: C.t0, margin: '4px 0 0' }}>
                      {focusedTrade
                        ? `${(focusedTrade as unknown as Record<string,string>).symbol || 'N/A'} ${(focusedTrade as unknown as Record<string,string>).direction || ''} · ${(focusedTrade as unknown as Record<string,string>).trade_date || ''} ${(focusedTrade as unknown as Record<string,string>).trade_time || ''}`
                        : storeEntries.length === 0 ? 'Loading...' : 'Trade not found'}
                    </p>
                  </div>
                  <button type="button" onClick={clearFocus} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t2, padding: 2, flexShrink: 0 }}>
                    <X size={14} />
                  </button>
                </div>

                {focusedTrade ? (
                  <>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: C.t1, marginBottom: 12 }}>
                      <span>
                        P&L: <span style={{ color: focusedTradePnl !== null && focusedTradePnl >= 0 ? C.grn : C.red, fontWeight: 600 }}>
                          {focusedTradePnl !== null ? formatSignedCurrency(focusedTradePnl) : '$0.00'}
                        </span>
                      </span>
                      <span>
                        Plan: <span style={{ color: typeof (focusedTrade as unknown as Record<string,unknown>).followed_plan !== 'boolean' ? C.t2 : ((focusedTrade as unknown as Record<string,unknown>).followed_plan ? C.grn : C.red) }}>
                          {typeof (focusedTrade as unknown as Record<string,unknown>).followed_plan !== 'boolean' ? 'Not logged' : ((focusedTrade as unknown as Record<string,unknown>).followed_plan ? 'Followed' : 'Drifted')}
                        </span>
                      </span>
                      {focusedTradeConfluences.length > 0 && (
                        <span>Confluences: <span style={{ color: C.t0 }}>{focusedTradeConfluences.join(', ')}</span></span>
                      )}
                    </div>

                    <div style={{ borderRadius: 8, border: `1px solid rgba(245,158,11,0.18)`, background: 'rgba(10,10,10,0.42)', padding: '12px 14px', minHeight: 80 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div>
                          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.acc, margin: 0 }}>Flyxa trade review</p>
                          <p style={{ fontSize: 11.5, color: C.t2, margin: '2px 0 0' }}>Trade quality, risk, execution, psychology, and one next adjustment.</p>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {focusedTradeAnalysisLoading && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              {[0,1,2].map(i => (
                                <span key={i} style={{ display: 'block', width: 6, height: 6, borderRadius: '50%', background: C.acc, animation: `analysing-pulse 1s ease-in-out ${i*0.16}s infinite` }} />
                              ))}
                            </div>
                          )}
                          {tradeAnalysisError && !focusedTradeAnalysisLoading && (
                            <button type="button" onClick={() => {
                              if (!focusedTradeId) return;
                              setTradeAnalysisError(null);
                              setTradeAnalysisLoadingId(null);
                              setTradeAnalysisById(prev => { const n = {...prev}; delete n[focusedTradeId]; return n; });
                            }} style={{ fontSize: 10.5, fontWeight: 600, color: C.acc, background: 'none', border: `1px solid ${C.b1}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontFamily: C.sans }}>
                              Retry
                            </button>
                          )}
                        </div>
                      </div>

                      {focusedTradeAnalysisLoading && (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                            <svg width="32" height="32" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0, animation: 'flyxa-logo-pulse 1.4s ease-in-out infinite' }}>
                              <line x1="5" y1="42" x2="22" y2="42" stroke="#B45309" strokeWidth="2.2" strokeLinecap="round"/>
                              <line x1="22" y1="42" x2="38" y2="26" stroke="#F59E0B" strokeWidth="2.6" strokeLinecap="round"/>
                              <line x1="38" y1="26" x2="59" y2="26" stroke="#F59E0B" strokeWidth="2.6" strokeLinecap="round"/>
                              <circle cx="22" cy="42" r="4.4" fill="#F59E0B"/>
                            </svg>
                            <div>
                              <p style={{ fontSize: 13, fontWeight: 600, color: C.t0, margin: 0 }}>Analysing execution quality</p>
                              <p style={{ fontSize: 12, color: C.t1, margin: '2px 0 0' }}>Reading entry, stop, target, exit, emotion, notes, and plan adherence...</p>
                            </div>
                          </div>
                          {[82,96,68].map((w, i) => (
                            <div key={w} style={{ height: 7, borderRadius: 99, marginBottom: 8, width: `${w}%`, background: 'linear-gradient(90deg, rgba(255,255,255,0.05), rgba(245,158,11,0.20), rgba(255,255,255,0.05))', backgroundSize: '220% 100%', animation: `analysing-shimmer 1.35s linear ${i*0.12}s infinite` }} />
                          ))}
                        </div>
                      )}

                      {tradeAnalysisError && !focusedTradeAnalysisLoading && (
                        <p style={{ fontSize: 12, color: C.red, margin: '8px 0 0' }}>{tradeAnalysisError}</p>
                      )}

                      {focusedTradeAnalysis && !focusedTradeAnalysisLoading && (
                        <div style={{ fontSize: 13, lineHeight: 1.7, color: C.t1, marginTop: 8 }}>
                          {focusedTradeAnalysis.split(/\n{2,}/).map((para, i) => (
                            <p key={i} style={{ margin: '0 0 10px', whiteSpace: 'pre-line' }}>{para.trim()}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p style={{ fontSize: 12, color: C.t1, margin: 0 }}>
                    {storeEntries.length === 0 ? 'Loading your trades...' : 'Trade not found in your history.'}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Responses */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
            {/* Loading card */}
            {loading && (
              <div style={{
                borderRadius: 10, border: `1px solid ${C.b0}`, background: C.d2,
                padding: '16px', marginBottom: 12,
              }}>
                <div style={{ height: 2, background: `linear-gradient(90deg, ${C.acc}60, ${C.grn}60)`, marginBottom: 14, borderRadius: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{
                        width: 6, height: 6, borderRadius: '50%', background: C.acc,
                        animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                      }} />
                    ))}
                  </div>
                  <span style={{ fontSize: 12.5, color: C.t1 }}>Claude is thinking through your trade data…</span>
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
                  Claude AI reads your actual trade data and reasons over it to give you genuine, personalised insights — not generic advice.
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
              Powered by Claude AI
            </div>
            <div style={{ fontSize: 11, color: C.t1, lineHeight: 1.6 }}>
              Claude reads your full trading statistics and reasons over them to give you genuine, personalised insights — not keyword-matched templates.
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
