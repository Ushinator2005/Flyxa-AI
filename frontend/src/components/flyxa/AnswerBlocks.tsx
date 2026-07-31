import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Flyxa answer block library
//
// The model never writes layout. It classifies the question, returns a
// FlyxaAnswerSpec (a verdict line, an ordered list of data blocks, an optional
// directive, and the sample it's based on), and this file maps each block name
// to one fixed component. Every answer therefore looks like the same product.
//
// Guarantees enforced here (not left to the model):
//   • the verdict is always the first thing rendered — never a preamble
//   • numbers render as data (mono, tabular, tone-coloured) not buried in prose
//   • no answer shows more than MAX_DATA_BLOCKS data blocks
//   • the sample footer always renders when provided
//   • the empty state is a first-class block, so "no data" never bluffs
// ─────────────────────────────────────────────────────────────────────────────

const P = {
  panel: 'rgba(255,255,255,0.02)',
  panelSoft: 'rgba(255,255,255,0.015)',
  border: 'rgba(255,255,255,0.08)',
  borderSoft: 'rgba(255,255,255,0.06)',
  t0: 'var(--t0, #e8e3dc)',
  t1: 'var(--t1, #8a8178)',
  t2: 'var(--t2, #5c5751)',
  amber: 'var(--acc, #f59e0b)',
  green: 'var(--grn, #22d68a)',
  red: 'var(--red, #f05252)',
  mono: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
  sans: 'var(--font-sans, Inter, sans-serif)',
};

const MAX_DATA_BLOCKS = 2;

// ── Contract ──────────────────────────────────────────────────────────────────
export type AnswerShape =
  | 'comparison' | 'single_metric' | 'trend' | 'diagnosis' | 'ranking' | 'journal' | 'no_data';

/** good → green, bad → red, accent → amber, neutral → default text. */
export type Tone = 'good' | 'bad' | 'neutral' | 'accent';

export interface SplitSide {
  title: string;
  badge?: string;
  tone?: Tone;
  rows: { label: string; value: string; tone?: Tone }[];
}
export interface SplitBlock { type: 'split'; left: SplitSide; right: SplitSide; }

export interface HeroBlock {
  type: 'hero';
  value: string;            // e.g. "48.0"
  unit?: string;            // e.g. "%"
  tone?: Tone;
  label: string;            // e.g. "Win rate · July ▲9.0 pts vs June" (supports inline markup)
  right?: string[];         // right-aligned muted lines, e.g. ["25 trades", "12 W · 12 L · 1 BE"]
}

export interface ChartBlock {
  type: 'chart';
  points: number[];         // y values in series order
  markerIndex?: number;     // index where the line changes colour / a dashed marker sits
  markerLabel?: string;     // e.g. "Jul 14 · one trade per day"
  startLabel?: string;      // left axis label, e.g. "Jun 01"
  endLabel?: string;        // right axis label, e.g. "Jul 31"
}

export interface CauseRow { title: string; impact: string; tone?: Tone; detail?: string; weight?: number; }
export interface CausesBlock { type: 'causes'; items: CauseRow[]; }

export interface RankRow { name: string; nameTone?: Tone; meta?: string; value: string; tone?: Tone; }
export interface RankedBlock { type: 'ranked'; items: RankRow[]; }

export interface QuoteRow { date?: string; text: string; }
export interface QuotesBlock { type: 'quotes'; items: QuoteRow[]; }

export interface Pill { label: string; value?: string; tone?: Tone; }
export interface PillsBlock { type: 'pills'; items: Pill[]; }

export interface EmptyBlock { type: 'empty'; title: string; body: string; suggestions?: string[]; }

export type AnswerBlock =
  | SplitBlock | HeroBlock | ChartBlock | CausesBlock
  | RankedBlock | QuotesBlock | PillsBlock | EmptyBlock;

