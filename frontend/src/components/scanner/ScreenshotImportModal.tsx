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

const DRAFT_KEY = 'tw_scanner_draft';
const DRAFT_IMAGE_KEY = 'tw_scanner_draft_image';

const SYMBOL_MAP: Record<string, string> = {
  NQM26:'NQ',NQH26:'NQ',NQU26:'NQ',NQZ26:'NQ',
  ESM26:'ES',ESH26:'ES',ESU26:'ES',ESZ26:'ES',
  MNQM26:'MNQ',MNQH26:'MNQ',MNQU26:'MNQ',MNQZ26:'MNQ',
  MESM26:'MES',MESH26:'MES',MESU26:'MES',MESZ26:'MES',
};

function resolveSymbol(raw: string): string {
  return SYMBOL_MAP[raw.toUpperCase()] ?? raw.toUpperCase();
}

function normalizeResolvedSymbol(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  const normalized = resolveSymbol(raw.trim());
  return ['UNKNOWN', 'UNKWN', 'N/A', 'NA', 'NONE', 'NULL'].includes(normalized) ? null : normalized;
}

function inferSymbolFromFileName(fileName: string): string | null {
  const upper = fileName.toUpperCase();
  const match = upper.match(/(?:^|[^A-Z0-9])(MNQ|MES|NQ|ES|MYM|YM|M2K|RTY|CL|MCL|GC|SI|6E)(?=[^A-Z0-9]|$)/);
  return match ? match[1] : null;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function formatDateParts(year: number, month: number, day: number): string | null {
  if (!isValidDateParts(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function inferTradeDateFromFileName(fileName: string): string | null {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const yearFirst = baseName.match(/(?:^|[^0-9])((?:20)\d{2})[-_. ]?([01]?\d)[-_. ]?([0-3]?\d)(?=[^0-9]|$)/);
  if (yearFirst) {
    const parsed = formatDateParts(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    if (parsed) return parsed;
  }

  const dayOrMonthFirst = baseName.match(/(?:^|[^0-9])([0-3]?\d)[-_. ]([0-3]?\d)[-_. ]((?:20)\d{2})(?=[^0-9]|$)/);
  if (dayOrMonthFirst) {
    const first = Number(dayOrMonthFirst[1]);
    const second = Number(dayOrMonthFirst[2]);
    const year = Number(dayOrMonthFirst[3]);
    const dayFirst = formatDateParts(year, second, first);
    if (dayFirst) return dayFirst;
    return formatDateParts(year, first, second);
  }

  return null;
}

interface CropPreset {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ComponentBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  count: number;
}

interface ScannerContext {
  direction_hint?: 'Long' | 'Short';
  chart_left_ratio?: number;
  chart_right_ratio?: number;
  box_left_ratio?: number;
  box_right_ratio?: number;
  entry_line_ratio?: number;
  entry_label_candidate_ratio?: number;
  stop_line_ratio?: number;
  target_line_ratio?: number;
  red_box?: Omit<ComponentBounds, 'count'>;
  green_box?: Omit<ComponentBounds, 'count'>;
}

const DEFAULT_FOCUS_CROPS: CropPreset[] = [
  { name: 'header-focus', x: 0.00, y: 0.00, width: 0.34, height: 0.12 },
  { name: 'trade-box-focus', x: 0.46, y: 0.10, width: 0.30, height: 0.72 },
  { name: 'entry-window-focus', x: 0.40, y: 0.16, width: 0.22, height: 0.62 },
  { name: 'exit-path-focus', x: 0.46, y: 0.16, width: 0.24, height: 0.62 },
  { name: 'price-label-focus', x: 0.78, y: 0.00, width: 0.22, height: 1.00 },
  { name: 'entry-label-focus', x: 0.83, y: 0.40, width: 0.17, height: 0.08 },
  { name: 'stop-label-focus', x: 0.83, y: 0.28, width: 0.17, height: 0.08 },
  { name: 'target-label-focus', x: 0.83, y: 0.52, width: 0.17, height: 0.08 },
];

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

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load chart image for scanner crops'));
    };
    image.src = objectUrl;
  });
}

function canvasToFile(canvas: HTMLCanvasElement, fileName: string, sourceType: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to create scanner crop'));
        return;
      }

      resolve(new File([blob], fileName, { type: sourceType || 'image/png' }));
    }, sourceType || 'image/png', 0.95);
  });
}

