import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, Clock3, Expand, ImagePlus, Sparkles, Wand2, X, Upload } from 'lucide-react';
import TradeForm from './TradeForm.js';
import { Trade } from '../../types/index.js';
import { lookupContract } from '../../constants/futuresContracts.js';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import { scanChart } from '../../utils/scanChart.js';
import DatePicker from '../common/DatePicker.js';
import { pushToast } from '../../store/toastStore.js';
import { useScanStore } from '../../store/scanStore.js';
import { buildScannerAssets, inferSymbolFromFileName, inferTradeDateFromFileName, normalizeResolvedSymbol } from '../../utils/tradeScannerPipeline.js';

const DRAFT_KEY = 'tw_scanner_draft';
const DRAFT_IMAGE_KEY = 'tw_scanner_draft_image';

const ACCOUNT_STATUS_STYLES = {
  Eval:   'border-blue-400/30 bg-blue-500/10 text-blue-300',
  Funded: 'border-amber-400/30 bg-amber-500/10 text-amber-300',
  Live:   'border-purple-400/30 bg-purple-500/10 text-purple-300',
  Passed: 'border-green-400/30 bg-green-500/10 text-green-300',
  Blown:  'border-red-400/30 bg-red-500/10 text-red-300',
} as const;

function readScannerDraft(): Partial<Trade> | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (!saved) {
      return null;
    }

    const parsed = JSON.parse(saved) as { data?: Partial<Trade> };
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}


interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<Trade>) => Promise<void>;
  editTrade?: Trade | null;
  prefillTrade?: Partial<Trade> | null;
  initialImageFile?: File | null;
  readOnly?: boolean;
  sharedByName?: string;
}