export interface FlyxaAnswerSpec {
  shape: AnswerShape;
  verdict: string;                    // the answer, first line. Supports **bold** and ~accent~
  verdictNote?: string;               // muted sub-line under the verdict
  blocks: AnswerBlock[];
  directive?: { text: string; sub?: string };
  footer?: string;                    // sample line, e.g. "69 trades analysed · 4 sessions compared"
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toneColor(tone?: Tone): string {
  switch (tone) {
    case 'good': return P.green;
    case 'bad': return P.red;
    case 'accent': return P.amber;
    default: return P.t0;
  }
}

/** Inline markup: **bold**, ~accent~, and auto tone-colouring of signed money/percent. */
function renderInline(text: string): React.ReactNode {
  // Split on the markup tokens and signed numeric tokens, keeping delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|~[^~]+~|[+−-]\$[\d,]+(?:\.\d+)?|[+−-]\d+(?:\.\d+)?%)/g);
  return parts.filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontWeight: 600, color: P.t0 }}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('~') && part.endsWith('~')) {
      return <span key={i} style={{ color: P.amber, fontWeight: 600 }}>{part.slice(1, -1)}</span>;
    }
    if (/^[+−-]\$[\d,]+(?:\.\d+)?$/.test(part) || /^[+−-]\d+(?:\.\d+)?%$/.test(part)) {
      const neg = part.startsWith('-') || part.startsWith('−');
      return <span key={i} style={{ color: neg ? P.red : P.green, fontFamily: P.mono, fontWeight: 600 }}>{part}</span>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

const microLabel: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.13em', textTransform: 'uppercase', color: P.t2, fontFamily: P.mono,
};
const monoNum: React.CSSProperties = { fontFamily: P.mono, fontVariantNumeric: 'tabular-nums' };