async function buildUploadImage(image: HTMLImageElement, fileName: string): Promise<File> {
  const maxWidth = 1800;
  const scale = Math.min(1, maxWidth / Math.max(1, image.naturalWidth || image.width));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to prepare scanner upload image');
  }

  context.drawImage(image, 0, 0, width, height);

  return canvasToFile(canvas, fileName.replace(/\.[^.]+$/, '') + '.webp', 'image/webp');
}

function clampRatio(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function isGreenOverlay(r: number, g: number, b: number): boolean {
  return g > r + 6 && b > r + 2 && g > 140 && b > 140;
}

function isRedOverlay(r: number, g: number, b: number): boolean {
  return r > g + 12 && r > b + 6 && r > 150;
}

function findLargestComponent(mask: Uint8Array, width: number, height: number): ComponentBounds | null {
  const visited = new Uint8Array(mask.length);
  let best: ComponentBounds | null = null;
  const queue = new Int32Array(mask.length);

  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || visited[index]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    visited[index] = 1;
    queue[tail++] = index;

    let count = 0;
    let xMin = width;
    let xMax = 0;
    let yMin = height;
    let yMax = 0;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);

      count++;
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);

      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ];

      neighbors.forEach(next => {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) {
          return;
        }

        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) {
          return;
        }

        visited[next] = 1;
        queue[tail++] = next;
      });
    }

    if (!best || count > best.count) {
      best = { xMin, xMax, yMin, yMax, count };
    }
  }

  return best;
}

function toRatioBounds(bounds: ComponentBounds, width: number, height: number): Omit<ComponentBounds, 'count'> {
  return {
    xMin: bounds.xMin / width,
    xMax: bounds.xMax / width,
    yMin: bounds.yMin / height,
    yMax: bounds.yMax / height,
  };
}

function inferChartPaneBounds(boxLeftRatio: number, boxRightRatio: number): { left: number; right: number } {
  if (boxRightRatio <= 0.48) {
    return { left: 0, right: 0.5 };
  }

  if (boxLeftRatio >= 0.52) {
    return { left: 0.5, right: 1 };
  }

  return { left: 0, right: 1 };
}

function detectTradeBoxContext(image: HTMLImageElement): ScannerContext | null {
  const targetWidth = Math.min(640, image.naturalWidth || image.width);
  const scale = targetWidth / (image.naturalWidth || image.width);
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const redMask = new Uint8Array(width * height);
  const greenMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x > width * 0.88) {
        continue;
      }

      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const pixelIndex = y * width + x;

      if (isRedOverlay(r, g, b)) {
        redMask[pixelIndex] = 1;
      }

      if (isGreenOverlay(r, g, b)) {
        greenMask[pixelIndex] = 1;
      }
    }
  }

  const redBox = findLargestComponent(redMask, width, height);
  const greenBox = findLargestComponent(greenMask, width, height);

  if (!redBox || !greenBox || redBox.count < 200 || greenBox.count < 200) {
    return null;
  }

  const boxLeftRatio = Math.min(redBox.xMin, greenBox.xMin) / width;
  const boxRightRatio = Math.max(redBox.xMax, greenBox.xMax) / width;
  const chartPane = inferChartPaneBounds(boxLeftRatio, boxRightRatio);
  const redCenterY = (redBox.yMin + redBox.yMax) / 2;
  const greenCenterY = (greenBox.yMin + greenBox.yMax) / 2;
  const directionHint =
    redCenterY < greenCenterY
      ? 'Short'
      : greenCenterY < redCenterY
        ? 'Long'
        : undefined;

  let entryLineRatio: number | undefined;
  let stopLineRatio: number | undefined;
  let targetLineRatio: number | undefined;
  if (directionHint === 'Long') {
    entryLineRatio = greenBox.yMax / height;
    stopLineRatio = redBox.yMax / height;
    targetLineRatio = greenBox.yMin / height;
  } else if (directionHint === 'Short') {
    entryLineRatio = redBox.yMax / height;
    stopLineRatio = redBox.yMin / height;
    targetLineRatio = greenBox.yMax / height;
  }
  const entryLabelCandidateRatio = directionHint === 'Short'
    ? greenBox.yMax / height
    : entryLineRatio;

  return {
    direction_hint: directionHint,
    chart_left_ratio: chartPane.left,
    chart_right_ratio: chartPane.right,
    box_left_ratio: boxLeftRatio,
    box_right_ratio: boxRightRatio,
    entry_line_ratio: entryLineRatio,
    entry_label_candidate_ratio: entryLabelCandidateRatio,
    stop_line_ratio: stopLineRatio,
    target_line_ratio: targetLineRatio,
    red_box: toRatioBounds(redBox, width, height),
    green_box: toRatioBounds(greenBox, width, height),
  };
}