export default function ScreenshotImportModal({ isOpen, onClose, onSave, editTrade, prefillTrade, initialImageFile, readOnly = false, sharedByName }: Props) {
  const { accounts, preferences, getDefaultTradeAccountId, isTradeAccountAllocatable, resolveTradeAccountId } = useAppSettings();
  const normalizeTradeAccountIds = useCallback((trade: Partial<Trade> | null | undefined) => {
    const rawIds = Array.isArray(trade?.accountIds) ? trade.accountIds : [];
    const primary = trade ? resolveTradeAccountId(trade) : getDefaultTradeAccountId();
    return Array.from(new Set([...rawIds, primary].filter((id): id is string => typeof id === 'string' && id.length > 0)));
  }, [getDefaultTradeAccountId, resolveTradeAccountId]);
  const getInitialTradeAccountId = useCallback(() => {
    const baseTrade = editTrade ?? prefillTrade ?? null;
    if (baseTrade?.accountId || baseTrade?.account_id || baseTrade?.id) {
      return resolveTradeAccountId(baseTrade);
    }

    return getDefaultTradeAccountId();
  }, [editTrade, getDefaultTradeAccountId, prefillTrade, resolveTradeAccountId]);
  const getInitialContractSize = useCallback(
    () => String(Math.max(1, Number(editTrade?.contract_size ?? prefillTrade?.contract_size ?? readScannerDraft()?.contract_size ?? 1))),
    [editTrade?.contract_size, prefillTrade?.contract_size]
  );

  const [scanning, setScanning]           = useState(() => !editTrade && !prefillTrade ? useScanStore.getState().scanning : false);
  const [scanError, setScanError]         = useState(() => !editTrade && !prefillTrade ? useScanStore.getState().error : '');
  const [warnings, setWarnings]           = useState<string[]>(() => !editTrade && !prefillTrade ? (useScanStore.getState().result?.warnings ?? []) : []);
  const [scanEvidence, setScanEvidence]   = useState<string>(() => !editTrade && !prefillTrade ? (useScanStore.getState().result?.evidence ?? '') : '');
  const [formData, setFormData]           = useState<Partial<Trade> | null>(() => {
    if (editTrade) return editTrade;
    if (prefillTrade) return prefillTrade;
    return readScannerDraft();
  });
  const [aiFields, setAiFields]           = useState<Set<string>>(() => {
    if (editTrade || prefillTrade) return new Set();
    const r = useScanStore.getState().result;
    return r ? new Set(r.aiFields) : new Set();
  });
  const [imagePreview, setImagePreview]   = useState<string | null>(() => {
    if (editTrade) return editTrade.screenshot_url ?? null;
    try { return localStorage.getItem(DRAFT_IMAGE_KEY) ?? null; } catch { return null; }
  });
  const [fullscreenPreview, setFullscreenPreview] = useState(false);
  const [isDragging, setIsDragging]       = useState(false);
  const [saving, setSaving]              = useState(false);
  const [contractInputValue, setContractInputValue] = useState(() => getInitialContractSize());
  const [tradeAccountId, setTradeAccountId] = useState(() => getInitialTradeAccountId());

  const [currentDate, setCurrentDate] = useState(
    () => editTrade?.trade_date ?? prefillTrade?.trade_date ?? readScannerDraft()?.trade_date ?? ''
  );
  const [currentTime, setCurrentTime] = useState(
    () => editTrade?.trade_time ?? prefillTrade?.trade_time ?? readScannerDraft()?.trade_time ?? ''
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoImportedImageKeyRef = useRef('');
  const mountedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const accountById = useMemo(() => new Map(accounts.map(account => [account.id, account] as const)), [accounts]);
  const existingTradeAccountId = editTrade ? resolveTradeAccountId(editTrade) : null;
  const selectedTradeAccount = accountById.get(tradeAccountId);
  const selectedTradeAccountIsAllocatable = tradeAccountId ? isTradeAccountAllocatable(tradeAccountId) : false;
  const hasAllocatableAccount = useMemo(
    () => accounts.some(account => isTradeAccountAllocatable(account.id)),
    [accounts, isTradeAccountAllocatable]
  );
  const selectedTradeAccountStatusClass = selectedTradeAccount
    ? ACCOUNT_STATUS_STYLES[selectedTradeAccount.status]
    : null;

  const getFallbackScanDate = () => new Date().toISOString().split('T')[0];
  const getFallbackScanTime = () =>
    new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const savedDraft = !editTrade && !prefillTrade ? readScannerDraft() : null;

    setCurrentDate(editTrade?.trade_date ?? prefillTrade?.trade_date ?? savedDraft?.trade_date ?? '');
    setCurrentTime(editTrade?.trade_time ?? prefillTrade?.trade_time ?? savedDraft?.trade_time ?? '');
    if (editTrade) {
      setImagePreview(editTrade.screenshot_url ?? null);
    } else {
      try { setImagePreview(localStorage.getItem(DRAFT_IMAGE_KEY) ?? null); } catch { setImagePreview(null); }
    }
    setContractInputValue(String(Math.max(1, Number(editTrade?.contract_size ?? prefillTrade?.contract_size ?? savedDraft?.contract_size ?? 1))));
    setTradeAccountId(getInitialTradeAccountId());

    if (editTrade || prefillTrade) {
      setAiFields(new Set());
      setWarnings([]);
      setScanEvidence('');
      setScanError('');
    } else {
      const { scanning: storeScan, result: storeResult, error: storeErr } = useScanStore.getState();
      if (storeScan) setScanning(true);
      setAiFields(storeResult ? new Set(storeResult.aiFields) : new Set());
      setWarnings(storeResult?.warnings ?? []);
      setScanEvidence(storeResult?.evidence ?? '');
      setScanError(storeErr);
    }

    if (editTrade) {
      setFormData(editTrade);
      return;
    }

    if (prefillTrade) {
      setFormData(prefillTrade);
      return;
    }

    setFormData(savedDraft ?? null);
  }, [editTrade, getInitialContractSize, getInitialTradeAccountId, isOpen, prefillTrade]);

  // Subscribe to scan store — syncs local state when scan completes while this component is mounted
  const storeScan = useScanStore(s => s.scanning);
  const storeResult = useScanStore(s => s.result);
  const storeError = useScanStore(s => s.error);
  useEffect(() => {
    if (!isOpen || editTrade || prefillTrade) return;
    if (storeScan) {
      setScanning(true);
    } else {
      setScanning(false);
      if (storeResult) {
        setAiFields(new Set(storeResult.aiFields));
        setWarnings(storeResult.warnings);
        setScanEvidence(storeResult.evidence);
        setScanError('');
        const draft = readScannerDraft();
        if (draft) setFormData(draft);
        try { const img = localStorage.getItem(DRAFT_IMAGE_KEY); if (img) setImagePreview(img); } catch {}
      } else if (storeError) {
        setScanError(storeError);
      }
    }
  }, [storeScan, storeResult, storeError, isOpen, editTrade, prefillTrade]);

  const handleFormDraftChange = useCallback((draftData: Partial<Trade>) => {
    if (!isOpen || editTrade) {
      return;
    }

    const parsedContractInput = Number.parseInt(contractInputValue, 10);
    const contractSize = Number.isFinite(parsedContractInput) && parsedContractInput > 0
      ? parsedContractInput
      : draftData.contract_size;
    const persistedDraft: Partial<Trade> = {
      ...draftData,
      accountId: (draftData.accountIds?.[0] ?? draftData.accountId ?? tradeAccountId) || getDefaultTradeAccountId(),
      accountIds: draftData.accountIds ?? [tradeAccountId || getDefaultTradeAccountId()],
      contract_size: contractSize,
      trade_date: currentDate || draftData.trade_date,
      trade_time: currentTime || draftData.trade_time,
      screenshot_url: imagePreview ?? undefined,
    };

    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: persistedDraft }));
    } catch {
      // ignore localStorage quota/write errors
    }
  }, [
    contractInputValue,
    currentDate,
    currentTime,
    editTrade,
    getDefaultTradeAccountId,
    imagePreview,
    isOpen,
    tradeAccountId,
  ]);

  useEffect(() => {
    if (!isOpen || editTrade) {
      return;
    }

    const existingDraft = readScannerDraft();
    const hasSomethingToPersist = Boolean(currentDate || currentTime || formData || existingDraft);
    if (!hasSomethingToPersist) {
      return;
    }

    const base = formData ?? existingDraft ?? {};
    const nextDraft: Partial<Trade> = {
      ...base,
      trade_date: currentDate || undefined,
      trade_time: currentTime || undefined,
    };

    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: nextDraft }));
    } catch {
      // ignore localStorage quota/write errors
    }
  }, [currentDate, currentTime, editTrade, formData, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const reset = () => {
    setFormData(editTrade ?? prefillTrade ?? null);
    setAiFields(new Set());
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(DRAFT_IMAGE_KEY);
    useScanStore.getState().clearScan();
    setImagePreview(editTrade?.screenshot_url ?? null);
    setFullscreenPreview(false);
    setScanError('');
    setWarnings([]);
    setScanEvidence('');
    setCurrentDate(editTrade?.trade_date ?? prefillTrade?.trade_date ?? '');
    setCurrentTime(editTrade?.trade_time ?? prefillTrade?.trade_time ?? '');
    setContractInputValue(getInitialContractSize());
    setTradeAccountId(getInitialTradeAccountId());
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = useCallback(() => {
    setFormData(editTrade ?? prefillTrade ?? null);
    setAiFields(new Set());
    setImagePreview(editTrade?.screenshot_url ?? null);
    setFullscreenPreview(false);
    setScanError('');
    setWarnings([]);
    setScanEvidence('');
    setCurrentDate(editTrade?.trade_date ?? prefillTrade?.trade_date ?? '');
    setCurrentTime(editTrade?.trade_time ?? prefillTrade?.trade_time ?? '');
    setContractInputValue(getInitialContractSize());
    setTradeAccountId(getInitialTradeAccountId());
    if (fileInputRef.current) fileInputRef.current.value = '';
    onClose();
  }, [editTrade, getInitialContractSize, getInitialTradeAccountId, onClose, prefillTrade]);

  const handleImageSelected = useCallback(async (file: File) => {
    setScanError('');
    setWarnings([]);
    setScanning(true);
    useScanStore.getState().startScan();

    const reader = new FileReader();
    reader.onload = e => {
      const preview = e.target?.result as string;
      setImagePreview(preview);
      if (!editTrade) {
        try { localStorage.setItem(DRAFT_IMAGE_KEY, preview); } catch { /* quota exceeded — skip */ }
      }
    };
    reader.readAsDataURL(file);

    try {
      const fileTradeDate = !editTrade ? inferTradeDateFromFileName(file.name) : null;
      const scanDate = fileTradeDate || currentDate || getFallbackScanDate();
      const scanTime = currentTime || getFallbackScanTime();
      if (fileTradeDate) {
        setCurrentDate(fileTradeDate);
      }
      const colors = preferences.scannerColors;
      const { focusImages, scannerContext: rawContext, uploadImage } = await buildScannerAssets(file, {
        entry: colors?.entry,
        stopLoss: colors?.stopLoss,
        takeProfit: colors?.takeProfit,
      });
      const enrichedContext: Record<string, unknown> = {
        ...(rawContext ?? {}),
        scanner_colors: {
          entryZone: { hex: colors?.entry ?? '#E67E22' },
          supplyStopZone: { hex: colors?.stopLoss ?? '#C0392B' },
          targetDemandZone: { hex: colors?.takeProfit ?? '#1A6B5A' },
        },
      };
      const extracted = await scanChart(
        uploadImage,
        scanDate,
        scanTime,
        focusImages,
        enrichedContext
      );
      const INTERNAL_WARNINGS = new Set([
        'Exact price-label review failed, so price levels relied on the broader chart reads.',
        'Exit verification failed — relying on manual chart read.',
        'Exit verification failed, so the final answer relied on the manual chart read.',
        'Stop/target sanity check failed, so the final answer relied on the broader exit review.',
        'Header symbol/timeframe read failed, so identity relied on the broader chart reads.',
        'Primary chart extraction failed, so the scanner fell back to the human-style review pass.',
        'Human-style review failed, so the scanner relied on the primary extraction pass.',
        'Final consensus review failed, so the result relied on the primary extraction passes.',
        'Sanity check failed — relying on exit verification result.',
      ]);
      const w: string[] = (Array.isArray(extracted.warnings) ? extracted.warnings : [])
        .filter((msg: string) => !INTERNAL_WARNINGS.has(msg));
      const fields = new Set<string>();
      const baseTrade = editTrade ?? prefillTrade ?? formData ?? null;
      const mapped: Partial<Trade> = {
        ...baseTrade,
        accountId: tradeAccountId || getDefaultTradeAccountId(),
        accountIds: normalizeTradeAccountIds(baseTrade).length > 0 ? normalizeTradeAccountIds(baseTrade) : [tradeAccountId || getDefaultTradeAccountId()],
        trade_date: fileTradeDate || currentDate || undefined,
        trade_time: currentTime || undefined,
        contract_size: Math.max(1, Number(formData?.contract_size ?? prefillTrade?.contract_size ?? editTrade?.contract_size ?? 1)),
      };
      if (fileTradeDate) {
        fields.add('trade_date');
      }
      const resolvedSymbol = normalizeResolvedSymbol(extracted.symbol) ?? inferSymbolFromFileName(file.name);
      if (resolvedSymbol) {
        mapped.symbol = resolvedSymbol;
        if (normalizeResolvedSymbol(extracted.symbol)) {
          fields.add('symbol');
        }
      }
      if (extracted.direction)  { mapped.direction = extracted.direction as 'Long'|'Short'; fields.add('direction'); }
      if (extracted.entry_price){ mapped.entry_price = Number(extracted.entry_price); fields.add('entry_price');
        const inst = lookupContract(mapped.symbol ?? '');
        if (inst) mapped.point_value = inst.point_value;
      }
      if (extracted.sl_price)   { mapped.sl_price = Number(extracted.sl_price); fields.add('sl_price'); }
      if (extracted.tp_price)   { mapped.tp_price = Number(extracted.tp_price); fields.add('tp_price'); }
      if (extracted.exit_reason){
        const r = extracted.exit_reason as 'TP'|'SL';
        mapped.exit_reason = r; fields.add('exit_reason');
        mapped.exit_price = r === 'TP' ? Number(extracted.tp_price ?? 0) : Number(extracted.sl_price ?? 0);
      }

      if (extracted.entry_time) {
        const timeValue = (extracted.entry_time as string).slice(0, 5);
        mapped.trade_time = timeValue;
        setCurrentTime(timeValue);
        fields.add('trade_time');
      } else {
        // No time detected — clear any stale value from a prior scan draft
        setCurrentTime('');
      }
      if (extracted.close_time) {
        mapped.close_time = (extracted.close_time as string).slice(0, 5);
        fields.add('close_time');
      }
      if (extracted.trade_length_seconds){ mapped.trade_length_seconds = Number(extracted.trade_length_seconds); fields.add('trade_length_seconds'); }
      if (extracted.candle_count)     mapped.candle_count = Number(extracted.candle_count);
      if (extracted.timeframe_minutes) mapped.timeframe_minutes = Number(extracted.timeframe_minutes);

      const evidence = extracted.first_touch_evidence ?? '';
      useScanStore.getState().completeScan({ aiFields: [...fields], warnings: w, evidence });
      if (!mountedRef.current) {
        pushToast({ tone: 'green', durationMs: 6000, message: 'Trade scan complete — open the journal to review.' });
      }
      setAiFields(fields);
      setFormData(mapped);
      setWarnings(w);
      setScanEvidence(evidence);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: mapped }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan image';
      useScanStore.getState().failScan(msg);
      setScanError(msg);
    } finally {
      setScanning(false);
    }
  }, [currentDate, currentTime, editTrade?.contract_size, formData?.contract_size, getDefaultTradeAccountId, prefillTrade?.contract_size, tradeAccountId]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) handleImageSelected(file);
  }, [handleImageSelected]);

  useEffect(() => {
    if (!isOpen) {
      autoImportedImageKeyRef.current = '';
      return;
    }

    if (!initialImageFile || editTrade) {
      return;
    }

    const imageKey = `${initialImageFile.name}:${initialImageFile.size}:${initialImageFile.lastModified}`;
    if (autoImportedImageKeyRef.current === imageKey) {
      return;
    }

    autoImportedImageKeyRef.current = imageKey;
    void handleImageSelected(initialImageFile);
  }, [editTrade, handleImageSelected, initialImageFile, isOpen]);

  const handleSave = async (data: Partial<Trade>) => {
    const selectedAccountIds = Array.from(new Set((data.accountIds?.length ? data.accountIds : [data.accountId ?? tradeAccountId]).filter((id): id is string => typeof id === 'string' && id.length > 0)));

    if (selectedAccountIds.length === 0) {
      pushToast({ tone: 'amber', durationMs: 3500, message: 'Select an account before saving this trade.' });
      return;
    }

    const invalidAccount = selectedAccountIds
      .map(accountId => accountById.get(accountId))
      .find(account => account && !isTradeAccountAllocatable(account.id) && account.id !== existingTradeAccountId);

    if (invalidAccount) {
      pushToast({
        tone: 'amber',
        durationMs: 4500,
        message: `${invalidAccount.name} is marked as ${invalidAccount.status} and cannot be allocated to a trade.`,
      });
      return;
    }

    setSaving(true);
    try {
      await onSave({
        ...data,
        accountId: selectedAccountIds[0] || getDefaultTradeAccountId(),
        account_id: selectedAccountIds[0] || getDefaultTradeAccountId(),
        accountIds: selectedAccountIds,
        screenshot_url: imagePreview ?? editTrade?.screenshot_url ?? undefined,
      });
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_IMAGE_KEY);
      useScanStore.getState().clearScan();
      handleClose();
    } catch (err) {
      pushToast({ tone: 'red', durationMs: 4500, message: err instanceof Error ? err.message : 'Failed to save trade.' });
    } finally {
      setSaving(false);
    }
  };

  const topInputClass = 'input-field h-12 border border-amber-400/70 bg-slate-950/80 shadow-[0_0_0_1px_rgba(245,158,11,0.18),0_0_18px_rgba(245,158,11,0.14)]';
  const hasPreviewImage = Boolean(imagePreview);
  const reviewSectionTitle = editTrade ? 'Review screenshot' : 'Import screenshot';
  const reviewSectionCopy = editTrade
    ? 'View the journaled chart in fullscreen, or upload a replacement screenshot and rescan this trade.'
    : 'Scan a TradingView chart, then review the extracted trade details before saving.';
  const handleContractSizeChange = (value: string) => {
    setContractInputValue(value);

    if (value === '') {
      setFormData(current => ({
        ...(current ?? {}),
        contract_size: undefined,
      }));
      return;
    }

    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return;
    }

    setFormData(current => ({
      ...(current ?? {}),
      contract_size: parsedValue,
    }));
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      if (fullscreenPreview) {
        setFullscreenPreview(false);
        return;
      }

      handleClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreenPreview, handleClose, isOpen]);

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 p-4 md:p-6">
        <button
          type="button"
          aria-label="Close trade modal"
          onClick={handleClose}
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        />

        <div className="relative mx-auto h-full max-w-[1400px]">
          <div className="flex h-full flex-col overflow-hidden rounded-[30px] border border-slate-700/70 bg-slate-900/95 shadow-[0_32px_120px_rgba(2,6,23,0.58)]">
            <div className="flex items-center justify-between border-b border-slate-700/80 px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {readOnly ? 'Shared Trade' : editTrade ? 'Edit Trade' : 'Add Trade'}
                </h2>
                {readOnly && sharedByName && (
                  <p className="text-xs text-slate-400 mt-0.5">shared by {sharedByName}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                {scanning && !readOnly && (
                  <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-200">
                    <span className="h-3 w-3 rounded-full border-2 border-blue-300 border-t-transparent animate-spin" />
                    Flyxa is analysing your trade
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-700/70 bg-slate-900/80 text-slate-400 transition hover:border-slate-500 hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5 md:py-5">
              <div className="flex min-h-full flex-col gap-5">

        {/* Trade date/time + warnings */}
        {!readOnly && <div className="rounded-2xl border border-slate-700/60 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.12),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.88))] px-4 py-4 shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Trade Date/Time</p>
              <h3 className="text-lg font-semibold text-slate-100">Add the trade anchor anytime before you save</h3>
              <p className="text-sm text-slate-400">You can fill these before, during, or after the scan. Saving still requires both fields.</p>
            </div>
            <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-xl">
              <label className="space-y-1.5">
                <span className="flex items-center gap-2 text-xs font-medium text-amber-300">
                  <CalendarDays size={14} />
                  Trade Date
                </span>
                <DatePicker
                  className={topInputClass}
                  value={currentDate}
                  onChange={setCurrentDate}
                  fullWidth
                  align="left"
                />
              </label>
              <label className="space-y-1.5">
                <span className="flex items-center gap-2 text-xs font-medium text-amber-300">
                  <Clock3 size={14} />
                  Trade Time
                </span>
                <input
                  type="time"
                  className={topInputClass}
                  value={currentTime}
                  onChange={e => setCurrentTime(e.target.value)}
                  required
                />
              </label>
            </div>
          </div>
        </div>}

        {!readOnly && scanEvidence && (
          <div className="rounded-xl border border-blue-500/25 bg-blue-500/10 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300/80">AI Scan Note</p>
            <p className="mt-1 text-sm text-blue-200">{scanEvidence}</p>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/10 px-4 py-3 space-y-1.5">
            {warnings.map((w, i) => <p key={i} className="text-yellow-400 text-xs">⚠ {w}</p>)}
          </div>
        )}

        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">

          {/* Left: image upload / preview */}
          <div className="min-w-0">
            <div className="flex flex-col gap-4 rounded-[28px] border border-slate-700/60 bg-[linear-gradient(180deg,rgba(15,23,42,0.92),rgba(15,23,42,0.78))] p-4 shadow-[0_24px_60px_rgba(2,6,23,0.32)]">
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => e.target.files?.[0] && handleImageSelected(e.target.files[0])} />

              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Chart Scanner</p>
                  <h3 className="mt-1 text-xl font-semibold text-slate-100">{reviewSectionTitle}</h3>
                  <p className="mt-1 text-sm text-slate-400">{reviewSectionCopy}</p>
                </div>
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-3 text-blue-300">
                  <Wand2 size={18} />
                </div>
              </div>

              {hasPreviewImage ? (
                <div className="relative overflow-hidden rounded-[24px] border border-slate-700/60 bg-slate-950/90 shadow-[inset_0_1px_0_rgba(148,163,184,0.06)]">
                  <div className="aspect-[4/3] w-full bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.12),transparent_48%)] p-3">
                    <button
                      type="button"
                      onClick={() => setFullscreenPreview(true)}
                      className="h-full w-full"
                    >
                      <img src={imagePreview!} alt="Chart" className="h-full w-full rounded-2xl object-contain" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFullscreenPreview(true)}
                    className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full border border-slate-600/80 bg-slate-950/90 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
                  >
                    <Expand size={12} />
                    Fullscreen
                  </button>
                  {!editTrade && !readOnly && (
                    <button onClick={reset} className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-slate-600/80 bg-slate-950/90 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white">
                      <X size={12} />
                      Clear
                    </button>
                  )}
                  {scanning && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-950/78 backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-3 rounded-2xl border border-blue-500/20 bg-slate-900/80 px-6 py-5">
                        <div className="h-9 w-9 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                        <div className="text-center">
                          <p className="text-sm font-medium text-blue-200">Analysing with Flyxa</p>
                          <p className="text-xs text-slate-400">Reading levels, entry anchor, and first-touch path</p>
                        </div>
                      </div>
                    </div>
                  )}
                  {!scanning && !readOnly && (
                    <button onClick={() => fileInputRef.current?.click()}
                      className="absolute bottom-3 right-3 inline-flex items-center gap-2 rounded-full border border-slate-600/80 bg-slate-950/90 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-blue-400/50 hover:text-white">
                      <ImagePlus size={13} />
                      {editTrade ? 'Upload New Screenshot' : 'Replace Screenshot'}
                    </button>
                  )}
                </div>
              ) : (
                <div
                  className={`group relative overflow-hidden rounded-[24px] border border-dashed cursor-pointer transition-all flex flex-col items-center justify-center px-6 py-16 select-none ${
                    isDragging
                      ? 'border-blue-400 bg-blue-500/10 shadow-[0_0_0_1px_rgba(59,130,246,0.28),0_18px_45px_rgba(37,99,235,0.16)]'
                      : 'border-slate-600/80 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.1),transparent_40%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.78))] hover:border-blue-400/60 hover:bg-blue-500/8'
                  }`}
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className={`mb-4 rounded-2xl border p-4 transition-all ${isDragging ? 'border-blue-400/50 bg-blue-500/20 text-blue-200' : 'border-slate-600/70 bg-slate-900/70 text-slate-300 group-hover:border-blue-400/40 group-hover:text-blue-200'}`}>
                    <Upload size={28} />
                  </div>
                  <h4 className="text-lg font-semibold text-slate-100">{isDragging ? 'Drop chart to start scan' : 'Drop chart screenshot here'}</h4>
                  <p className="text-slate-500 text-xs">or click to browse · PNG · JPG · WebP</p>
                  <p className="text-slate-600 text-xs mt-3">
                    {editTrade ? 'Upload a screenshot to inspect or rescan this trade' : 'Or fill in the form manually →'}
                  </p>
                </div>
              )}

              {scanError && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">{scanError}</div>
              )}

              <div className="rounded-[24px] border border-slate-700/60 bg-slate-950/70 p-4 shadow-[inset_0_1px_0_rgba(148,163,184,0.04)]">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                  {editTrade ? 'Trade Details' : 'Entry Details'}
                </p>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="label">Account</label>
                    <select
                      className="input-field h-11"
                      value={tradeAccountId}
                      onChange={e => setTradeAccountId(e.target.value)}
                    >
                      {accounts.filter(account => account.id !== DEFAULT_ACCOUNT_ID).map(account => (
                        <option
                          key={account.id}
                          value={account.id}
                          disabled={(account.status === 'Blown' || account.status === 'Passed') && account.id !== tradeAccountId}
                        >
                          {account.name}{account.status === 'Blown' ? ' (Blown)' : account.status === 'Passed' ? ' (Passed)' : ''}
                        </option>
                      ))}
                    </select>
                    {selectedTradeAccount && selectedTradeAccountStatusClass && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${selectedTradeAccountStatusClass}`}>
                          {selectedTradeAccount.status}
                        </span>
                        {!selectedTradeAccountIsAllocatable && tradeAccountId !== existingTradeAccountId && (
                          <span className="text-xs text-red-300">
                            {selectedTradeAccount?.status === 'Passed' ? 'Passed accounts can\'t be allocated to new trades.' : 'Blown accounts can\'t be allocated to new trades.'}
                          </span>
                        )}
                      </div>
                    )}
                    {!hasAllocatableAccount && (
                      <p className="mt-2 text-xs text-red-300">
                        Every account is marked as Blown or Passed. Change one account status before saving a trade.
                      </p>
                    )}
                  </div>
                  <label className="label">Contracts</label>
                  <input
                    type="number"
                    min={1}
                    className="input-field h-11"
                    value={contractInputValue}
                    onChange={e => handleContractSizeChange(e.target.value)}
                    required
                  />
                </div>
              </div>

              {aiFields.size > 0 && (
                <div className="flex items-center gap-2 rounded-xl border border-blue-400/20 bg-blue-400/8 px-4 py-3 text-sm text-blue-200">
                  <Sparkles size={14} />
                  {aiFields.size} fields auto-extracted — review and save
                </div>
              )}
            </div>
          </div>

          {/* Right: form */}
          <div className="min-w-0">
            <div
              className="rounded-[28px] border border-slate-700/60 bg-[linear-gradient(180deg,rgba(15,23,42,0.9),rgba(15,23,42,0.72))] p-4 shadow-[0_24px_60px_rgba(2,6,23,0.32)] md:p-5"
              style={readOnly ? { pointerEvents: 'none' } : undefined}
            >
              <TradeForm
                initialData={formData || undefined}
                aiFields={aiFields}
                tradeDate={currentDate}
                tradeTime={currentTime}
                showContractsField={false}
                showActionBar={!readOnly}
                onSubmit={handleSave}
                onDraftChange={handleFormDraftChange}
                onCancel={handleClose}
                isLoading={saving}
              />
            </div>
            {readOnly && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleClose}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-600/80 bg-slate-800/80 px-6 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-white"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {fullscreenPreview && imagePreview && (
        <div className="fixed inset-0 z-[70]">
          <button
            type="button"
            aria-label="Close trade screenshot"
            onClick={() => setFullscreenPreview(false)}
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at center, rgba(15, 23, 42, 0.16) 0%, rgba(2, 6, 23, 0.78) 68%, rgba(2, 6, 23, 0.92) 100%)',
            }}
          />

          <button
            type="button"
            onClick={() => setFullscreenPreview(false)}
            className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-600/80 bg-slate-950/90 text-slate-300 shadow-[0_12px_28px_rgba(2,6,23,0.34)] transition hover:border-slate-500 hover:text-white"
          >
            <X size={18} />
          </button>

          <div className="absolute inset-[24px] flex items-center justify-center md:inset-[32px]">
            <img
              src={imagePreview}
              alt="Trade screenshot fullscreen"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
