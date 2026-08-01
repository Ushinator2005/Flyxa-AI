import { useCallback, useRef, useState } from 'react';
import { Upload, X, Check, AlertTriangle, FileText } from 'lucide-react';

// ─── colours ──────────────────────────────────────────────────────────────────
const C = {
  d0: 'var(--app-bg, #0e0d0d)',
  d1: 'var(--app-panel, #141312)',
  d2: 'var(--app-panel-strong, #1a1917)',
  b0: 'var(--app-border, rgba(255,255,255,0.07))',
  t0: 'var(--app-text, #e8e3dc)',
  t1: 'var(--app-text-muted, #8a8178)',
  t2: 'var(--app-text-subtle, #5c5751)',
  acc: '#f59e0b',
  grn: '#22d68a',
  red: '#f05252',
  sans: 'var(--font-sans, Inter, sans-serif)',
  mono: 'var(--font-mono, monospace)',
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Step = 'upload' | 'map' | 'preview' | 'done';

type FieldKey =
  | 'symbol' | 'direction' | 'entry_price' | 'exit_price'
  | 'pnl' | 'trade_date' | 'trade_time' | 'close_time'
  | 'contract_size' | 'sl_price' | 'tp_price'
  | 'pre_trade_notes' | 'followed_plan' | 'emotional_state'
  | 'confluences';

interface FieldDef {
  key: FieldKey;
  label: string;
  required: boolean;
  hint: string;
}

const FIELDS: FieldDef[] = [
  { key: 'symbol',         label: 'Symbol',        required: true,  hint: 'NQ, ES, AAPL…'         },
  { key: 'direction',      label: 'Direction',     required: false, hint: 'Long/Short, Buy/Sell, auto-inferred from P&L if missing' },
  { key: 'entry_price',    label: 'Entry Price',   required: false, hint: 'Numeric, optional'      },
  { key: 'exit_price',     label: 'Exit Price',    required: false, hint: 'Numeric, optional'      },
  { key: 'pnl',            label: 'P&L',           required: true,  hint: 'Numeric, e.g. 250 or -100' },
  { key: 'trade_date',     label: 'Date',          required: true,  hint: 'YYYY-MM-DD or MM/DD/YYYY' },
  { key: 'trade_time',     label: 'Entry Time',    required: false, hint: 'HH:MM'                  },
  { key: 'close_time',     label: 'Exit Time',     required: false, hint: 'HH:MM'                  },
  { key: 'contract_size',  label: 'Contracts',     required: false, hint: 'Numeric, default 1'     },
  { key: 'sl_price',       label: 'Stop Loss',     required: false, hint: 'Numeric'                },
  { key: 'tp_price',       label: 'Take Profit',   required: false, hint: 'Numeric'                },
  { key: 'pre_trade_notes',label: 'Notes',         required: false, hint: 'Text'                   },
  { key: 'followed_plan',  label: 'Followed Plan', required: false, hint: 'yes/no, true/false'     },
  { key: 'emotional_state',label: 'Emotion',       required: false, hint: 'Calm, Anxious...'       },
  { key: 'confluences',    label: 'Confluences',   required: false, hint: 'Setup tags, model, bias, entry signal' },
];

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const normalized = text.replace(/^\uFEFF/, '');
  const table: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];

    if (ch === '"') {
      if (inQ && next === '"') { cur += '"'; i++; }
      else inQ = !inQ;
      continue;
    }

    if (ch === ',' && !inQ) { row.push(cur.trim()); cur = ''; continue; }

    if ((ch === '\n' || ch === '\r') && !inQ) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some(c => c !== '')) table.push(row);
      row = [];
      continue;
    }

    cur += ch;
  }

  row.push(cur.trim());
  if (row.some(c => c !== '')) table.push(row);

  if (table.length < 2) return { headers: [], rows: [] };
  return { headers: table[0], rows: table.slice(1) };
}