function buildDynamicFocusCrops(scannerContext: ScannerContext | null): CropPreset[] {
  if (!scannerContext?.box_left_ratio || !scannerContext.box_right_ratio) {
    return DEFAULT_FOCUS_CROPS;
  }

  const chartLeft = scannerContext.chart_left_ratio ?? 0;
  const chartRight = scannerContext.chart_right_ratio ?? 1;
  const chartWidth = Math.max(0.22, chartRight - chartLeft);
  const left = scannerContext.box_left_ratio;
  const right = scannerContext.box_right_ratio;
  const boxWidth = Math.max(0.08, right - left);
  const top = Math.min(scannerContext.red_box?.yMin ?? 0.18, scannerContext.green_box?.yMin ?? 0.18);
  const bottom = Math.max(scannerContext.red_box?.yMax ?? 0.78, scannerContext.green_box?.yMax ?? 0.78);
  const boxHeight = Math.max(0.22, bottom - top);
  const entryLine = scannerContext.entry_line_ratio ?? (top + boxHeight / 2);
  const stopLine = scannerContext.stop_line_ratio ?? top;
  const targetLine = scannerContext.target_line_ratio ?? bottom;
  const entryLabelCandidateLine = scannerContext.entry_label_candidate_ratio
    ?? (scannerContext.direction_hint === 'Short'
      ? scannerContext.green_box?.yMax
      : scannerContext.entry_line_ratio);
  const includeEntryCandidateCrop = typeof entryLabelCandidateLine === 'number'
    && Number.isFinite(entryLabelCandidateLine)
    && Math.abs(entryLabelCandidateLine - entryLine) > 0.018;
  const labelCrop = (name: string, yCenter: number): CropPreset => ({
    name,
    x: clampRatio(chartRight - chartWidth * 0.17, chartLeft, 0.9),
    y: clampRatio(yCenter - 0.045),
    width: clampRatio(chartWidth * 0.17, 0.1, 0.18),
    height: 0.09,
  });

  return [
    {
      name: 'header-focus',
      x: chartLeft,
      y: 0.00,
      width: clampRatio(chartWidth * 0.42, 0.24, 0.42),
      height: 0.12,
    },
    {
      name: 'trade-box-focus',
      x: clampRatio(left - boxWidth * 0.25, chartLeft, chartRight - 0.12),
      y: clampRatio(top - boxHeight * 0.18),
      width: clampRatio(boxWidth * 1.7, 0.18, chartRight - clampRatio(left - boxWidth * 0.25, chartLeft, chartRight - 0.12)),
      height: clampRatio(boxHeight * 1.35, 0.30, 0.78),
    },
    {
      name: 'entry-window-focus',
      x: clampRatio(left - boxWidth * 0.45, chartLeft, chartRight - 0.12),
      y: clampRatio(top - boxHeight * 0.15),
      width: clampRatio(boxWidth * 1.2, 0.16, chartRight - clampRatio(left - boxWidth * 0.45, chartLeft, chartRight - 0.12)),
      height: clampRatio(boxHeight * 1.2, 0.32, 0.74),
    },
    {
      name: 'exit-path-focus',
      x: clampRatio(left - boxWidth * 0.10, chartLeft, chartRight - 0.12),
      y: clampRatio(top - boxHeight * 0.15),
      width: clampRatio(boxWidth * 1.55, 0.18, chartRight - clampRatio(left - boxWidth * 0.10, chartLeft, chartRight - 0.12)),
      height: clampRatio(boxHeight * 1.2, 0.32, 0.74),
    },
    {
      name: 'price-label-focus',
      x: clampRatio(chartRight - chartWidth * 0.22, chartLeft, 0.86),
      y: 0.00,
      width: clampRatio(chartWidth * 0.22, 0.14, 0.22),
      height: 1.00,
    },
    labelCrop('entry-label-focus', entryLine),
    ...(includeEntryCandidateCrop && typeof entryLabelCandidateLine === 'number' ? [labelCrop('entry-color-label-focus', entryLabelCandidateLine)] : []),
    labelCrop('stop-label-focus', stopLine),
    labelCrop('target-label-focus', targetLine),
  ];
}

