import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { ResponseSchema } from '@google/generative-ai';
import type { ExtractedTradeData } from '../types/index';

// ── Structured-output schemas (Gemini JSON mode) ──────────────────────────────

const EXTRACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    symbol: { type: SchemaType.STRING, nullable: true },
    direction: { type: SchemaType.STRING, nullable: true },
    entry_price: { type: SchemaType.NUMBER, nullable: true },
    sl_price: { type: SchemaType.NUMBER, nullable: true },
    tp_price: { type: SchemaType.NUMBER, nullable: true },
    timeframe_minutes: { type: SchemaType.NUMBER, nullable: true },
    entry_time: { type: SchemaType.STRING, nullable: true },
    anchor_labels: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          x_pct: { type: SchemaType.NUMBER },
          label: { type: SchemaType.STRING, nullable: true },
        },
        required: ['x_pct', 'label'],
      },
    },
    price_confidence: { type: SchemaType.STRING },
    time_confidence: { type: SchemaType.STRING },
    evidence: { type: SchemaType.STRING },
    warnings: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['symbol', 'direction', 'entry_price', 'sl_price', 'tp_price', 'timeframe_minutes', 'entry_time', 'anchor_labels', 'price_confidence', 'time_confidence', 'evidence', 'warnings'],
};

const BOUNDARY_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    touched: { type: SchemaType.BOOLEAN },
    first_touch_candle_index: { type: SchemaType.NUMBER, nullable: true },
    confidence: { type: SchemaType.STRING },
    evidence: { type: SchemaType.STRING },
  },
  required: ['touched', 'first_touch_candle_index', 'confidence', 'evidence'],
};

const VERIFY_EXIT_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    exit_reason: { type: SchemaType.STRING, nullable: true },
    confidence: { type: SchemaType.STRING },
    first_touch_candle_index: { type: SchemaType.NUMBER, nullable: true },
    evidence: { type: SchemaType.STRING },
  },
  required: ['exit_reason', 'confidence', 'first_touch_candle_index', 'evidence'],
};

function parseModelFallbackChain(value: string | undefined): string[] {
  const models = (value ?? '')
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);
  return models.length > 0 ? models : ['gemini-2.5-flash', 'gemini-2.5-pro'];
}

function readBoundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

const GEMINI_MODEL_FALLBACK_CHAIN = parseModelFallbackChain(process.env.GEMINI_MODEL_FALLBACK_CHAIN);
const GEMINI_MAX_RETRIES_PER_MODEL = readBoundedEnvInt('GEMINI_MAX_RETRIES_PER_MODEL', 2, 0, 4);
const GEMINI_BASE_RETRY_DELAY_MS = readBoundedEnvInt('GEMINI_BASE_RETRY_DELAY_MS', 1200, 250, 10_000);
const GEMINI_REQUEST_TIMEOUT_MS = readBoundedEnvInt('GEMINI_REQUEST_TIMEOUT_MS', 60_000, 10_000, 90_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  const jitter = Math.round(Math.random() * 450);
  return GEMINI_BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + jitter;
}

function isRetryableGeminiError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('429') ||
    text.includes('529') ||
    text.includes('503') ||
    text.includes('busy') ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('too many requests') ||
    text.includes('resource exhausted') ||
    text.includes('service unavailable') ||
    text.includes('unavailable') ||
    text.includes('high demand') ||
    text.includes('overloaded') ||
    text.includes('deadline exceeded') ||
    text.includes('timed out') ||
    text.includes('timeout')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function generateWithFallback(
  genAI: GoogleGenerativeAI,
  systemPrompt: string,
  mimeType: string,
  base64Image: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }> = [],
  options?: {
    // JSON mode: eliminates the "Failed to parse Gemini response" failure class.
    responseSchema?: ResponseSchema;
    // Override the model chain (e.g. quality escalation to pro).
    modelChain?: string[];
  }
): Promise<{ text: string; model: string }> {
  const errors: string[] = [];
  const selectedFocusImages = focusImages
    .filter(image => image.base64Image && image.mimeType)
    .slice(0, 10);
  const content = [
    systemPrompt,
    'Image 1 label: full_chart. Use it for overall chart structure, candles, ticker, timeframe, and task-specific checks.',
    {
      inlineData: {
        mimeType,
        data: base64Image,
      },
    },
    ...selectedFocusImages.flatMap((image, index) => [
      `Image ${index + 2} label: ${image.label}. This is a scanner-generated crop. For price extraction, price-label-focus and the dedicated label-focus crops are more authoritative than the full chart when they show valid position-tool labels.`,
      {
        inlineData: {
          mimeType: image.mimeType,
          data: image.base64Image,
        },
      },
    ]),
  ];

  const modelChain = options?.modelChain ?? GEMINI_MODEL_FALLBACK_CHAIN;
  for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex++) {
    const modelName = modelChain[modelIndex];
    const model = genAI.getGenerativeModel({
      model: modelName,
      ...(options?.responseSchema ? {
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: options.responseSchema,
        },
      } : {}),
    });

    // Brief pause before switching to the fallback model
    if (modelIndex > 0) await sleep(2000);

    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES_PER_MODEL; attempt += 1) {
      try {
        const result = await withTimeout(
          model.generateContent(content),
          GEMINI_REQUEST_TIMEOUT_MS,
          `${modelName} scanner request`
        );
        const text = result.response.text().trim();
        return { text, model: modelName };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`[${modelName}] ${message}`);
        const retryable = isRetryableGeminiError(message);
        const hasMoreAttempts = attempt < GEMINI_MAX_RETRIES_PER_MODEL;

        if (!retryable || !hasMoreAttempts) {
          break;
        }

        await sleep(retryDelayMs(attempt));
      }
    }
  }

  throw new Error(errors[errors.length - 1] ?? 'Gemini API error');
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseDirection(value: unknown): 'Long' | 'Short' | null {
  if (value === 'Long' || value === 'Short') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'long') return 'Long';
  if (normalized === 'short') return 'Short';
  return null;
}

function parseExitReason(value: unknown): 'TP' | 'SL' | null {
  if (value === 'TP' || value === 'SL') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'TP' || normalized === 'SL') return normalized;
  return null;
}

function parseTimeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const hhmm = normalized.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!hhmm) return null;
  const hour = Number(hhmm[1]);
  const minute = Number(hhmm[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ── Deterministic time from axis anchors ─────────────────────────────────────
// The model's only time job in geometry mode is OCR: read the label under each
// detected gridline. Entry time and timeframe validation are arithmetic here.

type AnchorLabel = { xRatio: number; minutes: number };

const STANDARD_TIMEFRAME_MINUTES = [1, 2, 3, 5, 10, 15, 30, 45, 60, 120, 240];

function parseAnchorLabels(raw: unknown): AnchorLabel[] {
  if (!Array.isArray(raw)) return [];
  const anchors: AnchorLabel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const x = parseNullableNumber(record.x_pct);
    const label = parseTimeToken(record.label);
    if (x === null || label === null) continue;
    const [hours, minutes] = label.split(':').map(Number);
    const xRatio = x > 1 ? x / 100 : x;
    if (xRatio <= 0 || xRatio >= 1) continue;
    anchors.push({ xRatio, minutes: hours * 60 + minutes });
  }
  return anchors.sort((a, b) => a.xRatio - b.xRatio);
}

function formatMinutesAsHHMM(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function computeTimeFromAnchors(
  anchors: AnchorLabel[],
  geometry: { pitchRatio: number | null; boxLeftRatio: number | null },
  headerTimeframe: number | null,
): { entryTime: string | null; timeframe: number | null; failures: string[]; warnings: string[]; geometric: boolean } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const pitch = geometry.pitchRatio;
  if (!pitch || pitch <= 0) {
    return { entryTime: null, timeframe: headerTimeframe, failures, warnings, geometric: false };
  }
  if (anchors.length === 0) {
    failures.push('no readable x-axis time labels under the detected gridlines — re-read the labels in time-axis-focus character by character');
    return { entryTime: null, timeframe: headerTimeframe, failures, warnings, geometric: false };
  }

  // Axis-implied timeframe: label gap ÷ candle count between adjacent anchors.
  const impliedTimeframes: number[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const dx = anchors[index].xRatio - anchors[index - 1].xRatio;
    let labelGapMinutes = anchors[index].minutes - anchors[index - 1].minutes;
    if (labelGapMinutes <= 0) labelGapMinutes += 24 * 60;
    const candles = Math.round(dx / pitch);
    if (candles < 1 || dx < pitch * 0.5 || labelGapMinutes > 12 * 60) continue;
    const implied = labelGapMinutes / candles;
    const snapped = STANDARD_TIMEFRAME_MINUTES.find(value => Math.abs(value - implied) / value <= 0.25);
    if (snapped !== undefined) impliedTimeframes.push(snapped);
  }
  let axisTimeframe: number | null = null;
  if (impliedTimeframes.length > 0) {
    impliedTimeframes.sort((a, b) => a - b);
    axisTimeframe = impliedTimeframes[Math.floor(impliedTimeframes.length / 2)];
  }

  let timeframe = headerTimeframe;
  if (axisTimeframe !== null && headerTimeframe !== null && axisTimeframe !== headerTimeframe) {
    // The axis is measured (label gap ÷ counted pixels); the header is OCR.
    failures.push(`header timeframe ${headerTimeframe}m conflicts with the axis-derived ${axisTimeframe}m (anchor label spacing ÷ measured candle pitch) — re-read the header interval and the anchor labels`);
    warnings.push(`Header timeframe (${headerTimeframe}m) conflicted with axis geometry — using ${axisTimeframe}m.`);
    timeframe = axisTimeframe;
  } else if (axisTimeframe !== null && headerTimeframe === null) {
    warnings.push(`Timeframe inferred from axis geometry: ${axisTimeframe}m.`);
    timeframe = axisTimeframe;
  }

  const boxLeft = geometry.boxLeftRatio;
  if (boxLeft === null || timeframe === null || timeframe <= 0) {
    return { entryTime: null, timeframe, failures, warnings, geometric: false };
  }

  const anchor = anchors.reduce((best, candidate) =>
    Math.abs(candidate.xRatio - boxLeft) < Math.abs(best.xRatio - boxLeft) ? candidate : best);
  const candlesFromAnchor = Math.round((boxLeft - anchor.xRatio) / pitch);
  const entryTime = formatMinutesAsHHMM(anchor.minutes + candlesFromAnchor * timeframe);
  return { entryTime, timeframe, failures, warnings, geometric: true };
}

function hexToColorName(hex: string): string {
  const h = hex.replace('#', '').toLowerCase();
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  const saturation = max === min ? 0 : (max - min) / (lightness < 0.5 ? max + min : 510 - max - min);
  if (saturation < 0.12) {
    if (lightness > 0.85) return 'white';
    if (lightness > 0.6) return 'light grey';
    if (lightness > 0.35) return 'grey';
    return 'dark grey / near black';
  }
  const hue = max === min ? 0
    : max === r ? ((g - b) / (max - min) + (g < b ? 6 : 0)) / 6
    : max === g ? ((b - r) / (max - min) + 2) / 6
    : ((r - g) / (max - min) + 4) / 6;
  const deg = hue * 360;
  if (deg < 20 || deg >= 340) return 'red';
  if (deg < 40) return 'orange-red';
  if (deg < 65) return 'orange / amber';
  if (deg < 80) return 'yellow';
  if (deg < 155) return 'green';
  if (deg < 185) return 'teal / cyan';
  if (deg < 255) return 'blue';
  if (deg < 290) return 'purple / violet';
  if (deg < 340) return 'pink / magenta';
  return 'red';
}

function levelsConsistent(
  direction: 'Long' | 'Short',
  entry: number | null,
  sl: number | null,
  tp: number | null,
): boolean {
  if (entry === null || sl === null || tp === null) return false;
  return direction === 'Long' ? tp > entry && sl < entry : tp < entry && sl > entry;
}

function sanitizePriceLevels(
  direction: 'Long' | 'Short' | null,
  entry_price: number | null,
  sl_price: number | null,
  tp_price: number | null,
  warnings: string[],
): { sl_price: number | null; tp_price: number | null; warnings: string[] } {
  if (!direction || entry_price === null || sl_price === null || tp_price === null) {
    return { sl_price, tp_price, warnings };
  }
  const newWarnings = [...warnings];

  if (direction === 'Long') {
    const invalidTp = tp_price <= entry_price;
    const invalidSl = sl_price >= entry_price;
    if (invalidTp || invalidSl) {
      newWarnings.push(`Price levels rejected: Long trade requires TP > entry > SL, but entry=${entry_price}, SL=${sl_price}, TP=${tp_price}. Re-scan labels manually.`);
      return {
        sl_price: invalidSl ? null : sl_price,
        tp_price: invalidTp ? null : tp_price,
        warnings: newWarnings,
      };
    }
  } else {
    const invalidTp = tp_price >= entry_price;
    const invalidSl = sl_price <= entry_price;
    if (invalidTp || invalidSl) {
      newWarnings.push(`Price levels rejected: Short trade requires TP < entry < SL, but entry=${entry_price}, SL=${sl_price}, TP=${tp_price}. Re-scan labels manually.`);
      return {
        sl_price: invalidSl ? null : sl_price,
        tp_price: invalidTp ? null : tp_price,
        warnings: newWarnings,
      };
    }
  }

  return { sl_price, tp_price, warnings: newWarnings };
}

type ScannerUserColors = {
  stopLoss: string;
  takeProfit: string;
  entry: string;
};

type ScannerBoxBounds = {
  leftRatio: number;
  rightRatio: number;
};

type ScannerLineHints = {
  entryLineRatio?: number;
  stopLineRatio?: number;
  targetLineRatio?: number;
  timeAxisEntryXRatio?: number;
};

type ExtractionRead = {
  symbol: string | null;
  direction: 'Long' | 'Short' | null;
  entry_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
  exit_reason: 'TP' | 'SL' | null;
  trade_length_seconds: number | null;
  timeframe_minutes: number | null;
  entry_time: string | null;
  close_time: string | null;
  confidence: 'high' | 'medium' | 'low';
  first_touch_candle_index: number | null;
  evidence: string | null;
  warnings: string[];
};

function buildIdentityRules(): string {
  return `IDENTITY
1. Read symbol and timeframe from header-focus first, then full_chart.
2. Return the root futures symbol only: NQ, MNQ, ES, MES, YM, MYM, RTY, M2K, CL, MCL, GC, MGC, SI, 6E, 6B, BTC, MBT.
3. Contract month suffixes map to roots, e.g. NQM26 -> NQ, MNQM26 -> MNQ, ESM26 -> ES, MESM26 -> MES.
4. Never return generic words such as Futures, Micro, E-mini, CME, CBOT, or TradingView as the symbol.`;
}

function buildGeometryRules(
  directionHint?: 'Long' | 'Short',
  lineHints?: ScannerLineHints,
): string {
  if (!directionHint && !lineHints) return 'GEOMETRY\nNo reliable browser-side geometry was supplied. Use the compact red/green position tool in the screenshot.';

  return `GEOMETRY - USE BEFORE GUESSING
The browser-side scanner already located the compact paired position tool. Treat these hints as the source of truth for crop roles.
${directionHint ? `- Direction hint: ${directionHint}` : '- Direction hint: unavailable'}
${typeof lineHints?.entryLineRatio === 'number' ? `- entry-label-focus is centered near ${Math.round(lineHints.entryLineRatio * 100)}% image height.` : ''}
${typeof lineHints?.stopLineRatio === 'number' ? `- stop-label-focus is centered near ${Math.round(lineHints.stopLineRatio * 100)}% image height.` : ''}
${typeof lineHints?.targetLineRatio === 'number' ? `- target-label-focus is centered near ${Math.round(lineHints.targetLineRatio * 100)}% image height.` : ''}
${typeof lineHints?.timeAxisEntryXRatio === 'number' ? `- time-axis-focus centers the entry candle near ${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the left edge of that crop.` : ''}
Use labels at these geometry lines. Ignore easier-to-read labels away from these lines.`;
}

function buildPriceRules(userColors?: ScannerUserColors, hasGeometry = false): string {
  const entryText = userColors
    ? `${hexToColorName(userColors.entry)} (${userColors.entry})`
    : 'configured entry color, or neutral grey/dark fallback';
  const stopText = userColors
    ? `${hexToColorName(userColors.stopLoss)} (${userColors.stopLoss})`
    : 'red/pink stop-loss color';
  const targetText = userColors
    ? `${hexToColorName(userColors.takeProfit)} (${userColors.takeProfit})`
    : 'teal/green take-profit color';
  // Only claim the dedicated crops are boundary-centered when the pixel scanner
  // actually placed them. In fallback mode those crops are not sent at all.
  const stepThree = hasGeometry
    ? `3. For each level, start at the geometry crop/line:
   - entry_price: entry-label-focus at the shared red/green boundary.
   - sl_price: stop-label-focus at the outer red/pink stop boundary.
   - tp_price: target-label-focus at the outer teal/green target boundary.
   Use price-label-focus as the full right-axis backup when a dedicated crop contains a rejected label.`
    : `3. No boundary-centered crops are available for this scan. Locate each level yourself: find the compact position tool's boundaries in full_chart / trade-box-focus, then read the right-axis label aligned with each boundary using price-label-focus.`;

  return `PRICE LABEL DECISION TREE - FOLLOW IN ORDER
1. Find the compact position tool. It is the paired red/stop and teal/take-profit box with shared horizontal span and a shared entry boundary. Ignore large supply/demand/orderblock/session zones.
2. Read right-axis labels only. Do not use numbers printed inside the chart body, fib labels, R:R labels, confluence labels, or annotations.
${stepThree}
4. Reject cursor/live labels before reading numbers:
   - Any label with a circle-plus/crosshair/plus icon on its left is a cursor price tracker.
   - Any label with an attached countdown timer such as 00:29 or 1:03 is the live/current price marker.
5. Reject drawn-level labels before trusting crop color:
   - Look immediately left of the candidate right-axis label.
   - If a solid or dashed horizontal line of the SAME COLOR as the label extends left into the chart body, that label is a drawn level. Reject it for entry, SL, and TP.
   - The P&L box's own translucent zone border touching the label is allowed. Lines of a different color do not reject the label.
   - If two labels stack at the same Y/price, choose the one WITHOUT the same-color line.
6. Apply role colors:
   - sl_price must come from the standalone ${stopText} label at the stop boundary.
   - tp_price must come from the standalone ${targetText} label at the target boundary.
   - entry_price must come from the standalone ${entryText} label at the shared boundary. If no configured entry-color label is visible, a neutral grey/dark pill at the shared boundary is valid.
   - A stop-colored label can never be TP. A target-colored label can never be SL. Entry can never equal a stop-colored or target-colored label.
7. Direction consistency:
   - Long requires TP > entry > SL.
   - Short requires TP < entry < SL.
   If the numbers violate this, re-read labels at the geometry lines. Do not swap labels in your answer.
8. Fallback only when no valid right-axis position-tool label is visible: trace the relevant compact zone boundary horizontally to the price-axis grid and read the nearest grid price. Add a warning when using this fallback.

FINAL PRICE CHECK
Before returning JSON, verify entry_price, sl_price, and tp_price each came from standalone position-tool labels or the explicit grid fallback. If any chosen label has a same-color horizontal line extending left from it, reject and replace it.`;
}

export type ScannerTimeGeometry = {
  pitchRatio: number | null;
  gridlineRatios: number[];
  boxLeftRatio: number | null;
};

function buildTimeRules(lineHints?: ScannerLineHints, timeGeometry?: ScannerTimeGeometry): string {
  if (timeGeometry && timeGeometry.gridlineRatios.length >= 2) {
    const positions = timeGeometry.gridlineRatios
      .map(ratio => `${Math.round(ratio * 100)}%`)
      .join(', ');
    return `TIME
1. Read timeframe_minutes from the chart header interval (e.g. "5" means a 5-minute chart).
2. The pixel scanner measured vertical time gridlines at these positions across the full_chart width, from the left edge: ${positions}.
   For EACH position, read the time label printed on the bottom x-axis directly beneath that vertical gridline.
   Fill anchor_labels with one object per gridline: {"x_pct": <the given percent as a number>, "label": "HH:MM"}.
   Copy the label text exactly in 24-hour HH:MM. If the label under a gridline is a date (e.g. "Mon 13") or unreadable, set label to null for that position — never guess.
3. Do NOT count candles to compute entry_time — the backend derives the exact entry time from your anchor_labels and the measured candle spacing. Still return your own entry_time estimate as a fallback.
4. Do not estimate close_time or trade duration. Dedicated exit verifiers handle the exit after this extraction pass.`;
  }
  return `TIME
1. Read timeframe from the chart header.
2. Read entry_time using candle-count interpolation, not by blindly copying the nearest x-axis label.
${typeof lineHints?.timeAxisEntryXRatio === 'number' ? `3. Use time-axis-focus first. The entry candle is near ${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the left of that crop.` : '3. Use the bottom x-axis labels in full_chart or time-axis-focus.'}
4. Pick the x-axis time label whose candle is closest to the left edge of the P&L box.
5. Count candles from that anchor to the entry candle. entry_time = anchor time + candle count * timeframe.
6. No gridline geometry was detected for this chart — return anchor_labels as an empty array.
7. Do not estimate close_time or trade duration. Dedicated exit verifiers handle the exit after this extraction pass.`;
}

// Exported for the eval harness (scripts/run-scanner-evals.ts prompt checks).
export function buildMainExtractionPrompt(
  userColors?: ScannerUserColors,
  boxBounds?: ScannerBoxBounds,
  directionHint?: 'Long' | 'Short',
  lineHints?: ScannerLineHints,
  timeGeometry?: ScannerTimeGeometry,
): string {
  const boxText = boxBounds
    ? `The compact position tool spans approximately ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% of the image width.`
    : 'If exact box bounds are unavailable, use the compact colored position tool visible in the chart.';

  return `You are a futures chart extraction assistant. Extract only identity, price levels, direction, and entry time from a TradingView-style risk/reward screenshot.
Do not decide win/loss. Do not decide whether TP or SL was touched. Dedicated verifiers handle exits later.

${buildIdentityRules()}

${buildGeometryRules(directionHint, lineHints)}
${boxText}

${buildPriceRules(userColors, Boolean(lineHints))}

${buildTimeRules(lineHints, timeGeometry)}

Return ONLY raw JSON:
{
  "symbol": string or null,
  "direction": "Long" or "Short" or null,
  "entry_price": number or null,
  "sl_price": number or null,
  "tp_price": number or null,
  "timeframe_minutes": number or null,
  "entry_time": "HH:MM" or null,
  "anchor_labels": array of {"x_pct": number, "label": "HH:MM" or null},
  "price_confidence": "high" or "medium" or "low",
  "time_confidence": "high" or "medium" or "low",
  "evidence": "brief price/time evidence",
  "warnings": array of strings
}`;
}

export async function readTradeChart(
  base64Image: string,
  mimeType: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }> = [],
  userColors?: {
    stopLoss: string;
    takeProfit: string;
    entry: string;
  },
  boxBounds?: {
    leftRatio: number;
    rightRatio: number;
  },
  directionHint?: 'Long' | 'Short',
  lineHints?: {
    entryLineRatio?: number;
    stopLineRatio?: number;
    targetLineRatio?: number;
    timeAxisEntryXRatio?: number;
  },
  timeGeometry?: ScannerTimeGeometry,
): Promise<ExtractionRead> {
  const basePrompt = buildMainExtractionPrompt(userColors, boxBounds, directionHint, lineHints, timeGeometry);
  const escalationModel = process.env.GEMINI_ESCALATION_MODEL?.trim() || 'gemini-2.5-pro';

  type AttemptOutcome = ExtractionRead & { structuralFailures: string[]; priceConfidenceLow: boolean };

  const runAttempt = async (prompt: string, modelChain?: string[]): Promise<AttemptOutcome> => {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
      const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages, {
        responseSchema: EXTRACTION_SCHEMA,
        modelChain,
      });
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        return { ...nullResult(['Failed to parse Gemini response']), structuralFailures: ['response was not valid JSON'], priceConfidenceLow: true };
      }

      const modelDirection = parseDirection(parsed.direction);
      const entryPrice = parseNullableNumber(parsed.entry_price);
      const slRaw = parseNullableNumber(parsed.sl_price);
      const tpRaw = parseNullableNumber(parsed.tp_price);
      const baseWarnings: string[] = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : [];

      // The pixel-derived direction hint usually wins, but it has a known
      // failure mode: overlapping drawn zones corrupt the zone pairing. When
      // the model disagrees AND the price structure is only consistent under
      // the model's direction, the hint is the wrong one — prefer the read
      // that fits the numbers instead of nulling out valid prices.
      let direction = directionHint ?? modelDirection;
      if (directionHint && modelDirection && modelDirection !== directionHint) {
        const hintFits = levelsConsistent(directionHint, entryPrice, slRaw, tpRaw);
        const modelFits = levelsConsistent(modelDirection, entryPrice, slRaw, tpRaw);
        if (!hintFits && modelFits) {
          direction = modelDirection;
          baseWarnings.push(`Direction hint (${directionHint}) contradicted the price structure — used the model's ${modelDirection} read. Verify direction manually.`);
        } else {
          baseWarnings.push(`Direction corrected from ${modelDirection} to ${directionHint} using compact position-tool geometry.`);
        }
      }

      // Structural acceptance checks — these drive the repair/escalation loop.
      const structuralFailures: string[] = [];
      if (entryPrice === null || slRaw === null || tpRaw === null) {
        structuralFailures.push(`one or more prices missing (entry=${entryPrice}, sl=${slRaw}, tp=${tpRaw})`);
      } else {
        if (entryPrice === slRaw) structuralFailures.push(`entry_price equals sl_price (${entryPrice}) — you read the SL label as entry`);
        if (entryPrice === tpRaw) structuralFailures.push(`entry_price equals tp_price (${entryPrice}) — you read the TP label as entry`);
        if (direction && !levelsConsistent(direction, entryPrice, slRaw, tpRaw)) {
          structuralFailures.push(`levels inconsistent for ${direction} (entry=${entryPrice}, sl=${slRaw}, tp=${tpRaw})`);
        }
      }

      const { sl_price, tp_price, warnings: sanityWarnings } = sanitizePriceLevels(
        direction,
        entryPrice,
        slRaw,
        tpRaw,
        baseWarnings,
      );
      const priceConfidence = parsed.price_confidence === 'high' || parsed.price_confidence === 'medium' ? parsed.price_confidence : 'low';
      const timeConfidence = parsed.time_confidence === 'high' || parsed.time_confidence === 'medium' ? parsed.time_confidence : 'low';
      if (priceConfidence === 'low') {
        sanityWarnings.push('Price read is low confidence; verify entry/SL/TP manually.');
      }

      const timeframeRaw = parseNullableNumber(parsed.timeframe_minutes);
      const timeframeMinutes = timeframeRaw !== null && timeframeRaw > 0 ? Math.round(timeframeRaw) : null;

      // Geometry mode: the model OCR'd anchor labels; entry time and the
      // timeframe cross-check are computed here, deterministically.
      const modelEntryTime = parseTimeToken(parsed.entry_time);
      let entryTime = modelEntryTime;
      let finalTimeframe = timeframeMinutes;
      let finalTimeConfidence: 'high' | 'medium' | 'low' = timeConfidence;
      if (timeGeometry) {
        const computed = computeTimeFromAnchors(parseAnchorLabels(parsed.anchor_labels), timeGeometry, timeframeMinutes);
        structuralFailures.push(...computed.failures);
        sanityWarnings.push(...computed.warnings);
        finalTimeframe = computed.timeframe ?? timeframeMinutes;
        if (computed.geometric && computed.entryTime) {
          if (modelEntryTime && modelEntryTime !== computed.entryTime) {
            const toMinutes = (token: string) => Number(token.slice(0, 2)) * 60 + Number(token.slice(3, 5));
            const rawDiff = Math.abs(toMinutes(modelEntryTime) - toMinutes(computed.entryTime));
            if (Math.min(rawDiff, 1440 - rawDiff) > (finalTimeframe ?? 1)) {
              sanityWarnings.push(`Model estimated entry ${modelEntryTime}; axis geometry computed ${computed.entryTime} — using the geometric time.`);
            }
          }
          entryTime = computed.entryTime;
          finalTimeConfidence = 'high';
        }
      }
      if (finalTimeframe === null) {
        structuralFailures.push('timeframe_minutes missing — read the chart interval from the header (e.g. "5" means a 5-minute chart)');
      }

      return {
        symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
        direction,
        entry_price: entryPrice,
        sl_price,
        tp_price,
        exit_reason: null,
        trade_length_seconds: null,
        timeframe_minutes: finalTimeframe,
        entry_time: entryTime,
        close_time: null,
        confidence: finalTimeConfidence,
        first_touch_candle_index: null,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
        warnings: sanityWarnings,
        structuralFailures,
        priceConfidenceLow: priceConfidence === 'low',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini API error';
      return { ...nullResult([msg]), structuralFailures: [msg], priceConfidenceLow: true };
    }
  };

  const repairPrompt = (failures: string[], previous: AttemptOutcome) =>
    `${basePrompt}\n\nPREVIOUS ATTEMPT REJECTED — DO NOT REPEAT IT:\nYou returned entry_price=${previous.entry_price}, sl_price=${previous.sl_price}, tp_price=${previous.tp_price}, direction=${previous.direction}.\nRejected because: ${failures.join('; ')}.\nRe-read the right-axis labels character by character and return corrected values. If a level's label is genuinely not visible, return null for that level instead of guessing.`;

  // Attempt 1: standard chain.
  let outcome = await runAttempt(basePrompt);

  // Attempt 2 — repair: same model, with the failure fed back.
  if (outcome.structuralFailures.length > 0) {
    const repaired = await runAttempt(repairPrompt(outcome.structuralFailures, outcome));
    if (repaired.structuralFailures.length < outcome.structuralFailures.length) {
      repaired.warnings.push('Extraction required a repair pass — first read failed structural checks.');
      outcome = repaired;
    }
  }

  // Attempt 3 — escalation: stronger model when still structurally broken, or
  // when the read is structurally fine but low-confidence.
  if (outcome.structuralFailures.length > 0 || outcome.priceConfidenceLow) {
    const escalated = await runAttempt(
      outcome.structuralFailures.length > 0 ? repairPrompt(outcome.structuralFailures, outcome) : basePrompt,
      [escalationModel],
    );
    const escalatedBetter =
      escalated.structuralFailures.length < outcome.structuralFailures.length
      || (escalated.structuralFailures.length === outcome.structuralFailures.length && !escalated.priceConfidenceLow && outcome.priceConfidenceLow);
    if (escalatedBetter) {
      escalated.warnings.push(`Extraction escalated to ${escalationModel}.`);
      outcome = escalated;
    }
  }

  const { structuralFailures, priceConfidenceLow, ...result } = outcome;
  if (structuralFailures.length > 0) {
    result.warnings.push(`Extraction failed structural checks after retries: ${structuralFailures.join('; ')}.`);
  }
  void priceConfidenceLow;
  return result;
}