// ── Blocks ────────────────────────────────────────────────────────────────────
function Split({ block }: { block: SplitBlock }) {
  const Side = ({ side, divider }: { side: SplitSide; divider?: boolean }) => (
    <div style={{ padding: '13px 16px', borderLeft: divider ? `1px solid ${P.border}` : undefined, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: toneColor(side.tone) }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: P.t0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{side.title}</span>
        </span>
        {side.badge && <span style={{ ...microLabel, color: P.t2, letterSpacing: '0.04em', flexShrink: 0 }}>{side.badge}</span>}
      </div>
      {side.rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
          <span style={{ fontSize: 12, color: P.t1 }}>{r.label}</span>
          <span style={{ ...monoNum, fontSize: 12.5, fontWeight: 600, color: toneColor(r.tone ?? side.tone) }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: `1px solid ${P.border}`, borderRadius: 10, overflow: 'hidden', background: P.panelSoft }}>
      <Side side={block.left} />
      <Side side={block.right} divider />
    </div>
  );
}

function Hero({ block }: { block: HeroBlock }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 20px', border: `1px solid ${P.border}`, borderRadius: 10, background: P.panelSoft }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline' }}>
          <span style={{ ...monoNum, fontSize: 44, fontWeight: 700, letterSpacing: '-0.03em', color: toneColor(block.tone), lineHeight: 1 }}>{block.value}</span>
          {block.unit && <span style={{ ...monoNum, fontSize: 20, fontWeight: 700, color: toneColor(block.tone), opacity: 0.85 }}>{block.unit}</span>}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: P.t1, lineHeight: 1.5 }}>{renderInline(block.label)}</span>
      </div>
      {block.right && block.right.length > 0 && (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {block.right.map((line, i) => (
            <div key={i} style={{ ...monoNum, fontSize: 10.5, color: P.t2, lineHeight: 1.7 }}>{renderInline(line)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chart({ block }: { block: ChartBlock }) {
  const W = 800, H = 190, padX = 6, padTop = 14, padBottom = 30;
  const pts = block.points.length ? block.points : [0];
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBottom;
  const xAt = (i: number) => padX + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const yAt = (v: number) => padTop + innerH - ((v - min) / span) * innerH;
  const marker = block.markerIndex ?? -1;
  const path = (from: number, to: number) =>
    pts.slice(from, to + 1).map((v, k) => `${k === 0 ? 'M' : 'L'} ${xAt(from + k).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
  const hasMarker = marker > 0 && marker < pts.length;
  const baselineY = yAt(pts[0]);
  return (
    <div style={{ border: `1px solid ${P.border}`, borderRadius: 10, background: P.panelSoft, padding: '4px 4px 0' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} preserveAspectRatio="none">
        <line x1={padX} y1={baselineY} x2={W - padX} y2={baselineY} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        {hasMarker
          ? <>
              <path d={path(0, marker)} fill="none" stroke={P.amber} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
              <path d={path(marker, pts.length - 1)} fill="none" stroke={P.green} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
              <line x1={xAt(marker)} y1={padTop - 6} x2={xAt(marker)} y2={padTop + innerH} stroke={P.amber} strokeWidth={1} strokeDasharray="4 4" opacity={0.7} />
            </>
          : <path d={path(0, pts.length - 1)} fill="none" stroke={P.amber} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
        <circle cx={xAt(pts.length - 1)} cy={yAt(pts[pts.length - 1])} r={4} fill={hasMarker ? P.green : P.amber} />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 10px 10px', marginTop: -22 }}>
        <span style={{ ...monoNum, fontSize: 9.5, color: P.t2 }}>{block.startLabel}</span>
        {block.markerLabel && <span style={{ ...monoNum, fontSize: 9.5, color: P.amber }}>{block.markerLabel}</span>}
        <span style={{ ...monoNum, fontSize: 9.5, color: P.t2 }}>{block.endLabel}</span>
      </div>
    </div>
  );
}

function Causes({ block }: { block: CausesBlock }) {
  const maxWeight = Math.max(...block.items.map(i => i.weight ?? 1), 1);
  return (
    <div>
      {block.items.map((c, i) => (
        <div key={i} style={{ padding: '14px 0', borderTop: i > 0 ? `1px solid ${P.borderSoft}` : undefined }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: P.t0 }}>{renderInline(c.title)}</span>
            <span style={{ ...monoNum, fontSize: 13, fontWeight: 600, color: toneColor(c.tone ?? 'bad'), flexShrink: 0 }}>{c.impact}</span>
          </div>
          <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.06)', marginBottom: c.detail ? 8 : 0 }}>
            <div style={{ height: '100%', borderRadius: 2, width: `${Math.max(8, ((c.weight ?? 1) / maxWeight) * 100)}%`, background: toneColor(c.tone ?? 'bad') }} />
          </div>
          {c.detail && <p style={{ fontSize: 12, color: P.t1, margin: 0, lineHeight: 1.5 }}>{renderInline(c.detail)}</p>}
        </div>
      ))}
    </div>
  );
}

function Ranked({ block }: { block: RankedBlock }) {
  return (
    <div style={{ border: `1px solid ${P.border}`, borderRadius: 10, overflow: 'hidden', background: P.panelSoft }}>
      {block.items.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 15px', borderTop: i > 0 ? `1px solid ${P.borderSoft}` : undefined }}>
          <span style={{ ...monoNum, fontSize: 10, color: P.t2, width: 16, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: toneColor(r.nameTone), flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
          {r.meta && <span style={{ ...monoNum, fontSize: 11, color: P.t2, flexShrink: 0 }}>{r.meta}</span>}
          <span style={{ ...monoNum, fontSize: 12.5, fontWeight: 600, color: toneColor(r.tone), width: 78, textAlign: 'right', flexShrink: 0 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Quotes({ block }: { block: QuotesBlock }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {block.items.map((q, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          {q.date && <span style={{ ...monoNum, fontSize: 10.5, color: P.t2, flexShrink: 0, width: 42 }}>{q.date}</span>}
          <span style={{ fontSize: 12.5, color: P.t1, lineHeight: 1.5, fontStyle: 'italic' }}>“{q.text}”</span>
        </div>
      ))}
    </div>
  );
}

function Pills({ block }: { block: PillsBlock }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {block.items.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 6, border: `1px solid ${P.border}`, background: P.panel, fontSize: 11.5, color: P.t1 }}>
          {p.label}
          {p.value && <span style={{ ...monoNum, fontWeight: 700, color: toneColor(p.tone) }}>{p.value}</span>}
        </span>
      ))}
    </div>
  );
}

function Empty({ block, onSuggestion }: { block: EmptyBlock; onSuggestion?: (s: string) => void }) {
  return (
    <div>
      <div style={{ border: `1px dashed ${P.border}`, borderRadius: 10, padding: '16px 18px' }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: P.t0, margin: '0 0 7px' }}>{block.title}</p>
        <p style={{ fontSize: 12.5, color: P.t1, margin: 0, lineHeight: 1.6 }}>{renderInline(block.body)}</p>
      </div>
      {block.suggestions && block.suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 12 }}>
          {block.suggestions.map((s, i) => (
            <button key={i} type="button" onClick={() => onSuggestion?.(s)}
              style={{ padding: '6px 12px', borderRadius: 7, border: `1px solid ${P.border}`, background: P.panel, color: P.t1, fontSize: 11.5, cursor: 'pointer', fontFamily: P.sans }}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Directive({ text, sub }: { text: string; sub?: string }) {
  return (
    <div style={{ borderLeft: `2px solid ${P.amber}`, background: P.panel, borderRadius: '0 8px 8px 0', padding: '12px 16px' }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: P.t0, margin: 0, lineHeight: 1.5 }}>{renderInline(text)}</p>
      {sub && <p style={{ fontSize: 12, color: P.t1, margin: '6px 0 0', lineHeight: 1.5 }}>{renderInline(sub)}</p>}
    </div>
  );
}

function DataBlock({ block, onSuggestion }: { block: AnswerBlock; onSuggestion?: (s: string) => void }) {
  switch (block.type) {
    case 'split':  return <Split block={block} />;
    case 'hero':   return <Hero block={block} />;
    case 'chart':  return <Chart block={block} />;
    case 'causes': return <Causes block={block} />;
    case 'ranked': return <Ranked block={block} />;
    case 'quotes': return <Quotes block={block} />;
    case 'pills':  return <Pills block={block} />;
    case 'empty':  return <Empty block={block} onSuggestion={onSuggestion} />;
    default:       return null;
  }
}

// Pills / quotes are auxiliary; only these count toward the two-data-block cap.
const DATA_BLOCK_TYPES = new Set<AnswerBlock['type']>(['split', 'hero', 'chart', 'causes', 'ranked', 'empty']);

// ── Renderer ──────────────────────────────────────────────────────────────────
export default function FlyxaAnswer({ spec, onSuggestion }: { spec: FlyxaAnswerSpec; onSuggestion?: (s: string) => void }) {
  // Enforce the two-data-block ceiling; auxiliary blocks (pills/quotes) pass through.
  let dataCount = 0;
  const blocks = spec.blocks.filter(b => {
    if (!DATA_BLOCK_TYPES.has(b.type)) return true;
    if (dataCount >= MAX_DATA_BLOCKS) return false;
    dataCount += 1;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: P.sans }}>
      {/* Verdict — always first, always the answer */}
      <div>
        <p style={{ fontSize: 20, fontWeight: 600, color: P.t0, lineHeight: 1.3, margin: 0, letterSpacing: '-0.01em' }}>
          {renderInline(spec.verdict)}
        </p>
        {spec.verdictNote && (
          <p style={{ fontSize: 13, color: P.t1, margin: '9px 0 0', lineHeight: 1.55 }}>{renderInline(spec.verdictNote)}</p>
        )}
      </div>

      {blocks.map((b, i) => <DataBlock key={i} block={b} onSuggestion={onSuggestion} />)}

      {spec.directive && <Directive text={spec.directive.text} sub={spec.directive.sub} />}

      {spec.footer && (
        <p style={{ ...monoNum, fontSize: 10, color: P.t2, margin: 0, letterSpacing: '0.03em' }}>{spec.footer}</p>
      )}
    </div>
  );
}