export async function buildScannerAssets(file: File): Promise<{
  focusImages: File[];
  scannerContext: Record<string, unknown> | null;
  uploadImage: File;
}> {
  const image = await loadImage(file);
  const sourceType = file.type || 'image/png';
  const scannerContext = detectTradeBoxContext(image);
  const focusCrops = buildDynamicFocusCrops(scannerContext);
  const focusImages = await Promise.all(focusCrops.map(async crop => {
    const sx = Math.max(0, Math.floor(image.width * crop.x));
    const sy = Math.max(0, Math.floor(image.height * crop.y));
    const sw = Math.max(1, Math.floor(image.width * crop.width));
    const sh = Math.max(1, Math.floor(image.height * crop.height));
    const boundedWidth = Math.min(sw, image.width - sx);
    const boundedHeight = Math.min(sh, image.height - sy);

    const canvas = document.createElement('canvas');
    canvas.width = boundedWidth;
    canvas.height = boundedHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to prepare scanner crop canvas');
    }

    context.drawImage(
      image,
      sx,
      sy,
      boundedWidth,
      boundedHeight,
      0,
      0,
      boundedWidth,
      boundedHeight
    );

    return canvasToFile(canvas, `${crop.name}-${file.name}`, sourceType);
  }));

  const uploadImage = await buildUploadImage(image, file.name);

  return { focusImages, scannerContext: scannerContext ? scannerContext as unknown as Record<string, unknown> : null, uploadImage };
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Partial<Trade>) => Promise<void>;
  editTrade?: Trade | null;
  prefillTrade?: Partial<Trade> | null;
  initialImageFile?: File | null;
}

export default function ScreenshotImportModal({ isOpen, onClose, onSave, editTrade, prefillTrade, initialImageFile }: Props) {
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

  const [scanning, setScanning]           = useState(false);
  const [scanError, setScanError]         = useState('');
  const [warnings, setWarnings]           = useState<string[]>([]);
  const [scanEvidence, setScanEvidence]   = useState<string>('');
  const [formData, setFormData]           = useState<Partial<Trade> | null>(() => {
    if (editTrade) return editTrade;
    if (prefillTrade) return prefillTrade;
    return readScannerDraft();
  });
  const [aiFields, setAiFields]           = useState<Set<string>>(new Set());
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
    setAiFields(new Set());
    setWarnings([]);
    setScanEvidence('');
    setScanError('');

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
      const { focusImages, scannerContext: rawContext, uploadImage } = await buildScannerAssets(file);
      const colors = preferences.scannerColors;
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
      }
      if (extracted.close_time) {
        mapped.close_time = (extracted.close_time as string).slice(0, 5);
        fields.add('close_time');
      }
      if (extracted.trade_length_seconds){ mapped.trade_length_seconds = Number(extracted.trade_length_seconds); fields.add('trade_length_seconds'); }
      if (extracted.candle_count)     mapped.candle_count = Number(extracted.candle_count);
      if (extracted.timeframe_minutes) mapped.timeframe_minutes = Number(extracted.timeframe_minutes);

      setAiFields(fields);
      setFormData(mapped);
      setWarnings(w);
      setScanEvidence(extracted.first_touch_evidence ?? '');
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: mapped }));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to scan image');
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
              <h2 className="text-lg font-semibold text-white">{editTrade ? 'Edit Trade' : 'Add Trade'}</h2>
              <div className="flex items-center gap-3">
                {scanning && (
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
        <div className="rounded-2xl border border-slate-700/60 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.12),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.88))] px-4 py-4 shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
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
        </div>

        {scanEvidence && (
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
                  {!editTrade && (
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
                  {!scanning && (
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
            <div className="rounded-[28px] border border-slate-700/60 bg-[linear-gradient(180deg,rgba(15,23,42,0.9),rgba(15,23,42,0.72))] p-4 shadow-[0_24px_60px_rgba(2,6,23,0.32)] md:p-5">
              <TradeForm
                initialData={formData || undefined}
                aiFields={aiFields}
                tradeDate={currentDate}
                tradeTime={currentTime}
                showContractsField={false}
                onSubmit={handleSave}
                onDraftChange={handleFormDraftChange}
                onCancel={handleClose}
                isLoading={saving}
              />
            </div>
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