async function verifyTradeExit(
  base64Image: string,
  mimeType: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }>,
  trade: {
    direction: 'Long' | 'Short';
    entry: number;
    stop: number;
    target: number;
  },
  boxBounds?: { leftRatio: number; rightRatio: number },
): Promise<{
  exit_reason: 'TP' | 'SL' | null;
  confidence: 'high' | 'medium' | 'low';
  first_touch_candle_index: number | null;
  evidence: string | null;
}> {
  const isLong = trade.direction === 'Long';
  const bounds = boxBounds
    ? `Only inspect candles whose center x-position is between ${Math.round(boxBounds.leftRatio * 100)}% and ${Math.round(Math.min(boxBounds.rightRatio + 0.03, 1) * 100)}% of the image width. Candles outside this range do not exist for this analysis. Stop scanning the moment SL or TP is first touched.`
    : 'Only inspect candles physically inside the colored position-tool overlay (left edge to right edge). Stop scanning the moment SL or TP is first touched.';
  const prompt = `You are the independent exit verifier for a futures trade screenshot.
Do not re-read or change the supplied prices. Determine only the first touched exit level.

Trade:
- Direction: ${trade.direction}
- Entry: ${trade.entry}
- Stop: ${trade.stop}
- Target: ${trade.target}

${bounds}
Number the entry candle at the left edge of the colored position tool as candle 0.
Then count candle 1, candle 2, and so on while scanning candle wicks left to right.
For this ${trade.direction}:
- Stop is touched when a wick ${isLong ? `falls to or below ${trade.stop}` : `rises to or above ${trade.stop}`}.
- Target is touched when a wick ${isLong ? `rises to or above ${trade.target}` : `falls to or below ${trade.target}`}.
Entering the colored zone is not a hit; the wick must reach the OUTER boundary at the exact supplied price.
The first touched boundary wins. If neither boundary is visibly touched or ordering is uncertain, return null.
Ignore the live-price marker and all candles outside the colored position tool.

FORBIDDEN INFERENCES — never treat these as a hit:
• Fast or deep penetration INTO a zone that stops short of the exact boundary price. A wick covering most of the zone but not reaching ${trade.stop} / ${trade.target} is NOT a hit — keep scanning.
• "Price was clearly heading for the level" before reversing. Travel direction is not evidence.
• Zone color or size, or price action after the candidate candle.
COMMON FAILURE YOU MUST AVOID: price dives deep into the target zone, reverses without its wick ever reaching ${trade.target}, and later a wick DOES reach ${trade.stop}. The correct answer is SL — not TP. Check every candidate wick against the exact numeric price line before accepting it, then re-verify that no EARLIER candle touched the other boundary.
MANDATORY ORDER CHECK: before returning, explicitly compare the candle index of the first true SL touch and the first true TP touch. Return whichever index is smaller. Only a wick that reaches/crosses the exact price counts as a touch for this comparison.

SINGLE-CANDLE SPAN RULE — HIGHEST PRIORITY:
If the first candle to touch either boundary simultaneously spans BOTH boundaries in the same candle (${isLong ? `LOW wick ≤ ${trade.stop} AND HIGH wick ≥ ${trade.target}` : `HIGH wick ≥ ${trade.stop} AND LOW wick ≤ ${trade.target}`}), the intra-candle order is unknowable from a static image.
In that case you MUST return exit_reason: null, confidence: "low". DO NOT default to either side.

Return only JSON:
{
  "exit_reason": "TP" or "SL" or null,
  "confidence": "high" or "medium" or "low",
  "first_touch_candle_index": integer or null,
  "evidence": "brief first-touch evidence"
}`;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages, { responseSchema: VERIFY_EXIT_SCHEMA });
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      exit_reason: parseExitReason(parsed.exit_reason),
      confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
      first_touch_candle_index: (() => {
        const value = parseNullableNumber(parsed.first_touch_candle_index);
        return value === null ? null : Math.max(0, Math.round(value));
      })(),
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
    };
  } catch {
    return { exit_reason: null, confidence: 'low', first_touch_candle_index: null, evidence: null };
  }
}

