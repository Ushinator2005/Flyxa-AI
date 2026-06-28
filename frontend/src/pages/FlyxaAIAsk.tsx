import React, { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Send, RotateCcw, Sparkles, X, ArrowRight } from 'lucide-react';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import { useTrades, toApiTrade } from '../hooks/useTrades.js';
import { computeAllStats, QUICK_QUESTIONS } from '../utils/askFlyxa.js';
import { api, aiApi } from '../services/api.js';
import type { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { deriveTradeSessionLabel } from '../utils/sessionTimes.js';
import { normalizeConfluenceTags } from '../utils/confluenceTags.js';
import { getEvaluationTemplates, inferEvaluationTemplate } from '../utils/evaluationCoach.js';

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
}
function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}
function normalizeConfluences(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return normalizeConfluenceTags(JSON.parse(value));
    } catch {
      return normalizeConfluenceTags(value);
    }
  }
  return normalizeConfluenceTags(value);
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
      // Bold by weight only — no colour change so it doesn't fragment prose
      return <strong key={i} style={{ fontWeight: 600, color: 'inherit' }}>{part.slice(2, -2)}</strong>;
    }
    if (/^-?\$[\d,]+(?:\.\d+)?$/.test(part) || /^\d+(?:\.\d+)?%$/.test(part) || /^\d+\.\d+x$/.test(part) || /^\d+(?:\.\d+)?R$/.test(part)) {
      let display = part;
      if (/^-?\$[\d,]+(?:\.\d+)?$/.test(part)) {
        const isNeg = part.startsWith('-');
        const raw = parseFloat(part.replace(/[$,]/g, ''));
        if (!isNaN(raw)) {
          const absVal = Math.abs(raw);
          const formatted = absVal.toLocaleString('en-US', {
            minimumFractionDigits: part.includes('.') ? 2 : 0,
            maximumFractionDigits: 2,
          });
          display = (isNeg ? '-$' : '$') + formatted;
        }
      }
      // Numbers: same font/colour as body, just tabular alignment
      return <span key={i} style={{ fontVariantNumeric: 'tabular-nums' }}>{display}</span>;
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
      } else if (/^(RULE|ADJUSTMENT|FOCUS):/i.test(trimmed)) {
        current.rule = trimmed.replace(/^(RULE|ADJUSTMENT|FOCUS):\s*/i, '');
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
const JOURNAL_FLAG_PENALTIES: Record<string, number> = {
  'sized-up': 20,
  revenge: 20,
  'added-losing': 20,
  'incorrect-stop-loss': 12,
  'plan-deviation': 12,
  'reentry-stop': 12,
  'past-inval': 12,
  'moved-stop': 12,
  'boredom-trade': 12,
  'chased-entry': 6,
  'no-confirmation': 6,
  overtraded: 6,
  'exit-early': 6,
  'moved-target': 6,
  'be-too-early': 4,
};

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getTradeConfidence(record: Record<string, unknown>): number {
  const direct = numberFrom(record.confidence_level);
  if (direct !== null) return Math.max(0, Math.min(10, direct));

  const preEntry = getNestedRecord(record, 'preEntry');
  const preEntryConfidence = numberFrom(preEntry?.confidenceAtEntry);
  if (preEntryConfidence !== null && preEntryConfidence > 0) {
    return Math.max(0, Math.min(10, Math.round(preEntryConfidence * 2)));
  }

  return 5;
}

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
  const confidence = getTradeConfidence(t);
  const exitReason = String(t.exit_reason ?? '');
  const hasPreNotes = Boolean(t.pre_trade_notes);
  const hasPostNotes = Boolean(t.post_trade_notes);
  const psychologyRatings = getNestedRecord(t, 'psychologyRatings');
  const executionReview = getNestedRecord(t, 'executionReview');
  const storedProcessScore = numberFrom(t.processScore);
  const setupRating = numberFrom(psychologyRatings?.setupQuality);
  const executionRating = numberFrom(psychologyRatings?.execution);

  const journalProcess = (() => {
    if (storedProcessScore !== null && storedProcessScore > 0) return Math.max(0, Math.min(100, Math.round(storedProcessScore)));
    if (!psychologyRatings) return null;

    const ratingValues = ['setupQuality', 'discipline', 'execution', 'patience', 'riskManagement', 'emotionalControl']
      .map(key => numberFrom(psychologyRatings[key]))
      .filter((value): value is number => value !== null && value > 0);
    if (!ratingValues.length) return null;

    const avg = ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length;
    const flags = Array.isArray(t.behavioral_flags) ? t.behavioral_flags as string[] : [];
    const flagPenalty = flags.reduce((sum, flag) => sum + (JOURNAL_FLAG_PENALTIES[flag] ?? 8), 0);
    const perfectExecutionReview = executionReview
      && executionReview.enteredAtLevel === true
      && executionReview.waitedForConfirmation === true
      && executionReview.correctSize === true
      && executionReview.exitedAtPlan === true
      && executionReview.movedStopCorrectly === true
      && executionReview.resistedEarlyExit === true;
    const confidenceBonus = confidence >= 8 ? 5 : 0;
    return Math.max(0, Math.min(100, Math.round(avg * 20 - flagPenalty + (perfectExecutionReview ? 5 : 0) + confidenceBonus)));
  })();

  const emotionBonus: Record<string, number> = { Calm: 28, Confident: 22, Tired: 10, Anxious: 6, 'Overconfident': 5, FOMO: 2, 'Revenge Trading': 0 };
  const process = journalProcess ?? Math.min(100, Math.round(
    (followed ? 44 : 8) + (emotionBonus[emotion] ?? 12) + (hasPreNotes ? 14 : 0) + (hasPostNotes ? 8 : 0) + Math.min(6, confidence * 0.6)
  ));

  const setupQuality = setupRating !== null && setupRating > 0
    ? Math.max(0, Math.min(100, Math.round(setupRating * 20)))
    : Math.min(100, Math.round(
      Math.min(42, confs * 9) + (rr >= 3 ? 38 : rr >= 2 ? 30 : rr >= 1.5 ? 22 : rr >= 1 ? 14 : 5) + Math.min(20, confidence * 2)
    ));

  const execBase: Record<string, number> = { TP: 82, BE: 52, SL: 22 };
  const execution = executionRating !== null && executionRating > 0
    ? Math.max(0, Math.min(100, Math.round(executionRating * 20)))
    : Math.min(100, Math.round((execBase[exitReason] ?? 22) + Math.min(18, confidence * 1.8)));

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
  { key: 'the read',        num: '02', label: 'The Read'      },
  { key: 'what happened',   num: '02', label: 'The Read'      },
  { key: 'next focus',      num: '03', label: 'Next Focus'    },
  { key: 'adjustment',      num: '03', label: 'Next Focus'    },
  { key: 'the rule',        num: '03', label: 'Next Focus'    },
  // legacy keys so cached responses still render correctly
  { key: 'your pattern',    num: '01', label: 'Your Stats'    },
  { key: 'this trade',      num: '02', label: 'The Read'      },
  { key: 'edge adjustment', num: '03', label: 'Next Focus'    },
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

            {/* Focus callout */}
            {section.rule && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 10px', padding: '8px 10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: C.acc, letterSpacing: '0.1em', textTransform: 'uppercase', paddingTop: 1, flexShrink: 0, fontFamily: 'var(--font-mono, monospace)' }}>
                  {section.label.toLowerCase() === 'next focus' ? 'FOCUS' : 'NOTE'}
                </span>
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
              {r.error ? para : inlineChips(para)}
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
  const { preferences } = useAppSettings();
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
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);
  const activeAccount = useFlyxaStore(state => state.accounts.find(account => account.id === state.activeAccountId) ?? state.accounts[0]);

  const focusedTradeId = searchParams.get('tradeId');
  const focusedEntry = useMemo(() => {
    if (!focusedTradeId) return null;
    return storeEntries.find(entry => entry.trades.some(trade => trade.id === focusedTradeId)) ?? null;
  }, [focusedTradeId, storeEntries]);
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
  const focusedTradeWithSessionContext = useMemo<Trade | null>(() => {
    if (!focusedTrade) return null;
    const tradeDate = focusedTrade.trade_date;
    const preSession = tradeDate ? preSessionHistory[tradeDate] : null;
    const commitment = preSession?.commitment && typeof preSession.commitment === 'object' ? preSession.commitment : null;
    const sessionContext = {
      emotion: String(commitment?.emotion ?? preSession?.emotion ?? ''),
      note: String(commitment?.note ?? preSession?.note ?? ''),
      bias: (commitment?.bias ?? preSession?.bias ?? {}) as Record<string, string>,
      readiness: commitment?.readiness ?? preSession?.readiness,
      sessionPlan: commitment?.sessionPlan ?? preSession?.sessionPlan ?? [],
      dailyReflection: focusedEntry?.dailyReflection
        ? {
          pre: focusedEntry.dailyReflection.pre,
          bias: focusedEntry.dailyReflection.bias,
          newsRisk: focusedEntry.dailyReflection.newsRisk,
          sessionTarget: focusedEntry.dailyReflection.sessionTarget,
          marketRespectedBias: focusedEntry.dailyReflection.marketRespectedBias,
        }
        : undefined,
    };

    const hasContext = Boolean(
      sessionContext.emotion
      || sessionContext.note
      || Object.keys(sessionContext.bias ?? {}).length
      || sessionContext.readiness
      || sessionContext.sessionPlan.length
      || sessionContext.dailyReflection
    );

    return hasContext ? { ...focusedTrade, sessionContext } : focusedTrade;
  }, [focusedEntry, focusedTrade, preSessionHistory]);
  const focusedTradePnl = useMemo(() => (focusedTrade ? Number(focusedTrade.pnl ?? 0) : null), [focusedTrade]);
  const focusedTradeConfluences = useMemo(() => normalizeConfluences(focusedTrade?.confluences), [focusedTrade]);
  const focusedTradeAnalysis = focusedTradeId ? tradeAnalysisById[focusedTradeId] : null;
  const focusedTradeAnalysisLoading = Boolean(focusedTradeId && tradeAnalysisLoadingId === focusedTradeId);

  useEffect(() => {
    let cancelled = false;
    if (!focusedTradeId || !focusedTradeWithSessionContext || tradeAnalysisById[focusedTradeId]) return;
    setTradeAnalysisLoadingId(focusedTradeId);
    setTradeAnalysisError(null);
    aiApi.analyzeTradeById(focusedTradeId, focusedTradeWithSessionContext, trades)
      .then(({ analysis }) => { if (!cancelled) setTradeAnalysisById(prev => ({ ...prev, [focusedTradeId]: analysis })); })
      .catch(err => { if (!cancelled) setTradeAnalysisError(err instanceof Error ? err.message : 'Unable to analyse this trade.'); })
      .finally(() => { if (!cancelled) setTradeAnalysisLoadingId(cur => cur === focusedTradeId ? null : cur); });
    return () => { cancelled = true; };
  }, [focusedTradeId, focusedTradeWithSessionContext, tradeAnalysisById, trades]);

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

    const activeRule = activeAccount && (activeAccount.type === 'eval' || activeAccount.phase === 'eval')
      ? inferEvaluationTemplate(activeAccount)
      : null;
    const stats = {
      ...computeAllStats(trades),
      activeAccount: activeAccount ? {
        id: activeAccount.id,
        name: activeAccount.name,
        firm: activeAccount.firm,
        size: activeAccount.size,
        phase: activeAccount.phase,
      } : null,
      activePropFirmRule: activeRule,
      availableTopstepRules: getEvaluationTemplates().filter(template => template.firm === 'Topstep'),
    };
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
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[190px_minmax(0,1fr)]">

        {/* ── Left sub-nav ── */}
        <FlyxaNav />

        {/* ── Main content ── */}
        <main className="min-h-0 overflow-y-auto flex flex-col" style={{ backgroundColor: C.d0 }}>

          {/* Header */}
          <div style={{ padding: '28px 32px 20px', borderBottom: `1px solid ${C.b0}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: C.t2, marginBottom: 6,
                }}>
                  Ask
                </div>
                <h1 style={{ fontSize: 32, fontWeight: 650, letterSpacing: '-0.04em', color: C.t0, margin: 0 }}>
                  Ask one clean question.
                </h1>
                <p style={{ fontSize: 13, color: C.t1, marginTop: 8, maxWidth: 560, lineHeight: 1.7 }}>
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
            <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
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
                    width: '100%', height: 48, borderRadius: 11,
                    border: `1px solid ${input ? C.acc + '50' : C.b0}`,
                    background: C.d2, color: C.t0,
                    padding: '0 16px', fontSize: 14, fontFamily: C.sans,
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
                  width: 48, height: 48, borderRadius: 11, border: 'none', flexShrink: 0,
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
            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {QUICK_QUESTIONS.slice(0, 5).map(q => (
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
            const confidence = ft ? getTradeConfidence(ft) : 5;

            const direction = String(ft?.direction ?? '');
            const isLong = direction === 'Long';
            const dirColor = isLong ? C.grn : C.red;
            const symbol = String(ft?.symbol ?? 'N/A');
            const tradeDate = String(ft?.trade_date ?? '');
            const tradeTime = String(ft?.trade_time ?? '').slice(0, 5);
            const session = focusedTrade
              ? deriveTradeSessionLabel(focusedTrade, preferences.sessionTimes)
              : String(ft?.session ?? '');

            return (
              <div style={{ borderBottom: `1px solid ${C.b0}` }}>
                {/* ── Header ── */}
                <div style={{ padding: '14px 20px 12px', borderBottom: `1px solid rgba(255,255,255,0.06)` }}>
                  {/* Top row: direction badge + symbol + P&L + close */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    {/* Direction badge */}
                    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 5, background: isLong ? 'rgba(34,214,138,0.1)' : 'rgba(240,82,82,0.1)', border: `1px solid ${isLong ? 'rgba(34,214,138,0.25)' : 'rgba(240,82,82,0.25)'}` }}>
                      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color: dirColor, fontFamily: 'var(--font-mono, monospace)', textTransform: 'uppercase' }}>{direction}</span>
                      <span style={{ fontSize: 10, color: dirColor, lineHeight: 1 }}>{isLong ? '↑' : '↓'}</span>
                    </div>
                    {/* Symbol */}
                    <span style={{ fontSize: 17, fontWeight: 800, color: C.t0, letterSpacing: '-0.03em', lineHeight: 1 }}>{symbol}</span>
                    {/* Date + session */}
                    <span style={{ fontSize: 11, color: C.t2, fontFamily: 'var(--font-mono, monospace)' }}>{tradeDate}{tradeTime ? ` · ${tradeTime}` : ''}{session ? ` · ${session}` : ''}</span>
                    {/* P&L */}
                    {focusedTradePnl !== null && (
                      <span style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', color: focusedTradePnl >= 0 ? C.grn : C.red, letterSpacing: '-0.02em', lineHeight: 1 }}>
                        {formatSignedCurrency(focusedTradePnl)}
                      </span>
                    )}
                    <button type="button" onClick={clearFocus} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t2, padding: '2px 0 2px 6px', display: 'flex', flexShrink: 0 }}>
                      <X size={13} />
                    </button>
                  </div>
                  {/* Tag pills row */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {followedLogged && (
                      <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: followed ? 'rgba(34,214,138,0.1)' : 'rgba(245,158,11,0.1)', border: `1px solid ${followed ? 'rgba(34,214,138,0.22)' : 'rgba(245,158,11,0.25)'}`, color: followed ? C.grn : C.acc }}>
                        {followed ? 'Plan Followed' : 'Plan Drifted'}
                      </span>
                    )}
                    {focusedTradeConfluences.map((c, i) => (
                      <span key={i} style={{ fontSize: 10, fontWeight: 500, padding: '2px 7px', borderRadius: 4, background: 'rgba(255,255,255,0.04)', border: `1px solid rgba(255,255,255,0.08)`, color: C.t2 }}>{c}</span>
                    ))}
                    {dataTags.filter(t => t !== 'Plan drifted').map((tag, i) => (
                      <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(240,82,82,0.08)', border: '1px solid rgba(240,82,82,0.18)', color: C.red }}>{tag}</span>
                    ))}
                  </div>
                </div>

                <div style={{ padding: '12px 20px 24px' }}>
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
                      <div style={{ paddingRight: 2 }}>
                        {renderReviewSections(focusedTradeAnalysis)}
                      </div>
                      {/* Footer */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 10, borderTop: `1px solid rgba(255,255,255,0.05)` }}>
                        <span style={{ fontSize: 10.5, color: C.t2 }}>Based on {trades.length} logged trade{trades.length !== 1 ? 's' : ''}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const params = new URLSearchParams();
                            if (symbol && symbol !== 'N/A') params.set('symbol', symbol);
                            if (focusedTradeConfluences.length > 0) params.set('tags', focusedTradeConfluences.join(','));
                            navigate(`/flyxa-ai/patterns${params.toString() ? `?${params.toString()}` : ''}`);
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: C.acc, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: C.sans }}
                        >
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
          <div style={{ flex: '0 0 auto', padding: '16px 24px 32px' }}>
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
