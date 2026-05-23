import { useCallback, useRef, useState } from 'react';
import { Upload, X, ChevronRight, Check, AlertTriangle, FileText } from 'lucide-react';

// ─── colours (match app shell) ────────────────────────────────────────────────
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
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Step = 'upload' | 'map' | 'preview' | 'done';

type FieldKey =
  | 'symbol' | 'direction' | 'entry_price' | 'exit_price'
  | 'pnl' | 'trade_date' | 'trade_time' | 'close_time'
  | 'contract_size' | 'sl_price' | 'tp_price'
  | 'pre_trade_notes' | 'followed_plan' | 'emotional_state';

interface FieldDef {
  key: FieldKey;
  label: string;
  required: boolean;
  hint: string;
}

const FIELDS: FieldDef[] = [
  { key: 'symbol',         label: 'Symbol',        required: true,  hint: 'NQ, ES, AAPL…'         },
  { key: 'direction',      label: 'Direction',     required: true,  hint: 'Long/Short, Buy/Sell'   },
  { key: 'entry_price',    label: 'Entry Price',   required: true,  hint: 'Numeric'                },
  { key: 'exit_price',     label: 'Exit Price',    required: true,  hint: 'Numeric'                },
  { key: 'pnl',            label: 'P&L',           required: true,  hint: 'Numeric, e.g. 250 or -100' },
  { key: 'trade_date',     label: 'Date',          required: true,  hint: 'YYYY-MM-DD or MM/DD/YYYY' },
  { key: 'trade_time',     label: 'Entry Time',    required: false, hint: 'HH:MM'                  },
  { key: 'close_time',     label: 'Exit Time',     required: false, hint: 'HH:MM'                  },
  { key: 'contract_size',  label: 'Contracts',     required: false, hint: 'Numeric, default 1'     },
  { key: 'sl_price',       label: 'Stop Loss',     required: false, hint: 'Numeric'                },
  { key: 'tp_price',       label: 'Take Profit',   required: false, hint: 'Numeric'                },
  { key: 'pre_trade_notes',label: 'Notes',         required: false, hint: 'Text'                   },
  { key: 'followed_plan',  label: 'Followed Plan', required: false, hint: 'yes/no, true/false'     },
  { key: 'emotional_state',label: 'Emotion',       required: false, hint: 'Calm, Anxious…'         },
];

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows = lines.slice(1).map(parseRow).filter(r => r.some(c => c !== ''));
  return { headers, rows };
}

// ─── Auto column guesser ──────────────────────────────────────────────────────
const GUESSES: Record<FieldKey, string[]> = {
  symbol:         ['symbol', 'instrument', 'contract', 'ticker', 'market', 'asset'],
  direction:      ['direction', 'market pos', 'market pos.', 'side', 'b/s', 'buy/sell', 'type', 'action', 'pos'],
  entry_price:    ['entry price', 'entry', 'open price', 'avg price', 'avg entry', 'buy price', 'price'],
  exit_price:     ['exit price', 'exit', 'close price', 'sell price', 'avg exit'],
  pnl:            ['profit', 'pnl', 'p&l', 'p/l', 'net p/l', 'net profit', 'realized pnl', 'realized p&l', 'realized p/l', 'gain/loss', 'gain', 'net p&l'],
  trade_date:     ['date', 'trade date', 'entry date', 'open date', 'day'],
  trade_time:     ['entry time', 'time', 'open time', 'open', 'entry_time'],
  close_time:     ['exit time', 'close time', 'exit_time', 'close_time'],
  contract_size:  ['qty', 'quantity', 'contracts', 'size', 'volume', 'shares', 'lots'],
  sl_price:       ['stop loss', 'sl', 'stop', 'sl price'],
  tp_price:       ['take profit', 'tp', 'target', 'tp price', 'profit target'],
  pre_trade_notes:['notes', 'comment', 'comments', 'remarks', 'note', 'description'],
  followed_plan:  ['followed plan', 'plan', 'follow plan', 'followed_plan'],
  emotional_state:['emotion', 'emotional state', 'mood', 'feeling', 'state'],
};