// Same-candle tiebreaker. When entry and exit land on ONE candle the tick order
// of the two wicks is unknowable, but the POST-ENTRY direction usually isn't:
// anchor on the entry, ignore anything on the stop side that formed before the
// entry, and use where the candle CLOSED (plus where the entry sits in the range)
// to decide TP vs SL. A short entered near the high that closes down to the
// target is a win, not a stop-out from the pre-entry high wick.
async function resolveSameCandleExit(
  base64Image: string,
  mimeType: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }>,
  trade: {
    direction: 'Long' | 'Short';
    entry: number;
    stop: number;
    target: number;
  },
  boxBounds?: { leftRatio: number; rightRatio: number },
): Promise<{ exit_reason: 'TP' | 'SL' | null; confidence: 'high' | 'medium' | 'low'; evidence: string | null }> {
  const isLong = trade.direction === 'Long';
  const bounds = boxBounds
    ? `The entry candle is at the left edge of the colored position tool, near ${Math.round(boxBounds.leftRatio * 100)}% of the image width. Judge only that one candle.`
    : 'Judge only the entry candle at the left edge of the colored position tool.';
  const prompt = `A ${trade.direction} futures trade entered AND exited inside ONE candle, so its stop and target wicks are on the same candle and their tick order is not directly visible. Resolve the outcome from the POST-ENTRY direction, not from which wick looks longer. Do not change any price.

Trade:
- Direction: ${trade.direction}
- Entry: ${trade.entry}
- Stop (SL): ${trade.stop}
- Target (TP): ${trade.target}

${bounds}

Method, in order:
1. The entry at ${trade.entry} is the reference point. Any part of the candle's range on the STOP side that formed BEFORE the entry is NOT a stop-out. Only movement AFTER the entry can hit a level.
2. Find where the entry sits in the candle: near its open, its high, or its low.
3. Read the candle's CLOSE. Relative to the entry, the close is the reliable signal of where price went after entry:
${isLong
  ? `   - Long: a close toward/at the TARGET (${trade.target}, the upper side, a green push up) means price rose to target after entry -> TP. A close toward/at the STOP (${trade.stop}, lower side) -> SL.`
  : `   - Short: a close toward/at the TARGET (${trade.target}, the lower side, a red push down near the low) means price fell to target after entry -> TP. A close toward/at the STOP (${trade.stop}, upper side) -> SL.`}
4. Cross-check with the entry position: if the entry sits at the extreme ${isLong ? 'LOW (entered near the bottom of the candle)' : 'HIGH (entered near the top of the candle)'}, then after entry price could only travel toward the TARGET, so return TP.
Only return SL if the evidence genuinely shows price moved to the stop AFTER the entry.

Return only JSON:
{
  "exit_reason": "TP" or "SL" or null,
  "confidence": "high" or "medium" or "low",
  "first_touch_candle_index": 0,
  "evidence": "how the close and entry position imply the post-entry direction"
}`;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages, { responseSchema: VERIFY_EXIT_SCHEMA });
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      exit_reason: parseExitReason(parsed.exit_reason),
      confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
    };
  } catch {
    return { exit_reason: null, confidence: 'low', evidence: null };
  }
}

