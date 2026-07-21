import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useAuth } from '../contexts/AuthContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry, RiskRule } from '../store/types.js';
import { pushToast } from '../store/toastStore.js';
import { useTrades } from '../hooks/useTrades.js';
import { lookupContract } from '../constants/futuresContracts.js';
import { buildScannerAssets, inferSymbolFromFileName, inferTradeDateFromFileName, normalizeResolvedSymbol } from '../utils/tradeScannerPipeline.js';
import { scaleContractAmount } from '../utils/contractSizing.js';
import { normalizeConfluenceKey } from '../utils/confluenceTags.js';
import { pruneEmptyJournalEntries } from '../utils/journalEntryCleanup.js';
import { scanChart } from '../utils/scanChart.js';
import { maybeCaptureCorrection, maybeCaptureScanBundle } from '../utils/scannerEvalCapture.js';
import { uploadScreenshot } from '../utils/uploadScreenshot.js';
import { evaluateEntryRules, summarizeRuleEvaluations } from '../utils/tradingRules.js';
import { computeDayVerdict, computeEvaluationProgress, inferEvaluationTemplate, tradesForAccount } from '../utils/evaluationCoach.js';
import { flushSupabaseStoreNow, saveStoreStatePatchNow, deleteTradingDayEverywhere } from '../store/supabaseStorage.js';
import CSVImportModal from '../components/common/CSVImportModal.js';
import SessionShareCard from '../components/share/SessionShareCard.js';
import ScannerDropZone from '../components/scanner/ScannerDropZone.js';
import DatePicker from '../components/common/DatePicker.js';
import './TradeJournal.css';

import { type RuleState, type EmotionState, type TradeResult, type TradeDirection, type DayFilter, type JournalTrade, type JournalEntry, STATE_OF_MIND_TAGS, getTodayIso, getNowTime, addSecondsToTime, minutesBetweenTimes, formatDurationLabel, resolveTradeDurationMinutes, parseDate, isValidIsoDate, formatMonth, formatDateTitle, formatWeekday, formatSignedCurrency, toPercent, toR, formatCurrencyFixed, parsePrice, normalizeConfluences, getTradeEntry, getTradeExit, withTradeDerivedValues, getTradeDateValue, shiftMonth, inMonth, getRulesTemplate, createEmptyEntry, scoreToGradeLetter, gradeCssKey, computeEntryStats, findBestDay, normalizeEntries, computeTradePatternFlags, computeProcessScore, ALL_BEHAVIORAL_FLAGS } from '../utils/tradeJournal.js';

interface PriceLevelsBlockProps {
  trade: JournalTrade;
  onMutate: (fields: Partial<JournalTrade>) => void;
}

interface ContractSizingBlockProps {
  trade: JournalTrade;
  onMutate: (fields: Partial<JournalTrade>) => void;
}


function ContractSizingBlock({ trade, onMutate }: ContractSizingBlockProps) {
  const [localContracts, setLocalContracts] = useState(String(Math.max(1, Math.round(trade.contracts || 1))));

  useEffect(() => {
    setLocalContracts(String(Math.max(1, Math.round(trade.contracts || 1))));
  }, [trade.id, trade.contracts]);

  const commitContracts = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    const nextContracts = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    setLocalContracts(String(nextContracts));
    onMutate({ contracts: nextContracts });
  };

  const nudgeContracts = (delta: number) => {
    const parsed = Number.parseInt(localContracts, 10);
    const current = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    const next = Math.max(1, current + delta);
    setLocalContracts(String(next));
    onMutate({ contracts: next });
  };

  return (
    <div className="tj-sizing-row">
      <span className="tj-size-label">Contracts</span>
      <div className="tj-size-body">
        <button
          type="button"
          className="tj-size-btn"
          onClick={() => nudgeContracts(-1)}
          aria-label="Decrease contracts"
        >
          -
        </button>
        <input
          className="tj-size-input"
          type="number"
          min={1}
          step={1}
          value={localContracts}
          onChange={event => setLocalContracts(event.target.value)}
          onBlur={event => commitContracts(event.target.value)}
          aria-label="Contracts"
        />
        <button
          type="button"
          className="tj-size-btn"
          onClick={() => nudgeContracts(1)}
          aria-label="Increase contracts"
        >
          +
        </button>
      </div>
    </div>
  );
}

const ACCOUNT_STATUS_DOT: Record<string, string> = {
  Eval: '#60a5fa',
  Funded: '#fbbf24',
  Live: '#34d399',
  Blown: '#fca5a5',
};

function AccountSelectorBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (fields: Partial<JournalTrade>) => void }) {
  const { accounts } = useAppSettings();
  const selectedAccountIds = Array.from(new Set([...(trade.accountIds ?? []), trade.accountId].filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const toggleAccount = (accountId: string, checked: boolean) => {
    const nextIds = checked
      ? Array.from(new Set([...selectedAccountIds, accountId]))
      : selectedAccountIds.filter(id => id !== accountId);
    onMutate({ accountIds: nextIds, accountId: nextIds[0], account: nextIds[0] } as Partial<JournalTrade>);
  };

  return (
    <div className="tj-sizing-row">
      <span className="tj-size-label">Accounts</span>
      <div className="tj-account-check-list">
        {accounts.filter(account =>
          account.id !== DEFAULT_ACCOUNT_ID &&
          (!account.archived || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Blown'   || selectedAccountIds.includes(account.id)) &&
          (account.status !== 'Passed'  || selectedAccountIds.includes(account.id))
        ).map(account => {
          const isInactive = account.archived || account.status === 'Blown' || account.status === 'Passed';
          const statusLabel = account.archived ? ' (Archived)' : account.status === 'Blown' ? ' (Blown)' : account.status === 'Passed' ? ' (Passed)' : '';
          const dotColor = ACCOUNT_STATUS_DOT[account.status] ?? 'rgba(255,255,255,0.25)';
          return (
            <label
              key={account.id}
              className={`tj-account-check ${selectedAccountIds.includes(account.id) ? 'selected' : ''} ${isInactive ? 'opacity-50' : ''}`}
              title={account.archived ? 'Archived account' : account.status === 'Passed' ? 'Passed accounts cannot be allocated to new trades' : undefined}
            >
              <input
                type="checkbox"
                checked={selectedAccountIds.includes(account.id)}
                onChange={event => toggleAccount(account.id, event.target.checked)}
                disabled={isInactive}
              />
              <span
                className="tj-account-status-dot"
                style={{ background: dotColor }}
                title={account.status}
              />
              <span>{account.name}{statusLabel}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PriceLevelsBlock({ trade, onMutate }: PriceLevelsBlockProps) {
  const entry = getTradeEntry(trade);
  const exit = getTradeExit(trade);
  const [local, setLocal] = useState({
    entry: entry !== undefined ? String(entry) : '',
    exit: exit !== undefined ? String(exit) : '',
    sl: trade.sl != null ? String(trade.sl) : '',
    tp: trade.tp != null ? String(trade.tp) : '',
  });
  const [pnlEditMode, setPnlEditMode] = useState(false);
  const [pnlEditValue, setPnlEditValue] = useState('');
  const [commissionLocal, setCommissionLocal] = useState(
    typeof trade.commission === 'number' && trade.commission > 0 ? String(trade.commission) : ''
  );

  useEffect(() => {
    setLocal({
      entry: getTradeEntry(trade) !== undefined ? String(getTradeEntry(trade)) : '',
      exit: getTradeExit(trade) !== undefined ? String(getTradeExit(trade)) : '',
      sl: trade.sl != null ? String(trade.sl) : '',
      tp: trade.tp != null ? String(trade.tp) : '',
    });
    setPnlEditMode(false);
    setCommissionLocal(typeof trade.commission === 'number' && trade.commission > 0 ? String(trade.commission) : '');
  }, [trade.id, trade.entry, trade.entryPrice, trade.exit, trade.exitPrice, trade.sl, trade.tp, trade.commission]);

  const parseLocal = (value: string): number | undefined => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  const entryValue = parseLocal(local.entry);
  const exitValue = parseLocal(local.exit);
  const slValue = parseLocal(local.sl);
  const tpValue = parseLocal(local.tp);

  const commit = (field: 'entry' | 'exit' | 'sl' | 'tp', value: string) => {
    const parsed = parseLocal(value);
    const nextFields: Partial<JournalTrade> = {
      priceLevelsSource: 'manual',
      priceLevelsEdited: true,
    };
    if (field === 'entry') {
      nextFields.entry = parsed;
      nextFields.entryPrice = parsed ?? 0;
      nextFields.breakevenRestore = undefined;
    } else if (field === 'exit') {
      nextFields.exit = parsed;
      nextFields.exitPrice = parsed ?? 0;
      nextFields.breakevenRestore = undefined;
    } else if (field === 'sl') {
      nextFields.sl = parsed;
    } else {
      nextFields.tp = parsed;
    }
    onMutate(nextFields);
  };

  const pointValue = lookupContract(trade.symbol)?.point_value ?? 1;
  const contracts = trade.contracts > 0 ? trade.contracts : 1;

  const stopDelta = entryValue !== undefined && slValue !== undefined ? Math.abs(slValue - entryValue) : null;
  const tpDelta = entryValue !== undefined && tpValue !== undefined ? Math.abs(tpValue - entryValue) : null;
  const exitDelta = entryValue !== undefined && exitValue !== undefined
    ? trade.direction === 'LONG' ? exitValue - entryValue : entryValue - exitValue
    : null;

  const netPnl = entryValue !== undefined && exitValue !== undefined
    ? trade.direction === 'LONG'
      ? (exitValue - entryValue) * contracts * pointValue
      : (entryValue - exitValue) * contracts * pointValue
    : null;

  const effectivePnl = typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride)
    ? trade.pnlOverride
    : netPnl;

  const rr = (() => {
    if (entryValue === undefined || slValue === undefined || tpValue === undefined) return null;
    const risk = trade.direction === 'LONG' ? entryValue - slValue : slValue - entryValue;
    const reward = trade.direction === 'LONG' ? tpValue - entryValue : entryValue - tpValue;
    if (risk <= 0 || reward <= 0) return null;
    return reward / risk;
  })();

  const isBreakevenActive = entryValue !== undefined
    && exitValue !== undefined
    && Math.abs(exitValue - entryValue) < 0.000001
    && effectivePnl === 0;

  const handleBreakevenToggle = () => {
    if (entryValue === undefined) return;
    if (isBreakevenActive && trade.breakevenRestore) {
      const restore = trade.breakevenRestore;
      const restoredExit = restore.exit !== undefined ? String(restore.exit) : '';
      setLocal(prev => ({ ...prev, exit: restoredExit }));
      onMutate({
        exit: restore.exit,
        exitPrice: restore.exitPrice,
        pnlOverride: restore.pnlOverride,
        breakevenRestore: undefined,
        priceLevelsSource: 'manual',
        priceLevelsEdited: true,
      });
      return;
    }

    const v = String(entryValue);
    setLocal(prev => ({ ...prev, exit: v }));
    onMutate({
      exit: entryValue,
      exitPrice: entryValue,
      pnlOverride: 0,
      breakevenRestore: {
        exit: exitValue,
        exitPrice: trade.exitPrice,
        pnlOverride: trade.pnlOverride,
      },
      priceLevelsSource: 'manual',
      priceLevelsEdited: true,
    });
  };

  const sourceText = trade.priceLevelsEdited ? 'Manually set' : trade.priceLevelsSource === 'ai' ? 'AI extracted' : 'Manually set';
  const renderPointsDiff = (delta: number | null, mode: 'pos' | 'neg' | 'auto') => {
    if (delta === null) return '-';
    const isPositive = mode === 'pos' || (mode === 'auto' && delta >= 0);
    const sign = isPositive ? '+' : '-';
    return (
      <span className={`tj-pl-points ${isPositive ? 'pos' : 'neg'}`}>
        {`${sign}${Math.abs(delta).toFixed(2)} pts`}
      </span>
    );
  };

  return (
    <div className="tj-pl-card">
      <div className="tj-pl-header">
        <span className="tj-pl-title">PRICE LEVELS</span>
        <span className="tj-pl-source">{sourceText}</span>
      </div>
      <div className="tj-pl-grid">
        <div className="tj-pl-cell">
          <div className="tj-pl-label">ENTRY</div>
          <input
            className="tj-pl-input entry"
            type="number"
            step="0.25"
            value={local.entry}
            onChange={event => setLocal(prev => ({ ...prev, entry: event.target.value }))}
            onBlur={event => commit('entry', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff" aria-hidden="true">&nbsp;</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label">STOP LOSS</div>
          <input
            className="tj-pl-input sl"
            type="number"
            step="0.25"
            value={local.sl}
            onChange={event => setLocal(prev => ({ ...prev, sl: event.target.value }))}
            onBlur={event => commit('sl', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(stopDelta, 'neg')}</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label">TAKE PROFIT</div>
          <input
            className="tj-pl-input tp"
            type="number"
            step="0.25"
            value={local.tp}
            onChange={event => setLocal(prev => ({ ...prev, tp: event.target.value }))}
            onBlur={event => commit('tp', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(tpDelta, 'pos')}</div>
        </div>
        <div className="tj-pl-cell">
          <div className="tj-pl-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <span>EXIT</span>
            {entryValue !== undefined && (
              <button
                type="button"
                onClick={handleBreakevenToggle}
                style={{
                  fontSize: 9,
                  padding: '2px 6px',
                  borderRadius: 3,
                  border: '1px solid var(--amber)',
                  background: isBreakevenActive ? 'var(--amber)' : 'transparent',
                  color: isBreakevenActive ? '#111' : 'var(--amber)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: 700,
                  lineHeight: 1.3,
                  letterSpacing: '0.03em',
                  flexShrink: 0,
                }}
                title={isBreakevenActive && trade.breakevenRestore ? 'Restore previous exit' : 'Set exit to entry price (Breakeven)'}
              >
                {isBreakevenActive && trade.breakevenRestore ? '↺ BREAKEVEN' : 'BREAKEVEN'}
              </button>
            )}
          </div>
          <input
            className="tj-pl-input exit"
            type="number"
            step="0.25"
            value={local.exit}
            onChange={event => setLocal(prev => ({ ...prev, exit: event.target.value }))}
            onBlur={event => commit('exit', event.target.value)}
            placeholder="-"
          />
          <div className="tj-pl-diff">{renderPointsDiff(exitDelta, 'auto')}</div>
        </div>
      </div>
      <div className="tj-pl-summary">
        <div className="tj-pl-summary-block">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <div className="tj-pl-summary-label" style={{ marginBottom: 0 }}>GROSS P&amp;L</div>
            {trade.pnlOverride !== undefined && (
              <button
                type="button"
                onClick={() => { onMutate({ pnlOverride: undefined }); setPnlEditMode(false); }}
                style={{ fontSize: 9, color: 'var(--txt-3)', cursor: 'pointer', border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', lineHeight: 1 }}
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
              value={pnlEditValue}
              onChange={e => setPnlEditValue(e.target.value)}
              onBlur={() => {
                const parsed = parseFloat(pnlEditValue);
                if (Number.isFinite(parsed)) onMutate({ pnlOverride: parsed });
                setPnlEditMode(false);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const parsed = parseFloat(pnlEditValue);
                  if (Number.isFinite(parsed)) onMutate({ pnlOverride: parsed });
                  setPnlEditMode(false);
                } else if (e.key === 'Escape') {
                  setPnlEditMode(false);
                }
              }}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 18,
                fontWeight: 600,
                width: 130,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: parseFloat(pnlEditValue) > 0 ? 'var(--green)' : parseFloat(pnlEditValue) < 0 ? 'var(--red)' : 'var(--txt)',
                padding: '2px 6px',
                outline: 'none',
              }}
            />
          ) : (
            <div
              className={`tj-pl-summary-value ${effectivePnl !== null && effectivePnl > 0 ? 'pos' : effectivePnl !== null && effectivePnl < 0 ? 'neg' : ''}`}
              onClick={() => { setPnlEditValue(String(effectivePnl ?? 0)); setPnlEditMode(true); }}
              title="Click to override Gross P&L"
              style={{ cursor: 'pointer' }}
            >
              {effectivePnl === null ? '-' : formatCurrencyFixed(effectivePnl)}
            </div>
          )}
        </div>
        <div className="tj-pl-summary-block">
          <div className="tj-pl-summary-label">R:R</div>
          <div className={`tj-pl-summary-rr ${rr !== null && rr >= 2 ? 'pos' : rr !== null && rr >= 1 ? 'amber' : rr !== null ? 'neg' : ''}`}>
            {rr === null ? '-' : `${rr.toFixed(2)}R`}
          </div>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)', borderLeft: '3px solid var(--amber)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '10px 12px 10px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="tj-pl-summary-label" style={{ marginBottom: 0, whiteSpace: 'nowrap', color: 'var(--amber)' }}>Commissions &amp; Fees</div>
          <input
            type="number"
            min="0"
            step="0.01"
            value={commissionLocal}
            onChange={e => setCommissionLocal(e.target.value)}
            onBlur={() => {
              const parsed = parseFloat(commissionLocal);
              const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
              setCommissionLocal(value > 0 ? String(value) : '');
              onMutate({ commission: value > 0 ? value : undefined });
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const parsed = parseFloat(commissionLocal);
                const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                setCommissionLocal(value > 0 ? String(value) : '');
                onMutate({ commission: value > 0 ? value : undefined });
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="0.00"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 500,
              width: 80,
              background: 'var(--amber-dim, rgba(245,158,11,0.08))',
              border: '1px solid var(--amber)',
              borderRadius: 4,
              color: 'var(--txt)',
              padding: '3px 7px',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => {
              const parsed = parseFloat(commissionLocal);
              const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
              setCommissionLocal(value > 0 ? String(value) : '');
              onMutate({ commission: value > 0 ? value : undefined });
            }}
            style={{
              height: 26,
              padding: '0 8px',
              borderRadius: 4,
              border: '1px solid var(--amber)',
              background: 'var(--amber-dim, rgba(245,158,11,0.08))',
              color: 'var(--amber)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Save
          </button>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="tj-pl-summary-label" style={{ marginBottom: 2 }}>NET P&amp;L</div>
          {effectivePnl !== null ? (() => {
            const net = effectivePnl - (trade.commission ?? 0);
            return (
              <div className={`tj-pl-summary-value ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}`} style={{ fontSize: 18 }}>
                {formatCurrencyFixed(net)}
              </div>
            );
          })() : (
            <div className="tj-pl-summary-value">-</div>
          )}
        </div>
      </div>
    </div>
  );
}



// ── Behavioral flag penalty weights ──────────────────────────────────────────
// ── SectionHead collapsible header ───────────────────────────────────────────
function SectionHead({ title, collapsed, onToggle }: {
  title: string;
  sectionKey?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="tj-section-head" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={onToggle}>
      <span className="tj-section-title">{title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--app-text-subtle)', fontFamily: 'var(--font-mono)' }}>
        {collapsed ? '▶' : '▼'}
      </span>
    </div>
  );
}

function RuleComplianceBlock({ entry, rules, onMutateEntry }: {
  entry: JournalEntry;
  rules: RiskRule[];
  onMutateEntry: (fields: Partial<JournalEntry>) => void;
}) {
  const [showPassed, setShowPassed] = useState(false);
  const evaluations = evaluateEntryRules(entry as unknown as StoreJournalEntry, rules);
  const verified = evaluations.filter(item => item.state !== 'unchecked');
  const broken = verified.filter(item => item.state === 'fail');

  const updateManualRule = (label: string, state: RuleState) => {
    const next = entry.rules.some(rule => rule.text === label)
      ? entry.rules.map(rule => rule.text === label ? { ...rule, state } : rule)
      : [...entry.rules, { text: label, state }];
    onMutateEntry({ rules: next });
  };

  const visibleRows = evaluations.filter(item =>
    item.state === 'fail' || (item.source === 'manual' && item.state === 'unchecked') || showPassed
  );
  const passedCount = evaluations.filter(item => item.state === 'ok').length;

  const RuleRow = ({ item }: { item: typeof evaluations[number] }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 5, background: 'var(--surface-2)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <strong style={{ color: 'var(--txt)', fontSize: 10 }}>{item.label}</strong>
          <span style={{ color: item.source === 'automatic' ? 'var(--green)' : 'var(--cobalt)', fontSize: 8, textTransform: 'uppercase' }}>{item.source}</span>
        </div>
        <span style={{ display: 'block', marginTop: 3, color: 'var(--txt-3)', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</span>
      </div>
      {item.source === 'manual' ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={() => updateManualRule(item.label, 'ok')} style={{ padding: '4px 7px', borderRadius: 4, border: `1px solid ${item.state === 'ok' ? 'var(--green)' : 'var(--border)'}`, background: item.state === 'ok' ? 'var(--green-dim)' : 'transparent', color: item.state === 'ok' ? 'var(--green)' : 'var(--txt-3)', fontSize: 9, cursor: 'pointer' }}>Pass</button>
          <button type="button" onClick={() => updateManualRule(item.label, 'fail')} style={{ padding: '4px 7px', borderRadius: 4, border: `1px solid ${item.state === 'fail' ? 'var(--red)' : 'var(--border)'}`, background: item.state === 'fail' ? 'var(--red-dim)' : 'transparent', color: item.state === 'fail' ? 'var(--red)' : 'var(--txt-3)', fontSize: 9, cursor: 'pointer' }}>Break</button>
        </div>
      ) : (
        <span style={{ color: item.state === 'ok' ? 'var(--green)' : item.state === 'fail' ? 'var(--red)' : 'var(--txt-3)', fontSize: 9, fontWeight: 700 }}>
          {item.state === 'ok' ? 'PASS' : item.state === 'fail' ? 'BREAK' : 'UNVERIFIED'}
        </span>
      )}
    </div>
  );

  return (
    <div style={{ background: 'var(--app-panel)', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', marginBottom: 12 }}>
      {/* ── Section header with badge counts ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)', textTransform: 'uppercase', letterSpacing: '0.06em', flex: 1 }}>Rule Verification</span>
        {passedCount > 0 && (
          <span style={{ padding: '2px 8px', borderRadius: 3, background: 'var(--green-dim)', color: 'var(--green)', fontSize: 10, fontWeight: 700 }}>{passedCount} passed</span>
        )}
        {broken.length > 0 && (
          <span style={{ padding: '2px 8px', borderRadius: 3, background: 'var(--red-dim)', color: 'var(--red)', fontSize: 10, fontWeight: 700 }}>{broken.length} broken</span>
        )}
      </div>
      {/* ── Rule rows ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10 }}>
        {visibleRows.map(item => <RuleRow key={item.ruleId} item={item} />)}
        {!showPassed && passedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowPassed(true)}
            style={{ fontSize: 10, color: 'var(--txt-3)', background: 'none', border: '1px dashed var(--border)', borderRadius: 5, padding: '6px 10px', cursor: 'pointer', textAlign: 'left' }}
          >
            Show {passedCount} passed check{passedCount !== 1 ? 's' : ''}
          </button>
        )}
        {showPassed && passedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowPassed(false)}
            style={{ fontSize: 10, color: 'var(--txt-3)', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', textAlign: 'left' }}
          >
            Hide passed checks
          </button>
        )}
        {evaluations.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--txt-3)', padding: '4px 0' }}>No rules configured</span>
        )}
      </div>
    </div>
  );
}

// ── A — DailyReflectionBlock ──────────────────────────────────────────────────
function DailyReflectionBlock({ entry, onMutateEntry }: {
  entry: JournalEntry;
  onMutateEntry: (fields: Partial<JournalEntry>) => void;
}) {
  const dr = entry.dailyReflection ?? { pre: entry.reflection.pre, post: entry.reflection.post, lessons: entry.reflection.lessons, bias: null, newsRisk: null, sessionTarget: null, sessionGrade: null, marketRespectedBias: null, lessonCategory: null };
  const [activeTab, setActiveTab] = useState<'pre' | 'post' | 'lessons'>('pre');
  const [showPhysical, setShowPhysical] = useState(false);

  // ── Evaluation coaching context ────────────────────────────────
  const storeAccounts = useFlyxaStore(state => state.accounts);
  const storeEntries = useFlyxaStore(state => state.entries);
  const { accounts: tradingAccounts, decorateTrades } = useAppSettings();
  const statusById = useMemo(() => new Map(tradingAccounts.map(ta => [ta.id, (ta as { status?: string }).status ?? ''])), [tradingAccounts]);
  const EVAL_STATUSES = new Set(['Eval', 'Passed', 'Blown']);
  const entryAccountIds = useMemo(() => {
    const e = entry as unknown as { accountIds?: string[]; account?: string };
    return e.accountIds?.length ? e.accountIds : (e.account ? [e.account] : []);
  }, [entry]);

  const evalAccount = useMemo(() => {
    return storeAccounts.find(a =>
      entryAccountIds.includes(a.id) && (EVAL_STATUSES.has(statusById.get(a.id) ?? '') || a.type === 'eval' || a.phase === 'eval'),
    ) ?? null;
  }, [storeAccounts, entryAccountIds, statusById]);

  const dayVerdict = useMemo(() => {
    if (!evalAccount) return null;
    const allTrades = decorateTrades(storeEntries.flatMap(e => e.trades));
    const progress = computeEvaluationProgress(evalAccount, allTrades);
    const activeTemplate = inferEvaluationTemplate(evalAccount);
    const maxDrawdown = evalAccount.maxDrawdown || activeTemplate.maxDrawdown;
    const dailyLimit = evalAccount.dailyLossLimit || activeTemplate.dailyLossLimit;
    const drawdownRemainingPct = maxDrawdown > 0 ? Math.min(100, Math.round((progress.drawdownRemaining / maxDrawdown) * 100)) : 100;
    const dailyLimitHit = dailyLimit > 0 && progress.dailyLossRemaining <= 0;
    const accountTrades = tradesForAccount(allTrades, evalAccount.id);
    return computeDayVerdict(accountTrades, drawdownRemainingPct, dailyLimitHit);
  }, [evalAccount, storeEntries, decorateTrades]);
  const [localPre, setLocalPre] = useState(dr.pre);
  const [localPost, setLocalPost] = useState(dr.post);
  const [localLessons, setLocalLessons] = useState(dr.lessons);

  useEffect(() => {
    const d = entry.dailyReflection ?? { pre: entry.reflection.pre, post: entry.reflection.post, lessons: entry.reflection.lessons, bias: null, newsRisk: null, sessionTarget: null, sessionGrade: null, marketRespectedBias: null, lessonCategory: null };
    setLocalPre(d.pre); setLocalPost(d.post); setLocalLessons(d.lessons);
  }, [entry.id]);

  // Save local textarea content when section is collapsed (component unmounts)
  const unmountRef = useRef({ localPre, localPost, localLessons, dr, onMutateEntry });
  unmountRef.current = { localPre, localPost, localLessons, dr, onMutateEntry };
  useEffect(() => {
    return () => {
      const { localPre: p, localPost: po, localLessons: l, dr: d, onMutateEntry: m } = unmountRef.current;
      m({ dailyReflection: { ...d, pre: p, post: po, lessons: l } });
    };
  }, []);

  const update = (patch: Partial<typeof dr>) => {
    onMutateEntry({ dailyReflection: { ...dr, ...patch } });
  };

  const LESSON_CATS = ['Entry Timing','Exit Management','Sizing','Patience','Risk Management','Entry Selection','Emotional Control','Rule Following','Market Reading'];
  const GRADES = ['A+','A','B+','B','C+','C'];
  const biasOptions: Array<{ v: 'bullish'|'neutral'|'bearish'; label: string }> = [{ v:'bullish', label:'BULLISH' },{ v:'neutral', label:'NEUTRAL' },{ v:'bearish', label:'BEARISH' }];
  const newsOptions: Array<{ v: 'clear'|'caution'|'avoid'; label: string }> = [{ v:'clear', label:'CLEAR' },{ v:'caution', label:'CAUTION' },{ v:'avoid', label:'AVOID' }];

  return (
    <div className="tj-card" style={{ marginBottom: 8 }}>
      <div className="tj-tabs">
        {(['pre','post','lessons'] as const).map(tab => (
          <button key={tab} type="button" className={`tj-tab${activeTab===tab?' active':''}`} onClick={() => setActiveTab(tab)}>
            {tab === 'pre' ? 'Pre-market' : tab === 'post' ? 'Post-session' : 'Lessons'}
          </button>
        ))}
      </div>

      {activeTab === 'pre' && (
        <div style={{ padding: '0' }}>
          {dayVerdict && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 14px',
              borderBottom: '1px solid var(--app-border)',
              background: dayVerdict.verdict === 'yes' ? 'var(--green-dim)' : dayVerdict.verdict === 'caution' ? 'var(--amber-dim)' : 'var(--red-dim)',
            }}>
              <span style={{
                font: '700 11px/1 var(--font-mono)', letterSpacing: '.06em',
                color: dayVerdict.verdict === 'yes' ? 'var(--green)' : dayVerdict.verdict === 'caution' ? 'var(--amber)' : 'var(--red)',
                flexShrink: 0, paddingTop: 1,
              }}>
                {dayVerdict.verdict === 'yes' ? 'TRADE' : dayVerdict.verdict === 'caution' ? 'CAUTION' : 'SIT OUT'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--app-text-muted)', lineHeight: 1.5 }}>
                {dayVerdict.reason}
              </span>
            </div>
          )}
          <textarea className="tj-reflect" style={{ minHeight: 80, display:'block' }}
            value={localPre}
            onChange={e => setLocalPre(e.target.value)}
            onBlur={e => update({ pre: e.target.value })}
            placeholder="Game plan, key levels, bias, and conditions you're watching. Write this BEFORE the open."
          />
          <div style={{ display:'flex', gap:12, padding:'10px 14px', borderTop:'1px solid var(--app-border)', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Bias</div>
              <div style={{ display:'flex', gap:3 }}>
                {biasOptions.map(o => (
                  <button key={o.v} type="button" onClick={() => update({ bias: dr.bias === o.v ? null : o.v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.bias===o.v?'var(--amber-border)':'var(--app-border)'}`, background:dr.bias===o.v?'var(--amber-dim)':'transparent', color:dr.bias===o.v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>News Risk</div>
              <div style={{ display:'flex', gap:3 }}>
                {newsOptions.map(o => (
                  <button key={o.v} type="button" onClick={() => update({ newsRisk: dr.newsRisk === o.v ? null : o.v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.newsRisk===o.v?(o.v==='clear'?'var(--green-border)':o.v==='avoid'?'var(--red-border)':'var(--amber-border)'):'var(--app-border)'}`, background:dr.newsRisk===o.v?(o.v==='clear'?'var(--green-dim)':o.v==='avoid'?'var(--red-dim)':'var(--amber-dim)'):'transparent', color:dr.newsRisk===o.v?(o.v==='clear'?'var(--green)':o.v==='avoid'?'var(--red)':'var(--amber)'):'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {/* ── Physical State — collapsible one-liner ── */}
          {(() => {
            const ps = entry.physicalState ?? { sleep: 0, sleepHours: 0, stress: 0, energy: 0, distractions: [], environment: '' };
            const updatePs = (patch: Partial<typeof ps>) => onMutateEntry({ physicalState: { ...ps, ...patch } });
            const summary = [
              ps.sleep > 0 ? `Sleep ${ps.sleep}` : null,
              ps.energy > 0 ? `Energy ${ps.energy}` : null,
              ps.stress > 0 ? `Stress ${ps.stress}` : null,
              ps.environment || null,
            ].filter(Boolean).join(' · ');
            const DISTRACTIONS = ['Phone','Other screen','People','Noise','None'];
            const ENVIRONMENTS = ['Home','Office','Travelling','Unusual environment'];
            const toggleDistraction = (d: string) => {
              let next: string[];
              if (d === 'None') { next = ps.distractions.includes('None') ? [] : ['None']; }
              else { next = ps.distractions.includes(d) ? ps.distractions.filter((x: string) => x !== d) : [...ps.distractions.filter((x: string) => x !== 'None'), d]; }
              updatePs({ distractions: next });
            };
            const pipColor = (score: number, v: number, colorFn: (s: number) => string) =>
              score >= v ? colorFn(score) : 'var(--surface-2)';
            return (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                <button type="button" onClick={() => setShowPhysical(p => !p)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Physical</span>
                  {summary ? (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-2)' }}>{summary}</span>
                  ) : (
                    <span style={{ fontSize: 10, color: 'var(--txt-3)', fontStyle: 'italic' }}>not set</span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--txt-3)' }}>{showPhysical ? <ChevronUp size={11} /> : <ChevronDown size={11} />}</span>
                </button>
                {showPhysical && (
                  <div style={{ padding: '0 14px 12px' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
                      {([
                        { label: 'Sleep', field: 'sleep' as const, colorFn: () => 'var(--cobalt)' },
                        { label: 'Stress', field: 'stress' as const, colorFn: (v: number) => v <= 2 ? 'var(--green)' : v === 3 ? 'var(--amber)' : 'var(--red)' },
                        { label: 'Energy', field: 'energy' as const, colorFn: () => 'var(--green)' },
                      ] as Array<{ label: string; field: 'sleep' | 'stress' | 'energy'; colorFn: (v: number) => string }>).map(({ label, field, colorFn }) => (
                        <div key={field} style={{ minWidth: 70 }}>
                          <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
                          <div style={{ display: 'flex', gap: 3 }}>
                            {[1,2,3,4,5].map(v => (
                              <button key={v} type="button" onClick={() => updatePs({ [field]: v })}
                                style={{ width: 16, height: 5, borderRadius: 2, border: 'none', cursor: 'pointer', background: pipColor(ps[field] as number, v, colorFn) }} />
                            ))}
                          </div>
                        </div>
                      ))}
                      <div>
                        <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Distractions</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {DISTRACTIONS.map(d => {
                            const sel = ps.distractions.includes(d);
                            return (
                              <button key={d} type="button" onClick={() => toggleDistraction(d)}
                                style={{ padding: '2px 6px', fontSize: 9, borderRadius: 2, border: `1px solid ${sel ? (d === 'None' ? 'var(--green-border)' : 'var(--amber-border)') : 'var(--border)'}`, background: sel ? (d === 'None' ? 'var(--green-dim)' : 'var(--amber-dim)') : 'transparent', color: sel ? (d === 'None' ? 'var(--green)' : 'var(--amber)') : 'var(--txt-3)', cursor: 'pointer' }}>
                                {d}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Environment</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {ENVIRONMENTS.map(env => (
                            <button key={env} type="button" onClick={() => updatePs({ environment: ps.environment === env ? '' : env })}
                              style={{ padding: '2px 6px', fontSize: 9, borderRadius: 2, border: `1px solid ${ps.environment === env ? 'var(--amber-border)' : 'var(--border)'}`, background: ps.environment === env ? 'var(--amber-dim)' : 'transparent', color: ps.environment === env ? 'var(--amber)' : 'var(--txt-3)', cursor: 'pointer' }}>
                              {env}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {activeTab === 'post' && (
        <div>
          <textarea className="tj-reflect" style={{ minHeight:80, display:'block' }}
            value={localPost}
            onChange={e => setLocalPost(e.target.value)}
            onBlur={e => update({ post: e.target.value })}
            placeholder="How did the session go vs the plan?"
          />
          <div style={{ display:'flex', gap:12, padding:'10px 14px', borderTop:'1px solid var(--app-border)', flexWrap:'wrap', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Session Grade</div>
              <div style={{ display:'flex', gap:3 }}>
                {GRADES.map(g => (
                  <button key={g} type="button" onClick={() => update({ sessionGrade: dr.sessionGrade === g ? null : g })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.sessionGrade===g?'var(--amber-border)':'var(--app-border)'}`, background:dr.sessionGrade===g?'var(--amber-dim)':'transparent', color:dr.sessionGrade===g?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginLeft:'auto' }}>
              <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Market respected bias?</div>
              <div style={{ display:'flex', gap:3 }}>
                {[true,false].map(v => (
                  <button key={String(v)} type="button" onClick={() => update({ marketRespectedBias: dr.marketRespectedBias === v ? null : v })}
                    style={{ padding:'3px 8px', fontSize:9, borderRadius:4, border:`1px solid ${dr.marketRespectedBias===v?'var(--amber-border)':'var(--app-border)'}`, background:dr.marketRespectedBias===v?'var(--amber-dim)':'transparent', color:dr.marketRespectedBias===v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                    {v ? 'YES' : 'NO'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'lessons' && (
        <div>
          <textarea className="tj-reflect" style={{ minHeight:80, display:'block' }}
            value={localLessons}
            onChange={e => setLocalLessons(e.target.value)}
            onBlur={e => update({ lessons: e.target.value })}
            placeholder="One specific thing to do differently next session. Not 'be more disciplined' — something concrete and actionable."
          />
          <div style={{ padding:'10px 14px', borderTop:'1px solid var(--app-border)' }}>
            <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>Lesson Category</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {LESSON_CATS.map(cat => (
                <button key={cat} type="button" onClick={() => update({ lessonCategory: dr.lessonCategory === cat ? null : cat })}
                  style={{ padding:'3px 8px', fontSize:9, borderRadius:3, border:`1px solid ${dr.lessonCategory===cat?'var(--amber-border)':'var(--app-border)'}`, background:dr.lessonCategory===cat?'var(--amber-dim)':'transparent', color:dr.lessonCategory===cat?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── B — PreEntryBlock ─────────────────────────────────────────────────────────
function PreEntryBlock({ trade, entry, allEntries, onMutate }: {
  trade: JournalTrade;
  entry: JournalEntry;
  allEntries: JournalEntry[];
  onMutate: (fields: Partial<JournalTrade>) => void;
}) {
  const pe = trade.preEntry ?? { confidenceAtEntry:0, emotionalState:'', hesitated:null, hesitationReason:'' };
  const [hesReason, setHesReason] = useState(pe.hesitationReason ?? '');
  useEffect(() => { setHesReason(trade.preEntry?.hesitationReason ?? ''); }, [trade.id]);

  const update = (patch: Partial<typeof pe>) => onMutate({ preEntry: { ...pe, ...patch } });

  // Save hesitation reason on unmount (section collapse)
  const unmountRef = useRef({ hesReason, pe, onMutate });
  unmountRef.current = { hesReason, pe, onMutate };
  useEffect(() => {
    return () => {
      const { hesReason: h, pe: p, onMutate: m } = unmountRef.current;
      if (h !== (p.hesitationReason ?? '')) m({ preEntry: { ...p, hesitationReason: h } });
    };
  }, []);

  const EMOTIONAL_STATES = ['Calm and focused','Slightly anxious','Scared / nervous','Excited / hyped','Frustrated (from earlier trade)','Bored / impatient','Fearful of missing','Revenge-motivated','In the zone','Distracted / not present','Overconfident'];
  const CONF_LABELS = ['','Low / forced','Uncertain','Moderate','Confident','High conviction'];

  const dayTrades = entry.trades;
  const tradeIndex = dayTrades.findIndex(t => t.id === trade.id);
  const tradeNumber = tradeIndex + 1;
  const prevTrades = dayTrades.slice(0, tradeIndex);
  const dailyPnlBefore = prevTrades.reduce((sum, t) => sum + (t.pnl ?? 0) - (t.commission ?? 0), 0);
  const prevWasLoss = tradeIndex > 0 && (dayTrades[tradeIndex-1]?.result === 'loss');
  const isThirdPlus = tradeNumber >= 3;

  const dr = entry.dailyReflection;
  const maxLoss = dr?.sessionTarget ? -Math.abs(dr.sessionTarget) : null;
  const nearLimit = maxLoss !== null && dailyPnlBefore <= maxLoss * 0.8 && dailyPnlBefore < 0;

  // allEntries is available if needed for cross-day context
  void allEntries;

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, overflow:'hidden', marginBottom:8 }}>

      <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--app-border)' }}>
        <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:2 }}>Confidence at Entry</div>
        <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:8 }}>How certain were you this was the right trade?</div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ display:'flex', gap:4 }}>
            {[1,2,3,4,5].map(v => (
              <button key={v} type="button" onClick={() => update({ confidenceAtEntry: v })}
                style={{ width:28, height:6, borderRadius:2, border:'none', cursor:'pointer', background: pe.confidenceAtEntry >= v ? (v <= 2 ? 'var(--red)' : v === 3 ? 'var(--amber)' : 'var(--green)') : 'var(--app-panel-strong)' }} />
            ))}
          </div>
          {pe.confidenceAtEntry > 0 && (
            <span style={{ fontSize:11, fontFamily:'var(--font-mono)', color:'var(--amber)' }}>{CONF_LABELS[pe.confidenceAtEntry]}</span>
          )}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', borderBottom:'1px solid var(--app-border)' }}>
        <div style={{ padding:'12px 14px', borderRight:'1px solid var(--app-border)' }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>Emotional State at Entry</div>
          <select value={pe.emotionalState} onChange={e => update({ emotionalState: e.target.value })}
            style={{ width:'100%', padding:'5px 8px', fontSize:11, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:4, color:'var(--txt)', outline:'none', cursor:'pointer' }}>
            <option value="">Select state...</option>
            {EMOTIONAL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ padding:'12px 14px' }}>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:2 }}>Hesitated at Entry?</div>
          <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:6 }}>Did you delay or second-guess before pressing the button?</div>
          <div style={{ display:'flex', gap:4, marginBottom: pe.hesitated ? 8 : 0 }}>
            {[true,false].map(v => (
              <button key={String(v)} type="button" onClick={() => update({ hesitated: pe.hesitated === v ? null : v })}
                style={{ padding:'3px 10px', fontSize:10, borderRadius:4, border:`1px solid ${pe.hesitated===v?'var(--amber-border)':'var(--app-border)'}`, background:pe.hesitated===v?'var(--amber-dim)':'transparent', color:pe.hesitated===v?'var(--amber)':'var(--app-text-subtle)', cursor:'pointer', fontFamily:'var(--font-sans)', fontWeight:600 }}>
                {v ? 'YES' : 'NO'}
              </button>
            ))}
          </div>
          {pe.hesitated && (
            <textarea value={hesReason} onChange={e => setHesReason(e.target.value)} onBlur={e => update({ hesitationReason: e.target.value })}
              placeholder="What made you hesitate?" style={{ width:'100%', minHeight:40, padding:'6px 8px', fontSize:10, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:4, color:'var(--txt)', outline:'none', resize:'none', boxSizing:'border-box' }} />
          )}
        </div>
      </div>

      <div style={{ padding:'10px 14px', display:'flex', gap:20, alignItems:'center', flexWrap:'wrap' }}>
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em' }}>Trade # Today</div>
          <div style={{ fontSize:13, fontFamily:'var(--font-mono)', color:'var(--app-text)', marginTop:2 }}>{tradeNumber}</div>
        </div>
        <div>
          <div style={{ fontSize:9, color:'var(--app-text-subtle)', textTransform:'uppercase', letterSpacing:'0.07em' }}>Daily P&L Before</div>
          <div style={{ fontSize:13, fontFamily:'var(--font-mono)', color: dailyPnlBefore > 0 ? 'var(--green)' : dailyPnlBefore < 0 ? 'var(--red)' : 'var(--app-text-muted)', marginTop:2 }}>
            {dailyPnlBefore >= 0 ? '+' : ''}{dailyPnlBefore.toFixed(2)}
          </div>
        </div>
        {isThirdPlus && prevWasLoss && (
          <div style={{ padding:'3px 10px', borderRadius:4, background:'var(--amber-dim)', border:'1px solid var(--amber-border)', fontSize:10, color:'var(--amber)', fontFamily:'var(--font-sans)' }}>
            Trade {tradeNumber} after loss — check revenge risk
          </div>
        )}
        {nearLimit && (
          <div style={{ padding:'3px 10px', borderRadius:4, background:'var(--amber-dim)', border:'1px solid var(--amber-border)', fontSize:10, color:'var(--amber)' }}>
            Within ${Math.abs(dailyPnlBefore - (maxLoss ?? 0)).toFixed(0)} of daily limit
          </div>
        )}
      </div>
    </div>
  );
}

// ── E — PsychologyRatingsBlock ────────────────────────────────────────────────
function PsychologyRatingsBlock({ trade, onMutate }: { trade: JournalTrade; onMutate: (f: Partial<JournalTrade>) => void }) {
  const r = trade.psychologyRatings ?? { setupQuality:0, discipline:0, execution:0, patience:0, riskManagement:0, emotionalControl:0, notes:{} };
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  const [noteValues, setNoteValues] = useState<Record<string, string>>(r.notes ?? {});
  useEffect(() => { setNoteValues(trade.psychologyRatings?.notes ?? {}); }, [trade.id]);

  const update = (patch: Partial<typeof r>) => onMutate({ psychologyRatings: { ...r, ...patch } });
  const pipColor = (score: number, v: number) => score >= v ? (score <= 2 ? 'var(--red)' : score === 3 ? 'var(--amber)' : 'var(--green)') : 'var(--app-panel-strong)';

  const CARDS: Array<{ key: keyof Omit<typeof r,'notes'>; label: string; sub: string }> = [
    { key:'setupQuality', label:'Trade Quality', sub:'How clean and high-conviction was this trade?' },
    { key:'discipline', label:'Discipline', sub:'Did you follow your rules completely?' },
    { key:'execution', label:'Execution', sub:'Did you enter and exit as planned?' },
    { key:'patience', label:'Patience', sub:'Did you wait for the right moment?' },
    { key:'riskManagement', label:'Risk Management', sub:'Did you respect sizing and stops?' },
    { key:'emotionalControl', label:'Emotional Control', sub:'Were you in control throughout?' },
  ];

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:8 }}>
      {CARDS.map(card => {
        const score = r[card.key] as number;
        return (
          <div key={card.key} style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'10px 12px' }}>
            <div style={{ fontSize:9, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--app-text-subtle)', marginBottom:2 }}>{card.label}</div>
            <div style={{ fontSize:10, color:'var(--app-text-subtle)', fontStyle:'italic', marginBottom:8 }}>{card.sub}</div>
            <div style={{ display:'flex', gap:3, marginBottom:6 }}>
              {[1,2,3,4,5].map(v => (
                <button key={v} type="button" onClick={() => update({ [card.key]: v })}
                  style={{ flex:1, height:5, borderRadius:2, border:'none', cursor:'pointer', background: pipColor(score, v) }} />
              ))}
            </div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              {score > 0
                ? <span style={{ fontSize:15, fontWeight:500, fontFamily:'var(--font-mono)', color: score<=2?'var(--red)':score===3?'var(--amber)':'var(--green)' }}>{score}</span>
                : <span style={{ fontSize:11, color:'var(--app-text-subtle)', fontStyle:'italic' }}>Not rated</span>
              }
              <button type="button" onClick={() => setNoteOpen(p => ({ ...p, [card.key]: !p[card.key] }))}
                style={{ fontSize:10, color:'var(--app-text-subtle)', background:'none', border:'none', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                {noteValues[card.key] ? '✎ note' : '+ note'}
              </button>
            </div>
            {noteOpen[card.key] && (
              <input type="text" value={noteValues[card.key] ?? ''} onChange={e => setNoteValues(p => ({ ...p, [card.key]: e.target.value }))}
                onBlur={e => { update({ notes: { ...r.notes, [card.key]: e.target.value } }); if (!e.target.value) setNoteOpen(p => ({ ...p, [card.key]: false })); }}
                placeholder="Why this score?"
                style={{ width:'100%', marginTop:6, padding:'3px 6px', fontSize:10, fontFamily:'var(--font-sans)', background:'var(--app-panel-strong)', border:'1px solid var(--app-border)', borderRadius:3, color:'var(--txt)', outline:'none', boxSizing:'border-box' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── F — BehavioralFlagsBlock ──────────────────────────────────────────────────
// ── G — StateOfMindBlock ──────────────────────────────────────────────────────
function StateOfMindBlock({ entry, activeTrade, onMutateEntry, onMutateTrade }: {
  entry: JournalEntry;
  activeTrade: JournalTrade | null;
  onMutateEntry: (f: Partial<JournalEntry>) => void;
  onMutateTrade?: (f: Partial<JournalTrade>) => void;
}) {
  const emotions = entry.emotions;
  const selectedFor = (label: string, _valence: 'positive' | 'caution' | 'negative') =>
    emotions.some(e => e.label === label && e.state !== 'neutral');

  const toggle = (label: string, valence: 'positive' | 'caution' | 'negative') => {
    const nextEmotions: JournalEntry['emotions'] = emotions.map((e) =>
      e.label === label
        ? {
            ...e,
            state: e.state === 'neutral'
              ? (valence === 'positive' ? 'green' : valence === 'caution' ? 'amber' : 'red') as EmotionState
              : 'neutral',
          }
        : e
    );
    onMutateEntry({ emotions: nextEmotions });

    // Keep selected-trade tags in sync as a convenience, but persist day tags as source of truth.
    if (onMutateTrade && activeTrade) {
      const selected = nextEmotions.filter((emotion) => emotion.state !== 'neutral');
      const nextTradeSom = selected.map((emotion) => ({
        label: emotion.label,
        valence: emotion.state === 'green' ? 'positive' as const : emotion.state === 'amber' ? 'caution' as const : 'negative' as const,
      }));
      onMutateTrade({ stateOfMind: nextTradeSom });
    }
  };

  const groups: Array<{ key: 'positive'|'caution'|'negative'; color: string; bg: string; border: string }> = [
    { key:'positive', color:'var(--green)', bg:'var(--green-dim)', border:'var(--green-border)' },
    { key:'caution',  color:'var(--amber)', bg:'var(--amber-dim)', border:'var(--amber-border)' },
    { key:'negative', color:'var(--red)',   bg:'var(--red-dim)',   border:'var(--red-border)' },
  ];

  return (
    <div style={{ background:'var(--app-panel)', border:'1px solid var(--app-border)', borderRadius:6, padding:'12px 14px', marginBottom:8 }}>
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {groups.map((g, gi) => (
          <div key={g.key}>
            {gi > 0 && <div style={{ height:1, background:'var(--app-border)', marginBottom:10 }} />}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
              {STATE_OF_MIND_TAGS[g.key].map(label => {
                const sel = selectedFor(label, g.key);
                return (
                  <button key={label} type="button" onClick={() => toggle(label, g.key)}
                    style={{ padding:'3px 8px', fontSize:10, borderRadius:3, border:`1px solid ${sel?g.border:'var(--app-border)'}`, background:sel?g.bg:'transparent', color:sel?g.color:'var(--app-text-muted)', cursor:'pointer', fontFamily:'var(--font-sans)' }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ── I — ProcessScoreBlock ─────────────────────────────────────────────────────
function ProcessScoreBlock({ trade, entries, navigate, onSaveEntries }: { trade: JournalTrade; entries: JournalEntry[]; navigate: (path: string) => void; onSaveEntries: () => void }) {
  const score = computeProcessScore(trade);
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B+' : score >= 60 ? 'B' : score >= 50 ? 'C+' : 'C';
  const scoreColor = score >= 70 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--red)';
  const flags = trade.behavioralFlags ?? [];

  const allTrades = entries.flatMap(e => e.trades);
  const wins = allTrades.filter(t => t.result === 'win' && (t.processScore ?? computeProcessScore(t)) > 0);
  const losses = allTrades.filter(t => t.result === 'loss' && (t.processScore ?? computeProcessScore(t)) > 0);
  const avgWinScore = wins.length ? Math.round(wins.reduce((s, t) => s + (t.processScore ?? computeProcessScore(t)), 0) / wins.length) : null;
  const avgLossScore = losses.length ? Math.round(losses.reduce((s, t) => s + (t.processScore ?? computeProcessScore(t)), 0) / losses.length) : null;

  const insights: Array<{ text: string; color: string }> = [];
  if (flags.length > 0) insights.push({ text: `${flags.length} behavioral flag${flags.length > 1 ? 's' : ''} reduced your score by ${Math.min(flags.length * 8, 40)} pts`, color: 'var(--red)' });
  if (avgWinScore !== null && avgLossScore !== null) insights.push({ text: `Avg score: wins ${avgWinScore} vs losses ${avgLossScore}`, color: 'var(--txt-2)' });
  const conf = trade.preEntry?.confidenceAtEntry ?? 0;
  const disc = trade.psychologyRatings?.discipline ?? 0;
  if (conf >= 4 && disc <= 2) insights.push({ text: 'High confidence, low discipline — review sizing', color: 'var(--amber)' });
  if (insights.length === 0 && score === 0) insights.push({ text: 'Rate psychology + flag behaviors to generate a score', color: 'var(--txt-3)' });

  const RING = 48;
  const R = 19;
  const circ = 2 * Math.PI * R;
  const offset = circ * (1 - (score > 0 ? score : 0) / 100);

  return (
    <div style={{ background: 'var(--app-panel)', border: `1px solid ${score > 0 && score < 50 ? 'var(--red-border, rgba(239,68,68,0.25))' : 'var(--border)'}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
      {/* Compact horizontal card */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        {/* 48px ring */}
        <div style={{ position: 'relative', width: RING, height: RING, flexShrink: 0 }}>
          <svg width={RING} height={RING} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={RING/2} cy={RING/2} r={R} fill="none" stroke="var(--surface-2)" strokeWidth={4} />
            {score > 0 && (
              <circle cx={RING/2} cy={RING/2} r={R} fill="none" stroke={scoreColor} strokeWidth={4}
                strokeDasharray={`${circ} ${circ}`} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.4s ease' }} />
            )}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: score > 0 ? scoreColor : 'var(--txt-3)', lineHeight: 1 }}>{score > 0 ? score : '—'}</span>
          </div>
        </div>
        {/* Title + insights */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Process Score</span>
            {score > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: scoreColor }}>{grade}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {insights.slice(0, 2).map((ins, i) => (
              <span key={i} style={{ fontSize: 11, color: ins.color, lineHeight: 1.4 }}>{ins.text}</span>
            ))}
          </div>
        </div>
      </div>
      {/* AI button */}
      <button type="button" onClick={() => { onSaveEntries(); navigate(`/flyxa-ai/ask?tradeId=${trade.id}`); }}
        style={{ width: '100%', padding: 11, fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)', background: 'var(--amber)', color: '#000', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxSizing: 'border-box' }}>
        <Sparkles size={13} />
        Analyse this trade with Flyxa AI
      </button>
    </div>
  );
}


function TradeJournalCard({
  trade, entry, allEntries, onMutate, onMutateEntry,
}: {
  trade: JournalTrade;
  entry: JournalEntry;
  allEntries: JournalEntry[];
  onMutate: (f: Partial<JournalTrade>) => void;
  onMutateEntry: (f: Partial<JournalEntry>) => void;
}) {
  const [showPsychDetail, setShowPsychDetail] = useState(false);
  const [showFlagPopover, setShowFlagPopover] = useState(false);
  // Viewport-fixed placement so ancestor overflow clipping can't cut the list off.
  const [flagPopoverPos, setFlagPopoverPos] = useState<{ left: number; top: number; maxHeight: number; openUp: boolean }>({ left: 0, top: 0, maxHeight: 320, openUp: false });

  // ── Thesis / Invalidation ────────────────────────────────────
  const th = trade.thesis ?? { setup: '', invalidation: '', asymmetry: '', setupType: '' };
  const [localThesis, setLocalThesis] = useState({ setup: th.setup ?? '', invalidation: th.invalidation ?? '' });
  const { confluenceOptions } = useAppSettings();
  const [confluenceDraft, setConfluenceDraft] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  useEffect(() => {
    setLocalThesis({ setup: trade.thesis?.setup ?? '', invalidation: trade.thesis?.invalidation ?? '' });
    setConfluenceDraft('');
    setSuggestionIndex(-1);
  }, [trade.id]);

  const commitThesis = (field: 'setup' | 'invalidation', value: string) =>
    onMutate({ thesis: { ...th, [field]: value } });

  // ── Confluences ───────────────────────────────────────────────
  const confluences = normalizeConfluences(trade.confluences);
  const setConfluences = (next: string[]) => onMutate({ confluences: normalizeConfluences(next) });
  const suggestions = confluenceDraft.trim().length > 0
    ? confluenceOptions.filter(opt =>
        opt.toLowerCase().includes(confluenceDraft.toLowerCase()) &&
        !confluences.some(c => normalizeConfluenceKey(c) === normalizeConfluenceKey(opt))
      )
    : [];
  const addConfluence = () => {
    const next = (suggestionIndex >= 0 && suggestions[suggestionIndex]) ? suggestions[suggestionIndex] : confluenceDraft.trim();
    if (!next) return;
    setConfluences([...confluences, next]);
    setConfluenceDraft(''); setSuggestionIndex(-1);
  };

  // ── Behavioral flags ─────────────────────────────────────────
  const flags = trade.behavioralFlags ?? [];
  const toggleFlag = (id: string) => {
    const next = flags.includes(id) ? flags.filter(f => f !== id) : [...flags, id];
    onMutate({ behavioralFlags: next });
  };
  const checkedFlags = ALL_BEHAVIORAL_FLAGS.filter(f => flags.includes(f.id));

  // ── Psychology inline ─────────────────────────────────────────
  const r = trade.psychologyRatings ?? { setupQuality: 0, discipline: 0, execution: 0, patience: 0, riskManagement: 0, emotionalControl: 0, notes: {} };
  const psychKeys: Array<{ key: keyof Omit<typeof r, 'notes'>; label: string }> = [
    { key: 'discipline', label: 'Discipline' },
    { key: 'execution', label: 'Execution' },
    { key: 'riskManagement', label: 'Risk' },
    { key: 'emotionalControl', label: 'Control' },
  ];

  // ── State of mind (from entry) ────────────────────────────────
  const emotions = entry.emotions;
  const activeEmotions = emotions.filter(e => e.state !== 'neutral');
  const somColor = (state: string) => state === 'green' ? 'var(--green)' : state === 'amber' ? 'var(--amber)' : 'var(--red)';
  const somBorder = (state: string) => state === 'green' ? 'var(--green-border)' : state === 'amber' ? 'var(--amber-border)' : 'var(--red-border)';
  const somBg = (state: string) => state === 'green' ? 'var(--green-dim)' : state === 'amber' ? 'var(--amber-dim)' : 'var(--red-dim)';

  // Save thesis on unmount
  const unmountRef = useRef({ localThesis, th, onMutate });
  unmountRef.current = { localThesis, th, onMutate };
  useEffect(() => {
    return () => {
      const { localThesis: l, th: t, onMutate: m } = unmountRef.current;
      if (l.setup !== t.setup || l.invalidation !== t.invalidation) {
        m({ thesis: { ...t, setup: l.setup, invalidation: l.invalidation } });
      }
    };
  }, []);

  const THESIS_COLS = [
    { key: 'setup' as const, title: 'Trade Thesis', placeholder: 'What edge did you see? Why this level, this direction, right now?' },
    { key: 'invalidation' as const, title: 'Invalidation', placeholder: 'If price does X, the trade is invalid and I should be out.' },
  ];

  return (
    <div style={{ background: 'var(--app-panel)', border: '1px solid var(--border)', borderRadius: 7, overflow: 'visible', marginBottom: 8 }}>
      {/* ── Row 1: Thesis + Invalidation ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid var(--border)' }}>
        {THESIS_COLS.map((col, i) => (
          <div key={col.key} style={{ borderRight: i < 1 ? '1px solid var(--border)' : undefined }}>
            <div style={{ padding: '7px 12px 5px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--txt-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{col.title}</span>
            </div>
            <textarea
              value={localThesis[col.key]}
              onChange={e => setLocalThesis(p => ({ ...p, [col.key]: e.target.value }))}
              onBlur={e => commitThesis(col.key, e.target.value)}
              placeholder={col.placeholder}
              className="tj-reflect"
              style={{ minHeight: 64, fontSize: 12, padding: '8px 12px', display: 'block' }}
            />
          </div>
        ))}
      </div>

      {/* ── Row 2: Confluence chips ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {confluences.map((item, idx) => (
            <button
              key={`${item}-${idx}`}
              type="button"
              onClick={() => setConfluences(confluences.filter((_, i) => i !== idx))}
              title="Remove"
              style={{ padding: '3px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-2)', cursor: 'pointer' }}
            >
              {item} ×
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <input
              value={confluenceDraft}
              onChange={e => { setConfluenceDraft(e.target.value); setSuggestionIndex(-1); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); addConfluence(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIndex(i => Math.max(i - 1, -1)); }
                else if (e.key === 'Escape') { setSuggestionIndex(-1); setConfluenceDraft(''); }
              }}
              onBlur={() => { if (confluenceDraft.trim()) addConfluence(); }}
              placeholder="+ add confluence"
              style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--txt-2)', outline: 'none', width: 140 }}
            />
            {suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, zIndex: 300, background: 'var(--app-panel-strong)', border: '1px solid var(--border)', borderRadius: 4, boxShadow: '0 4px 14px rgba(0,0,0,0.35)', minWidth: 200, maxHeight: 160, overflowY: 'auto' }}>
                {suggestions.map((opt, i) => (
                  <button key={opt} type="button" onMouseDown={e => { e.preventDefault(); setConfluences([...confluences, opt]); setConfluenceDraft(''); setSuggestionIndex(-1); }} onMouseEnter={() => setSuggestionIndex(i)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', fontSize: 11, background: i === suggestionIndex ? 'var(--cobalt-dim)' : 'transparent', color: i === suggestionIndex ? '#8ab6ff' : 'var(--txt-2)', border: 'none', cursor: 'pointer' }}>
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 3: Behavioral flag chips ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {checkedFlags.map(f => (
            <button key={f.id} type="button" onClick={() => toggleFlag(f.id)} title="Remove flag"
              style={{ padding: '3px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--red-border)', background: 'var(--red-dim)', color: 'var(--red)', cursor: 'pointer' }}>
              {f.label} ×
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <button type="button"
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                const roomBelow = window.innerHeight - rect.bottom - 12;
                const openUp = roomBelow < 260 && rect.top > roomBelow;
                setFlagPopoverPos({
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)),
                  top: openUp ? rect.top - 4 : rect.bottom + 4,
                  maxHeight: Math.max(140, Math.min(320, (openUp ? rect.top : roomBelow) - 8)),
                  openUp,
                });
                setShowFlagPopover(p => !p);
              }}
              style={{ padding: '3px 8px', fontSize: 10, borderRadius: 4, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--txt-3)', cursor: 'pointer' }}>
              + add flag
            </button>
            {showFlagPopover && (
              <div style={{ position: 'fixed', left: flagPopoverPos.left, top: flagPopoverPos.top, transform: flagPopoverPos.openUp ? 'translateY(-100%)' : 'none', zIndex: 1500, background: 'var(--app-panel-strong)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.45)', minWidth: 260, maxHeight: flagPopoverPos.maxHeight, overflowY: 'auto', padding: 8 }}
                onMouseLeave={() => setShowFlagPopover(false)}>
                {ALL_BEHAVIORAL_FLAGS.map(f => {
                  const checked = flags.includes(f.id);
                  return (
                    <button key={f.id} type="button" onClick={() => { toggleFlag(f.id); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', fontSize: 11, background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer', color: checked ? 'var(--red)' : 'var(--txt-2)' }}>
                      <span style={{ width: 12, height: 12, borderRadius: 2, border: `1px solid ${checked ? 'var(--red-border)' : 'var(--border)'}`, background: checked ? 'var(--red-dim)' : 'transparent', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        {checked && <span style={{ fontSize: 8, color: 'var(--red)', lineHeight: 1 }}>✕</span>}
                      </span>
                      {f.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Row 4: Psychology inline ── */}
      <div style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {psychKeys.map(({ key, label }) => {
            const score = r[key] as number;
            return (
              <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--txt-3)' }}>{label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: score === 0 ? 'var(--txt-3)' : score <= 2 ? 'var(--red)' : score === 3 ? 'var(--amber)' : 'var(--green)' }}>
                  {score === 0 ? '—' : score}
                </span>
              </span>
            );
          })}
          {activeEmotions.slice(0, 2).map(e => (
            <span key={e.label} style={{ padding: '2px 6px', fontSize: 9, borderRadius: 3, border: `1px solid ${somBorder(e.state)}`, background: somBg(e.state), color: somColor(e.state) }}>
              {e.label}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => setShowPsychDetail(p => !p)}
            style={{ fontSize: 10, color: 'var(--cobalt)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Detail {showPsychDetail ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>
        {showPsychDetail && (
          <div style={{ marginTop: 10 }}>
            <PsychologyRatingsBlock trade={trade} onMutate={onMutate} />
            <StateOfMindBlock entry={entry} activeTrade={trade} onMutateEntry={onMutateEntry} onMutateTrade={onMutate} />
            <PreEntryBlock trade={trade} entry={entry} allEntries={allEntries} onMutate={onMutate} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function TradeJournal() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { preferences, accounts, getDefaultTradeAccountId } = useAppSettings();
  const { user } = useAuth();
  const { deleteTrade: deleteTradeEverywhere, createTrade } = useTrades();
  const persistedEntries = useFlyxaStore(state => state.entries);
  const riskRules = useFlyxaStore(state => state.riskRules);
  const setEntriesInStore = useFlyxaStore(state => state.setEntries);
  const deleteEntryInStore = useFlyxaStore(state => state.deleteEntry);
  const rulesTemplate = useMemo(() => getRulesTemplate(riskRules), [riskRules]);
  const entries = useMemo(() => normalizeEntries(persistedEntries, rulesTemplate), [persistedEntries, rulesTemplate]);

  const recentForm = useMemo(() => computeRecentForm(entries), [entries]);

  const [monthCursor, setMonthCursor] = useState(() => {
    const today = parseDate(getTodayIso(preferences.timezone));
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [dayFilter, setDayFilter] = useState<DayFilter>('all');
  const [query, setQuery] = useState('');
  const [activeTradeId, setActiveTradeId] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(true);
  // Optimistic ref: holds a just-created blank entry until the Zustand store
  // propagates it, preventing a render where selectedEntry is briefly null.
  const optimisticEntryRef = useRef<JournalEntry | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // Extension bridge effects are declared after handleScanFile (see below).
  const [scanError, setScanError] = useState('');
  const [scanPreviewUrl, setScanPreviewUrl] = useState('');
  const [deleteTradeId, setDeleteTradeId] = useState<string | null>(null);
  const [selectedTradeIds, setSelectedTradeIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [deleteEntryConfirm, setDeleteEntryConfirm] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [isScreenshotFullscreen, setIsScreenshotFullscreen] = useState(false);
  const [isTradeDateEditorOpen, setIsTradeDateEditorOpen] = useState(false);
  const [tradeDateDraft, setTradeDateDraft] = useState(getTodayIso(preferences.timezone));
  const [isEntryDateEditorOpen, setIsEntryDateEditorOpen] = useState(false);
  const [entryDateDraft, setEntryDateDraft] = useState(getTodayIso(preferences.timezone));
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [expandedTradeId, setExpandedTradeId] = useState<string | null>(null);
  // Reset expanded row when the selected day changes
  useEffect(() => { setExpandedTradeId(null); }, [selectedEntryId]);

  // Collapsible section state — persisted to localStorage
  const COLLAPSE_KEY = 'flyxa-journal-sections';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}'); } catch { return {}; }
  });
  const toggleSection = (key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const screenshotInputRef = useRef<HTMLInputElement>(null);
  const screenshotSlotRef = useRef<number | null>(null);
  const supportingImageInputRef = useRef<HTMLInputElement>(null);

  const [viewingImageIndex, setViewingImageIndex] = useState(0);
  const [slideDir, setSlideDir] = useState<'left' | 'right'>('right');

  const mutateEntries = useCallback((updater: (prev: JournalEntry[]) => JournalEntry[]) => {
    applyEntriesMutation(updater, rulesTemplate, setEntriesInStore);
  }, [rulesTemplate, setEntriesInStore]);

  const handleCSVImport = useCallback(
    (trades: Parameters<typeof importTradesFromCsv>[0]) => importTradesFromCsv(trades, createTrade),
    [createTrade],
  );

  const mutateTradeFields = useCallback((tradeId: string, fields: Partial<JournalTrade>) => {
    if (!selectedEntryId) return;
    mutateEntries(prev => prev.map(entry => {
      if (entry.id !== selectedEntryId) return entry;
      return {
        ...entry,
        trades: entry.trades.map(trade => {
          if (trade.id !== tradeId) return trade;
          // Dev eval flywheel: the first manual correction of an AI-scanned
          // trade's price levels is ground truth the scanner got wrong.
          if (trade.priceLevelsSource === 'ai' && !trade.priceLevelsEdited && fields.priceLevelsEdited === true) {
            maybeCaptureCorrection({
              tradeId: trade.id,
              symbol: trade.symbol,
              date: trade.date ?? '',
              screenshotUrl: trade.screenshotUrl,
              before: { entry: trade.entry, sl: trade.sl, tp: trade.tp, exit: trade.exit, direction: trade.direction, entryTime: trade.entryTime },
              after: { entry: fields.entry, sl: fields.sl, tp: fields.tp, exit: fields.exit },
            });
          }
          const nextFields = { ...fields };
          if (typeof fields.contracts === 'number' && fields.contracts !== trade.contracts) {
            nextFields.pnlOverride = scaleContractAmount(trade.pnlOverride, trade.contracts, fields.contracts);
            nextFields.commission = scaleContractAmount(trade.commission, trade.contracts, fields.contracts);
          }
          return withTradeDerivedValues({ ...trade, ...nextFields });
        }),
      };
    }));
  }, [mutateEntries, selectedEntryId]);

  // Helper: a "phantom" trade has no meaningful data — it was created by clicking
  // "Add trade" but never filled in. We identify it by the combination of:
  //   result === 'open', pnl === 0, entryPrice === 0, exitPrice === 0, no screenshot.
  const isPhantomTrade = useCallback((t: JournalTrade) =>
    t.result === 'open' && t.pnl === 0 && t.entryPrice === 0 && t.exitPrice === 0 && !t.screenshotUrl,
  []);

  // One-time mount cleanup: remove phantom trades that were accidentally persisted
  // in previous sessions (before setActiveTradeId was called after addManualTrade).
  const phantomCleanupDone = useRef(false);
  useEffect(() => {
    if (phantomCleanupDone.current) return;
    phantomCleanupDone.current = true;
    mutateEntries(prev => {
      const next = prev.map(entry => ({
        ...entry,
        trades: entry.trades.filter(t => !isPhantomTrade(t)),
      }));
      const changed = next.some((e, i) => e.trades.length !== prev[i]?.trades.length);
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Entry-leave cleanup: when the user navigates to a different entry, strip any
  // unfilled blank trades from the entry they just left so they don't accumulate.
  const prevSelectedEntryIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevSelectedEntryIdRef.current;
    prevSelectedEntryIdRef.current = selectedEntryId;
    if (!prevId || prevId === selectedEntryId) return;
    mutateEntries(prev => {
      const entry = prev.find(e => e.id === prevId);
      if (!entry) return prev;
      const cleanedTrades = entry.trades.filter(t => !isPhantomTrade(t));
      if (cleanedTrades.length === entry.trades.length) return prev;
      return prev.map(e => e.id === prevId ? { ...e, trades: cleanedTrades } : e);
    });
  }, [selectedEntryId, mutateEntries, isPhantomTrade]);

  useEffect(() => {
    if (!entries.length) {
      setSelectedEntryId(null);
      return;
    }
    if (!selectedEntryId || !entries.some(entry => entry.id === selectedEntryId)) {
      const mostRecent = [...entries].sort((a, b) => b.date.localeCompare(a.date))[0];
      setSelectedEntryId(mostRecent.id);
    }
  }, [entries, selectedEntryId]);

  useEffect(() => {
    const date = params.get('date');
    const tradeId = params.get('tradeId');
    if (!date) return;
    const targetEntry = entries.find(entry => entry.date === date);
    if (!targetEntry) return;
    setSelectedEntryId(targetEntry.id);
    if (tradeId) setActiveTradeId(tradeId);
    setShowScanner(false);
  }, [entries, params]);

  useEffect(() => {
    const currentSelected = entries.find(entry => entry.id === selectedEntryId) ?? null;
    if (!currentSelected || !currentSelected.trades.length) {
      setActiveTradeId(null);
      return;
    }
    if (!activeTradeId || !currentSelected.trades.some(trade => trade.id === activeTradeId)) {
      setActiveTradeId(currentSelected.trades[0].id);
    }
  }, [activeTradeId, entries, selectedEntryId]);

  const entriesInMonth = useMemo(
    () => entries.filter(entry => inMonth(entry.date, monthCursor)),
    [entries, monthCursor],
  );

  const tradedEntriesInMonth = useMemo(
    () => entriesInMonth.filter(entry => entry.trades.length > 0),
    [entriesInMonth],
  );

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entriesInMonth
      .filter(entry => {
        const stats = computeEntryStats(entry);
        // Win/loss/untagged filters only apply to days with trades
        if (entry.trades.length > 0) {
          if (dayFilter === 'win' && stats.pnl <= 0) return false;
          if (dayFilter === 'loss' && stats.pnl >= 0) return false;
          if (dayFilter === 'untagged' && entry.emotions.some(emotion => emotion.state !== 'neutral')) return false;
        } else if (dayFilter !== 'all') {
          // Blank days are hidden when a specific filter is active
          return false;
        }
        if (!needle) return true;
        const symbolMatch = entry.trades.some(trade => trade.symbol.toLowerCase().includes(needle));
        const noteMatch = `${entry.reflection.pre} ${entry.reflection.post} ${entry.reflection.lessons}`.toLowerCase().includes(needle);
        return symbolMatch || noteMatch;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [dayFilter, entriesInMonth, query]);

  const selectedEntry = useMemo(() => {
    const fromStore = entries.find(entry => entry.id === selectedEntryId) ?? null;
    if (fromStore) {
      optimisticEntryRef.current = null; // store has caught up — clear optimistic
      return fromStore;
    }
    // Fallback: if we just created this entry optimistically, use it until the
    // Zustand store propagates (prevents ScannerDropZone re-appearing for one render).
    if (optimisticEntryRef.current?.id === selectedEntryId) {
      return optimisticEntryRef.current;
    }
    return null;
  }, [entries, selectedEntryId]);

  const activeTrade = useMemo(() => {
    if (!selectedEntry || !selectedEntry.trades.length) return null;
    return selectedEntry.trades.find(trade => trade.id === activeTradeId) ?? selectedEntry.trades[0];
  }, [activeTradeId, selectedEntry]);

  useEffect(() => {
    if (!selectedEntry || !activeTrade) return;
    setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
    setIsTradeDateEditorOpen(false);
  }, [activeTrade?.id, selectedEntry?.id, selectedEntry?.date]);

  useEffect(() => {
    if (!selectedEntry) return;
    setEntryDateDraft(selectedEntry.date);
    setIsEntryDateEditorOpen(false);
  }, [selectedEntry?.id]);

  const monthSummary = useMemo(() => {
    const dayPnL = tradedEntriesInMonth.map(entry => computeEntryStats(entry).pnl);
    const monthPnl = dayPnL.reduce((sum, pnl) => sum + pnl, 0);
    const daysTraded = tradedEntriesInMonth.length;
    let wins = 0;
    let losses = 0;
    tradedEntriesInMonth.forEach(entry => {
      const stats = computeEntryStats(entry);
      wins += stats.wins;
      losses += stats.losses;
    });
    const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
    const bestDay = findBestDay(tradedEntriesInMonth);
    return { monthPnl, daysTraded, winRate, bestDay };
  }, [tradedEntriesInMonth]);

  // Pre-compute per-entry adherence for the visible list so the render stays O(1) per card.
  const entryAdherenceMap = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const entry of visibleEntries) {
      if (entry.trades.length === 0) continue;
      const s = summarizeRuleEvaluations(
        evaluateEntryRules(entry as unknown as StoreJournalEntry, riskRules)
      );
      map.set(entry.id, s.pct);
    }
    return map;
  }, [visibleEntries, riskRules]);

  const addBlankDay = useCallback(() => {
    // Always create for today — never inherit the currently-viewed entry's date
    const date = getTodayIso(preferences.timezone);
    const parsedDate = parseDate(date);
    const targetMonth = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), 1);

    const existing = entries.find(entry => entry.date === date);
    if (existing) {
      // Day already exists — just select it; don't inject a phantom trade
      optimisticEntryRef.current = existing;
      setSelectedEntryId(existing.id);
      setMonthCursor(targetMonth);
      setShowScanner(false);
      return;
    }

    const blank = createEmptyEntry(date, rulesTemplate, getDefaultTradeAccountId(), true);
    // No phantom trade — blank days start empty. User adds trades via "Add trade".
    optimisticEntryRef.current = blank;
    mutateEntries(prev => [blank, ...prev]);
    setSelectedEntryId(blank.id);
    setMonthCursor(targetMonth);
    setShowScanner(false);
  }, [entries, getDefaultTradeAccountId, mutateEntries, preferences.timezone, rulesTemplate, setMonthCursor]);

  const saveTradeDate = useCallback(() => {
    performSaveTradeDate({ selectedEntry, activeTrade, tradeDateDraft, preferences, rulesTemplate, getDefaultTradeAccountId, mutateEntries, setSelectedEntryId, setActiveTradeId, setMonthCursor, setIsTradeDateEditorOpen });
  }, [activeTrade, getDefaultTradeAccountId, mutateEntries, rulesTemplate, selectedEntry, tradeDateDraft]);

  const saveEntryDate = useCallback(() => {
    if (!selectedEntry || activeTrade) return;
    const nextDate = entryDateDraft;
    if (!nextDate || nextDate === selectedEntry.date) { setIsEntryDateEditorOpen(false); return; }
    const collision = entries.find(e => e.date === nextDate && e.id !== selectedEntry.id);
    if (collision) {
      pushToast({ tone: 'red', durationMs: 4000, message: 'An entry already exists for that date.' });
      return;
    }
    mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, date: nextDate } : e));
    setIsEntryDateEditorOpen(false);
    pushToast({ tone: 'green', durationMs: 3000, message: 'Date updated.' });
  }, [activeTrade, entries, entryDateDraft, mutateEntries, selectedEntry]);

  const goToScanner = useCallback(() => {
    setShowScanner(true);
    navigate('/scanner');
  }, [navigate]);

  const addManualTrade = useCallback(() => {
    if (!selectedEntry) return;
    const entryAccount = accounts.find(a => a.id === selectedEntry.account);
    if (entryAccount?.status === 'Passed') return;
    const basePrice = 0;
    const newTrade: JournalTrade = {
      id: crypto.randomUUID(),
      date: selectedEntry.date,
      symbol: 'NQ',
      direction: 'LONG',
      entryTime: getNowTime(),
      exitTime: getNowTime(),
      durationMinutes: null,
      entryPrice: basePrice,
      exitPrice: basePrice,
      entry: undefined,
      exit: undefined,
      priceLevelsSource: 'manual',
      priceLevelsEdited: false,
      contracts: 1,
      rr: 0,
      pnl: 0,
      result: 'open',
      confluences: [],
    };
    mutateEntries(prev => prev.map(entry => entry.id === selectedEntry.id ? { ...entry, trades: [withTradeDerivedValues(newTrade), ...entry.trades] } : entry));
    setActiveTradeId(newTrade.id);
  }, [accounts, mutateEntries, selectedEntry]);

  const applyScannedTrade = useCallback((fileDataUrl: string, trade: JournalTrade, date: string) => {
    performApplyScannedTrade(fileDataUrl, trade, date, { mutateEntries, selectedEntryId, rulesTemplate, getDefaultTradeAccountId, setSelectedEntryId, setMonthCursor, setActiveTradeId });
  }, [getDefaultTradeAccountId, mutateEntries, rulesTemplate, selectedEntryId, setMonthCursor]);

  const handleScanFile = useCallback(async (file: File) => {
    await performScanFile(file, { preferences, user, getDefaultTradeAccountId, applyScannedTrade, setScanError, setIsScanning, setScanPreviewUrl });
  }, [applyScannedTrade, getDefaultTradeAccountId, preferences.scannerColors, selectedEntry?.date]);

  // ── Browser extension bridge ─────────────────────────────────────────────────
  // Ref always tracks the latest handleScanFile so the mount effect below never
  // holds a stale closure regardless of when deps change after first mount.
  const _extScanRef = useRef(handleScanFile);
  useEffect(() => { _extScanRef.current = handleScanFile; });

  // On mount: consume a file that App.tsx stored before we navigated here
  // (window.__flyxaPendingFile). Also listen for the event for the
  // already-mounted case where App.tsx fires flyxa:scan_ready immediately.
  useEffect(() => {
    const pending = (window as unknown as Record<string, unknown>).__flyxaPendingFile;
    if (pending instanceof File) {
      delete (window as unknown as Record<string, unknown>).__flyxaPendingFile;
      void _extScanRef.current(pending);
    }
    const handler = (e: Event) => {
      const file = (e as CustomEvent<{ file: File }>).detail?.file;
      if (!(file instanceof File)) return;
      // Clear the pending file so a subsequent mount can't trigger a second scan
      delete (window as unknown as Record<string, unknown>).__flyxaPendingFile;
      void _extScanRef.current(file);
    };
    window.addEventListener('flyxa:scan_ready', handler);
    return () => window.removeEventListener('flyxa:scan_ready', handler);
  }, []);

  const deleteEntry = useCallback(async () => {
    if (!selectedEntry) return;
    const entryDate = selectedEntry.date;
    const entriesForDate = useFlyxaStore.getState().entries.filter(entry => entry.date === entryDate);
    const tradeIds = entriesForDate.flatMap(entry => entry.trades.map(trade => trade.id));
    setDeleteEntryConfirm(false);
    entriesForDate.forEach(entry => deleteEntryInStore(entry.id));
    const localStateSnapshot = JSON.parse(
      JSON.stringify(useFlyxaStore.getState())
    ) as Record<string, unknown>;

    try {
      await deleteTradingDayEverywhere(entryDate, tradeIds, localStateSnapshot);
      setSelectedEntryId(null);
      setActiveTradeId(null);
      pushToast({ tone: 'green', durationMs: 2500, message: 'Trading day deleted' });
    } catch (error) {
      console.error(error);
      pushToast({
        tone: 'red',
        durationMs: 4500,
        message: 'The day was removed locally, but cloud deletion did not finish. Please retry.',
      });
    }
  }, [deleteEntryInStore, selectedEntry]);

  const onShotPick = useCallback((index: number) => {
    screenshotSlotRef.current = index;
    screenshotInputRef.current?.click();
  }, []);

  const onShotFile = useCallback(async (file: File) => {
    if (!selectedEntry) return;
    const slot = screenshotSlotRef.current;
    if (slot === null) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('Could not read screenshot.'));
      reader.readAsDataURL(file);
    });
    const url = user ? await uploadScreenshot(dataUrl, user.id) : dataUrl;
    const currentTradeId = activeTradeId;
    mutateEntries(prev => prev.map(entry => {
      if (entry.id !== selectedEntry.id) return entry;
      const nextScreenshots = [...entry.screenshots];
      nextScreenshots[slot] = url;
      const nextTrades = entry.trades.map(t =>
        t.id === currentTradeId ? { ...t, screenshotUrl: url } : t
      );
      return { ...entry, screenshots: nextScreenshots, trades: nextTrades };
    }));
    screenshotSlotRef.current = null;
  }, [activeTradeId, mutateEntries, selectedEntry, user]);

  const onSupportingImageFile = useCallback(async (file: File) => {
    if (!activeTrade || !selectedEntry) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('Could not read image.'));
      reader.readAsDataURL(file);
    });
    const url = user ? await uploadScreenshot(dataUrl, user.id) : dataUrl;
    mutateTradeFields(activeTrade.id, {
      supportingImages: [...(activeTrade.supportingImages ?? []), url],
    });
    // navigate to the newly added image
    setViewingImageIndex((activeTrade.supportingImages?.length ?? 0) + 1);
  }, [activeTrade, mutateTradeFields, selectedEntry, user]);

  // Reset image carousel when switching trades
  useEffect(() => {
    setViewingImageIndex(0);
  }, [activeTradeId]);

  // On trade days: prefer the active trade's screenshot, then the first entry slot, then the scanner image.
  // On blank days: show manually-uploaded screenshots (entry.screenshots) but NOT the scanner image,
  // which could be a "no trades found" scan that shouldn't appear on intentional no-trade days.
  const primaryScreenshot = (() => {
    if (!selectedEntry) return '';
    if (selectedEntry.trades.length > 0) {
      return activeTrade?.screenshotUrl || selectedEntry.screenshots[0] || selectedEntry.scannedImageUrl || '';
    }
    return selectedEntry.screenshots.find(s => typeof s === 'string' && s.trim()) ?? '';
  })();

  const allTradeImages = [
    ...(primaryScreenshot ? [primaryScreenshot] : []),
    ...(activeTrade?.supportingImages ?? []),
  ];
  const clampedIndex = Math.min(viewingImageIndex, Math.max(0, allTradeImages.length - 1));
  const currentImage = allTradeImages[clampedIndex] ?? '';
  const hasExistingImages = !!(selectedEntry && (
    selectedEntry.scannedImageUrl ||
    selectedEntry.screenshots?.some(s => typeof s === 'string' && s.trim())
  ));

  function navImage(dir: 'left' | 'right') {
    setSlideDir(dir);
    setViewingImageIndex(i =>
      dir === 'right' ? Math.min(i + 1, allTradeImages.length - 1) : Math.max(i - 1, 0),
    );
  }

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [dayPanelOpen, setDayPanelOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => {
    const handler = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setDayPanelOpen(true);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // ── Adherence: single source of truth for both header and plan adherence section ──
  const adherenceSummary = useMemo(() => {
    if (!selectedEntry || selectedEntry.trades.length === 0) return null;
    return summarizeRuleEvaluations(
      evaluateEntryRules(selectedEntry as unknown as StoreJournalEntry, riskRules)
    );
  }, [selectedEntry, riskRules]);
  const adherencePct = adherenceSummary?.pct ?? null;


  return (
    <div className="tj-shell">
      <input
        ref={screenshotInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void onShotFile(file);
          event.target.value = '';
        }}
      />
      <input
        ref={supportingImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void onSupportingImageFile(file);
          event.target.value = '';
        }}
      />

      <MobileDayPanelChrome isMobile={isMobile} dayPanelOpen={dayPanelOpen} setDayPanelOpen={setDayPanelOpen} />

      <DayPanelSection
        isMobile={isMobile}
        dayPanelOpen={dayPanelOpen}
        setDayPanelOpen={setDayPanelOpen}
        monthCursor={monthCursor}
        setMonthCursor={setMonthCursor}
        monthSummary={monthSummary}
        recentForm={recentForm}
        query={query}
        setQuery={setQuery}
        dayFilter={dayFilter}
        setDayFilter={setDayFilter}
        visibleEntries={visibleEntries}
        selectedEntryId={selectedEntryId}
        setSelectedEntryId={setSelectedEntryId}
        setShowScanner={setShowScanner}
        entryAdherenceMap={entryAdherenceMap}
        setShowCSVImport={setShowCSVImport}
        goToScanner={goToScanner}
      />

      <section className="tj-entry-panel" data-tour-id="scanner-entry-panel">
        {!showScanner && selectedEntry ? (
          <>
            {/* ── SECTION 1: HEADER ── */}
            <EntryHeaderSection
              selectedEntry={selectedEntry}
              activeTrade={activeTrade}
              riskRules={riskRules}
              adherencePct={adherencePct}
              deleteEntryConfirm={deleteEntryConfirm}
              setDeleteEntryConfirm={setDeleteEntryConfirm}
              isTradeDateEditorOpen={isTradeDateEditorOpen}
              setIsTradeDateEditorOpen={setIsTradeDateEditorOpen}
              tradeDateDraft={tradeDateDraft}
              setTradeDateDraft={setTradeDateDraft}
              isEntryDateEditorOpen={isEntryDateEditorOpen}
              setIsEntryDateEditorOpen={setIsEntryDateEditorOpen}
              entryDateDraft={entryDateDraft}
              setEntryDateDraft={setEntryDateDraft}
              saveTradeDate={saveTradeDate}
              saveEntryDate={saveEntryDate}
              deleteEntry={deleteEntry}
              goToScanner={goToScanner}
              onShare={() => setShareOpen(true)}
            />

            <div className="tj-entry-body">

              {/* ── SECTION 2: STAT BAR ── */}
              <EntryStatBarSection
                selectedEntry={selectedEntry}
                activeTrade={activeTrade}
                riskRules={riskRules}
                adherencePct={adherencePct}
              />

              {/* ── SECTION 3: CONTRACT SIZING ── */}
              {activeTrade && (
                <>
                  <div className="tj-section-head">
                    <span className="tj-section-title">Contract Sizing</span>
                  </div>
                  <div className="tj-sizing-group">
                    <AccountSelectorBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                    <ContractSizingBlock
                      trade={activeTrade}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                    />
                  </div>
                </>
              )}

              {/* ── SECTION 4: SCREENSHOT — hidden on blank days with no existing image ── */}
              <ScreenshotSection
                selectedEntry={selectedEntry}
                activeTrade={activeTrade}
                activeTradeId={activeTradeId}
                hasExistingImages={hasExistingImages}
                allTradeImages={allTradeImages}
                clampedIndex={clampedIndex}
                currentImage={currentImage}
                slideDir={slideDir}
                setSlideDir={setSlideDir}
                screenshotInputRef={screenshotInputRef}
                onShotPick={onShotPick}
                setIsScreenshotFullscreen={setIsScreenshotFullscreen}
                setViewingImageIndex={setViewingImageIndex}
                navImage={navImage}
                mutateTradeFields={mutateTradeFields}
              />

              {/* ── SECTION 5: TRADES — hidden on blank days ── */}
              <TradeListSection
                selectedEntry={selectedEntry}
                entries={entries}
                riskRules={riskRules}
                activeTradeId={activeTradeId}
                setActiveTradeId={setActiveTradeId}
                setSelectedEntryId={setSelectedEntryId}
                selectedTradeIds={selectedTradeIds}
                setSelectedTradeIds={setSelectedTradeIds}
                bulkDeleteConfirm={bulkDeleteConfirm}
                setBulkDeleteConfirm={setBulkDeleteConfirm}
                deleteTradeId={deleteTradeId}
                setDeleteTradeId={setDeleteTradeId}
                expandedTradeId={expandedTradeId}
                setExpandedTradeId={setExpandedTradeId}
                addManualTrade={addManualTrade}
                deleteTradeEverywhere={deleteTradeEverywhere}
                deleteEntryInStore={deleteEntryInStore}
                mutateTradeFields={mutateTradeFields}
              />

              {/* ── SECTION 6B: RULE VERIFICATION — hidden on blank days ── */}
              {selectedEntry.trades.length > 0 && (
                <RuleComplianceBlock
                  entry={selectedEntry}
                  rules={riskRules}
                  onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                />
              )}

              {/* ── SECTION 8: DAILY REFLECTION ── */}
              <SectionHead title="Daily Reflection" sectionKey="dailyReflection" collapsed={!!collapsed['dailyReflection']} onToggle={() => toggleSection('dailyReflection')} />
              {!collapsed['dailyReflection'] && (
                <DailyReflectionBlock
                  entry={selectedEntry}
                  onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                />
              )}

              {/* ── SECTION 9: TRADE JOURNAL CARD (thesis + flags + psychology) ── */}
              {activeTrade && (
                <>
                  <SectionHead title="Trade Journal" sectionKey="tradeJournal" collapsed={!!collapsed['tradeJournal']} onToggle={() => toggleSection('tradeJournal')} />
                  {!collapsed['tradeJournal'] && (
                    <TradeJournalCard
                      trade={activeTrade}
                      entry={selectedEntry}
                      allEntries={entries}
                      onMutate={fields => mutateTradeFields(activeTrade.id, fields)}
                      onMutateEntry={fields => mutateEntries(prev => prev.map(e => e.id === selectedEntry.id ? { ...e, ...fields } : e))}
                    />
                  )}

                  {/* ── SECTION 10: FLYXA PROCESS SCORE ── */}
                  <SectionHead title="Flyxa Process Score" sectionKey="processScore" collapsed={!!collapsed['processScore']} onToggle={() => toggleSection('processScore')} />
                  {!collapsed['processScore'] && (
                    <ProcessScoreBlock
                      trade={activeTrade}
                      entries={entries}
                      navigate={navigate}
                      onSaveEntries={() => mutateEntries(p => p)}
                    />
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <ScannerDropZone
            isScanning={isScanning}
            scanError={scanError}
            scanPreviewUrl={scanPreviewUrl}
            onScanFile={(file) => { void handleScanFile(file); }}
            onAddBlankDay={addBlankDay}
            isMobile={isMobile}
          />
        )}
      </section>

      <ScreenshotFullscreenModal
        isScreenshotFullscreen={isScreenshotFullscreen}
        currentImage={currentImage}
        setIsScreenshotFullscreen={setIsScreenshotFullscreen}
      />

      {selectedEntry && (
        <SessionShareCard
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          data={(() => {
            const stats = computeEntryStats(selectedEntry, riskRules);
            // Third stat by social currency: best trade if there's more than
            // one, otherwise the day's instrument.
            const nets = selectedEntry.trades.map(t => t.pnl - (t.commission ?? 0));
            const best = nets.length ? Math.max(...nets) : 0;
            const symbols = Array.from(new Set(selectedEntry.trades.map(t => t.symbol).filter(Boolean)));
            const extraStat = selectedEntry.trades.length > 1 && best > 0
              ? { label: 'Best trade', value: formatSignedCurrency(best), color: 'var(--green)', sensitive: true }
              : symbols.length > 0
                ? { label: 'Instrument', value: symbols.slice(0, 2).join(' · ') }
                : null;
            return {
              dateLabel: formatDateTitle(selectedEntry.date),
              netPnl: stats.pnl,
              trades: selectedEntry.trades.length,
              winRate: Math.round(stats.winRate),
              grade: null,
              extraStat,
              username: (user?.user_metadata?.display_name as string | undefined)
                ?? user?.email?.split('@')[0]
                ?? 'trader',
            };
          })()}
        />
      )}

      {showCSVImport && (
        <CSVImportModal
          onClose={() => setShowCSVImport(false)}
          onImport={async (trades) => {
            await handleCSVImport(trades);
            setShowCSVImport(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Module-level helpers (moved out of the component body so TypeScript's
//     control-flow analysis stays enabled inside TradeJournal) ────────────────

function computeRecentForm(entries: JournalEntry[]) {
  const allTrades = entries.flatMap(e =>
    e.trades.filter(t => t.result !== 'open').map(t => ({ ...t, entryDate: e.date }))
  );
  const sorted = [...allTrades].sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate) || (a.entryTime ?? '').localeCompare(b.entryTime ?? '')
  );
  const last10 = sorted.slice(-10);

  // Per-trade bar data — ratio in [-1, +1] relative to largest trade
  const maxAbsPnl = Math.max(...last10.map(t => Math.abs(t.pnl - (t.commission ?? 0))), 1);
  const tradeBars = last10.map(t => {
    const net = t.pnl - (t.commission ?? 0);
    return { result: t.result as TradeResult, net, ratio: net / maxAbsPnl };
  });

  // Current W/L streak (most-recent first)
  let streak = 0;
  let streakType: 'win' | 'loss' | null = null;
  for (let i = last10.length - 1; i >= 0; i--) {
    const r = last10[i].result;
    if (i === last10.length - 1) {
      streakType = r === 'win' ? 'win' : r === 'loss' ? 'loss' : null;
      streak = streakType ? 1 : 0;
    } else if (streakType && r === streakType) {
      streak++;
    } else {
      break;
    }
  }

  const winsLast10 = last10.filter(t => t.result === 'win').length;
  const lossesLast10 = last10.filter(t => t.result === 'loss').length;
  const breakevenLast10 = last10.filter(t => t.result !== 'win' && t.result !== 'loss').length;
  const decisiveLast10 = winsLast10 + lossesLast10;
  const netLast10 = last10.reduce((s, t) => s + t.pnl - (t.commission ?? 0), 0);

  // 7-day rolling stats
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(now.getDate() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const last7d = allTrades.filter(t => t.entryDate >= cutoffStr);
  const wins7d = last7d.filter(t => t.result === 'win').length;
  const total7d = last7d.length;
  const netPnl7d = last7d.reduce((s, t) => s + t.pnl - (t.commission ?? 0), 0);

  return {
    last10,
    tradeBars,
    winsLast10,
    lossesLast10,
    breakevenLast10,
    netLast10,
    winRateLast10: decisiveLast10 > 0 ? (winsLast10 / decisiveLast10) * 100 : null,
    streak,
    streakType,
    total7d,
    winRate7d: total7d > 0 ? (wins7d / total7d) * 100 : null,
    netPnl7d: total7d > 0 ? netPnl7d : null,
  };
}

// ─── SECTION: Day panel (left sidebar — month summary, recent form, day list) ──

interface DayPanelSectionProps {
  isMobile: boolean;
  dayPanelOpen: boolean;
  setDayPanelOpen: Dispatch<SetStateAction<boolean>>;
  monthCursor: Date;
  setMonthCursor: Dispatch<SetStateAction<Date>>;
  monthSummary: { monthPnl: number; daysTraded: number; winRate: number; bestDay: number | null };
  recentForm: ReturnType<typeof computeRecentForm>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  dayFilter: DayFilter;
  setDayFilter: Dispatch<SetStateAction<DayFilter>>;
  visibleEntries: JournalEntry[];
  selectedEntryId: string | null;
  setSelectedEntryId: Dispatch<SetStateAction<string | null>>;
  setShowScanner: Dispatch<SetStateAction<boolean>>;
  entryAdherenceMap: Map<string, number | null>;
  setShowCSVImport: Dispatch<SetStateAction<boolean>>;
  goToScanner: () => void;
}

function DayPanelSection({
  isMobile,
  dayPanelOpen,
  setDayPanelOpen,
  monthCursor,
  setMonthCursor,
  monthSummary,
  recentForm,
  query,
  setQuery,
  dayFilter,
  setDayFilter,
  visibleEntries,
  selectedEntryId,
  setSelectedEntryId,
  setShowScanner,
  entryAdherenceMap,
  setShowCSVImport,
  goToScanner,
}: DayPanelSectionProps) {
  return (
      <aside
        className="tj-day-panel"
        data-tour-id="scanner-day-panel"
        style={isMobile ? {
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          width: 260,
          zIndex: 9989,
          overflowY: 'auto',
          transform: dayPanelOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.22s ease',
        } : undefined}
      >
        <div className="tj-day-header">
          <div className="tj-day-top">
            <p className="tj-month-title">{formatMonth(monthCursor)}</p>
            <span className="tj-nav-group">
              <button type="button" className="tj-nav" onClick={() => setMonthCursor(prev => shiftMonth(prev, -1))}>
                <ChevronLeft size={13} />
              </button>
              <button type="button" className="tj-nav" onClick={() => setMonthCursor(prev => shiftMonth(prev, 1))}>
                <ChevronRight size={13} />
              </button>
            </span>
          </div>
          <button
            data-tour-id="scanner-import"
            type="button"
            className="tj-import-csv-btn"
            title="Import trades from Notion or broker CSV"
            onClick={() => setShowCSVImport(true)}
          >
            <Upload size={13} />
            <span>Import trades from CSV</span>
          </button>

          <div className="tj-month-grid">
            <div className="tj-month-cell">
              <div className="tj-month-label">Month P&amp;L</div>
              <div className={`tj-month-value ${monthSummary.monthPnl > 0 ? 'pos' : monthSummary.monthPnl < 0 ? 'neg' : 'zero'}`}>
                {formatSignedCurrency(monthSummary.monthPnl)}
              </div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Win Rate</div>
              <div className="tj-month-value">{toPercent(monthSummary.winRate)}</div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Days Traded</div>
              <div className="tj-month-value">{monthSummary.daysTraded}</div>
            </div>
            <div className="tj-month-cell">
              <div className="tj-month-label">Best Day</div>
              <div className={`tj-month-value ${(monthSummary.bestDay ?? 0) > 0 ? 'pos' : 'zero'}`}>
                {monthSummary.bestDay === null ? '--' : formatSignedCurrency(monthSummary.bestDay)}
              </div>
            </div>
          </div>
        </div>

        {/* Recent Form */}
        {recentForm.last10.length > 0 && (() => {
          const RF_GREEN = '#34d399';
          const RF_RED = '#f87171';
          const RF_AMBER = '#f59e0b';
          const winColor = recentForm.winsLast10 > recentForm.lossesLast10 ? RF_GREEN
            : recentForm.winsLast10 < recentForm.lossesLast10 ? RF_RED : 'var(--txt-2)';
          return (
            <div style={{ padding: '10px 14px 12px', borderBottom: '1px solid var(--border)' }}>
              {/* Label */}
              <div style={{ fontSize: '9px', fontWeight: 600, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--txt-3)', marginBottom: '8px' }}>
                Last {recentForm.last10.length} trades
              </div>

              {/* Result tiles — uniform height, colour = W/L/BE */}
              <div style={{ display: 'flex', gap: '3px', marginBottom: '10px' }}>
                {recentForm.tradeBars.map((bar, i) => {
                  const color = bar.result === 'win' ? RF_GREEN : bar.result === 'loss' ? RF_RED : RF_AMBER;
                  const pnlStr = bar.net >= 0 ? `+${formatSignedCurrency(bar.net)}` : formatSignedCurrency(bar.net);
                  return (
                    <div
                      key={i}
                      title={`${bar.result.toUpperCase()}  ${pnlStr}`}
                      style={{
                        flex: 1,
                        height: '16px',
                        borderRadius: '2px',
                        background: color,
                        opacity: 0.6,
                      }}
                    />
                  );
                })}
              </div>

              {/* Three stats — plain, no borders */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
                {[
                  {
                    label: 'Record',
                    value: recentForm.breakevenLast10 > 0
                      ? `${recentForm.winsLast10}–${recentForm.lossesLast10}–${recentForm.breakevenLast10}`
                      : `${recentForm.winsLast10}–${recentForm.lossesLast10}`,
                    color: winColor,
                  },
                  {
                    label: 'Win rate',
                    value: recentForm.winRateLast10 !== null ? `${recentForm.winRateLast10.toFixed(0)}%` : '–',
                    color: recentForm.winRateLast10 !== null && recentForm.winRateLast10 >= 50 ? RF_GREEN : RF_RED,
                  },
                  {
                    label: 'Streak',
                    value: recentForm.streak > 0
                      ? `${recentForm.streak}${recentForm.streakType === 'win' ? 'W' : 'L'}`
                      : '–',
                    color: recentForm.streakType === 'win' ? RF_GREEN : RF_RED,
                  },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontSize: '8.5px', color: 'var(--txt-3)', marginBottom: '2px' }}>{label}</div>
                    <div style={{ fontSize: '12px', fontWeight: 400, fontFamily: 'var(--font-mono)', color, WebkitFontSmoothing: 'antialiased' }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="tj-search-row" data-tour-id="scanner-search">
          <Search size={13} color="var(--txt-3)" />
          <input
            className="tj-search-input"
            placeholder="Search entries..."
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </div>

        <div className="tj-chip-row">
          {[
            { key: 'all', label: 'All' },
            { key: 'win', label: 'Win days' },
            { key: 'loss', label: 'Loss days' },
            { key: 'untagged', label: 'Untagged' },
          ].map(chip => (
            <button
              key={chip.key}
              type="button"
              className={`tj-chip ${dayFilter === chip.key ? 'sel' : ''}`}
              onClick={() => setDayFilter(chip.key as DayFilter)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="tj-day-list">
          {visibleEntries.length ? (
            visibleEntries.map(entry => {
              const stats = computeEntryStats(entry);
              const day = parseDate(entry.date).getDate();
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`tj-day-item ${selectedEntryId === entry.id ? 'active' : ''}`}
                  onClick={() => { setSelectedEntryId(entry.id); setShowScanner(false); if (isMobile) setDayPanelOpen(false); }}
                >
                  <div className="tj-date-col">
                    <div className="tj-day-num">{day}</div>
                    <div className="tj-weekday">{formatWeekday(entry.date)}</div>
                  </div>
                  <div className="tj-day-body">
                    {entry.trades.length > 0 ? (
                      <>
                        <div className={`tj-day-pnl ${stats.pnl > 0 ? 'pos' : stats.pnl < 0 ? 'neg' : ''}`}>{formatSignedCurrency(stats.pnl)}</div>
                        <div className="tj-day-meta">{`${stats.wins}W | ${stats.losses}L | ${stats.tradeCount} trades`}</div>
                        {(() => {
                          const pct = entryAdherenceMap.get(entry.id) ?? null;
                          if (pct === null) return null;
                          const clr = pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)';
                          return <div style={{ fontSize: 9, color: clr, marginTop: 1, fontWeight: 600 }}>{pct}% adherence</div>;
                        })()}
                      </>
                    ) : (
                      <>
                        <div className="tj-day-pnl" style={{ opacity: 0.35 }}>—</div>
                        <div className="tj-day-meta" style={{ opacity: 0.45 }}>No trades</div>
                      </>
                    )}
                  </div>
                  {(() => {
                    if (entry.trades.length === 0) return <div className="tj-day-grade g-none" style={{ opacity: 0.25 }}>—</div>;
                    const scored = entry.trades.map(t => computeProcessScore(t)).filter(s => s > 0);
                    const avgScore = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
                    const letter = scoreToGradeLetter(avgScore);
                    return <div className={`tj-day-grade g-${gradeCssKey(letter)}`}>{letter}</div>;
                  })()}
                </button>
              );
            })
          ) : (
            <div className="tj-day-empty">
              <div className="tj-day-empty-box">
                <div className="tj-day-empty-icon"><FileText size={16} /></div>
                <p className="tj-day-empty-title">No entries yet</p>
                <p className="tj-day-empty-sub">Log your first trade below.</p>
                <button type="button" className="tj-day-empty-btn" onClick={goToScanner}>
                  <Plus size={11} />
                  Log Trade
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
  );
}

// ─── SECTION: Mobile chrome (overlay backdrop + left-edge day-panel toggle) ──

function MobileDayPanelChrome({ isMobile, dayPanelOpen, setDayPanelOpen }: {
  isMobile: boolean;
  dayPanelOpen: boolean;
  setDayPanelOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobile && dayPanelOpen && (
        <div
          onClick={() => setDayPanelOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 9988, background: 'rgba(0,0,0,0.45)' }}
        />
      )}

      {/* Persistent left-edge arrow tab (mobile only) */}
      {isMobile && (
        <button
          type="button"
          aria-label={dayPanelOpen ? 'Close day panel' : 'Open day panel'}
          onClick={() => setDayPanelOpen(prev => !prev)}
          style={{
            position: 'fixed',
            left: dayPanelOpen ? 260 : 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 9990,
            width: 20,
            height: 44,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderLeft: 'none',
            borderRadius: '0 6px 6px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'left 0.22s ease',
            padding: 0,
          }}
        >
          {dayPanelOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
    </>
  );
}

// ─── SECTION: Entry header (date title, P&L strip, date editors, actions) ────

interface EntryHeaderSectionProps {
  selectedEntry: JournalEntry;
  activeTrade: JournalTrade | null;
  riskRules: RiskRule[];
  adherencePct: number | null;
  deleteEntryConfirm: boolean;
  setDeleteEntryConfirm: Dispatch<SetStateAction<boolean>>;
  isTradeDateEditorOpen: boolean;
  setIsTradeDateEditorOpen: Dispatch<SetStateAction<boolean>>;
  tradeDateDraft: string;
  setTradeDateDraft: Dispatch<SetStateAction<string>>;
  isEntryDateEditorOpen: boolean;
  setIsEntryDateEditorOpen: Dispatch<SetStateAction<boolean>>;
  entryDateDraft: string;
  setEntryDateDraft: Dispatch<SetStateAction<string>>;
  saveTradeDate: () => void;
  saveEntryDate: () => void;
  deleteEntry: () => Promise<void>;
  goToScanner: () => void;
  onShare: () => void;
}

function EntryHeaderSection({
  selectedEntry,
  activeTrade,
  riskRules,
  adherencePct,
  deleteEntryConfirm,
  setDeleteEntryConfirm,
  isTradeDateEditorOpen,
  setIsTradeDateEditorOpen,
  tradeDateDraft,
  setTradeDateDraft,
  isEntryDateEditorOpen,
  setIsEntryDateEditorOpen,
  entryDateDraft,
  setEntryDateDraft,
  saveTradeDate,
  saveEntryDate,
  deleteEntry,
  goToScanner,
  onShare,
}: EntryHeaderSectionProps) {
  const { preferences, accounts } = useAppSettings();
  return (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              paddingBottom: 14, borderBottom: '1px solid var(--border)', padding: '16px 20px 14px',
              flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--txt)', marginBottom: 6, fontFamily: 'var(--font-sans)' }}>
                  {formatDateTitle(selectedEntry.date)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {(() => {
                    const stats = computeEntryStats(selectedEntry, riskRules);
                    const pnl = stats.pnl;
                    const pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--txt-2)';
                    const pctColor = adherencePct !== null
                      ? (adherencePct >= 80 ? 'var(--green)' : adherencePct >= 60 ? 'var(--amber)' : 'var(--red)')
                      : 'var(--txt-2)';
                    const headerAccount = accounts.find(a => a.id === selectedEntry.account);
                    const totalContracts = selectedEntry.trades.reduce((sum, t) => sum + (t.contracts > 0 ? t.contracts : 1), 0);
                    return (
                      <>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: pnlColor, fontWeight: 500 }}>
                          {formatSignedCurrency(pnl)}
                        </span>
                        <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--txt-3)', display: 'inline-block', flexShrink: 0 }} />
                        {adherencePct !== null && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: pctColor, fontWeight: 500 }}>
                            {adherencePct}% adherence
                          </span>
                        )}
                        {headerAccount && (
                          <>
                            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--txt-3)', display: 'inline-block', flexShrink: 0 }} />
                            <span style={{ fontSize: 13, color: 'var(--txt-2)' }}>{headerAccount.name}</span>
                          </>
                        )}
                        {selectedEntry.trades.length > 0 && (
                          <>
                            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--txt-3)', display: 'inline-block', flexShrink: 0 }} />
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--txt-2)' }}>{totalContracts} contract{totalContracts !== 1 ? 's' : ''}</span>
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
                {activeTrade && !deleteEntryConfirm && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                      Trade date: {getTradeDateValue(activeTrade, selectedEntry.date)}
                    </span>
                    <button
                      type="button"
                      className="tj-mini-btn"
                      onClick={() => {
                        setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
                        setIsTradeDateEditorOpen(true);
                      }}
                    >
                      Edit trade date
                    </button>
                  </div>
                )}
                {isTradeDateEditorOpen && activeTrade && !deleteEntryConfirm && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DatePicker
                      className="tj-date-edit-input"
                      value={tradeDateDraft}
                      onChange={setTradeDateDraft}
                      compact
                      align="left"
                      max={getTodayIso(preferences.timezone)}
                    />
                    <button type="button" className="tj-mini-btn" onClick={saveTradeDate}>Save</button>
                    <button type="button" className="tj-mini-btn" onClick={() => {
                      setTradeDateDraft(getTradeDateValue(activeTrade, selectedEntry.date));
                      setIsTradeDateEditorOpen(false);
                    }}>Cancel</button>
                  </div>
                )}
                {!activeTrade && !deleteEntryConfirm && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>Date: {selectedEntry.date}</span>
                    {!isEntryDateEditorOpen && (
                      <button type="button" className="tj-mini-btn" onClick={() => { setEntryDateDraft(selectedEntry.date); setIsEntryDateEditorOpen(true); }}>
                        Edit date
                      </button>
                    )}
                  </div>
                )}
                {isEntryDateEditorOpen && !activeTrade && !deleteEntryConfirm && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <DatePicker
                      className="tj-date-edit-input"
                      value={entryDateDraft}
                      onChange={setEntryDateDraft}
                      compact
                      align="left"
                      max={getTodayIso(preferences.timezone)}
                    />
                    <button type="button" className="tj-mini-btn" onClick={saveEntryDate}>Save</button>
                    <button type="button" className="tj-mini-btn" onClick={() => { setEntryDateDraft(selectedEntry.date); setIsEntryDateEditorOpen(false); }}>Cancel</button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
                {deleteEntryConfirm ? (
                  <>
                    <span style={{ fontSize: 12, color: 'var(--txt-2)' }}>Delete this day?</span>
                    <button type="button" className="tj-mini-btn" onClick={() => setDeleteEntryConfirm(false)}>Cancel</button>
                    <button type="button" className="tj-mini-btn red" onClick={deleteEntry}>Delete</button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-2)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
                      onClick={() => setDeleteEntryConfirm(true)}
                    >
                      <Trash2 size={13} />
                      Delete
                    </button>
                    {selectedEntry.trades.length > 0 && (
                      <button
                        type="button"
                        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--txt-2)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
                        onClick={onShare}
                        title="Create a share card for this day"
                      >
                        <Upload size={13} />
                        Share
                      </button>
                    )}
                    <button
                      type="button"
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 4, border: 'none', background: 'var(--amber)', color: '#000', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
                      onClick={goToScanner}
                      data-tour-id="scanner-log-trade-button"
                    >
                      <Plus size={13} />
                      Log trade
                    </button>
                  </>
                )}
              </div>
            </div>
  );
}

// ─── SECTION: Entry stat bar (net P&L, win rate, avg R:R, process, adherence) ─

function EntryStatBarSection({ selectedEntry, activeTrade, riskRules, adherencePct }: {
  selectedEntry: JournalEntry;
  activeTrade: JournalTrade | null;
  riskRules: RiskRule[];
  adherencePct: number | null;
}) {
  return (
    <>
              {(() => {
                const stats = computeEntryStats(selectedEntry, riskRules);
                const pnlColor = stats.pnl > 0 ? 'var(--green)' : stats.pnl < 0 ? 'var(--red)' : 'var(--txt)';
                return (
                  <div style={{ display: 'flex', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }} data-tour-id="scanner-trade-stats">
                    {[
                      { label: 'NET P&L', node: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: pnlColor }}>{formatSignedCurrency(stats.pnl)}</span> },
                      { label: 'WIN RATE', node: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt)' }}>{toPercent(stats.winRate)}</span> },
                      { label: 'AVG R:R', node: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt)' }}>{toR(stats.avgRR)}</span> },
                      { label: 'TRADES', node: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt)' }}>{String(stats.tradeCount)}</span> },
                      { label: 'PROCESS', node: activeTrade ? (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--amber)' }}>{computeProcessScore(activeTrade)}</span>
                      ) : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt-3)' }}>--</span> },
                      { label: 'ADHERENCE', node: adherencePct !== null ? (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: adherencePct >= 80 ? 'var(--green)' : adherencePct >= 60 ? 'var(--amber)' : 'var(--red)' }}>{adherencePct}%</span>
                      ) : <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt-3)' }}>--</span> },
                    ].map((cell, i, arr) => (
                      <div key={cell.label} style={{ flex: 1, padding: '10px 14px', borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--txt-3)', marginBottom: 4 }}>{cell.label}</div>
                        {cell.node}
                      </div>
                    ))}
                  </div>
                );
              })()}
    </>
  );
}

// ─── SECTION: Screenshot viewer (carousel, add/remove, fullscreen trigger) ───

interface ScreenshotSectionProps {
  selectedEntry: JournalEntry;
  activeTrade: JournalTrade | null;
  activeTradeId: string | null;
  hasExistingImages: boolean;
  allTradeImages: string[];
  clampedIndex: number;
  currentImage: string;
  slideDir: 'left' | 'right';
  setSlideDir: Dispatch<SetStateAction<'left' | 'right'>>;
  screenshotInputRef: RefObject<HTMLInputElement>;
  onShotPick: (index: number) => void;
  setIsScreenshotFullscreen: Dispatch<SetStateAction<boolean>>;
  setViewingImageIndex: Dispatch<SetStateAction<number>>;
  navImage: (dir: 'left' | 'right') => void;
  mutateTradeFields: (tradeId: string, fields: Partial<JournalTrade>) => void;
}

function ScreenshotSection({
  selectedEntry,
  activeTrade,
  activeTradeId,
  hasExistingImages,
  allTradeImages,
  clampedIndex,
  currentImage,
  slideDir,
  setSlideDir,
  screenshotInputRef,
  onShotPick,
  setIsScreenshotFullscreen,
  setViewingImageIndex,
  navImage,
  mutateTradeFields,
}: ScreenshotSectionProps) {
  return (
    <>
              {(selectedEntry.trades.length > 0 || hasExistingImages) && (<>
              <div className="tj-section-head first">
                <span className="tj-section-title">Screenshot</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {allTradeImages.length > 1 && (
                    <span style={{ fontSize: 10, color: 'var(--txt-3)', fontVariantNumeric: 'tabular-nums' }}>
                      {clampedIndex + 1} / {allTradeImages.length}
                    </span>
                  )}
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--cobalt)', fontFamily: 'var(--font-sans)' }}
                    onClick={() => { screenshotInputRef.current?.click(); onShotPick(0); }}
                  >
                    + Add image
                  </button>
                </span>
              </div>
              <div className="tj-shot-viewer" data-tour-id="scanner-screenshot">
                <button
                  type="button"
                  className="tj-shot tj-shot-single"
                  onClick={() => clampedIndex === 0 ? onShotPick(0) : undefined}
                >
                  {currentImage ? (
                    <>
                      <img
                        key={`${activeTradeId}-${clampedIndex}`}
                        src={currentImage}
                        alt="Trade chart"
                        className={`tj-shot-slide-${slideDir}`}
                      />
                      <span className="tj-shot-controls">
                        <button
                          type="button"
                          className="tj-shot-control-btn"
                          onClick={event => {
                            event.stopPropagation();
                            setIsScreenshotFullscreen(true);
                          }}
                          aria-label="Open screenshot fullscreen"
                        >
                          <Maximize2 size={14} />
                        </button>
                        {clampedIndex > 0 && activeTrade && (
                          <button
                            type="button"
                            className="tj-shot-control-btn"
                            title="Remove this image"
                            onClick={event => {
                              event.stopPropagation();
                              const newImgs = [...(activeTrade.supportingImages ?? [])];
                              newImgs.splice(clampedIndex - 1, 1);
                              mutateTradeFields(activeTrade.id, { supportingImages: newImgs });
                              setViewingImageIndex(v => Math.max(0, v - 1));
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </>
                  ) : (
                    <>
                      <ImageIcon size={18} />
                      <span className="tj-shot-label">Add chart</span>
                    </>
                  )}
                </button>
                {allTradeImages.length > 1 && (
                  <div className="tj-shot-side-nav">
                    {clampedIndex > 0 && (
                      <button type="button" className="tj-shot-side-btn" onClick={() => navImage('left')} aria-label="Previous image" title="Back to main chart">
                        <ChevronLeft size={14} />
                      </button>
                    )}
                    <div className="tj-shot-side-dots">
                      {allTradeImages.map((_, i) => (
                        <button key={i} type="button" className={`tj-side-dot${i === clampedIndex ? ' active' : ''}`}
                          onClick={() => { setSlideDir(i > clampedIndex ? 'right' : 'left'); setViewingImageIndex(i); }}
                          aria-label={`Image ${i + 1}`} />
                      ))}
                    </div>
                    {clampedIndex < allTradeImages.length - 1 && (
                      <button type="button" className="tj-shot-side-btn" onClick={() => navImage('right')} aria-label="Next image" title="View supporting image">
                        <ChevronRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              </>)}
    </>
  );
}

// ─── SECTION: Trade list (per-trade cards, bulk select/delete, price levels) ──

interface TradeListSectionProps {
  selectedEntry: JournalEntry;
  entries: JournalEntry[];
  riskRules: RiskRule[];
  activeTradeId: string | null;
  setActiveTradeId: Dispatch<SetStateAction<string | null>>;
  setSelectedEntryId: Dispatch<SetStateAction<string | null>>;
  selectedTradeIds: Set<string>;
  setSelectedTradeIds: Dispatch<SetStateAction<Set<string>>>;
  bulkDeleteConfirm: boolean;
  setBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  deleteTradeId: string | null;
  setDeleteTradeId: Dispatch<SetStateAction<string | null>>;
  expandedTradeId: string | null;
  setExpandedTradeId: Dispatch<SetStateAction<string | null>>;
  addManualTrade: () => void;
  deleteTradeEverywhere: (id: string) => Promise<void>;
  deleteEntryInStore: (id: string) => void;
  mutateTradeFields: (tradeId: string, fields: Partial<JournalTrade>) => void;
}

function TradeListSection({
  selectedEntry,
  entries,
  riskRules,
  activeTradeId,
  setActiveTradeId,
  setSelectedEntryId,
  selectedTradeIds,
  setSelectedTradeIds,
  bulkDeleteConfirm,
  setBulkDeleteConfirm,
  deleteTradeId,
  setDeleteTradeId,
  expandedTradeId,
  setExpandedTradeId,
  addManualTrade,
  deleteTradeEverywhere,
  deleteEntryInStore,
  mutateTradeFields,
}: TradeListSectionProps) {
  return (
    <>
              {selectedEntry.trades.length > 0 && (<><div className="tj-section-head">
                <span className="tj-section-title">
                  Trades
                  {selectedTradeIds.size > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)', fontWeight: 600 }}>
                      {selectedTradeIds.size} selected
                    </span>
                  )}
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {selectedTradeIds.size > 0 && !bulkDeleteConfirm && (
                    <button type="button" className="tj-mini-btn red" onClick={() => setBulkDeleteConfirm(true)}>
                      Delete {selectedTradeIds.size}
                    </button>
                  )}
                  {selectedTradeIds.size > 0 && (
                    <button type="button" className="tj-mini-btn" onClick={() => { setSelectedTradeIds(new Set()); setBulkDeleteConfirm(false); }}>
                      Clear
                    </button>
                  )}
                  <button type="button" className="tj-section-action" onClick={addManualTrade}>Add trade</button>
                </span>
              </div>
              {bulkDeleteConfirm && selectedTradeIds.size > 0 && (
                <div className="tj-delete-row">
                  <span className="tj-delete-text">Delete {selectedTradeIds.size} trade{selectedTradeIds.size !== 1 ? 's' : ''}?</span>
                  <span className="tj-delete-actions">
                    <button type="button" className="tj-mini-btn" onClick={() => setBulkDeleteConfirm(false)}>Cancel</button>
                    <button type="button" className="tj-mini-btn red"
                      onClick={async () => {
                        const ids = Array.from(selectedTradeIds);
                        const willBeEmpty = selectedEntry.trades.length === ids.length;
                        const entryDate = selectedEntry.date;
                        const entryId = selectedEntry.id;
                        for (const id of ids) { await deleteTradeEverywhere(id); }
                        setSelectedTradeIds(new Set());
                        setBulkDeleteConfirm(false);
                        setDeleteTradeId(null);
                        if (willBeEmpty) {
                          useFlyxaStore.getState().entries.filter(e => e.date === entryDate).forEach(e => deleteEntryInStore(e.id));
                          void flushSupabaseStoreNow().catch(() => {});
                          const next = entries.filter(e => e.id !== entryId).sort((a, b) => b.date.localeCompare(a.date)).find(e => e.trades.length > 0);
                          if (next) { setSelectedEntryId(next.id); setActiveTradeId(next.trades[0].id); }
                          else { setSelectedEntryId(null); setActiveTradeId(null); }
                        }
                      }}
                    >Confirm</button>
                  </span>
                </div>
              )}
              <div className="tj-trade-list" data-tour-id="scanner-trade-list">
                {(() => {
                  const _contractRule = riskRules.find(r => r.kind === 'max_contracts');
                  const _contractLimits = (_contractRule?.contractLimits as Record<string, number> | undefined) ?? {};
                  const _sortedTrades = [...selectedEntry.trades].sort((a, b) => (a.entryTime ?? '').localeCompare(b.entryTime ?? ''));
                  const _patternFlags = computeTradePatternFlags(_sortedTrades, _contractLimits);
                  return _sortedTrades.map((trade, tradeIdx) => (
                  deleteTradeId === trade.id ? (
                    <div key={trade.id} className="tj-delete-row">
                      <span className="tj-delete-text">Delete this trade?</span>
                      <span className="tj-delete-actions">
                        <button type="button" className="tj-mini-btn" onClick={() => setDeleteTradeId(null)}>Cancel</button>
                        <button type="button" className="tj-mini-btn red"
                          onClick={async () => {
                            const willBeEmpty = selectedEntry.trades.length === 1;
                            const entryDate = selectedEntry.date;
                            const entryId = selectedEntry.id;
                            await deleteTradeEverywhere(trade.id);
                            setDeleteTradeId(null);
                            if (willBeEmpty) {
                              useFlyxaStore.getState().entries.filter(e => e.date === entryDate).forEach(e => deleteEntryInStore(e.id));
                              void flushSupabaseStoreNow().catch(() => {});
                              const next = entries.filter(e => e.id !== entryId).sort((a, b) => b.date.localeCompare(a.date)).find(e => e.trades.length > 0);
                              if (next) { setSelectedEntryId(next.id); setActiveTradeId(next.trades[0].id); }
                              else { setSelectedEntryId(null); setActiveTradeId(null); }
                            }
                          }}
                        >Delete</button>
                      </span>
                    </div>
                  ) : (
                    <div
                      key={trade.id}
                      className={`tj-trade-card ${trade.result}${activeTradeId === trade.id ? ' active' : ''}${selectedTradeIds.has(trade.id) ? ' tj-trade-selected' : ''}`}
                      onClick={() => { setActiveTradeId(trade.id); setSelectedTradeIds(new Set()); setBulkDeleteConfirm(false); }}
                      aria-current={activeTradeId === trade.id ? 'true' : undefined}
                      style={{ position: 'relative', flexDirection: 'column', alignItems: 'stretch', padding: 0 }}
                    >
                      {/* ── Collapsed header row ── */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px' }}>
                        <button
                          type="button"
                          className="tj-check-btn"
                          aria-label={selectedTradeIds.has(trade.id) ? 'Deselect trade' : 'Select trade'}
                          onClick={e => {
                            e.stopPropagation();
                            setSelectedTradeIds(prev => {
                              const next = new Set(prev);
                              if (next.has(trade.id)) next.delete(trade.id); else next.add(trade.id);
                              return next;
                            });
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: 3, border: `1px solid ${selectedTradeIds.has(trade.id) ? 'var(--amber)' : 'var(--border)'}`, background: selectedTradeIds.has(trade.id) ? 'var(--amber-dim)' : 'transparent', flexShrink: 0 }}>
                            {selectedTradeIds.has(trade.id) && <span style={{ fontSize: 9, color: 'var(--amber)', lineHeight: 1 }}>✓</span>}
                          </span>
                        </button>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-3)', flexShrink: 0 }}>#{tradeIdx + 1}</span>
                        <span className="tj-symbol">{trade.symbol}</span>
                        <span className={`tj-tc-badge ${trade.direction === 'LONG' ? 'b-long' : 'b-short'}`}>{trade.direction === 'LONG' ? 'LONG' : 'SHORT'}</span>
                        {trade.result === 'be' && (
                          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 5px', borderRadius: 3, background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid var(--amber)', flexShrink: 0 }}>BE</span>
                        )}
                        {_patternFlags.has(trade.id) && (() => {
                          const _flag = _patternFlags.get(trade.id)!;
                          const _isOvertrading = _flag.includes('trades in 10min');
                          return _isOvertrading ? (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 8px', background:'rgba(248,113,113,0.12)', border:'1px solid rgba(248,113,113,0.45)', borderRadius:3, fontSize:11, fontWeight:600, letterSpacing:'0.02em', color:'#f87171', flexShrink:0, whiteSpace:'nowrap', textTransform:'uppercase' }}>
                              <AlertTriangle size={11} style={{ flexShrink:0 }} />
                              {_flag}
                            </span>
                          ) : (
                            <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 6px', background:'var(--red-dim)', border:'1px solid var(--red-border)', borderRadius:3, fontSize:10, color:'var(--red)', flexShrink:0, whiteSpace:'nowrap' }}>
                              <AlertTriangle size={10} style={{ flexShrink:0 }} />
                              {_flag}
                            </span>
                          );
                        })()}
                        <span style={{ flex: 1 }} />
                        {(trade.entryTime || trade.durationMinutes != null) && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--txt-3)', flexShrink: 0 }}>
                            {trade.entryTime ?? '--:--'}{trade.durationMinutes != null ? ` · ${formatDurationLabel(resolveTradeDurationMinutes(trade))}` : ''}
                          </span>
                        )}
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: trade.pnl > 0 ? 'var(--green)' : trade.pnl < 0 ? 'var(--red)' : 'var(--txt-2)', flexShrink: 0 }}>
                          {formatSignedCurrency(trade.pnl - (trade.commission ?? 0))}
                        </span>
                        <button
                          type="button"
                          style={{ background: 'none', border: 'none', padding: '2px 2px', cursor: 'pointer', color: 'var(--txt-3)', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
                          aria-label={expandedTradeId === trade.id ? 'Collapse price levels' : 'Expand price levels'}
                          onClick={e => {
                            e.stopPropagation();
                            setActiveTradeId(trade.id);
                            setExpandedTradeId(prev => prev === trade.id ? null : trade.id);
                          }}
                        >
                          {expandedTradeId === trade.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                        <button type="button" className="tj-trash-btn" onClick={e => { e.stopPropagation(); setDeleteTradeId(trade.id); }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {/* ── Expanded price levels ── */}
                      {expandedTradeId === trade.id && (
                        <div style={{ borderTop: '1px solid var(--border)', padding: '0 10px 10px' }} onClick={e => e.stopPropagation()}>
                          {/* Correction row — fix scanner misreads (symbol, direction, time, duration) */}
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', padding: '10px 2px 8px' }}>
                            <div>
                              <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Symbol</div>
                              <input
                                type="text"
                                defaultValue={trade.symbol}
                                key={`sym-${trade.id}`}
                                onBlur={e => {
                                  const v = e.target.value.trim().toUpperCase();
                                  if (v && v !== trade.symbol) mutateTradeFields(trade.id, { symbol: v });
                                }}
                                style={{ width: 52, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--app-panel-strong)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--txt)', outline: 'none', textTransform: 'uppercase' }}
                              />
                            </div>
                            <div>
                              <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Direction</div>
                              <div style={{ display: 'flex', gap: 3 }}>
                                {(['LONG', 'SHORT'] as const).map(dir => (
                                  <button
                                    key={dir}
                                    type="button"
                                    onClick={() => { if (trade.direction !== dir) mutateTradeFields(trade.id, { direction: dir }); }}
                                    style={{ padding: '4px 9px', fontSize: 9, fontWeight: 700, borderRadius: 4, cursor: 'pointer', border: `1px solid ${trade.direction === dir ? (dir === 'LONG' ? 'var(--green-border)' : 'var(--red-border)') : 'var(--border)'}`, background: trade.direction === dir ? (dir === 'LONG' ? 'var(--green-dim)' : 'var(--red-dim)') : 'transparent', color: trade.direction === dir ? (dir === 'LONG' ? 'var(--green)' : 'var(--red)') : 'var(--txt-3)' }}
                                  >
                                    {dir}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Entry time</div>
                              <input
                                type="time"
                                defaultValue={trade.entryTime}
                                key={`et-${trade.id}`}
                                onBlur={e => { if (e.target.value && e.target.value !== trade.entryTime) mutateTradeFields(trade.id, { entryTime: e.target.value }); }}
                                style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--app-panel-strong)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--txt)', outline: 'none' }}
                              />
                            </div>
                            <div>
                              <div style={{ fontSize: 9, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Duration (min)</div>
                              <input
                                type="number"
                                min={0}
                                defaultValue={trade.durationMinutes ?? ''}
                                key={`dur-${trade.id}`}
                                placeholder="—"
                                onBlur={e => {
                                  const mins = parseInt(e.target.value, 10);
                                  mutateTradeFields(trade.id, { durationMinutes: Number.isFinite(mins) && mins >= 0 ? mins : null });
                                }}
                                style={{ width: 60, padding: '4px 6px', fontSize: 11, fontFamily: 'var(--font-mono)', background: 'var(--app-panel-strong)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--txt)', outline: 'none' }}
                              />
                            </div>
                          </div>
                          <PriceLevelsBlock
                            trade={trade}
                            onMutate={fields => mutateTradeFields(trade.id, fields)}
                          />
                        </div>
                      )}
                    </div>
                  )
                  ))
                ;})()}
              </div></>)}
    </>
  );
}

// ─── SECTION: Fullscreen screenshot modal ─────────────────────────────────────

function ScreenshotFullscreenModal({ isScreenshotFullscreen, currentImage, setIsScreenshotFullscreen }: {
  isScreenshotFullscreen: boolean;
  currentImage: string;
  setIsScreenshotFullscreen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <>
      {isScreenshotFullscreen && currentImage && (
        <div
          className="tj-shot-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Trade screenshot fullscreen"
          onClick={() => setIsScreenshotFullscreen(false)}
        >
          <button
            type="button"
            className="tj-shot-modal-close"
            onClick={() => setIsScreenshotFullscreen(false)}
            aria-label="Close fullscreen screenshot"
          >
            <X size={16} />
          </button>
          <img
            src={currentImage}
            alt="Trade chart fullscreen"
            className="tj-shot-modal-image"
            onClick={event => event.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ─── Scan pipeline (moved verbatim out of TradeJournal's handleScanFile) ─────

interface PerformScanFileCtx {
  preferences: ReturnType<typeof useAppSettings>['preferences'];
  user: ReturnType<typeof useAuth>['user'];
  getDefaultTradeAccountId: ReturnType<typeof useAppSettings>['getDefaultTradeAccountId'];
  applyScannedTrade: (fileDataUrl: string, trade: JournalTrade, date: string) => void;
  setScanError: Dispatch<SetStateAction<string>>;
  setIsScanning: Dispatch<SetStateAction<boolean>>;
  setScanPreviewUrl: Dispatch<SetStateAction<string>>;
}

async function performScanFile(file: File, ctx: PerformScanFileCtx) {
  const { preferences, user, getDefaultTradeAccountId, applyScannedTrade, setScanError, setIsScanning, setScanPreviewUrl } = ctx;
    if (!file.type.startsWith('image/')) {
      setScanError('Upload an image file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setScanError('File is larger than 10MB.');
      return;
    }

    setScanError('');
    setIsScanning(true);
    // Filename date takes priority; otherwise use today. Do NOT fall back to
    // selectedEntry?.date — that causes trades scanned on day N to get stamped
    // as day N-1 when the user still has the previous day's entry selected.
    const tradeDate = inferTradeDateFromFileName(file.name) ?? getTodayIso(preferences.timezone);
    const tradeTime = getNowTime();
    let scanSucceeded = false;

    try {
      const fileDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.readAsDataURL(file);
      });
      setScanPreviewUrl(fileDataUrl);

      const colors = preferences.scannerColors;
      // buildScannerAssets resolves the colors and embeds scanner_colors in the context
      const { focusImages, scannerContext, uploadImage } = await buildScannerAssets(file, {
        entry: colors?.entry,
        stopLoss: colors?.stopLoss,
        takeProfit: colors?.takeProfit,
      });
      let extracted: Awaited<ReturnType<typeof scanChart>>;
      try {
        extracted = await scanChart(uploadImage, tradeDate, tradeTime, focusImages, scannerContext);
      } catch (scanError) {
        // Failed scans are the most valuable eval cases — capture before rethrowing.
        void maybeCaptureScanBundle({
          uploadImage, focusImages, scannerContext,
          error: scanError instanceof Error ? scanError.message : String(scanError),
          sourceFileName: file.name,
        });
        throw scanError;
      }
      void maybeCaptureScanBundle({ uploadImage, focusImages, scannerContext, result: extracted, sourceFileName: file.name });

      const normalizedSymbol = normalizeResolvedSymbol(extracted.symbol) ?? inferSymbolFromFileName(file.name) ?? 'NQ';
      const direction: TradeDirection = extracted.direction === 'Short' ? 'SHORT' : 'LONG';
      const scannerEntry = parsePrice(extracted.entry_price ?? undefined);
      const scannerTp = parsePrice(extracted.tp_price ?? undefined);
      const scannerSl = parsePrice(extracted.sl_price ?? undefined);
      if (scannerEntry === undefined || scannerTp === undefined || scannerSl === undefined) {
        const warningSuffix = Array.isArray(extracted.warnings) && extracted.warnings.length > 0
          ? ` ${extracted.warnings[0]}`
          : '';
        throw new Error(`Scanner could not read entry/stop/target from this chart.${warningSuffix}`);
      }
      // The backend's dedicated first-touch readers are authoritative. Once
      // they resolve SL/TP and a concrete candle, that level is the exit price.
      const exitIsReliable = extracted.exit_reason !== null
        && typeof extracted.first_touch_candle_index === 'number'
        && Number.isFinite(extracted.first_touch_candle_index)
        && extracted.first_touch_candle_index >= 0;
      const scannerExit = exitIsReliable
        ? extracted.exit_reason === 'SL'
          ? scannerSl
          : extracted.exit_reason === 'TP'
            ? scannerTp
            : undefined
        : undefined;
      const entryPrice = scannerEntry ?? 0;
      const exitPrice = scannerExit ?? 0;
      const entryTime = typeof extracted.entry_time === 'string' ? extracted.entry_time.slice(0, 5) : tradeTime;
      const closeTime = typeof extracted.close_time === 'string'
        ? extracted.close_time.slice(0, 5)
        : addSecondsToTime(entryTime, extracted.trade_length_seconds ?? null) ?? entryTime;
      const durationFromSeconds = typeof extracted.trade_length_seconds === 'number'
        ? Math.max(1, Math.round(extracted.trade_length_seconds / 60))
        : null;
      const durationFromTimeRange = minutesBetweenTimes(entryTime, closeTime);
      const durationMinutes = durationFromSeconds ?? durationFromTimeRange;

      const screenshotUrl = user
        ? await uploadScreenshot(fileDataUrl, user.id)
        : fileDataUrl;

      const trade: JournalTrade = {
        id: crypto.randomUUID(),
        date: tradeDate,
        accountId: getDefaultTradeAccountId(),
        accountIds: [getDefaultTradeAccountId()],
        symbol: normalizedSymbol,
        direction,
        entryTime,
        exitTime: closeTime,
        durationMinutes,
        entryPrice,
        exitPrice,
        entry: scannerEntry,
        exit: scannerExit,
        sl: scannerSl,
        tp: scannerTp,
        priceLevelsSource: 'ai',
        priceLevelsEdited: false,
        contracts: 1,
        rr: 0,
        pnl: 0,
        result: 'open',
        screenshotUrl,
        confluences: [],
      };

      applyScannedTrade(screenshotUrl, withTradeDerivedValues(trade), tradeDate);
      scanSucceeded = true;
      // Surface scanner warnings — "verify Win/Loss manually" etc. matter to the
      // user and were previously dropped on success.
      const scanWarnings = (Array.isArray(extracted.warnings) ? extracted.warnings : [])
        .filter(w => typeof w === 'string' && !w.startsWith('Boundary scan:'));
      if (!exitIsReliable || scanWarnings.length > 0) {
        const detail = scanWarnings.find(w => w.toLowerCase().includes('verify')) ?? scanWarnings[0];
        pushToast({
          tone: 'amber',
          durationMs: 6000,
          message: detail
            ? `Trade saved — ${detail}`
            : 'Trade saved — exit unconfirmed, set the exit price manually.',
        });
      } else {
        pushToast({ tone: 'green', durationMs: 3000, message: 'Trade scanned and saved' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scan failed.';
      const lowered = message.toLowerCase();
      if (
        lowered.includes('503') ||
        lowered.includes('529') ||
        lowered.includes('high demand') ||
        lowered.includes('service unavailable') ||
        lowered.includes('overloaded') ||
        lowered.includes('temporarily busy')
      ) {
        setScanError('Scanner AI is temporarily busy. Please retry in 10-20 seconds.');
      } else if (lowered.includes('failed to fetch')) {
        setScanError('Could not reach the scanner service. Please try again in a moment.');
      } else {
        setScanError(message);
      }
    } finally {
      setIsScanning(false);
      if (scanSucceeded) {
        setScanPreviewUrl('');
      }
    }
}

// ─── CSV import (moved verbatim out of TradeJournal's handleCSVImport) ───────

async function importTradesFromCsv(trades: Array<{
    symbol: string; direction: 'Long' | 'Short';
    entry_price: number; exit_price: number; pnl: number; trade_date: string;
    trade_time?: string; close_time?: string; contract_size?: number;
    sl_price?: number; tp_price?: number; pre_trade_notes?: string;
    followed_plan?: boolean; emotional_state?: string; confluences?: string[];
  }>, createTrade: ReturnType<typeof useTrades>['createTrade']) {
    let ok = 0;
    for (const t of trades) {
      try {
        await createTrade({
          symbol: t.symbol,
          direction: t.direction,
          entry_price: t.entry_price,
          exit_price: t.exit_price,
          sl_price: t.sl_price ?? t.entry_price,
          tp_price: t.tp_price ?? t.entry_price,
          exit_reason: t.pnl > 0 ? 'TP' : t.pnl < 0 ? 'SL' : 'BE',
          pnl: t.pnl,
          pnlOverride: t.pnl,
          contract_size: t.contract_size ?? 1,
          trade_date: t.trade_date,
          trade_time: t.trade_time ?? '09:30',
          close_time: t.close_time ?? null,
          pre_trade_notes: t.pre_trade_notes ?? '',
          post_trade_notes: '',
          followed_plan: t.followed_plan ?? null,
          emotional_state: t.emotional_state ?? null,
          confluences: t.confluences ?? [],
        });
        ok++;
      } catch {
        // skip individual failures, count successes
      }
    }
    pushToast({ tone: 'green', durationMs: 4000, message: `Imported ${ok} trade${ok !== 1 ? 's' : ''} from CSV` });
    void flushSupabaseStoreNow().catch(() => {});
}

// ─── Entries mutation + safety guard (moved verbatim out of mutateEntries) ───

function applyEntriesMutation(
  updater: (prev: JournalEntry[]) => JournalEntry[],
  rulesTemplate: string[],
  setEntriesInStore: (entries: StoreJournalEntry[]) => void,
) {
    const storeState = useFlyxaStore.getState();
    const current = normalizeEntries(storeState.entries as unknown[], rulesTemplate);
    // Scanner entries represent traded days. Moving or deleting the final trade
    // must also remove its empty day instead of leaving a "No trades" shell.
    // Pass preSessionHistory so no-trade days with a pre/post session are kept.
    const next = pruneEmptyJournalEntries(
      updater(current),
      storeState.preSessionHistory as Record<string, unknown>,
    );

    // Safety guard: abort if a trade that wasn't explicitly deleted has gone
    // missing. Catches bugs where logic errors or pruning would silently drop data.
    const deletedIds = new Set<string>(
      Array.isArray(storeState.deletedTradeIds)
        ? (storeState.deletedTradeIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
    );
    const nextTradeIds = new Set<string>(
      next.flatMap(e => e.trades.map(t => t.id).filter((id): id is string => typeof id === 'string'))
    );
    const lostTrades = current.flatMap(e => e.trades).filter(t => {
      if (typeof t.id !== 'string') return false;
      if (deletedIds.has(t.id)) return false;
      if (nextTradeIds.has(t.id)) return false;
      // Phantom trades (unfilled blanks: no price, no pnl, no screenshot) are
      // legitimately cleaned up by the mount/leave cleanup without touching deletedTradeIds.
      if (t.result === 'open' && t.pnl === 0 && (t.entryPrice ?? 0) === 0 && (t.exitPrice ?? 0) === 0 && !t.screenshotUrl) return false;
      return true;
    });
    if (lostTrades.length > 0) {
      pushToast({
        tone: 'red',
        durationMs: 10_000,
        message: `⚠️ Save aborted: ${lostTrades.length} trade(s) would have been lost unexpectedly. No data was changed.`,
      });
      return;
    }

    setEntriesInStore(next as unknown as StoreJournalEntry[]);
    const updatedState = useFlyxaStore.getState();
    void saveStoreStatePatchNow({
      entries: updatedState.entries,
      deletedTradeIds: updatedState.deletedTradeIds,
      deletedEntryDates: updatedState.deletedEntryDates,
      restoredEntryDates: updatedState.restoredEntryDates,
    }).catch(() => {
      pushToast({
        tone: 'red',
        durationMs: 8000,
        message: '⚠️ Could not save to cloud — your changes are local only. Stay on this device or try again.',
      });
    });
}

// ─── Trade date move (moved verbatim out of TradeJournal's saveTradeDate) ────

interface SaveTradeDateCtx {
  selectedEntry: JournalEntry | null;
  activeTrade: JournalTrade | null;
  tradeDateDraft: string;
  preferences: ReturnType<typeof useAppSettings>['preferences'];
  rulesTemplate: string[];
  getDefaultTradeAccountId: ReturnType<typeof useAppSettings>['getDefaultTradeAccountId'];
  mutateEntries: (updater: (prev: JournalEntry[]) => JournalEntry[]) => void;
  setSelectedEntryId: Dispatch<SetStateAction<string | null>>;
  setActiveTradeId: Dispatch<SetStateAction<string | null>>;
  setMonthCursor: Dispatch<SetStateAction<Date>>;
  setIsTradeDateEditorOpen: Dispatch<SetStateAction<boolean>>;
}

function performSaveTradeDate(ctx: SaveTradeDateCtx) {
  const { selectedEntry, activeTrade, tradeDateDraft, preferences, rulesTemplate, getDefaultTradeAccountId, mutateEntries, setSelectedEntryId, setActiveTradeId, setMonthCursor, setIsTradeDateEditorOpen } = ctx;
    if (!selectedEntry || !activeTrade) return;
    const nextDate = tradeDateDraft.trim();
    if (!isValidIsoDate(nextDate)) {
      pushToast({ tone: 'red', durationMs: 3000, message: 'Enter a valid date (YYYY-MM-DD).' });
      return;
    }
    if (nextDate > getTodayIso(preferences.timezone)) {
      pushToast({ tone: 'red', durationMs: 3000, message: 'Trade date cannot be in the future.' });
      return;
    }

    const currentTradeDate = getTradeDateValue(activeTrade, selectedEntry.date);
    // Only skip the move if the date hasn't changed AND the trade is already in the right entry
    if (nextDate === currentTradeDate && selectedEntry.date === nextDate) {
      setIsTradeDateEditorOpen(false);
      return;
    }

    let nextSelectedId: string | null = null;
    mutateEntries((prev) => {
      let movedTrade: JournalTrade | null = null;
      const withoutTrade = prev.map((entry) => {
        const tradeIdx = entry.trades.findIndex((trade) => trade.id === activeTrade.id);
        if (tradeIdx < 0) return entry;
        movedTrade = entry.trades[tradeIdx];
        return {
          ...entry,
          trades: entry.trades.filter((trade) => trade.id !== activeTrade.id),
        };
      });

      if (!movedTrade) return prev;
      const tradeToMove = movedTrade as JournalTrade;
      const movedWithDate = withTradeDerivedValues({ ...tradeToMove, date: nextDate });
      const target = withoutTrade.find((entry) => entry.date === nextDate);

      if (target) {
        nextSelectedId = target.id;
        return withoutTrade.map((entry) => (
          entry.id === target.id
            ? { ...entry, trades: [movedWithDate, ...entry.trades] }
            : entry
        ));
      }

      const created = createEmptyEntry(nextDate, rulesTemplate, tradeToMove.accountId ?? getDefaultTradeAccountId());
      created.trades = [movedWithDate];
      nextSelectedId = created.id;
      return [created, ...withoutTrade];
    });

    if (nextSelectedId) {
      setSelectedEntryId(nextSelectedId);
      setActiveTradeId(activeTrade.id);
    }
    const parsed = parseDate(nextDate);
    setMonthCursor(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    setIsTradeDateEditorOpen(false);
    pushToast({ tone: 'green', durationMs: 3000, message: 'Trade moved to selected date.' });
}

// ─── Scanned-trade insertion (moved verbatim out of applyScannedTrade) ───────

interface ApplyScannedTradeCtx {
  mutateEntries: (updater: (prev: JournalEntry[]) => JournalEntry[]) => void;
  selectedEntryId: string | null;
  rulesTemplate: string[];
  getDefaultTradeAccountId: ReturnType<typeof useAppSettings>['getDefaultTradeAccountId'];
  setSelectedEntryId: Dispatch<SetStateAction<string | null>>;
  setMonthCursor: Dispatch<SetStateAction<Date>>;
  setActiveTradeId: Dispatch<SetStateAction<string | null>>;
}

function performApplyScannedTrade(fileDataUrl: string, trade: JournalTrade, date: string, ctx: ApplyScannedTradeCtx) {
  const { mutateEntries, selectedEntryId, rulesTemplate, getDefaultTradeAccountId, setSelectedEntryId, setMonthCursor, setActiveTradeId } = ctx;
    let nextSelectedId: string | null = null;
    mutateEntries(prev => {
      // Prefer the entry whose date matches the trade — if the user has a
      // different day's entry selected, the scanned trade still lands on the
      // correct date (and creates a new entry if that date doesn't exist yet).
      const existing = prev.find(entry => entry.date === date) ?? prev.find(entry => entry.id === selectedEntryId);
      if (existing) {
        nextSelectedId = existing.id;
        return prev.map(entry => {
          if (entry.id !== existing.id) return entry;
          const shots = [...entry.screenshots];
          shots[0] = fileDataUrl;
          return {
            ...entry,
            scannedImageUrl: fileDataUrl,
            screenshots: shots,
            trades: [trade, ...entry.trades],
          };
        });
      }
      const created = createEmptyEntry(date, rulesTemplate, trade.accountId ?? getDefaultTradeAccountId());
      created.scannedImageUrl = fileDataUrl;
      created.screenshots[0] = fileDataUrl;
      created.trades = [trade];
      nextSelectedId = created.id;
      return [created, ...prev];
    });
    if (nextSelectedId) {
      setSelectedEntryId(nextSelectedId);
    }
    const scannedMonth = parseDate(date);
    setMonthCursor(new Date(scannedMonth.getFullYear(), scannedMonth.getMonth(), 1));
    setActiveTradeId(trade.id);
}