function autoGuessMapping(headers: string[]): Record<FieldKey, string> {
  const lower = headers.map(h => h.toLowerCase().trim());
  const mapping: Partial<Record<FieldKey, string>> = {};
  for (const field of FIELDS) {
    for (const guess of GUESSES[field.key]) {
      const idx = lower.findIndex(h => h === guess || h.includes(guess));
      if (idx !== -1) { mapping[field.key] = headers[idx]; break; }
    }
  }

  // NinjaTrader: "Entry time" often contains both date + time
  // If trade_date not matched but trade_time is, copy it
  if (!mapping.trade_date && mapping.trade_time) {
    mapping.trade_date = mapping.trade_time;
  }

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
  // Try to extract just the date part if it's a datetime string
  // Formats: "9/15/2025 9:30:00 AM", "2025-09-15 09:30:00", "09/15/2025", "2025-09-15", "15/09/2025"
  const d = v.trim();

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);

  // M/D/YYYY or MM/DD/YYYY (US)
  const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const [, m, day, y] = us;
    return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // D.M.YYYY
  const eu = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (eu) {
    const [, day, m, y] = eu;
    return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

function parseTime(v: string): string | null {
  if (!v) return null;
  const d = v.trim();

  // "9:30:00 AM" or "9:30 AM"
  const ampm = d.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2];
    const mer = ampm[3].toUpperCase();
    if (mer === 'PM' && h !== 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }

  // "09:30:00" or "9:30"
  const hm = d.match(/(\d{1,2}):(\d{2})/);
  if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;

  return null;
}

function parseNum(v: string): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(/[$,()]/g, '').trim());
  // Parentheses = negative, e.g. (100.00)
  const neg = /^\(.*\)$/.test(v.trim());
  return isNaN(n) ? null : neg ? -Math.abs(n) : n;
}

function parseFollowedPlan(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(s)) return true;
  if (['no', 'false', '0', 'n'].includes(s)) return false;
  return null;
}

// ─── Map a single CSV row to ApiTrade partial ─────────────────────────────────
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
  _errors: string[];
};