async function detectBoundaryTouch(
  base64Image: string,
  mimeType: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }>,
  trade: {
    direction: 'Long' | 'Short';
    entry: number;
    stop: number;
    target: number;
  },
  boundary: 'SL' | 'TP',
  boxBounds?: { leftRatio: number; rightRatio: number },
): Promise<{
  touched: boolean;
  first_touch_candle_index: number | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string | null;
}> {
  const isLong = trade.direction === 'Long';
  const price = boundary === 'SL' ? trade.stop : trade.target;
  const touchRule = boundary === 'SL'
    ? isLong
      ? `the candle LOW wick reaches or falls below ${price}`
      : `the candle HIGH wick reaches or rises above ${price}`
    : isLong
      ? `the candle HIGH wick reaches or rises above ${price}`
      : `the candle LOW wick reaches or falls below ${price}`;
  const bounds = boxBounds
    ? `The position tool colored boxes span image columns ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% from the left edge.
HARD RULE: Any candle whose center x-position is to the LEFT of ${Math.round(boxBounds.leftRatio * 100)}% does not exist. Do not look at it. Do not count it. Do not let its wick influence your answer in any way. This is especially important for large market-open spike candles (e.g. the 09:30 ET candle) immediately left of the box — those are pre-trade and must be completely ignored.
HARD RULE: Any candle whose center x-position is to the RIGHT of ${Math.round(Math.min(boxBounds.rightRatio + 0.03, 1) * 100)}% does not exist. Stop there.`
    : `Only inspect candles physically inside the colored position-tool overlay. Ignore candles to the LEFT (pre-trade) and beyond the RIGHT edge of the overlay. Large market-open spike candles immediately left of the box are especially common and must be excluded.`;

  const prompt = `You are checking ONE boundary on a futures chart. Do not decide whether the trade won or lost.

Trade direction: ${trade.direction}
Entry: ${trade.entry}
Boundary to inspect: ${boundary} at ${price}
${bounds}

Start at the FIRST candle whose center is inside the LEFT edge of the colored position tool. That is candle 0.
Count every candle to the right as candle 1, 2, 3, and so on.
Ignore all candles left of the colored tool and all chart annotations.
CRITICAL: If there is a large spike or crash candle just outside the left edge of the box, that is a pre-trade candle. It does not count as candle 0 and its wick does not trigger any boundary.

This ${boundary} boundary is touched only when ${touchRule}.
Entering the colored zone without reaching its far outer edge is NOT a touch. The wick must VISIBLY and CLEARLY reach or cross the exact price line at ${price}. A wick that enters the colored zone but appears to stop before the outer edge does not count.

FORBIDDEN INFERENCES — these are NEVER evidence of a touch:
• Price moving FAST or DEEP into the colored zone. Depth and speed of penetration are irrelevant — a wick that covers 90% of the zone but stops short of ${price} is touched=false.
• Price "obviously heading toward" the level before reversing. Direction of travel proves nothing.
• The zone's color, size, or how much of it price traversed.
• What price did AFTERWARD (reversing, continuing, closing beyond). Only the wick extreme vs ${price} matters.
The ONLY question you answer: does a wick extreme physically reach or cross the horizontal line at exactly ${price}? Trace that exact line across the chart and compare wick tips against it.

BORDERLINE CALLS: if the deepest wick tip reaches, grazes, or crosses the ${price} line, return touched=true — use confidence to express doubt ("high" for a clear cross, "low" for a graze you are unsure about). Return touched=false only when the deepest wick visibly stops short of the line.
Your evidence string MUST state where the decisive wick tip sits relative to the ${price} line (e.g. "candle 4 high wick crosses the ${price} line by ~2 points" or "deepest wick stops visibly short of the line"). If you cannot describe the wick-vs-line relationship, return touched=false.

Scan strictly left-to-right and stop at the earliest candle touching this boundary.

Return only JSON:
{
  "touched": boolean,
  "first_touch_candle_index": integer or null,
  "confidence": "high" or "medium" or "low",
  "evidence": "describe the earliest touching wick"
}`;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages, { responseSchema: BOUNDARY_SCHEMA });
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const index = parseNullableNumber(parsed.first_touch_candle_index);
    const touched = parsed.touched === true && index !== null;
    return {
      touched,
      first_touch_candle_index: touched ? Math.max(0, Math.round(index)) : null,
      confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
    };
  } catch {
    return { touched: false, first_touch_candle_index: null, confidence: 'low', evidence: null };
  }
}