// ─── Auto column guesser ──────────────────────────────────────────────────────
const GUESSES: Record<FieldKey, string[]> = {
  symbol:         ['symbol', 'instrument', 'contract', 'ticker', 'market', 'asset', 'pair', 'name', 'product', 'security', 'underlying'],
  direction:      ['direction', 'position', 'side', 'b/s', 'buy/sell', 'long/short', 'market pos', 'market pos.', 'pos', 'action', 'trade side', 'order side'],
  entry_price:    ['entry price', 'entry', 'open price', 'avg price', 'avg entry', 'buy price', 'entry avg', 'entry level', 'avg entry price', 'fill price'],
  exit_price:     ['exit price', 'exit', 'close price', 'sell price', 'avg exit', 'exit avg', 'exit level', 'avg exit price'],
  pnl:            ['net pnl', 'net p&l', 'net p/l', 'pnl', 'p&l', 'p/l', 'realized pnl', 'realized p&l', 'realized p/l', 'net profit', 'result $', 'gain/loss', 'gain', 'profit', 'profit/loss', 'profit loss', 'closed p&l', 'closed p/l', 'total profit', 'p&l $', 'net amount'],
  trade_date:     ['date', 'trade date', 'entry date', 'open date', 'day', 'session date', 'created time', 'created', 'close date', 'exit date', 'execution date', 'trade_date', 'closed date'],
  trade_time:     ['entry time', 'time', 'open time', 'open', 'entry_time', 'opened at', 'start time'],
  close_time:     ['exit time', 'close time', 'exit_time', 'close_time', 'closed at', 'end time'],
  contract_size:  ['qty', 'quantity', 'contracts', 'size', 'volume', 'shares', 'lots', 'position size'],
  sl_price:       ['stop loss', 'sl', 'stop', 'sl price'],
  tp_price:       ['take profit', 'tp', 'target', 'tp price', 'profit target'],
  pre_trade_notes:['notes', 'comment', 'comments', 'remarks', 'note', 'description', 'reflection', 'review', 'lesson', 'thesis'],
  followed_plan:  ['followed plan', 'plan', 'follow plan', 'followed_plan', 'followed rules', 'rules followed', 'on plan'],
  emotional_state:['emotion', 'emotional state', 'mood', 'feeling', 'state', 'mindset', 'psychology'],
  confluences:    ['confluence', 'confluences', 'model', 'setup', 'strategy', 'entry signal', 'entry signals', 'type of trade', 'trade type', 'narrative', 'bias', 'tags', 'tag'],
};

function autoGuessMapping(headers: string[]): Record<FieldKey, string> {
  const lower = headers.map(h => h.toLowerCase().trim());
  const mapping: Partial<Record<FieldKey, string>> = {};
  for (const field of FIELDS) {
    for (const guess of GUESSES[field.key]) {
      const idx = lower.findIndex(h => h === guess);
      if (idx !== -1) { mapping[field.key] = headers[idx]; break; }
    }
    if (mapping[field.key]) continue;
    for (const guess of GUESSES[field.key]) {
      const idx = lower.findIndex(h => h === guess || h.includes(guess));
      if (idx !== -1) { mapping[field.key] = headers[idx]; break; }
    }
  }
  if (!mapping.trade_date && mapping.trade_time) mapping.trade_date = mapping.trade_time;
  return mapping as Record<FieldKey, string>;
}

// ─── Value parsers ─────────────────────────────────────────────────────────────
function parseDirection(v: string): 'Long' | 'Short' | null {
  const s = v.trim().toLowerCase();
  if (['long', 'buy', 'b', 'l', 'bot', 'bought'].includes(s)) return 'Long';
  if (['short', 'sell', 's', 'sld', 'sold'].includes(s)) return 'Short';
  return null;
}