function mapRow(
  row: string[],
  headers: string[],
  mapping: Record<FieldKey, string>,
): ImportedTrade | null {
  const get = (field: FieldKey): string => {
    const col = mapping[field];
    if (!col) return '';
    const idx = headers.indexOf(col);
    return idx >= 0 ? (row[idx] ?? '') : '';
  };

  const errors: string[] = [];

  const symbol = get('symbol').trim().replace(/\s+\d{2}-\d{2}$/, '').toUpperCase(); // strip expiry like "NQ 09-25"
  if (!symbol) errors.push('Missing symbol');

  const direction = parseDirection(get('direction'));
  if (!direction) errors.push(`Unknown direction: "${get('direction')}"`);

  const entryRaw = get('entry_price');
  const entry_price = parseNum(entryRaw);
  if (entry_price === null) errors.push(`Bad entry price: "${entryRaw}"`);

  const exitRaw = get('exit_price');
  const exit_price = parseNum(exitRaw);
  if (exit_price === null) errors.push(`Bad exit price: "${exitRaw}"`);

  const pnlRaw = get('pnl');
  const pnl = parseNum(pnlRaw);
  if (pnl === null) errors.push(`Bad P&L: "${pnlRaw}"`);

  const dateRaw = get('trade_date');
  const trade_date = parseDate(dateRaw);
  if (!trade_date) errors.push(`Bad date: "${dateRaw}"`);

  if (errors.length > 0) return { symbol, direction: direction ?? 'Long', entry_price: entry_price ?? 0, exit_price: exit_price ?? 0, pnl: pnl ?? 0, trade_date: trade_date ?? '', _errors: errors };

  // Optional fields
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

  return {
    symbol,
    direction: direction!,
    entry_price: entry_price!,
    exit_price: exit_price!,
    pnl: pnl!,
    trade_date: trade_date!,
    trade_time,
    close_time,
    contract_size: contracts && contracts > 0 ? contracts : undefined,
    sl_price,
    tp_price,
    pre_trade_notes: notes,
    followed_plan: typeof fp === 'boolean' ? fp : undefined,
    emotional_state: emotion,
    _errors: [],
  };
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface CSVImportModalProps {
  onClose: () => void;
  onImport: (trades: ImportedTrade[]) => Promise<void>;
}

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
  const inputRef = useRef<HTMLInputElement>(null);

  const processText = useCallback((text: string) => {
    const { headers: h, rows: r } = parseCSV(text);
    if (h.length === 0) { setFileError('Could not parse CSV — make sure the file has a header row.'); return; }
    if (r.length === 0) { setFileError('CSV has headers but no data rows.'); return; }
    setHeaders(h);
    setRows(r);
    setMapping(autoGuessMapping(h));
    setFileError('');
    setStep('map');
  }, []);

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.(csv|txt)$/i)) { setFileError('Please upload a .csv or .txt file.'); return; }
    const reader = new FileReader();
    reader.onload = (e) => processText((e.target?.result as string) ?? '');
    reader.readAsText(file);
  }, [processText]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleGoPreview = useCallback(() => {
    const result = rows.map(r => mapRow(r, headers, mapping as Record<FieldKey, string>));
    setParsed(result);
    setStep('preview');
  }, [rows, headers, mapping]);

  const handleImport = useCallback(async () => {
    const valid = parsed.filter((t): t is ImportedTrade => t !== null && t._errors.length === 0);
    if (valid.length === 0) return;
    setImporting(true);
    try {
      await onImport(valid);
      const failed = parsed.filter(t => t === null || t._errors.length > 0).length;
      setImportResult({ ok: valid.length, fail: failed });
      setStep('done');
    } finally {
      setImporting(false);
    }
  }, [parsed, onImport]);

  const validCount = parsed.filter(t => t && t._errors.length === 0).length;
  const errorCount = parsed.filter(t => !t || t._errors.length > 0).length;
  const requiredMapped = FIELDS.filter(f => f.required).every(f => mapping[f.key]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        background: 'rgba(10,8,6,0.85)',
        backdropFilter: 'blur(12px)',
        fontFamily: C.sans,
      }}
    >
      <div style={{
        width: 'min(720px, 100%)',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        border: `1px solid ${C.b0}`,
        background: C.d1,
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${C.b0}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 650, color: C.t0 }}>Import Trades from CSV</div>
            <div style={{ fontSize: 11, color: C.t2, marginTop: 2 }}>
              NinjaTrader · Tradovate · APEX · TopStep · Any broker
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.t1, padding: 4, lineHeight: 0 }}>
            <X size={16} />
          </button>
        </div>

        {/* Step indicator */}
        <div style={{ padding: '10px 20px', borderBottom: `1px solid ${C.b0}`, display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['upload', 'map', 'preview', 'done'] as Step[]).map((s, i) => {
            const labels = ['Upload', 'Map columns', 'Preview', 'Done'];
            const isCurrent = step === s;
            const isPast = ['upload', 'map', 'preview', 'done'].indexOf(step) > i;
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, fontWeight: isCurrent ? 600 : 400,
                  color: isCurrent ? C.acc : isPast ? C.grn : C.t2,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 700,
                    background: isCurrent ? `${C.acc}20` : isPast ? `${C.grn}20` : 'transparent',
                    border: `1px solid ${isCurrent ? C.acc : isPast ? C.grn : C.b0}`,
                    color: isCurrent ? C.acc : isPast ? C.grn : C.t2,
                  }}>
                    {isPast ? <Check size={9} /> : i + 1}
                  </div>
                  {labels[i]}
                </div>
                {i < 3 && <ChevronRight size={11} style={{ color: C.t2, flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>

          {/* ── STEP: Upload ── */}
          {step === 'upload' && (
            <div>
              <div
                onDrop={handleDrop}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => inputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? C.acc : C.b0}`,
                  borderRadius: 10,
                  padding: '40px 24px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? `${C.acc}08` : C.d2,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
              >
                <Upload size={28} style={{ color: C.t2, marginBottom: 12 }} />
                <div style={{ fontSize: 14, color: C.t0, fontWeight: 500, marginBottom: 6 }}>
                  Drop your CSV here or click to browse
                </div>
                <div style={{ fontSize: 12, color: C.t2 }}>
                  Supports .csv and .txt files
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
                  marginTop: 12, padding: '10px 14px', borderRadius: 8,
                  background: `${C.red}12`, border: `1px solid ${C.red}30`,
                  color: C.red, fontSize: 12, display: 'flex', gap: 8, alignItems: 'center',
                }}>
                  <AlertTriangle size={14} />
                  {fileError}
                </div>
              )}

              {/* Format guide */}
              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.t2, marginBottom: 10 }}>
                  Supported formats
                </div>
                {[
                  { name: 'NinjaTrader', cols: 'Instrument, Market pos., Quantity, Entry price, Exit price, Entry time, Exit time, Profit' },
                  { name: 'Tradovate', cols: 'Symbol, B/S, Qty, Avg Price, Net Profit, Time' },
                  { name: 'TopStep / TopstepX', cols: 'Symbol, Side, Qty, Avg Entry, Avg Exit, Open Time, Close Time, P/L, Net P/L' },
                  { name: 'Generic', cols: 'Symbol, Direction, Entry, Exit, PnL, Date, Contracts' },
                ].map(fmt => (
                  <div key={fmt.name} style={{
                    padding: '10px 14px', borderRadius: 8, marginBottom: 6,
                    background: C.d2, border: `1px solid ${C.b0}`,
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.t0, marginBottom: 3 }}>{fmt.name}</div>
                    <div style={{ fontSize: 11, color: C.t2, fontFamily: 'var(--font-mono, monospace)' }}>{fmt.cols}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STEP: Map ── */}
          {step === 'map' && (
            <div>
              <div style={{ fontSize: 13, color: C.t1, marginBottom: 16 }}>
                Detected <strong style={{ color: C.t0 }}>{rows.length} rows</strong> and{' '}
                <strong style={{ color: C.t0 }}>{headers.length} columns</strong>.
                Match each Flyxa field to a column in your file.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                {FIELDS.map(field => (
                  <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: field.required ? C.acc : C.t2 }}>
                      {field.label}{field.required ? ' *' : ''}
                    </label>
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value || undefined }))}
                      style={{
                        height: 34, borderRadius: 7, padding: '0 10px',
                        border: `1px solid ${mapping[field.key] ? C.acc + '40' : C.b0}`,
                        background: C.d2, color: mapping[field.key] ? C.t0 : C.t2,
                        fontSize: 12, fontFamily: C.sans, outline: 'none', cursor: 'pointer',
                      }}
                    >
                      <option value="">— skip —</option>
                      {headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 10, color: C.t2 }}>{field.hint}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STEP: Preview ── */}
          {step === 'preview' && (
            <div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
                <div style={{
                  padding: '6px 12px', borderRadius: 7,
                  background: `${C.grn}12`, border: `1px solid ${C.grn}30`,
                  color: C.grn, fontSize: 12, fontWeight: 600,
                }}>
                  {validCount} ready to import
                </div>
                {errorCount > 0 && (
                  <div style={{
                    padding: '6px 12px', borderRadius: 7,
                    background: `${C.red}12`, border: `1px solid ${C.red}30`,
                    color: C.red, fontSize: 12, fontWeight: 600,
                  }}>
                    {errorCount} will be skipped (missing required fields)
                  </div>
                )}
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${C.b0}` }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.b0}` }}>
                      {['', 'Symbol', 'Dir', 'Date', 'Entry', 'Exit', 'P&L', 'Contracts', 'Time', 'Issues'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700, fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.t2, background: C.d2 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 20).map((t, i) => {
                      const ok = t && t._errors.length === 0;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.b0}`, background: ok ? 'transparent' : `${C.red}06` }}>
                          <td style={{ padding: '7px 10px' }}>
                            {ok
                              ? <Check size={12} style={{ color: C.grn }} />
                              : <AlertTriangle size={12} style={{ color: C.red }} />}
                          </td>
                          <td style={{ padding: '7px 10px', color: C.t0, fontWeight: 500 }}>{t?.symbol ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: t?.direction === 'Long' ? C.grn : C.red }}>{t?.direction ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: C.t1 }}>{t?.trade_date ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: C.t1, fontFamily: 'var(--font-mono)' }}>{t?.entry_price ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: C.t1, fontFamily: 'var(--font-mono)' }}>{t?.exit_price ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: (t?.pnl ?? 0) >= 0 ? C.grn : C.red, fontFamily: 'var(--font-mono)' }}>
                            {t?.pnl !== undefined ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', color: C.t1 }}>{t?.contract_size ?? 1}</td>
                          <td style={{ padding: '7px 10px', color: C.t2 }}>{t?.trade_time ?? '—'}</td>
                          <td style={{ padding: '7px 10px', color: C.red, fontSize: 10 }}>
                            {t?._errors.join(', ') ?? 'null row'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {parsed.length > 20 && (
                <div style={{ fontSize: 11, color: C.t2, marginTop: 8, textAlign: 'center' }}>
                  Showing first 20 of {parsed.length} rows
                </div>
              )}
            </div>
          )}

          {/* ── STEP: Done ── */}
          {step === 'done' && importResult && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: `${C.grn}15`, border: `2px solid ${C.grn}40`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 16px',
              }}>
                <Check size={24} style={{ color: C.grn }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 650, color: C.t0, marginBottom: 8 }}>
                Import complete
              </div>
              <div style={{ fontSize: 13, color: C.t1 }}>
                <strong style={{ color: C.grn }}>{importResult.ok} trades</strong> imported successfully
                {importResult.fail > 0 && (
                  <>, <strong style={{ color: C.red }}>{importResult.fail} skipped</strong> due to missing fields</>
                )}
              </div>
              <div style={{ fontSize: 12, color: C.t2, marginTop: 6 }}>
                Your patterns page will update automatically as data grows.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: `1px solid ${C.b0}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <button
            onClick={step === 'upload' || step === 'done' ? onClose : () => setStep(step === 'map' ? 'upload' : 'map')}
            style={{
              padding: '8px 16px', borderRadius: 7, border: `1px solid ${C.b0}`,
              background: 'transparent', color: C.t1, fontSize: 12.5, cursor: 'pointer', fontFamily: C.sans,
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
                  padding: '8px 18px', borderRadius: 7, border: 'none',
                  background: requiredMapped ? C.acc : `${C.acc}40`,
                  color: '#0a0806', fontSize: 12.5, fontWeight: 650, cursor: requiredMapped ? 'pointer' : 'not-allowed',
                  fontFamily: C.sans, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                Preview <ChevronRight size={13} />
              </button>
            )}

            {step === 'preview' && (
              <button
                disabled={validCount === 0 || importing}
                onClick={() => { void handleImport(); }}
                style={{
                  padding: '8px 18px', borderRadius: 7, border: 'none',
                  background: validCount > 0 && !importing ? C.acc : `${C.acc}40`,
                  color: '#0a0806', fontSize: 12.5, fontWeight: 650,
                  cursor: validCount > 0 && !importing ? 'pointer' : 'not-allowed',
                  fontFamily: C.sans, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {importing ? (
                  <>Importing…</>
                ) : (
                  <><FileText size={13} /> Import {validCount} trade{validCount !== 1 ? 's' : ''}</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