function nullResult(warnings: string[]) {
  return {
    symbol: null,
    direction: null as null,
    entry_price: null,
    sl_price: null,
    tp_price: null,
    exit_reason: null as null,
    trade_length_seconds: null,
    timeframe_minutes: null,
    entry_time: null,
    close_time: null,
    confidence: 'low' as const,
    first_touch_candle_index: null,
    evidence: null,
    warnings,
  };
}

function addSecondsToHHMM(time: string | null, seconds: number | null): string | null {
  if (!time || !Number.isFinite(seconds ?? NaN) || (seconds ?? 0) < 0) return null;
  const [hText, mText] = time.split(':');
  const hours = Number(hText);
  const minutes = Number(mText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const totalMinutes = (hours * 60) + minutes + Math.round((seconds ?? 0) / 60);
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const outHours = Math.floor(normalized / 60).toString().padStart(2, '0');
  const outMinutes = (normalized % 60).toString().padStart(2, '0');
  return `${outHours}:${outMinutes}`;
}

export async function analyzeChartImage(
  base64Image: string,
  mimeType: string,
  _entryDate: string,
  entryTime: string,
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }> = [],
  scannerContext?: Record<string, unknown>
): Promise<ExtractedTradeData> {
  const colors = scannerContext?.scanner_colors as {
    supplyStopZone?: { hex: string };
    targetDemandZone?: { hex: string };
    entryZone?: { hex: string };
  } | undefined;

  const userColors = colors ? {
    stopLoss: colors.supplyStopZone?.hex ?? '#C0392B',
    takeProfit: colors.targetDemandZone?.hex ?? '#1A6B5A',
    entry: colors.entryZone?.hex ?? '#E67E22',
  } : undefined;

  const boxLeftRatio = typeof scannerContext?.box_left_ratio === 'number' ? scannerContext.box_left_ratio : null;
  const boxRightRatio = typeof scannerContext?.box_right_ratio === 'number' ? scannerContext.box_right_ratio : null;
  const boxBounds = boxLeftRatio !== null && boxRightRatio !== null
    ? { leftRatio: boxLeftRatio, rightRatio: boxRightRatio }
    : undefined;

  const rawDirectionHint = scannerContext?.direction_hint;
  const directionHint: 'Long' | 'Short' | undefined =
    rawDirectionHint === 'Long' || rawDirectionHint === 'Short' ? rawDirectionHint : undefined;

  const readRatioHint = (key: string): number | undefined => {
    const value = scannerContext?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  const lineHints = {
    entryLineRatio: readRatioHint('entry_line_ratio'),
    stopLineRatio: readRatioHint('stop_line_ratio'),
    targetLineRatio: readRatioHint('target_line_ratio'),
    timeAxisEntryXRatio: readRatioHint('time_axis_entry_x_ratio'),
  };
  const hasLineHints = Object.values(lineHints).some(value => typeof value === 'number');

  // Pixel-measured time geometry: candle pitch + gridline positions. When both
  // are present the model only OCRs axis labels and entry time is arithmetic.
  const candlePitchRatio = typeof scannerContext?.candle_pitch_ratio === 'number' && scannerContext.candle_pitch_ratio > 0
    ? scannerContext.candle_pitch_ratio
    : null;
  const gridlineRatios = Array.isArray(scannerContext?.gridline_x_ratios)
    ? (scannerContext.gridline_x_ratios as unknown[]).filter((value): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1)
    : [];
  const timeGeometry: ScannerTimeGeometry | undefined = candlePitchRatio !== null && gridlineRatios.length >= 2
    ? { pitchRatio: candlePitchRatio, gridlineRatios, boxLeftRatio }
    : undefined;

  const scannerDebug = scannerContext ? {
    direction_hint: directionHint,
    entry_line_ratio: lineHints.entryLineRatio,
    stop_line_ratio: lineHints.stopLineRatio,
    target_line_ratio: lineHints.targetLineRatio,
    box_left_ratio: boxLeftRatio ?? undefined,
    box_right_ratio: boxRightRatio ?? undefined,
    used_dynamic_crops: boxBounds !== undefined && hasLineHints,
    candle_pitch_ratio: candlePitchRatio ?? undefined,
    gridline_count: gridlineRatios.length || undefined,
    used_time_geometry: timeGeometry !== undefined,
  } : undefined;

  // Role-specific image subsets. Each pass only receives the crops relevant to
  // its job — the exit verifiers must not see price-label strips (distractors
  // for a wick-vs-line question), and the extraction pass doesn't need the
  // exit path. This halves image tokens per scan and removes noise.
  const EXTRACTION_CROPS = [
    'header-focus', 'trade-box-focus', 'price-label-focus',
    'entry-label-focus', 'stop-label-focus',
    'target-label-focus', 'time-axis-focus',
  ];
  const EXIT_CROPS = ['exit-path-focus', 'trade-box-focus'];
  const selectImages = (names: string[]) =>
    focusImages.filter(image => names.some(name => image.label.startsWith(name)));
  const extractionImages = selectImages(EXTRACTION_CROPS);
  const exitImages = selectImages(EXIT_CROPS);

  const result = await readTradeChart(
    base64Image,
    mimeType,
    extractionImages.length > 0 ? extractionImages : focusImages,
    userColors,
    boxBounds,
    directionHint,
    hasLineHints ? lineHints : undefined,
    timeGeometry,
  );
  let verifiedExitReason: 'TP' | 'SL' | null = null;
  let verifiedConfidence: 'high' | 'medium' | 'low' = 'low';
  let verifiedFirstTouchIndex: number | null = null;
  let verifiedEvidence: string | null = null;
  const verificationWarnings = [...(result.warnings ?? [])];

  if (
    result.direction
    && result.entry_price !== null
    && result.sl_price !== null
    && result.tp_price !== null
  ) {
    const tradeForVerification = {
      direction: result.direction,
      entry: result.entry_price,
      stop: result.sl_price,
      target: result.tp_price,
    };
    const [stopTouch, targetTouch, independentExit] = await Promise.all([
      detectBoundaryTouch(base64Image, mimeType, exitImages, tradeForVerification, 'SL', boxBounds),
      detectBoundaryTouch(base64Image, mimeType, exitImages, tradeForVerification, 'TP', boxBounds),
      verifyTradeExit(base64Image, mimeType, exitImages, tradeForVerification, boxBounds),
    ]);

    // The exit IS whichever boundary a candle wick touches first. A touch counts
    // whenever a scan names a concrete first-touch candle — confidence tiers the
    // warning attached to the verdict, it does not suppress the verdict.
    const stopConfirmed = stopTouch.touched && stopTouch.first_touch_candle_index !== null;
    const targetConfirmed = targetTouch.touched && targetTouch.first_touch_candle_index !== null;
    const stopIndex = stopConfirmed ? stopTouch.first_touch_candle_index : null;
    const targetIndex = targetConfirmed ? targetTouch.first_touch_candle_index : null;

    // First-touch verdict from the two independent boundary scans.
    let boundaryExit: 'TP' | 'SL' | null = null;
    let boundaryIndex: number | null = null;
    let boundaryConfidence: 'high' | 'medium' | 'low' = 'low';
    let boundaryEvidence = result.evidence;

    if (stopConfirmed && (!targetConfirmed || (stopIndex as number) < (targetIndex as number))) {
      boundaryExit = 'SL';
      boundaryIndex = stopIndex;
      boundaryConfidence = stopTouch.confidence;
      boundaryEvidence = stopTouch.evidence;
    } else if (targetConfirmed && (!stopConfirmed || (targetIndex as number) < (stopIndex as number))) {
      boundaryExit = 'TP';
      boundaryIndex = targetIndex;
      boundaryConfidence = targetTouch.confidence;
      boundaryEvidence = targetTouch.evidence;
    } else if (stopConfirmed && targetConfirmed && stopIndex === targetIndex) {
      // Same-candle span: the intrabar tick order is unknowable, but the
      // post-entry direction usually is. Anchor on the entry and read where the
      // candle closed to decide TP vs SL, instead of giving up.
      const sameCandle = await resolveSameCandleExit(base64Image, mimeType, exitImages, tradeForVerification, boxBounds);
      if (sameCandle.exit_reason) {
        boundaryExit = sameCandle.exit_reason;
        boundaryIndex = stopIndex;
        boundaryConfidence = sameCandle.confidence === 'high' ? 'medium' : sameCandle.confidence;
        boundaryEvidence = sameCandle.evidence;
        verificationWarnings.push(
          `SL and TP both hit on candle ${stopIndex}; resolved to ${sameCandle.exit_reason} from the post-entry direction (${sameCandle.evidence ?? 'candle close'}). Verify Win/Loss manually.`
        );
      } else {
        verificationWarnings.push(
          `SL and TP were both detected on candle ${stopIndex}; intrabar order cannot be determined from the screenshot.`
        );
      }
    }

    // First touch decides the exit. The independent first-touch pass no longer
    // vetoes the boundary scans — it upgrades confidence when it agrees, and
    // attaches a verify-manually warning when it disagrees. When the boundary
    // scans see no touch at all, the independent verdict fills in as a fallback
    // so a readable exit never comes back blank.
    const contradicted = independentExit.exit_reason !== null && boundaryExit !== null && independentExit.exit_reason !== boundaryExit;
    const corroborated = independentExit.exit_reason !== null && independentExit.exit_reason === boundaryExit;

    if (boundaryExit) {
      verifiedExitReason = boundaryExit;
      verifiedFirstTouchIndex = boundaryIndex;
      verifiedEvidence = boundaryEvidence;
      if (corroborated) {
        verifiedConfidence = boundaryConfidence === 'low' ? 'medium' : boundaryConfidence;
      } else if (contradicted) {
        verifiedConfidence = 'low';
        verificationWarnings.push(
          `Exit set to ${boundaryExit}, but the independent verifier read ${independentExit.exit_reason}. Verify Win/Loss manually.`
        );
      } else {
        verifiedConfidence = boundaryConfidence;
        if (boundaryConfidence !== 'high') {
          verificationWarnings.push(
            `Exit set to ${boundaryExit} from a ${boundaryConfidence}-confidence touch. Verify Win/Loss manually.`
          );
        }
      }
    } else if (independentExit.exit_reason !== null && independentExit.first_touch_candle_index !== null) {
      verifiedExitReason = independentExit.exit_reason;
      verifiedFirstTouchIndex = independentExit.first_touch_candle_index;
      verifiedConfidence = independentExit.confidence === 'high' ? 'medium' : independentExit.confidence;
      verifiedEvidence = independentExit.evidence;
      verificationWarnings.push(
        `Exit set to ${independentExit.exit_reason} from the independent verifier — the boundary scans saw no touch. Verify Win/Loss manually.`
      );
    }

    verificationWarnings.push(
      `Boundary scan: SL=${stopTouch.touched ? `candle ${stopTouch.first_touch_candle_index} (${stopTouch.confidence})` : 'not touched'}, `
      + `TP=${targetTouch.touched ? `candle ${targetTouch.first_touch_candle_index} (${targetTouch.confidence})` : 'not touched'}; `
      + `independent verifier=${independentExit.exit_reason ?? 'null'}.`
    );

    if (!verifiedExitReason) {
      verificationWarnings.push(
        'No touch of SL or TP was detected inside the trade window — the trade may still be open or the exit is outside the screenshot. Set the exit manually.'
      );
    }
  }

  let verifiedDurationSeconds = verifiedExitReason !== null
    && verifiedFirstTouchIndex !== null
    && result.timeframe_minutes !== null
    && result.timeframe_minutes > 0
      ? verifiedFirstTouchIndex * result.timeframe_minutes * 60
      : null;

  // Box-width invariant: the exit candle sits inside the position tool, so the
  // first-touch index can never exceed the candles that physically fit in the
  // box. An index past that is a miscount — discard the duration, keep the exit.
  if (
    verifiedDurationSeconds !== null
    && verifiedFirstTouchIndex !== null
    && candlePitchRatio !== null
    && boxBounds
  ) {
    const boxCandleCapacity = Math.ceil((boxBounds.rightRatio - boxBounds.leftRatio) / candlePitchRatio) + 1;
    if (verifiedFirstTouchIndex > boxCandleCapacity) {
      verificationWarnings.push(
        `First-touch candle index ${verifiedFirstTouchIndex} exceeds the ~${boxCandleCapacity} candles that fit inside the position tool — duration discarded as a miscount. Set the exit time manually.`
      );
      verifiedDurationSeconds = null;
    }
  }

  // No wall-clock fallback: a scan that cannot read the entry time returns
  // null so the journal shows "verify time" instead of a fabricated clock stamp.
  void entryTime;
  if (result.entry_time === null) {
    verificationWarnings.push('Entry time could not be read from the chart x-axis — set it manually in the journal.');
  }
  const verifiedCloseTime = addSecondsToHHMM(result.entry_time, verifiedDurationSeconds);

  return {
    symbol: result.symbol,
    direction: result.direction,
    entry_price: result.entry_price,
    entry_time: result.entry_time,
    close_time: verifiedCloseTime,
    entry_time_confidence: result.confidence,
    sl_price: result.sl_price,
    tp_price: result.tp_price,
    trade_length_seconds: verifiedDurationSeconds,
    candle_count: null,
    timeframe_minutes: result.timeframe_minutes,
    exit_reason: verifiedExitReason,
    pnl_result: verifiedExitReason === 'TP' ? 'Win' : verifiedExitReason === 'SL' ? 'Loss' : null,
    exit_confidence: verifiedConfidence,
    first_touch_candle_index: verifiedFirstTouchIndex,
    first_touch_evidence: verifiedEvidence,
    warnings: verificationWarnings,
    scanner_debug: scannerDebug,
  };
}