function parseDate(v: string): string | null {
  if (!v) return null;
  const d = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const slash = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const [, first, second, y] = slash;
    const firstNum = Number(first);
    const secondNum = Number(second);
    const m = firstNum > 12 && secondNum <= 12 ? second : first;
    const day = firstNum > 12 && secondNum <= 12 ? first : second;
    return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const eu = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (eu) {
    const [, day, m, y] = eu;
    return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const parsed = new Date(d);
  if (!Number.isNaN(parsed.getTime())) {
    // Use UTC to avoid timezone-shifting a date-only string into the previous day
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
  }
  return null;
}

function parseTime(v: string): string | null {
  if (!v) return null;
  const d = v.trim();
  const ampm = d.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2];
    const mer = ampm[3].toUpperCase();
    if (mer === 'PM' && h !== 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  const hm = d.match(/(\d{1,2}):(\d{2})/);
  if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
  return null;
}

function parseSymbol(v: string): string {
  return v
    .trim()
    .replace(/\s*\(https?:\/\/[^)]*\)\s*/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+\d{2}-\d{2}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parseNum(v: string): number | null {
  if (!v) return null;
  const raw = v.trim();
  // Strip currency symbols and leading/trailing currency codes (e.g. "USD 250", "250 EUR", "€250", "£-100")
  const preStripped = raw
    .replace(/[€£¥₹]/g, '')
    .replace(/^[A-Za-z]{2,4}\s+/i, '')   // "USD 250" → "250"
    .replace(/\s+[A-Za-z]{2,4}$/i, '')    // "250 USD" → "250"
    .trim();
  const cleaned = preStripped.replace(/[+$,()]/g, '').trim();
  if (!cleaned || /^[-–—]$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  const neg = /^\(.*\)$/.test(raw) || /^[-\u2212]/.test(raw) || /^[-\u2212]/.test(preStripped);
  return isNaN(n) ? null : neg ? -Math.abs(n) : n;
}

function parseFollowedPlan(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['yes', 'true', '1', 'y', 'checked', 'done', 'on plan'].includes(s)) return true;
  if (['no', 'false', '0', 'n', 'unchecked', 'off plan'].includes(s)) return false;
  return null;
}

function cleanTag(tag: string): string {
  return tag
    .replace(/\s*\(https?:\/\/[^)]*\)\s*/gi, ' ')  // strip "(https://...)" inline links
    .replace(/https?:\/\/\S+/gi, ' ')               // strip bare URLs
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTags(v: string): string[] {
  if (!v) return [];
  return v
    .split(/[,;|]/)
    .map(tag => cleanTag(tag))
    .filter(Boolean)
    .filter((tag, index, all) => all.findIndex(item => item.toLowerCase() === tag.toLowerCase()) === index);
}

// ─── Row mapper ───────────────────────────────────────────────────────────────
type ImportedTrade = {
  symbol: string;
  direction: 'Long' | 'Short';
  entry_price: number;
  exit_price: number;
  pnl: number;
  trade_date: string;
  trade_time?: string;
  close_time?: string;
  contract_size?: number;
  sl_price?: number;
  tp_price?: number;
  pre_trade_notes?: string;
  followed_plan?: boolean;
  emotional_state?: string;
  confluences?: string[];
  _errors: string[];
};

function mapRow(row: string[], headers: string[], mapping: Record<FieldKey, string>, confluenceColumns: string[] = []): ImportedTrade | null {
  const get = (field: FieldKey): string => {
    const col = mapping[field];
    if (!col) return '';
    const idx = headers.indexOf(col);
    return idx >= 0 ? (row[idx] ?? '') : '';
  };
  const getColumn = (col: string): string => {
    const idx = headers.indexOf(col);
    return idx >= 0 ? (row[idx] ?? '') : '';
  };

  const errors: string[] = [];
  const symbol = parseSymbol(get('symbol'));
  if (!symbol) errors.push('Missing symbol');

  // Parse P&L first so direction can be inferred from its sign
  const pnlRaw = get('pnl');
  const pnl = parseNum(pnlRaw);
  if (pnl === null) errors.push(`Bad P&L: "${pnlRaw}"`);

  // Direction: use mapped column if available and recognised; otherwise infer from P&L sign.
  // Never error on missing/unrecognised direction — it is always recoverable from P&L.
  const direction: 'Long' | 'Short' =
    parseDirection(get('direction')) ?? (pnl !== null ? (pnl >= 0 ? 'Long' : 'Short') : 'Long');

  const entryRaw = get('entry_price');
  const entry_price = parseNum(entryRaw);
  if (entryRaw.trim() && entry_price === null) errors.push(`Bad entry price: "${entryRaw}"`);

  const exitRaw = get('exit_price');
  const exit_price = parseNum(exitRaw);
  if (exitRaw.trim() && exit_price === null) errors.push(`Bad exit price: "${exitRaw}"`);

  const dateRaw = get('trade_date');
  const trade_date = parseDate(dateRaw);
  if (!trade_date) errors.push(`Bad date: "${dateRaw}"`);

  if (errors.length > 0) return { symbol, direction, entry_price: entry_price ?? 0, exit_price: exit_price ?? 0, pnl: pnl ?? 0, trade_date: trade_date ?? '', _errors: errors };

  const timeRaw = get('trade_time');
  const trade_time = parseTime(timeRaw) ?? undefined;
  const closeRaw = get('close_time');
  const close_time = parseTime(closeRaw) ?? undefined;
  const contracts = parseNum(get('contract_size'));
  const sl_price = parseNum(get('sl_price')) ?? undefined;
  const tp_price = parseNum(get('tp_price')) ?? undefined;
  const notes = get('pre_trade_notes').trim() || undefined;
  const fp = parseFollowedPlan(get('followed_plan'));
  const emotion = get('emotional_state').trim() || undefined;
  const confluenceRaw = confluenceColumns.length > 0
    ? confluenceColumns.map(getColumn).filter(Boolean).join(', ')
    : get('confluences');
  const confluences = parseTags(confluenceRaw);

  return {
    symbol, direction, entry_price: entry_price ?? exit_price ?? 0,
    exit_price: exit_price ?? entry_price ?? 0, pnl: pnl!, trade_date: trade_date!,
    trade_time, close_time, contract_size: contracts && contracts > 0 ? contracts : undefined,
    sl_price, tp_price, pre_trade_notes: notes,
    followed_plan: typeof fp === 'boolean' ? fp : undefined,
    emotional_state: emotion, confluences: confluences.length > 0 ? confluences : undefined,
    _errors: [],
  };
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface CSVImportModalProps {
  onClose: () => void;
  onImport: (trades: ImportedTrade[]) => Promise<void>;
}

// ─── STEPS label map ──────────────────────────────────────────────────────────
const STEP_LABELS: Record<Step, string> = {
  upload: 'Upload',
  map: 'Map columns',
  preview: 'Preview',
  done: 'Done',
};
const STEP_ORDER: Step[] = ['upload', 'map', 'preview', 'done'];

const PLATFORMS = [
  { name: 'NinjaTrader', domain: 'ninjatrader.com',  cols: 'Instrument · Market pos. · Quantity · Entry price · Exit price · Profit' },
  { name: 'Tradovate',   domain: 'tradovate.com',    cols: 'Symbol · B/S · Qty · Avg Price · Net Profit · Time' },
  { name: 'TopStep',     domain: 'topstep.com',      cols: 'Symbol · Side · Qty · Avg Entry · Avg Exit · P/L' },
  { name: 'Notion',      domain: 'notion.so',        cols: 'Name · Direction · P&L · Date · Tags · Emotion' },
  { name: 'Generic CSV', domain: null,               cols: 'Symbol · Direction · P&L · Date · Contracts · Notes' },
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function CSVImportModal({ onClose, onImport }: CSVImportModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [parsed, setParsed] = useState<(ImportedTrade | null)[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: number; fail: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState('');
  const [previewLimit, setPreviewLimit] = useState<number | 'all'>(20);
  const [confluenceColumns, setConfluenceColumns] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const processText = useCallback((text: string) => {
    const { headers: h, rows: r } = parseCSV(text);
    if (h.length === 0) { setFileError('Could not parse CSV, check the file has a header row.'); return; }
    if (r.length === 0) { setFileError('CSV has headers but no data rows.'); return; }
    const guessed = autoGuessMapping(h);
    setHeaders(h); setRows(r);
    setMapping(guessed);
    setConfluenceColumns(guessed.confluences ? [guessed.confluences] : []);
    setFileError(''); setStep('map');
  }, []);

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.(csv|txt)$/i)) { setFileError('Please upload a .csv or .txt file.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => processText((e.target?.result as string) ?? '');
    reader.readAsText(file);
  }, [processText]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleGoPreview = useCallback(() => {
    setParsed(rows.map(r => mapRow(r, headers, mapping as Record<FieldKey, string>, confluenceColumns)));
    setStep('preview');
  }, [rows, headers, mapping, confluenceColumns]);

  const handleImport = useCallback(async () => {
    const valid = parsed.filter((t): t is ImportedTrade => t !== null && t._errors.length === 0);
    if (valid.length === 0) return;
    setImporting(true);
    try {
      await onImport(valid);
      setImportResult({ ok: valid.length, fail: parsed.filter(t => !t || t._errors.length > 0).length });
      setStep('done');
    } finally {
      setImporting(false);
    }
  }, [parsed, onImport]);

  const validCount = parsed.filter(t => t && t._errors.length === 0).length;
  const errorCount = parsed.filter(t => !t || t._errors.length > 0).length;
  const requiredMapped = FIELDS.filter(f => f.required).every(f => mapping[f.key]);
  const currentIdx = STEP_ORDER.indexOf(step);
  const visiblePreviewRows = previewLimit === 'all' ? parsed : parsed.slice(0, previewLimit);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        background: 'rgba(8,7,6,0.88)',
        backdropFilter: 'blur(10px)',
        fontFamily: C.sans,
      }}
    >
      <div style={{
        width: 'min(740px, 100%)',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        border: `1px solid ${C.b0}`,
        borderTop: `2px solid ${C.acc}`,
        background: C.d1,
        overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,0.55)',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${C.b0}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
              color: C.acc, background: 'rgba(245,158,11,0.1)',
              border: '1px solid rgba(245,158,11,0.22)',
              borderRadius: 4, padding: '2px 7px',
            }}>CSV</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}>
              Import trade history
            </span>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t2, padding: 4, lineHeight: 0, display: 'flex' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Step bar */}
        <div style={{
          padding: '0 20px',
          borderBottom: `1px solid ${C.b0}`,
          display: 'flex',
          gap: 0,
        }}>
          {STEP_ORDER.map((s, i) => {
            const isCurrent = step === s;
            const isPast = currentIdx > i;
            return (
              <div
                key={s}
                style={{
                  padding: '10px 16px 9px',
                  fontSize: 11,
                  fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? C.t0 : isPast ? C.t1 : C.t2,
                  borderBottom: isCurrent ? `2px solid ${C.acc}` : '2px solid transparent',
                  display: 'flex', alignItems: 'center', gap: 5,
                  marginBottom: -1,
                  transition: 'color 0.15s',
                }}
              >
                {isPast && <Check size={10} style={{ color: C.grn }} />}
                {STEP_LABELS[s]}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>

          {/* ── Upload ── */}
          {step === 'upload' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Drop zone */}
              <div
                onDrop={handleDrop}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => inputRef.current?.click()}
                style={{
                  border: `1px dashed ${dragOver ? C.acc : 'rgba(255,255,255,0.14)'}`,
                  borderRadius: 8,
                  padding: '36px 24px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.02)',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <Upload size={20} style={{ color: dragOver ? C.acc : C.t2, marginBottom: 12 }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: C.t0, marginBottom: 8, letterSpacing: '-0.01em' }}>
                  Drop your CSV here
                </div>
                <div style={{ fontSize: 12, color: C.t1, lineHeight: 1.6, maxWidth: 380, margin: '0 auto' }}>
                  Flyxa maps your columns automatically and creates journal days for each trade.
                </div>
                <div style={{ marginTop: 14, fontSize: 11, color: C.t2 }}>
                  .csv or .txt · any broker format
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.txt"
                  style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
              </div>

              {fileError && (
                <div style={{
                  padding: '9px 13px', borderRadius: 7,
                  background: `${C.red}10`, border: `1px solid ${C.red}28`,
                  color: C.red, fontSize: 12, display: 'flex', gap: 8, alignItems: 'center',
                }}>
                  <AlertTriangle size={13} />
                  {fileError}
                </div>
              )}

              {/* Platform list */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.t2, marginBottom: 10 }}>
                  Supported platforms
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: `1px solid ${C.b0}`, borderRadius: 8, overflow: 'hidden' }}>
                  {PLATFORMS.map((p, i) => (
                    <div
                      key={p.name}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '140px 1fr',
                        gap: 12,
                        alignItems: 'center',
                        padding: '9px 14px',
                        borderBottom: i < PLATFORMS.length - 1 ? `1px solid ${C.b0}` : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        {p.domain ? (
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${p.domain}&sz=32`}
                            alt=""
                            width={16}
                            height={16}
                            style={{ borderRadius: 3, flexShrink: 0, opacity: 0.9 }}
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <FileText size={14} style={{ color: C.t2, flexShrink: 0 }} />
                        )}
                        <span style={{ fontSize: 11.5, fontWeight: 650, color: C.t0 }}>{p.name}</span>
                      </div>
                      <span style={{ fontSize: 10.5, color: C.t2, fontFamily: C.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.cols}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: C.t2 }}>
                  Column names don't need to match exactly, you can remap everything on the next step.
                </div>
              </div>
            </div>
          )}

          {/* ── Map ── */}
          {step === 'map' && (
            <div>
              <div style={{ fontSize: 12.5, color: C.t1, marginBottom: 16 }}>
                <strong style={{ color: C.t0 }}>{rows.length} rows</strong> · <strong style={{ color: C.t0 }}>{headers.length} columns</strong> detected.
                {' '}Match each field to a column in your file.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
                {FIELDS.filter(field => field.key !== 'confluences').map(field => (
                  <div key={field.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: field.required ? C.acc : C.t2 }}>
                        {field.label}
                      </label>
                      {field.required && <span style={{ fontSize: 9, color: C.acc }}>required</span>}
                    </div>
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value || undefined }))}
                      style={{
                        width: '100%',
                        height: 33, borderRadius: 6, padding: '0 9px',
                        border: `1px solid ${mapping[field.key] ? 'rgba(245,158,11,0.35)' : C.b0}`,
                        background: C.d2,
                        color: mapping[field.key] ? C.t0 : C.t2,
                        fontSize: 12, fontFamily: C.sans, outline: 'none', cursor: 'pointer',
                      }}
                    >
                      <option value="">— skip —</option>
                      {headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 10, color: C.t2, marginTop: 3, display: 'block' }}>{field.hint}</span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 18,
                  padding: 14,
                  borderRadius: 8,
                  border: `1px solid ${confluenceColumns.length > 0 ? 'rgba(245,158,11,0.32)' : C.b0}`,
                  background: 'rgba(245,158,11,0.035)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.acc }}>
                      Confluences
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: C.t1 }}>
                      Select every column that describes your setup or edge. Flyxa will combine them into trade tags.
                    </div>
                  </div>
                  {confluenceColumns.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setConfluenceColumns([])}
                      style={{ background: 'none', border: 'none', color: C.t2, fontSize: 11, cursor: 'pointer', padding: 0 }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                  {headers.map(header => {
                    const selected = confluenceColumns.includes(header);
                    return (
                      <label
                        key={header}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          minWidth: 0,
                          padding: '7px 9px',
                          borderRadius: 6,
                          border: `1px solid ${selected ? 'rgba(245,158,11,0.38)' : C.b0}`,
                          background: selected ? 'rgba(245,158,11,0.09)' : C.d2,
                          color: selected ? C.t0 : C.t1,
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={e => {
                            setConfluenceColumns(cols => e.target.checked
                              ? Array.from(new Set([...cols, header]))
                              : cols.filter(col => col !== header));
                            setMapping(m => ({ ...m, confluences: e.target.checked ? header : (m.confluences === header ? undefined : m.confluences) }));
                          }}
                          style={{ accentColor: C.acc, flexShrink: 0 }}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{header}</span>
                      </label>
                    );
                  })}
                </div>
                {confluenceColumns.length > 0 && (
                  <div style={{ marginTop: 9, fontSize: 11, color: C.t2 }}>
                    Selected: <span style={{ color: C.t0 }}>{confluenceColumns.join(' · ')}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Preview ── */}
          {step === 'preview' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
                <span style={{
                  padding: '4px 10px', borderRadius: 5,
                  border: `1px solid ${C.grn}30`, background: `${C.grn}0e`,
                  color: C.grn, fontSize: 11, fontWeight: 650,
                }}>
                  {validCount} ready
                </span>
                {errorCount > 0 && (
                  <span style={{
                    padding: '4px 10px', borderRadius: 5,
                    border: `1px solid ${C.red}30`, background: `${C.red}0e`,
                    color: C.red, fontSize: 11, fontWeight: 650,
                  }}>
                    {errorCount} skipped
                  </span>
                )}
                <span style={{ fontSize: 11, color: C.t2, marginLeft: 2 }}>
                  Skipped rows are missing required fields.
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: C.t2 }}>
                  Showing <span style={{ color: C.t0, fontWeight: 650 }}>{visiblePreviewRows.length}</span> of <span style={{ color: C.t0, fontWeight: 650 }}>{parsed.length}</span> rows
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.t2 }}>
                  Rows
                  <select
                    value={previewLimit}
                    onChange={e => setPreviewLimit(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                    style={{
                      height: 28,
                      borderRadius: 6,
                      padding: '0 8px',
                      border: `1px solid ${C.b0}`,
                      background: C.d2,
                      color: C.t0,
                      fontSize: 11,
                      fontFamily: C.sans,
                      outline: 'none',
                    }}
                  >
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value="all">All</option>
                  </select>
                </label>
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 7, border: `1px solid ${C.b0}` }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.b0}` }}>
                      {['', 'Symbol', 'Dir', 'Date', 'Entry', 'Exit', 'P&L', 'Qty', 'Time', 'Issues'].map(h => (
                        <th key={h} style={{
                          padding: '7px 10px', textAlign: 'left',
                          fontWeight: 700, fontSize: 9.5, letterSpacing: '0.08em',
                          textTransform: 'uppercase', color: C.t2,
                          background: C.d2, whiteSpace: 'nowrap',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePreviewRows.map((t, i) => {
                      const ok = t && t._errors.length === 0;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.b0}`, background: ok ? 'transparent' : `${C.red}06` }}>
                          <td style={{ padding: '6px 10px', width: 24 }}>
                            {ok
                              ? <Check size={11} style={{ color: C.grn }} />
                              : <AlertTriangle size={11} style={{ color: C.red }} />}
                          </td>
                          <td style={{ padding: '6px 10px', color: C.t0, fontWeight: 600 }}>{t?.symbol ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: t?.direction === 'Long' ? C.grn : C.red, fontWeight: 600 }}>{t?.direction ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: C.t1, fontFamily: C.mono }}>{t?.trade_date ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: C.t1, fontFamily: C.mono }}>{t?.entry_price ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: C.t1, fontFamily: C.mono }}>{t?.exit_price ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: (t?.pnl ?? 0) >= 0 ? C.grn : C.red, fontFamily: C.mono, fontWeight: 600 }}>
                            {t?.pnl !== undefined ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ padding: '6px 10px', color: C.t1 }}>{t?.contract_size ?? 1}</td>
                          <td style={{ padding: '6px 10px', color: C.t2, fontFamily: C.mono }}>{t?.trade_time ?? '—'}</td>
                          <td style={{ padding: '6px 10px', color: C.red, fontSize: 10 }}>
                            {t?._errors.join(', ') ?? 'null row'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {previewLimit === 'all' && parsed.length > 100 && (
                <div style={{ fontSize: 11, color: C.t2, marginTop: 8 }}>
                  Rendering all {parsed.length} rows may feel slower on very large CSV files.
                </div>
              )}
            </div>
          )}

          {/* ── Done ── */}
          {step === 'done' && importResult && (
            <div style={{ padding: '24px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.t2, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                Import complete
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.t0, letterSpacing: '-0.02em', marginBottom: 6, fontFamily: C.mono }}>
                {importResult.ok} trade{importResult.ok !== 1 ? 's' : ''} added
              </div>
              <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.6 }}>
                {importResult.fail > 0
                  ? <>{importResult.fail} row{importResult.fail !== 1 ? 's' : ''} were skipped due to missing required fields.</>
                  : <>All rows imported successfully. Check the Journal to review your trades.</>
                }
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '11px 20px',
          borderTop: `1px solid ${C.b0}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button
            onClick={step === 'upload' || step === 'done' ? onClose : () => setStep(step === 'map' ? 'upload' : 'map')}
            style={{
              padding: '7px 14px', borderRadius: 6,
              border: `1px solid ${C.b0}`, background: 'transparent',
              color: C.t1, fontSize: 12, cursor: 'pointer', fontFamily: C.sans,
            }}
          >
            {step === 'done' ? 'Close' : step === 'upload' ? 'Cancel' : 'Back'}
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            {step === 'map' && (
              <button
                disabled={!requiredMapped}
                onClick={handleGoPreview}
                style={{
                  padding: '7px 16px', borderRadius: 6, border: 'none',
                  background: requiredMapped ? C.acc : `${C.acc}35`,
                  color: requiredMapped ? '#0a0806' : C.t2,
                  fontSize: 12, fontWeight: 700, cursor: requiredMapped ? 'pointer' : 'not-allowed',
                  fontFamily: C.sans,
                }}
              >
                Preview →
              </button>
            )}

            {step === 'preview' && (
              <button
                disabled={validCount === 0 || importing}
                onClick={() => { void handleImport(); }}
                style={{
                  padding: '7px 16px', borderRadius: 6, border: 'none',
                  background: validCount > 0 && !importing ? C.acc : `${C.acc}35`,
                  color: validCount > 0 && !importing ? '#0a0806' : C.t2,
                  fontSize: 12, fontWeight: 700,
                  cursor: validCount > 0 && !importing ? 'pointer' : 'not-allowed',
                  fontFamily: C.sans, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {importing ? 'Importing…' : <><FileText size={12} /> Import {validCount} trade{validCount !== 1 ? 's' : ''}</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
