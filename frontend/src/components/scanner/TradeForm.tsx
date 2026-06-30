import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles, TrendingDown, TrendingUp, X } from 'lucide-react';
import { Trade } from '../../types/index.js';
import { formatCurrency } from '../../utils/calculations.js';
import { formatRiskRewardRatio } from '../../utils/riskReward.js';
import { lookupContract, FuturesContract } from '../../constants/futuresContracts.js';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import DatePicker from '../common/DatePicker.js';
import { normalizeConfluenceKey, normalizeConfluenceTags } from '../../utils/confluenceTags.js';

interface Props {
  initialData?: Partial<Trade>;
  aiFields?: Set<string>;
  tradeDate: string;
  tradeTime: string;
  chartImage?: string;
  aiScanned?: boolean;
  onRequestChartUpload?: () => void;
  onRequestChartFullscreen?: () => void;
  onTradeDateChange?: (value: string) => void;
  onTradeTimeChange?: (value: string) => void;
  formId?: string;
  showActionBar?: boolean;
  showContractsField?: boolean;
  onSubmit: (data: Partial<Trade>) => void;
  onDraftChange?: (data: Partial<Trade>) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const emotionalStates = ['Calm', 'Confident', 'Anxious', 'Revenge Trading', 'FOMO', 'Overconfident', 'Tired'];
const THESIS_BLOCK = 'FLYXA_THESIS';
const PROCESS_BLOCK = 'FLYXA_PROCESS_GRADE';
const REFLECTION_BLOCK = 'FLYXA_REFLECTION';

function normalizeConfluences(value: unknown): string[] {
  return normalizeConfluenceTags(value, 12);
}

function normalizeAccountIds(value: unknown, fallback?: string): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  const normalized = rawValues
    .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  const deduped = Array.from(new Set(normalized));
  if (deduped.length > 0) return deduped;
  return fallback ? [fallback] : [];
}

function encodeStructuredValue(value: string): string {
  return value.replace(/\n/g, '\\n').trim();
}

function decodeStructuredValue(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function parseStructuredBlock(note: string | undefined, blockName: string): { fields: Record<string, string>; remaining: string } {
  if (!note?.trim()) {
    return { fields: {}, remaining: '' };
  }

  const pattern = new RegExp(`\\[${blockName}\\]\\n?([\\s\\S]*?)\\n?\\[\\/${blockName}\\]\\n?`, 'm');
  const match = note.match(pattern);
  if (!match) {
    return { fields: {}, remaining: note.trim() };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    fields[key] = decodeStructuredValue(value);
  }

  return {
    fields,
    remaining: note.replace(match[0], '').trim(),
  };
}

function buildStructuredBlock(blockName: string, fields: Record<string, string>): string {
  const lines = Object.entries(fields)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}:${encodeStructuredValue(value)}`);

  if (lines.length === 0) {
    return '';
  }

  return `[${blockName}]\n${lines.join('\n')}\n[/${blockName}]`;
}

const defaultForm: Partial<Trade> = {
  symbol: '',
  direction: 'Long',
  entry_price: 0,
  exit_price: 0,
  sl_price: 0,
  tp_price: 0,
  contract_size: 1,
  point_value: 20,
  trade_date: new Date().toISOString().split('T')[0],
  trade_time: '',
  trade_length_seconds: 0,
  candle_count: 0,
  timeframe_minutes: 1,
  emotional_state: null,
  confidence_level: null,
  pre_trade_notes: '',
  post_trade_notes: '',
  confluences: [],
  followed_plan: null,
};

function buildFormState(initialData?: Partial<Trade>): Partial<Trade> {
  const primaryAccount = initialData?.accountId ?? initialData?.account_id;
  return {
    ...defaultForm,
    ...initialData,
    accountIds: normalizeAccountIds(initialData?.accountIds, primaryAccount),
    confluences: normalizeConfluences(initialData?.confluences),
  };
}

export default function TradeForm({
  initialData,
  aiFields = new Set(),
  tradeDate,
  tradeTime,
  chartImage,
  aiScanned = false,
  onRequestChartUpload,
  onRequestChartFullscreen,
  onTradeDateChange,
  onTradeTimeChange,
  formId = 'scanner-trade-form',
  showActionBar = true,
  showContractsField = true,
  onSubmit,
  onDraftChange,
  onCancel,
  isLoading,
}: Props) {
  const navigate = useNavigate();
  const { confluenceOptions, accounts, getDefaultTradeAccountId } = useAppSettings();
  const [form, setForm] = useState<Partial<Trade>>(() => buildFormState(initialData));
  const [thesisSetup, setThesisSetup] = useState('');
  const [thesisInvalidation, setThesisInvalidation] = useState('');
  const [thesisTrigger, setThesisTrigger] = useState('');
  const [processScore, setProcessScore] = useState(0);
  const [processReason, setProcessReason] = useState('');
  const [reflectionMarket, setReflectionMarket] = useState('');
  const [reflectionExecution, setReflectionExecution] = useState('');
  const [reflectionAdjustment, setReflectionAdjustment] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [selectedConfluence, setSelectedConfluence] = useState('');
  const [matchedContract, setMatchedContract] = useState<FuturesContract | undefined>(
    () => lookupContract(initialData?.symbol || '')
  );
  const [pnlEditMode, setPnlEditMode] = useState(false);
  const [pnlOverride, setPnlOverride] = useState<number | null>(
    () => typeof initialData?.pnlOverride === 'number' && Number.isFinite(initialData.pnlOverride) ? initialData.pnlOverride : null
  );
  const [commission, setCommission] = useState<number>(
    () => typeof initialData?.commission === 'number' && initialData.commission >= 0 ? initialData.commission : 0
  );

  useEffect(() => {
    const nextForm = buildFormState(initialData);
    const preParsed = parseStructuredBlock(nextForm.pre_trade_notes, THESIS_BLOCK);
    const processParsed = parseStructuredBlock(nextForm.post_trade_notes, PROCESS_BLOCK);
    const reflectionParsed = parseStructuredBlock(processParsed.remaining, REFLECTION_BLOCK);

    const parsedScore = Number(processParsed.fields.score);

    setThesisSetup(preParsed.fields.setup || '');
    setThesisInvalidation(preParsed.fields.invalidation || '');
    setThesisTrigger(preParsed.fields.trigger || '');
    setProcessScore(Number.isFinite(parsedScore) && parsedScore >= 1 && parsedScore <= 5 ? parsedScore : 0);
    setProcessReason(processParsed.fields.reason || '');
    setReflectionMarket(reflectionParsed.fields.market_vs_thesis || '');
    setReflectionExecution(reflectionParsed.fields.execution_quality || '');
    setReflectionAdjustment(reflectionParsed.fields.next_adjustment || '');
    setForm({
      ...nextForm,
      pre_trade_notes: preParsed.remaining,
      post_trade_notes: reflectionParsed.remaining,
    });
    const contract = lookupContract(initialData?.symbol || '');
    setMatchedContract(contract);
    setSubmitError('');
    setSelectedConfluence('');
    setPnlOverride(typeof initialData?.pnlOverride === 'number' && Number.isFinite(initialData.pnlOverride) ? initialData.pnlOverride : null);
    setPnlEditMode(false);
    setCommission(typeof initialData?.commission === 'number' && initialData.commission >= 0 ? initialData.commission : 0);
  }, [initialData]);

  const calcPnL = (): number => {
    const { direction, entry_price, exit_price, contract_size, point_value } = form;
    if (!entry_price || !exit_price || !contract_size || !point_value) return 0;
    return direction === 'Long'
      ? (exit_price - entry_price) * contract_size * point_value
      : (entry_price - exit_price) * contract_size * point_value;
  };

  const calcRR = (): string => {
    const { entry_price, sl_price, tp_price } = form;
    if (!entry_price || !sl_price || !tp_price) return 'N/A';
    const risk = Math.abs(entry_price - sl_price);
    const reward = Math.abs(tp_price - entry_price);
    if (risk === 0) return 'N/A';
    return (reward / risk).toFixed(2);
  };

  const pointDiffLabel = (from?: number, to?: number) => {
    if (typeof from !== 'number' || typeof to !== 'number') return '—';
    if (!Number.isFinite(from) || !Number.isFinite(to)) return '—';
    const diff = Number((to - from).toFixed(2));
    const sign = diff > 0 ? '+' : '';
    return `${sign}${diff} pts`;
  };

  const set = (key: keyof Trade, value: unknown) => {
    setSubmitError('');
    setForm(f => {
      const next = { ...f, [key]: value };

      if (key === 'tp_price' && next.exit_reason === 'TP') {
        next.exit_price = Number(value);
      }

      if (key === 'sl_price' && next.exit_reason === 'SL') {
        next.exit_price = Number(value);
      }

      if (key === 'entry_price' && next.exit_reason === 'BE') {
        next.exit_price = Number(value);
      }

      return next;
    });
  };

  const handleSymbolChange = (value: string) => {
    const upper = value.toUpperCase();
    set('symbol', upper);
    const contract = lookupContract(upper);
    setMatchedContract(contract);
    if (contract) set('point_value', contract.point_value);
  };

  const hasTradeDateTime = Boolean(tradeDate && tradeTime);
  const hasDuration = typeof form.trade_length_seconds === 'number'
    && Number.isFinite(form.trade_length_seconds)
    && form.trade_length_seconds > 0;
  const requiredFieldsMessage = !hasTradeDateTime && !hasDuration
    ? 'Trade Date/Time and Duration are required before saving.'
    : !hasTradeDateTime
      ? 'Trade Date/Time required before saving.'
      : !hasDuration
        ? 'Duration is required before saving.'
        : '';
  const canSubmit = Boolean(hasTradeDateTime && hasDuration && !isLoading);

  const buildComposedNotes = () => {
    const thesisBlock = buildStructuredBlock(THESIS_BLOCK, {
      setup: thesisSetup,
      invalidation: thesisInvalidation,
      trigger: thesisTrigger,
    });
    const processBlock = buildStructuredBlock(PROCESS_BLOCK, {
      score: processScore > 0 ? String(processScore) : '',
      reason: processReason,
    });
    const reflectionBlock = buildStructuredBlock(REFLECTION_BLOCK, {
      market_vs_thesis: reflectionMarket,
      execution_quality: reflectionExecution,
      next_adjustment: reflectionAdjustment,
    });

    return {
      preTradeNotes: [thesisBlock, form.pre_trade_notes?.trim() || '']
        .filter(Boolean)
        .join('\n\n')
        .trim(),
      postTradeNotes: [processBlock, reflectionBlock, form.post_trade_notes?.trim() || '']
        .filter(Boolean)
        .join('\n\n')
        .trim(),
    };
  };

  useEffect(() => {
    if (!onDraftChange) {
      return;
    }

    const { preTradeNotes, postTradeNotes } = buildComposedNotes();
    onDraftChange({
      ...form,
      confluences: normalizeConfluences(form.confluences),
      trade_date: tradeDate || undefined,
      trade_time: tradeTime || undefined,
      pre_trade_notes: preTradeNotes,
      post_trade_notes: postTradeNotes,
    });
  }, [
    form,
    onDraftChange,
    processReason,
    processScore,
    reflectionAdjustment,
    reflectionExecution,
    reflectionMarket,
    thesisInvalidation,
    thesisSetup,
    thesisTrigger,
    tradeDate,
    tradeTime,
  ]);

  useEffect(() => {
    if (form.accountIds?.length || form.accountId) return;
    const defaultAccountId = getDefaultTradeAccountId();
    setForm(current => ({ ...current, accountId: defaultAccountId, accountIds: [defaultAccountId] }));
  }, [form.accountId, form.accountIds?.length, getDefaultTradeAccountId]);

  const setAccountIds = (accountId: string, checked: boolean) => {
    setSubmitError('');
    setForm(current => {
      const currentIds = normalizeAccountIds(current.accountIds, current.accountId);
      const nextIds = checked
        ? Array.from(new Set([...currentIds, accountId]))
        : currentIds.filter(id => id !== accountId);
      const finalIds = nextIds.length > 0 ? nextIds : [getDefaultTradeAccountId()];
      return {
        ...current,
        accountIds: finalIds,
        accountId: finalIds[0],
        account_id: finalIds[0],
      };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasTradeDateTime || !hasDuration) {
      setSubmitError(requiredFieldsMessage);
      return;
    }

    if (form.exit_reason !== 'TP' && form.exit_reason !== 'SL' && form.exit_reason !== 'BE') {
      setSubmitError('Select whether TP, SL, or Breakeven before saving this trade.');
      return;
    }

    const normalizedExitPrice =
      form.exit_reason === 'TP' ? form.tp_price :
      form.exit_reason === 'SL' ? form.sl_price :
      form.entry_price;
    if (!normalizedExitPrice) {
      setSubmitError('Add an entry price so the breakeven exit can be priced correctly.');
      return;
    }

    const { preTradeNotes, postTradeNotes } = buildComposedNotes();

    onSubmit({
      ...form,
      accountId: normalizeAccountIds(form.accountIds, form.accountId)[0],
      account_id: normalizeAccountIds(form.accountIds, form.accountId)[0],
      accountIds: normalizeAccountIds(form.accountIds, form.accountId),
      confluences: normalizeConfluences(form.confluences),
      trade_date: tradeDate,
      trade_time: tradeTime,
      exit_price: normalizedExitPrice,
      pre_trade_notes: preTradeNotes,
      post_trade_notes: postTradeNotes,
      commission,
      ...(pnlOverride !== null ? { pnlOverride } : {}),
    });
  };

  const pnl = pnlOverride !== null ? pnlOverride : calcPnL();
  const rr = calcRR();
  const confluences = normalizeConfluences(form.confluences);
  const availableConfluenceOptions = confluenceOptions.filter(
    option => !confluences.some(confluence => normalizeConfluenceKey(confluence) === normalizeConfluenceKey(option))
  );

  const addConfluence = () => {
    if (!selectedConfluence) {
      return;
    }

    const nextConfluences = normalizeConfluences([...confluences, selectedConfluence]);
    set('confluences', nextConfluences);
    setSelectedConfluence('');
  };

  const removeConfluence = (indexToRemove: number) => {
    set('confluences', confluences.filter((_, index) => index !== indexToRemove));
  };

  const AIBadge = ({ field }: { field: string }) => aiFields.has(field) ? (
    <span className="inline-flex items-center gap-0.5 text-xs text-blue-400 ml-1 font-normal">
      <Sparkles size={9} /> AI
    </span>
  ) : null;

  const P = 'var(--app-panel)';
  const P2 = 'var(--app-panel-strong)';
  const BD = 'var(--app-border)';
  const T1 = 'var(--app-text)';
  const T2 = 'var(--app-text-muted)';
  const T3 = 'var(--app-text-subtle)';
  const AMBER = 'var(--accent)';
  const AMBER_DIM = 'var(--accent-dim)';
  const AMBER_BD = 'var(--accent-border)';

  const panel: React.CSSProperties = { background: P, border: `1px solid ${BD}`, borderRadius: 8, padding: '16px 18px', marginBottom: 0 };
  const sub: React.CSSProperties = { background: P2, border: `1px solid ${BD}`, borderRadius: 6, padding: '12px 14px' };

  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <p style={{ fontSize: 11, fontWeight: 600, color: T3, marginBottom: 12 }}>
      {children}
    </p>
  );

  const toggleBtn = (active: boolean, color: 'green' | 'red' | 'amber'): React.CSSProperties => {
    const colors = {
      green: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.35)', text: '#34d399' },
      red:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)',  text: '#f87171' },
      amber: { bg: AMBER_DIM,               border: AMBER_BD,                text: AMBER },
    }[color];
    return active
      ? { flex: 1, height: 36, borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.bg, color: colors.text, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }
      : { flex: 1, height: 36, borderRadius: 6, border: `1px solid ${BD}`, background: 'transparent', color: T2, fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 };
  };

  const durationInput: React.CSSProperties = { width: '100%', background: 'transparent', border: 'none', textAlign: 'center', fontSize: 13, color: T1, outline: 'none' };

  return (
    <form id={formId} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <style>{`
        .scanner-row-one {
          display: grid;
          grid-template-columns: minmax(240px, 0.9fr) 1fr 1fr;
          gap: 8px;
        }
        .scanner-row-two,
        .scanner-notes-two-col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .scanner-three-col {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 8px;
        }
        .scanner-chart-meta {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .scanner-confluence-row {
          display: flex;
          gap: 6px;
          margin-bottom: 8px;
        }
        @media (max-width: 1240px) {
          .scanner-row-one {
            grid-template-columns: 1fr 1fr;
          }
          .scanner-row-one > :first-child {
            grid-column: 1 / -1;
          }
          .scanner-three-col {
            grid-template-columns: 1fr 1fr;
          }
          .scanner-three-col > :last-child {
            grid-column: 1 / -1;
          }
        }
        @media (max-width: 860px) {
          .scanner-row-one {
            grid-template-columns: 1fr;
          }
          .scanner-row-one > :first-child {
            grid-column: auto;
          }
          .scanner-row-two,
          .scanner-notes-two-col,
          .scanner-three-col,
          .scanner-chart-meta {
            grid-template-columns: 1fr;
          }
          .scanner-three-col > :last-child {
            grid-column: auto;
          }
          .scanner-confluence-row {
            flex-direction: column;
          }
        }
      `}</style>

      {/* Row 1: Chart + Instrument + Price Levels */}
      <div className="scanner-row-one">
        {/* Chart */}
        <div style={panel}>
          <SectionLabel>Chart Scanner</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              onClick={() => onRequestChartUpload?.()}
              style={{
                width: '100%',
                minHeight: 190,
                borderRadius: 6,
                border: `1px solid ${BD}`,
                background: P2,
                overflow: 'hidden',
                cursor: 'pointer',
                position: 'relative',
                display: 'grid',
                placeItems: 'center',
                color: T3,
              }}
            >
              {chartImage ? (
                <img src={chartImage} alt="Trade chart" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: 12 }}>Import screenshot</span>
              )}
              {aiScanned && (
                <span
                  style={{
                    position: 'absolute',
                    top: 8,
                    left: 8,
                    borderRadius: 4,
                    border: `1px solid ${AMBER_BD}`,
                    background: AMBER_DIM,
                    padding: '2px 6px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: AMBER,
                  }}
                >
                  AI Scanned
                </span>
              )}
              {chartImage && onRequestChartFullscreen && (
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    onRequestChartFullscreen();
                  }}
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: 8,
                    borderRadius: 4,
                    border: `1px solid ${BD}`,
                    background: 'rgba(13,17,23,0.78)',
                    color: T2,
                    fontSize: 10,
                    padding: '2px 6px',
                    cursor: 'pointer',
                  }}
                >
                  Fullscreen
                </button>
              )}
            </button>
            <div className="scanner-chart-meta">
              <div>
                <label className="label">Trade Date</label>
                <DatePicker
                  className="input-field h-9"
                  value={tradeDate}
                  onChange={value => onTradeDateChange?.(value)}
                  fullWidth
                  align="left"
                  compact
                />
              </div>
              <div>
                <label className="label">Entry Time</label>
                <input
                  type="time"
                  className="input-field h-9"
                  value={tradeTime}
                  onChange={event => onTradeTimeChange?.(event.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Instrument */}
        <div style={panel}>
          <SectionLabel>Instrument</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label className="label">Symbol <AIBadge field="symbol" /></label>
              <input
                type="text"
                className="input-field h-9"
                value={form.symbol || ''}
                onChange={e => handleSymbolChange(e.target.value)}
                placeholder="e.g. MNQM26"
                required
              />
              {matchedContract && (
                <p style={{ fontSize: 10, color: '#34d399', marginTop: 3 }}>{matchedContract.name} · ${matchedContract.point_value}/pt</p>
              )}
            </div>
            <div>
              <label className="label">Direction <AIBadge field="direction" /></label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => set('direction', 'Long')} style={toggleBtn(form.direction === 'Long', 'green')}>
                  <TrendingUp size={12} /> Long
                </button>
                <button type="button" onClick={() => set('direction', 'Short')} style={toggleBtn(form.direction === 'Short', 'red')}>
                  <TrendingDown size={12} /> Short
                </button>
              </div>
            </div>
            {showContractsField && (
              <div>
                <label className="label">Contracts</label>
                <input
                  type="number"
                  className="input-field h-9"
                  value={form.contract_size || 1}
                  onChange={e => set('contract_size', parseInt(e.target.value))}
                  min={1}
                  required
                />
              </div>
            )}
            <div>
              <label className="label">Accounts</label>
              <div style={{ display: 'grid', gap: 6 }}>
                {accounts.filter(a => a.status !== 'Blown' && a.id !== DEFAULT_ACCOUNT_ID).map(account => {
                  const selectedAccountIds = normalizeAccountIds(form.accountIds, form.accountId || getDefaultTradeAccountId());
                  const checked = selectedAccountIds.includes(account.id);
                  return (
                    <label
                      key={account.id}
                      style={{
                        minHeight: 34,
                        borderRadius: 6,
                        border: `1px solid ${checked ? AMBER_BD : BD}`,
                        background: checked ? AMBER_DIM : P2,
                        color: checked ? T1 : T2,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 9px',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={event => setAccountIds(account.id, event.target.checked)}
                        style={{ accentColor: AMBER }}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {account.name}
                      </span>
                      <span style={{ color: T3, fontSize: 10 }}>{account.status}</span>
                    </label>
                  );
                })}
              </div>
              <p style={{ marginTop: 5, fontSize: 10, color: T3 }}>Copy trades can be linked to every account that took the same execution.</p>
            </div>
          </div>
        </div>

        {/* Price Levels */}
        <div style={panel}>
          <SectionLabel>Price Levels</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label className="label">Entry <AIBadge field="entry_price" /></label>
              <input type="number" className="input-field h-9" value={form.entry_price || ''} onChange={e => set('entry_price', parseFloat(e.target.value))} step={0.25} required />
              <p style={{ fontSize: 10, color: '#60a5fa', marginTop: 3 }}>reference</p>
            </div>
            <div>
              <label className="label">Exit</label>
              <input type="number" className="input-field h-9" value={form.exit_price || ''} onChange={e => set('exit_price', parseFloat(e.target.value))} step={0.25} />
              <p style={{ fontSize: 10, color: '#34d399', marginTop: 3 }}>{pointDiffLabel(form.entry_price, form.exit_price)}</p>
            </div>
            <div>
              <label className="label">Stop Loss <AIBadge field="sl_price" /></label>
              <input type="number" className="input-field h-9" value={form.sl_price || ''} onChange={e => set('sl_price', parseFloat(e.target.value))} step={0.25} required />
              <p style={{ fontSize: 10, color: '#f87171', marginTop: 3 }}>{pointDiffLabel(form.entry_price, form.sl_price)}</p>
            </div>
            <div>
              <label className="label">Take Profit <AIBadge field="tp_price" /></label>
              <input type="number" className="input-field h-9" value={form.tp_price || ''} onChange={e => set('tp_price', parseFloat(e.target.value))} step={0.25} required />
              <p style={{ fontSize: 10, color: '#fbbf24', marginTop: 3 }}>{pointDiffLabel(form.entry_price, form.tp_price)}</p>
            </div>
          </div>
          <div style={{ ...sub, marginTop: 8, display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <p style={{ fontSize: 11, color: T3 }}>Gross P&amp;L</p>
                {pnlOverride !== null && (
                  <button
                    type="button"
                    onClick={() => { setPnlOverride(null); setPnlEditMode(false); }}
                    style={{ fontSize: 9, color: T3, cursor: 'pointer', border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', lineHeight: 1 }}
                    title="Reset to calculated value"
                  >
                    ↺ auto
                  </button>
                )}
              </div>
              {pnlEditMode ? (
                <input
                  type="number"
                  step="0.01"
                  autoFocus
                  value={pnlOverride !== null ? pnlOverride : calcPnL()}
                  onChange={e => setPnlOverride(e.target.value === '' ? 0 : parseFloat(e.target.value))}
                  onBlur={() => setPnlEditMode(false)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); setPnlEditMode(false); }
                    else if (e.key === 'Escape') { setPnlOverride(null); setPnlEditMode(false); }
                  }}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 16,
                    fontWeight: 600,
                    width: 130,
                    background: 'transparent',
                    border: `1px solid ${BD}`,
                    borderRadius: 4,
                    color: pnl > 0 ? '#34d399' : pnl < 0 ? '#f87171' : AMBER,
                    padding: '2px 6px',
                    outline: 'none',
                  }}
                />
              ) : (
                <p
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: pnl === 0 ? AMBER : pnl > 0 ? '#34d399' : '#f87171', cursor: 'pointer' }}
                  onClick={() => { setPnlOverride(v => v !== null ? v : calcPnL()); setPnlEditMode(true); }}
                  title="Click to override Gross P&L"
                >
                  {formatCurrency(pnl)}
                </p>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 11, color: T3, marginBottom: 3 }}>R:R</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: T1 }}>
                {rr === 'N/A' ? 'N/A' : formatRiskRewardRatio(Number(rr))}
              </p>
            </div>
          </div>
          {/* Commission row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BD}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <p style={{ fontSize: 11, color: T3, whiteSpace: 'nowrap' }}>Fees / Commission</p>
              <input
                type="number"
                min="0"
                step="0.01"
                value={commission === 0 ? '' : commission}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setCommission(Number.isFinite(v) && v >= 0 ? v : 0);
                }}
                placeholder="0.00"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 500,
                  width: 90,
                  background: 'transparent',
                  border: `1px solid ${BD}`,
                  borderRadius: 4,
                  color: T2,
                  padding: '2px 6px',
                  outline: 'none',
                }}
              />
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: 11, color: T3, marginBottom: 2 }}>Net P&amp;L</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: (pnl - commission) === 0 ? AMBER : (pnl - commission) > 0 ? '#34d399' : '#f87171' }}>
                {formatCurrency(pnl - commission)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: Outcome + Psychology */}
      <div className="scanner-row-two">

        {/* Outcome */}
        <div style={panel}>
          <SectionLabel>Outcome</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label className="label">Exit Reason <AIBadge field="exit_reason" /></label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['TP', 'SL', 'BE'] as const).map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      set('exit_reason', r);
                      if (r === 'TP' && form.tp_price) set('exit_price', form.tp_price);
                      if (r === 'SL' && form.sl_price) set('exit_price', form.sl_price);
                      if (r === 'BE' && form.entry_price) set('exit_price', form.entry_price);
                    }}
                    style={toggleBtn(form.exit_reason === r, r === 'TP' ? 'green' : r === 'SL' ? 'red' : 'amber')}
                  >
                    {r === 'TP' ? 'Take Profit' : r === 'SL' ? 'Stop Loss' : 'Breakeven'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Duration <AIBadge field="trade_length_seconds" /></label>
              <div style={{ display: 'flex', border: `1px solid ${BD}`, borderRadius: 6, background: P2, overflow: 'hidden', height: 36 }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                  <input
                    type="number" min={0} max={23}
                    value={Math.floor((form.trade_length_seconds || 0) / 3600)}
                    onChange={e => { const h = Math.max(0, parseInt(e.target.value) || 0); const m = Math.floor(((form.trade_length_seconds || 0) % 3600) / 60); set('trade_length_seconds', h * 3600 + m * 60); }}
                    style={durationInput}
                    placeholder="0"
                  />
                  <span style={{ paddingRight: 6, fontSize: 11, color: T3 }}>h</span>
                </div>
                <div style={{ width: 1, background: BD }} />
                <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                  <input
                    type="number" min={0} max={59}
                    value={Math.floor(((form.trade_length_seconds || 0) % 3600) / 60)}
                    onChange={e => { const m = Math.max(0, parseInt(e.target.value) || 0); const h = Math.floor((form.trade_length_seconds || 0) / 3600); set('trade_length_seconds', h * 3600 + m * 60); }}
                    style={durationInput}
                    placeholder="0"
                  />
                  <span style={{ paddingRight: 6, fontSize: 11, color: T3 }}>m</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Psychology */}
        <div style={panel}>
          <SectionLabel>Psychology</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label className="label">Emotional State</label>
              <select
                className="input-field h-9"
                value={form.emotional_state ?? ''}
                onChange={e => set('emotional_state', e.target.value ? e.target.value : null)}
              >
                <option value="">Not logged</option>
                {emotionalStates.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Confidence ({typeof form.confidence_level === 'number' ? `${form.confidence_level}/10` : 'Not logged'})</label>
              <input
                type="range" min={1} max={10}
                value={typeof form.confidence_level === 'number' ? form.confidence_level : 5}
                onChange={e => set('confidence_level', parseInt(e.target.value))}
                style={{ width: '100%', marginTop: 6, accentColor: AMBER }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T3, marginTop: 2 }}>
                <span>Low</span><span>High</span>
              </div>
            </div>
            <div>
              <label className="label">Followed Trading Plan?</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => set('followed_plan', true)} style={toggleBtn(form.followed_plan === true, 'green')}>
                  Yes
                </button>
                <button type="button" onClick={() => set('followed_plan', false)} style={toggleBtn(form.followed_plan === false, 'red')}>
                  No
                </button>
                <button type="button" onClick={() => set('followed_plan', null)} style={toggleBtn(form.followed_plan == null, 'amber')}>
                  Not logged
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 3: Confluences (full width) */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: T3, margin: 0 }}>Confluences</p>
          <button type="button" onClick={() => navigate('/settings#journal')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10, color: 'var(--cobalt)', fontFamily: 'var(--font-sans)' }}>Manage tags →</button>
        </div>
        <div className="scanner-confluence-row">
          <select
            className="input-field h-9"
            style={{ flex: 1 }}
            value={selectedConfluence}
            onChange={e => setSelectedConfluence(e.target.value)}
          >
            <option value="">Select confluence</option>
            {availableConfluenceOptions.map(option => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={addConfluence}
            disabled={!selectedConfluence}
            style={{ height: 36, paddingLeft: 12, paddingRight: 12, borderRadius: 6, border: `1px solid ${!selectedConfluence ? BD : AMBER_BD}`, background: !selectedConfluence ? 'transparent' : AMBER_DIM, color: !selectedConfluence ? T3 : AMBER, fontSize: 12, fontWeight: 600, cursor: !selectedConfluence ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <Plus size={13} /> Add
          </button>
        </div>
        {confluences.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {confluences.map((c, i) => (
              <span key={`${c}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, border: `1px solid ${AMBER_BD}`, background: AMBER_DIM, fontSize: 11, color: AMBER }}>
                {c}
                <button type="button" onClick={() => removeConfluence(i)} aria-label={`Remove ${c}`} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: AMBER, display: 'flex', alignItems: 'center' }}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 11, color: T3 }}>Pick confirmations that were present when you entered this trade.</p>
        )}
      </div>

      {/* Row 4: Notes (full width, 3-col internal) */}
      <div style={panel}>
        <SectionLabel>Notes</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Pre-trade Thesis — 3 col */}
          <div style={sub}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: '#34d399' }}>Pre-trade Thesis</p>
              <p style={{ fontSize: 11, color: T3 }}>Capture trade logic before outcome bias creeps in.</p>
            </div>
            <div className="scanner-three-col">
              <div>
                <label className="label">Trade Thesis</label>
                <textarea className="input-field resize-none" rows={2} value={thesisSetup} onChange={e => setThesisSetup(e.target.value)} placeholder="What edge did you see?" />
              </div>
              <div>
                <label className="label">Invalidation</label>
                <textarea className="input-field resize-none" rows={2} value={thesisInvalidation} onChange={e => setThesisInvalidation(e.target.value)} placeholder="What would prove this wrong?" />
              </div>
              <div>
                <label className="label">Execution Trigger</label>
                <textarea className="input-field resize-none" rows={2} value={thesisTrigger} onChange={e => setThesisTrigger(e.target.value)} placeholder="What had to happen before entry?" />
              </div>
            </div>
          </div>

          {/* Process Grade + Reflection side by side */}
          <div className="scanner-notes-two-col">
            <div style={sub}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: T2 }}>Process Grade</p>
                <p style={{ fontSize: 11, color: T3 }}>Rate quality, not P&amp;L.</p>
              </div>
              <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                {[1, 2, 3, 4, 5].map(score => (
                  <button
                    key={score}
                    type="button"
                    onClick={() => setProcessScore(score)}
                    style={processScore === score
                      ? { flex: 1, height: 30, borderRadius: 5, border: `1px solid ${AMBER_BD}`, background: AMBER_DIM, color: AMBER, fontSize: 13, fontWeight: 600, cursor: 'pointer' }
                      : { flex: 1, height: 30, borderRadius: 5, border: `1px solid ${BD}`, background: 'transparent', color: T2, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
                  >
                    {score}
                  </button>
                ))}
              </div>
              <textarea className="input-field resize-none" rows={2} value={processReason} onChange={e => setProcessReason(e.target.value)} placeholder="Why this score?" />
            </div>

            <div style={sub}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: AMBER }}>Additional Notes</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea className="input-field resize-none" rows={2} value={form.pre_trade_notes || ''} onChange={e => set('pre_trade_notes', e.target.value)} placeholder="Additional pre-trade observations." />
                <textarea className="input-field resize-none" rows={2} value={form.post_trade_notes || ''} onChange={e => set('post_trade_notes', e.target.value)} placeholder="Additional post-trade notes." />
              </div>
            </div>
          </div>

          {/* Reflection — 3 col */}
          <div style={sub}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: AMBER }}>Reflection</p>
              <p style={{ fontSize: 11, color: T3 }}>Force specific learning after the trade.</p>
            </div>
            <div className="scanner-three-col">
              <div>
                <label className="label">Market vs Thesis</label>
                <textarea className="input-field resize-none" rows={2} value={reflectionMarket} onChange={e => setReflectionMarket(e.target.value)} placeholder="Did price confirm or reject your thesis?" />
              </div>
              <div>
                <label className="label">Execution Quality</label>
                <textarea className="input-field resize-none" rows={2} value={reflectionExecution} onChange={e => setReflectionExecution(e.target.value)} placeholder="What did you do well or poorly?" />
              </div>
              <div>
                <label className="label">One Next Adjustment</label>
                <textarea className="input-field resize-none" rows={2} value={reflectionAdjustment} onChange={e => setReflectionAdjustment(e.target.value)} placeholder="What single change will you test next?" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      {(submitError || requiredFieldsMessage) && (
        <p style={{ fontSize: 12, color: requiredFieldsMessage && !submitError ? AMBER : '#f87171' }}>
          {submitError || requiredFieldsMessage}
        </p>
      )}
      {showActionBar && (
        <div style={{ display: 'flex', gap: 8, borderTop: `1px solid ${BD}`, paddingTop: 10 }}>
          <button
            type="submit"
            disabled={!canSubmit}
            title={requiredFieldsMessage || undefined}
            style={{
              flex: 1, height: 38, borderRadius: 6,
              border: `1px solid ${canSubmit ? 'transparent' : BD}`,
              background: canSubmit ? AMBER : P2,
              color: canSubmit ? '#000' : T3,
              fontSize: 13, fontWeight: 600, cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {isLoading ? 'Saving...' : 'Save Trade'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{ height: 38, paddingLeft: 16, paddingRight: 16, borderRadius: 6, border: `1px solid ${BD}`, background: 'transparent', color: T2, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}
