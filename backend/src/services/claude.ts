import Anthropic from '@anthropic-ai/sdk';
import { Trade, ExtractedTradeData } from '../types/index';
import dotenv from 'dotenv';
import { inflateSync } from 'zlib';
import sharp from 'sharp';

dotenv.config({ override: true });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-5';
const MODEL_TEMPERATURE = 0;
const EXIT_CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
const VALID_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
const MANUAL_READING_PROCESS = `Read the chart in this exact order:

0. If the screenshot contains more than one chart or comparison pane, ONLY analyse the chart that contains the colored risk/reward box. Ignore every other chart, even if it shows correlated price action.

1. Read the symbol and timeframe from the top-left label of the chart that contains the risk/reward box.
   - The timeframe is the small interval value immediately beside the symbol/ticker in the top-left TradingView header.
   - Example: "MNQM6 · 1 · CME" means timeframe_minutes = 1.
   - Example: "NQ1! · 5" means timeframe_minutes = 5.
   - Use the header number/text next to the ticker only.
   - Do NOT infer timeframe from candle spacing, the x-axis, how long the trade lasts, or how many candles fit on screen.
   - If the header uses hour notation like 1H or 4H, convert it to minutes.

2. Identify the P&L box: the semi-transparent overlay of TWO colored zones on the chart.
   - TEAL (mint/cyan green) zone = profit target area
   - PINK (light red/rose) zone = stop loss risk area

3. CRITICAL — Identify the three price levels attached to the P&L box boundaries:
   - Configured entry-color pill/box label on the right-side price axis = entry price. On the right axis you may see several labels: a GREEN one (live price — ignore it), a RED one (stop loss), black/white horizontal-line labels (ignore them), and an entry label using the user's scanner entry-zone color. Read the number printed inside the configured entry-color pill exactly — it is the entry price. If no configured-color entry pill is visible, a grey TradingView entry pill is an acceptable fallback. Do not read axis gridline text, do not use black/white key-level labels, and do not interpolate between gridlines.
   - RED label on the right-side price axis = stop loss (the OUTERMOST far edge of the pink zone — the edge furthest from entry, NOT any intermediate level inside the pink zone).
   - The TAKE PROFIT is the OUTERMOST far edge of the teal zone (the edge furthest from entry).

   HOW TO FIND THE TAKE PROFIT:
   a. Locate the teal box. Find its ABSOLUTE outermost edge (top edge for Long, bottom edge for Short). That is the TP level — it is the boundary where the teal box ends.
   b. Trace that outermost edge horizontally to the right-axis price scale to read the price.
   c. IGNORE any dashed lines, horizontal lines, or colored markers drawn INSIDE the teal box body — those are NOT the TP. The TP is only at the outermost boundary of the teal box itself.
   d. IGNORE any horizontal lines drawn on the chart that cross the chart area but do not coincide with the actual outer edge of the teal box.
   e. There may be a small teal/green label AT THAT OUTERMOST EDGE — use it if visible.
   f. NEVER use the live/current-price label as the TP. The live price label is the topmost or bottom-most floating green label that shows the most recent market price — it is NOT attached to the P&L box and will be at a very different price from the teal box edge. If a green label is far outside the P&L box range, it is the live price — ignore it.
   g. If target-label-focus is attached, that crop is centered on the TP level. If you see a green label aligned with the teal box OUTER edge in that crop, use it as tp_price even if it resembles the live/current-price label.

4. Confirm direction from box layout:
   - Long: teal zone ABOVE entry, pink zone BELOW entry → tp_price > entry_price
   - Short: pink zone ABOVE entry, teal zone BELOW entry → tp_price < entry_price
   If your identified tp_price is outside the visible teal box, you have the wrong label — re-read step 3.
   If tp_price equals an intermediate level inside the teal zone rather than its outermost edge, you have the wrong label — re-read step 3.

5. Read the entry time from the x-axis using the left edge of the P&L box.
6. Starting at the entry candle, move candle by candle to decide whether stop loss or take profit is touched first.
7. Count candles to the exit candle and calculate trade_length_seconds from the timeframe.

Do not invent labels that are not visible. Prefer the single most likely journal-ready answer.
Never use a second chart pane to decide exit order for the primary trade.`;
const FIRST_TOUCH_RULE = `The first touch decides the outcome.
- Stop scanning as soon as either stop loss or take profit is hit.
- Ignore any later move after the first touch.
- If price hits stop first and later reaches target, the correct result is still SL.
- If price hits target first and later reaches stop, the correct result is still TP.
- CRITICAL: The current live price shown on the right axis (the floating green label) is NOT the trade exit. Ignore it completely. Only look at candles AFTER the entry point.
- Work candle by candle from the entry forward (left to right). The FIRST candle whose wick touches the SL or TP level decides the result — everything after that is irrelevant.`;

type ExitConfidence = typeof EXIT_CONFIDENCE_VALUES[number];
type ImageMimeType = typeof VALID_MIME_TYPES[number];

interface ChartImageInput {
  base64Image: string;
  mimeType: ImageMimeType;
  label: string;
}

interface ExitVerificationResult {
  exit_reason: 'TP' | 'SL' | null;
  trade_length_seconds: number | null;
  candle_count: number | null;
  timeframe_minutes: number | null;
  exit_confidence: ExitConfidence | null;
  first_touch_candle_index: number | null;
  first_touch_evidence: string | null;
}

interface LevelTouchSanityResult {
  stop_touched: boolean | null;
  target_touched: boolean | null;
  first_touch: 'TP' | 'SL' | null;
  evidence: string | null;
}

interface ExactPriceRead {
  direction: 'Long' | 'Short' | null;
  entry_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
}

interface HeaderIdentityRead {
  symbol: string | null;
  timeframe_minutes: number | null;
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
  scanner_colors?: {
    entryZone?: { hex?: string };
    supplyStopZone?: { hex?: string };
    targetDemandZone?: { hex?: string };
  };
  red_box?: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  };
  green_box?: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  };
}

interface DecodedImageData {
  width: number;
  height: number;
  data: Uint8Array;
}

interface DeterministicExitCheck {
  exit_reason: 'TP' | 'SL' | null;
  evidence: string | null;
}

function parseJsonObject(rawText: string): Record<string, unknown> {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Claude response');
  }

  return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngImage(base64Image: string): DecodedImageData | null {
  const buffer = Buffer.from(base64Image, 'base64');
  const signature = '89504e470d0a1a0a';

  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== signature) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkLength;

    if (chunkDataEnd + 4 > buffer.length) {
      return null;
    }

    const chunkData = buffer.subarray(chunkDataStart, chunkDataEnd);

    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlaceMethod = chunkData[12];
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }

    offset = chunkDataEnd + 4;
  }

  if (!width || !height || bitDepth !== 8 || interlaceMethod !== 0 || ![2, 6].includes(colorType) || idatChunks.length === 0) {
    return null;
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));

  if (inflated.length < height * (stride + 1)) {
    return null;
  }

  const raw = Buffer.alloc(height * stride);
  let inputOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = inflated[inputOffset++];
    const rowStart = y * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = inflated[inputOffset++];
      const left = x >= bytesPerPixel ? raw[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[rowStart + x - stride] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? raw[rowStart + x - stride - bytesPerPixel] : 0;

      let value = rawByte;
      if (filterType === 1) value = (rawByte + left) & 0xff;
      else if (filterType === 2) value = (rawByte + up) & 0xff;
      else if (filterType === 3) value = (rawByte + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) value = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;

      raw[rowStart + x] = value;
    }
  }

  if (colorType === 6) {
    return {
      width,
      height,
      data: new Uint8Array(raw),
    };
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = 255;
  }

  return { width, height, data: rgba };
}

function isDarkPricePixel(r: number, g: number, b: number, a: number): boolean {
  return a > 180 && r < 120 && g < 120 && b < 120;
}

function getColumnPriceExtents(
  data: Uint8Array,
  width: number,
  x: number,
  yStart: number,
  yEnd: number
): { minY: number; maxY: number } | null {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;

  for (let y = yStart; y < yEnd; y++) {
    const index = (y * width + x) * 4;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];
    const isDark = isDarkPricePixel(r, g, b, a);

    if (isDark && runStart === null) {
      runStart = y;
      continue;
    }

    if (!isDark && runStart !== null) {
      if (y - runStart >= 3) {
        runs.push({ start: runStart, end: y - 1 });
      }
      runStart = null;
    }
  }

  if (runStart !== null && yEnd - runStart >= 3) {
    runs.push({ start: runStart, end: yEnd - 1 });
  }

  if (!runs.length) {
    return null;
  }

  return {
    minY: Math.min(...runs.map(run => run.start)),
    maxY: Math.max(...runs.map(run => run.end)),
  };
}

function detectDeterministicExitFromDecodedImage(
  image: DecodedImageData | null,
  scannerContext?: ScannerContext
): DeterministicExitCheck | null {
  const context = scannerContext;
  if (
    !image ||
    !context ||
    context.stop_line_ratio === undefined ||
    context.target_line_ratio === undefined ||
    context.box_left_ratio === undefined
  ) {
    return null;
  }

  const { width, height, data } = image;
  const inferredDirection =
    context.direction_hint ??
    (context.stop_line_ratio < context.target_line_ratio ? 'Short' : 'Long');
  const searchStartX = Math.max(0, Math.floor(width * context.box_left_ratio) + 2);
  const searchEndX = Math.max(searchStartX + 1, Math.floor(width * 0.88));
  const searchMinY = Math.floor(height * 0.08);
  const searchMaxY = Math.floor(height * 0.92);
  const stopY = Math.floor(height * context.stop_line_ratio);
  const targetY = Math.floor(height * context.target_line_ratio);
  const tolerance = 2;

  let firstStopX: number | null = null;
  let firstTargetX: number | null = null;

  for (let x = searchStartX; x < searchEndX; x++) {
    const columnExtents = getColumnPriceExtents(data, width, x, searchMinY, searchMaxY);
    if (!columnExtents) {
      continue;
    }

    const { minY: columnMinY, maxY: columnMaxY } = columnExtents;
    if (inferredDirection === 'Short') {
      if (firstStopX === null && columnMinY <= stopY + tolerance) {
        firstStopX = x;
      }
      if (firstTargetX === null && columnMaxY >= targetY - tolerance) {
        firstTargetX = x;
      }
    } else {
      if (firstStopX === null && columnMaxY >= stopY - tolerance) {
        firstStopX = x;
      }
      if (firstTargetX === null && columnMinY <= targetY + tolerance) {
        firstTargetX = x;
      }
    }
  }

  if (firstStopX === null && firstTargetX === null) {
    return null;
  }

  if (firstStopX !== null && firstTargetX === null) {
    return {
      exit_reason: 'SL',
      evidence: 'Price reached the stop-loss level before the take-profit level.',
    };
  }

  if (firstTargetX !== null && firstStopX === null) {
    return {
      exit_reason: 'TP',
      evidence: 'Price reached the take-profit level before the stop-loss level.',
    };
  }

  if (firstStopX !== null && firstTargetX !== null) {
    if (Math.abs(firstStopX - firstTargetX) <= 3) {
      return null;
    }

    const stopFirst = firstStopX < firstTargetX;
    return {
      exit_reason: stopFirst ? 'SL' : 'TP',
      evidence: stopFirst
        ? 'Price touched the stop-loss before the take-profit.'
        : 'Price touched the take-profit before the stop-loss.',
    };
  }

  return null;
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeScannedSymbol(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.toUpperCase().trim();
  const cleaned = normalized
    .replace(/[|:,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rootCleaned = cleaned.replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, '');
  const invalidValues = new Set([
    'UNKNOWN',
    'UNKWN',
    'N/A',
    'NA',
    'NONE',
    'NULL',
    'FUTURES',
    'MICRO',
    'E-MINI',
    'EMINI',
    'MICRO FUTURES',
    'NASDAQ FUTURES',
    'S&P FUTURES',
    'TRADINGVIEW',
  ]);

  if (invalidValues.has(rootCleaned)) {
    return null;
  }

  const explicitTickerPatterns: Array<[RegExp, string]> = [
    [/\bMNQ[A-Z]?\d{1,2}\b/, 'MNQ'],
    [/\bMES[A-Z]?\d{1,2}\b/, 'MES'],
    [/\bMYM[A-Z]?\d{1,2}\b/, 'MYM'],
    [/\bM2K[A-Z]?\d{1,2}\b/, 'M2K'],
    [/\bMCL[A-Z]?\d{1,2}\b/, 'MCL'],
    [/\bMGC[A-Z]?\d{1,2}\b/, 'MGC'],
    [/\bMBT[A-Z]?\d{1,2}\b/, 'MBT'],
    [/\bMET[A-Z]?\d{1,2}\b/, 'MET'],
    [/\bNQ[A-Z]?\d{1,2}\b/, 'NQ'],
    [/\bES[A-Z]?\d{1,2}\b/, 'ES'],
    [/\bYM[A-Z]?\d{1,2}\b/, 'YM'],
    [/\bRTY[A-Z]?\d{1,2}\b/, 'RTY'],
    [/\bCL[A-Z]?\d{1,2}\b/, 'CL'],
    [/\bGC[A-Z]?\d{1,2}\b/, 'GC'],
    [/\bSI[A-Z]?\d{1,2}\b/, 'SI'],
    [/\bZB[A-Z]?\d{1,2}\b/, 'ZB'],
    [/\bZN[A-Z]?\d{1,2}\b/, 'ZN'],
    [/\bZF[A-Z]?\d{1,2}\b/, 'ZF'],
    [/\b6E[A-Z]?\d{1,2}\b/, '6E'],
    [/\b6B[A-Z]?\d{1,2}\b/, '6B'],
    [/\b6J[A-Z]?\d{1,2}\b/, '6J'],
    [/\bBTC[A-Z]?\d{0,2}\b/, 'BTC'],
    [/\bETH[A-Z]?\d{0,2}\b/, 'ETH'],
  ];

  for (const [pattern, ticker] of explicitTickerPatterns) {
    if (pattern.test(cleaned)) {
      return ticker;
    }
  }

  if (cleaned.includes('MICRO NASDAQ') || cleaned.includes('MICRO E-MINI NASDAQ') || cleaned.includes('MICRO NASDAQ-100')) {
    return 'MNQ';
  }

  if (cleaned.includes('NASDAQ')) {
    return cleaned.includes('MICRO') ? 'MNQ' : 'NQ';
  }

  if (cleaned.includes('MICRO S&P') || cleaned.includes('MICRO SP')) {
    return 'MES';
  }

  if (cleaned.includes('S&P') || cleaned.includes('SP 500') || cleaned.includes('E-MINI S&P') || cleaned.includes('E MINI S&P')) {
    return cleaned.includes('MICRO') ? 'MES' : 'ES';
  }

  return invalidValues.has(rootCleaned) ? null : rootCleaned;
}

function parseNullableTime(value: unknown): string | null {
  const normalized = parseNullableString(value);
  return normalized && /^\d{2}:\d{2}$/.test(normalized) ? normalized : null;
}

function parseNullableDirection(value: unknown): 'Long' | 'Short' | null {
  return value === 'Long' || value === 'Short' ? value : null;
}

function parseNullableExitReason(value: unknown): 'TP' | 'SL' | null {
  return value === 'TP' || value === 'SL' ? value : null;
}

function parseNullablePnLResult(value: unknown): 'Win' | 'Loss' | null {
  return value === 'Win' || value === 'Loss' ? value : null;
}

function parseNullableExitConfidence(value: unknown): ExitConfidence | null {
  return typeof value === 'string' && EXIT_CONFIDENCE_VALUES.includes(value as ExitConfidence)
    ? (value as ExitConfidence)
    : null;
}

function parseNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function pickFirstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }

  return null;
}

function appendWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function buildEntryTimeHint(extractedEntryTime: string | null): string {
  return extractedEntryTime
    ? `Use the screenshot's entry time of ${extractedEntryTime} only if it matches the x-axis.`
    : 'Do not use any fallback clock time to decide the outcome. Read the entry candle from the left edge of the risk/reward box on the screenshot.';
}

function formatScannerContext(scannerContext?: ScannerContext): string {
  if (!scannerContext) {
    return 'No geometric trade-box detection metadata was available.';
  }

  const directionDirective = scannerContext.direction_hint === 'Short'
    ? `CRITICAL — DIRECTION IS SHORT: Pixel analysis confirmed the red/pink zone is ABOVE entry and teal zone is BELOW entry.
  - stop-label-focus IS centered on the SL level which is ABOVE entry → sl_price WILL BE GREATER than entry_price
  - target-label-focus IS centered on the TP level which is BELOW entry → tp_price WILL BE LESS than entry_price
  - Do NOT swap or re-interpret these values. Read each crop as labelled. Do NOT use price ordering to override the direction.`
    : scannerContext.direction_hint === 'Long'
    ? `CRITICAL — DIRECTION IS LONG: Pixel analysis confirmed the teal zone is ABOVE entry and red/pink zone is BELOW entry.
  - stop-label-focus IS centered on the SL level which is BELOW entry → sl_price WILL BE LESS than entry_price
  - target-label-focus IS centered on the TP level which is ABOVE entry → tp_price WILL BE GREATER than entry_price
  - Do NOT swap or re-interpret these values. Read each crop as labelled. Do NOT use price ordering to override the direction.`
    : 'Direction could not be determined from pixel analysis — infer from box layout.';

  return `Detected trade-box geometry from image processing:
${directionDirective}
- direction_hint: ${scannerContext.direction_hint ?? 'unknown'}
- entry_line_ratio: ${scannerContext.entry_line_ratio ?? 'unknown'}
- entry_label_candidate_ratio: ${scannerContext.entry_label_candidate_ratio ?? 'unknown'}
- stop_line_ratio: ${scannerContext.stop_line_ratio ?? 'unknown'}
- target_line_ratio: ${scannerContext.target_line_ratio ?? 'unknown'}
- box_left_ratio: ${scannerContext.box_left_ratio ?? 'unknown'}
- box_right_ratio: ${scannerContext.box_right_ratio ?? 'unknown'}`;
}

function describeImageLabel(label: string): string {
  switch (label) {
    case 'full_chart':
      return 'the full chart for overall candle sequence, x-axis timing, and confirmation';
    case 'header-focus':
      return 'a zoomed crop of the top-left chart header for symbol and timeframe; the timeframe is the interval immediately beside the ticker';
    case 'trade-box-focus':
      return 'a zoomed crop around the trade box for direction, entry edge, and price movement';
    case 'entry-window-focus':
      return 'a tight crop around the left edge of the trade box and the first candles after entry; use this as the primary first-touch view';
    case 'exit-path-focus':
      return 'a focused crop covering the immediate candles after entry and the full path to the first likely exit touch';
    case 'price-label-focus':
      return 'a zoomed crop of the right-side price labels; use this for the exact entry, stop, and target numbers';
    case 'entry-label-focus':
      return 'a tight crop centered on the entry price label; use this as the primary source for entry_price';
    case 'entry-color-label-focus':
      return 'an alternate tight crop around the configured entry-color price pill; prefer it over black or white line labels for entry_price';
    case 'stop-label-focus':
      return 'a tight crop centered on the stop-loss label; use this as the primary source for sl_price';
    case 'target-label-focus':
      return 'a tight crop centered on the take-profit label; use this as the primary source for tp_price';
    default:
      return 'an additional focused crop of the chart';
  }
}

function selectImagesByLabels(images: ChartImageInput[], labels: string[]): ChartImageInput[] {
  const allowedLabels = new Set(labels);
  const selected = images.filter(image => allowedLabels.has(image.label));

  if (selected.length > 0) {
    return selected;
  }

  return images.filter(image => image.label === 'full_chart');
}

function hasValidLevelStructure(direction: 'Long' | 'Short' | null, entry: number | null, stop: number | null, target: number | null): boolean {
  if (!direction || entry === null || stop === null || target === null) {
    return false;
  }

  return direction === 'Long'
    ? stop < entry && entry < target
    : target < entry && entry < stop;
}

function normalizeExitConfidence(...values: Array<ExitConfidence | null>): ExitConfidence | null {
  if (values.includes('high')) return 'high';
  if (values.includes('medium')) return 'medium';
  if (values.includes('low')) return 'low';
  return null;
}

function pickMostCommonString<T extends string>(...values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();

  values.forEach(value => {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  });

  let bestValue: T | null = null;
  let bestCount = 0;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });

  return bestValue;
}

function countVotes(...values: Array<'TP' | 'SL' | null>): { TP: number; SL: number } {
  return values.reduce((acc, value) => {
    if (value === 'TP' || value === 'SL') {
      acc[value] += 1;
    }
    return acc;
  }, { TP: 0, SL: 0 });
}

function pickMostCommonNumber(...values: Array<number | null>): number | null {
  const counts = new Map<number, number>();

  values.forEach(value => {
    if (value !== null) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  });

  let bestValue: number | null = null;
  let bestCount = 0;
  counts.forEach((count, value) => {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  });

  return bestValue;
}

function chooseConsensusNumber(...values: Array<number | null | undefined>): number | null {
  const normalized = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (normalized.length === 0) {
    return null;
  }

  const mostCommon = pickMostCommonNumber(...normalized);
  if (mostCommon !== null) {
    return mostCommon;
  }

  const sorted = [...normalized].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function inferDirectionFromLevels(entry: number | null, stop: number | null, target: number | null): 'Long' | 'Short' | null {
  if (entry === null || stop === null || target === null) {
    return null;
  }

  if (stop < entry && entry < target) {
    return 'Long';
  }

  if (target < entry && entry < stop) {
    return 'Short';
  }

  return null;
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return Array.from(
    new Set(
      values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    )
  );
}

function repairTradeStructure(
  direction: 'Long' | 'Short' | null,
  entry: number | null,
  stop: number | null,
  target: number | null,
  labeledCandidates: {
    entries: Array<number | null | undefined>;
    stops: Array<number | null | undefined>;
    targets: Array<number | null | undefined>;
  }
): {
  direction: 'Long' | 'Short' | null;
  entry_price: number | null;
  sl_price: number | null;
  tp_price: number | null;
} {
  const resolvedDirection = direction ?? inferDirectionFromLevels(entry, stop, target);

  if (hasValidLevelStructure(resolvedDirection, entry, stop, target)) {
    return {
      direction: resolvedDirection,
      entry_price: entry,
      sl_price: stop,
      tp_price: target,
    };
  }

  const entryCandidates = uniqueNumbers(labeledCandidates.entries);
  const stopCandidates = uniqueNumbers(labeledCandidates.stops);
  const targetCandidates = uniqueNumbers(labeledCandidates.targets);
  const allCandidates = uniqueNumbers([...entryCandidates, ...stopCandidates, ...targetCandidates]);

  if (!resolvedDirection || allCandidates.length < 3) {
    return {
      direction: resolvedDirection,
      entry_price: entry,
      sl_price: stop,
      tp_price: target,
    };
  }

  const sortedAll = [...allCandidates].sort((a, b) => a - b);
  const minCandidate = sortedAll[0];
  const maxCandidate = sortedAll[sortedAll.length - 1];
  const interiorCandidates = sortedAll.filter(value => value > minCandidate && value < maxCandidate);

  const preferredEntry = chooseConsensusNumber(entry, ...entryCandidates);
  const preferredStop = chooseConsensusNumber(stop, ...stopCandidates);
  const preferredTarget = chooseConsensusNumber(target, ...targetCandidates);

  if (resolvedDirection === 'Long') {
    const repairedStop = stopCandidates.find(value => value < (preferredEntry ?? Number.POSITIVE_INFINITY)) ?? preferredStop ?? minCandidate;
    const repairedTarget = [...targetCandidates].reverse().find(value => value > (preferredEntry ?? Number.NEGATIVE_INFINITY)) ?? preferredTarget ?? maxCandidate;
    const repairedEntry = entryCandidates.find(value => value > repairedStop && value < repairedTarget)
      ?? preferredEntry
      ?? interiorCandidates[0]
      ?? sortedAll[Math.floor(sortedAll.length / 2)];

    return {
      direction: 'Long',
      entry_price: repairedEntry,
      sl_price: repairedStop,
      tp_price: repairedTarget,
    };
  }

  const repairedStop = [...stopCandidates].reverse().find(value => value > (preferredEntry ?? Number.NEGATIVE_INFINITY)) ?? preferredStop ?? maxCandidate;
  const repairedTarget = targetCandidates.find(value => value < (preferredEntry ?? Number.POSITIVE_INFINITY)) ?? preferredTarget ?? minCandidate;
  const repairedEntry = entryCandidates.find(value => value > repairedTarget && value < repairedStop)
    ?? preferredEntry
    ?? interiorCandidates[interiorCandidates.length - 1]
    ?? sortedAll[Math.floor(sortedAll.length / 2)];

  return {
    direction: 'Short',
    entry_price: repairedEntry,
    sl_price: repairedStop,
    tp_price: repairedTarget,
  };
}

function clearExitOutcome(data: ExtractedTradeData): void {
  data.exit_reason = null;
  data.pnl_result = null;
  data.trade_length_seconds = null;
  data.candle_count = null;
  data.exit_confidence = null;
  data.first_touch_candle_index = null;
  data.first_touch_evidence = null;
}

function sanitizeExtractedTradeData(raw: Record<string, unknown>): ExtractedTradeData {
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];

  const data: ExtractedTradeData = {
    symbol: parseNullableString(raw.symbol),
    direction: parseNullableDirection(raw.direction),
    entry_price: parseNullableNumber(raw.entry_price),
    entry_time: parseNullableTime(raw.entry_time),
    entry_time_confidence: parseNullableExitConfidence(raw.entry_time_confidence),
    sl_price: parseNullableNumber(raw.sl_price),
    tp_price: parseNullableNumber(raw.tp_price),
    trade_length_seconds: parseNullableNumber(raw.trade_length_seconds),
    candle_count: parseNullableNumber(raw.candle_count),
    timeframe_minutes: parseNullableNumber(raw.timeframe_minutes),
    exit_reason: parseNullableExitReason(raw.exit_reason),
    pnl_result: parseNullablePnLResult(raw.pnl_result),
    exit_confidence: parseNullableExitConfidence(raw.exit_confidence),
    first_touch_candle_index: parseNullableNumber(raw.first_touch_candle_index),
    first_touch_evidence: parseNullableString(raw.first_touch_evidence),
    warnings,
  };

  if (data.symbol) {
    data.symbol = normalizeScannedSymbol(data.symbol);
  }

  if (data.exit_reason !== null) {
    data.pnl_result = data.exit_reason === 'TP' ? 'Win' : 'Loss';
  }

  return data;
}

function sanitizeExactPriceRead(raw: Record<string, unknown>): ExactPriceRead {
  return {
    direction: parseNullableDirection(raw.direction),
    entry_price: parseNullableNumber(raw.entry_price),
    sl_price: parseNullableNumber(raw.sl_price),
    tp_price: parseNullableNumber(raw.tp_price),
  };
}

function sanitizeHeaderIdentityRead(raw: Record<string, unknown>): HeaderIdentityRead {
  return {
    symbol: normalizeScannedSymbol(parseNullableString(raw.symbol)),
    timeframe_minutes: parseNullableNumber(raw.timeframe_minutes),
  };
}

async function extractHeaderIdentity(images: ChartImageInput[]): Promise<HeaderIdentityRead> {
  const systemPrompt = `You are reading ONLY the TradingView header of the single chart that contains the colored risk/reward box.

  Read only:
  - the exact futures ticker/root from the top-left chart label
  - the timeframe from the small interval immediately beside the ticker in that same header

Critical symbol rules:
- Return the tradeable root ticker, not generic words
- Good outputs: MNQ, NQ, MES, ES, MYM, YM, M2K, RTY, CL, MCL, GC, MGC, SI, SIL, 6E, 6B, 6J, BTC, MBT, ETH, MET
- If the header shows an expiry code like MNQM26 or NQU6, return the root ticker only: MNQ or NQ
- If the header says Micro Nasdaq-100 or Micro E-mini Nasdaq-100, return MNQ
- If the header says E-mini Nasdaq-100, return NQ
- NEVER return generic words like Futures, Micro, E-mini, CME, CBOT, or TradingView as the symbol

Critical timeframe rules:
- Read the timeframe ONLY from the interval shown immediately beside the ticker/root in the top-left header
- Example: "MNQM6 · 1 · CME" => timeframe_minutes = 1
- Example: "NQ1! · 5" => timeframe_minutes = 5
- Example: "ES1! · 15" => timeframe_minutes = 15
- Do NOT estimate timeframe from candle width, chart zoom, x-axis spacing, or trade duration
- Return timeframe_minutes as a number in minutes only

Return ONLY a raw JSON object with these exact keys:
symbol, timeframe_minutes`;

  return sanitizeHeaderIdentityRead(await callClaudeJson(
    systemPrompt,
    images,
    'Read only the instrument ticker/root and the timeframe interval printed immediately beside it in the header of the chart containing the colored risk/reward box.',
    250
  ));
}

function buildPriceExtractionPrompt(scannerContext?: ScannerContext): string {
  const hasGeometry = Boolean(
    scannerContext?.entry_line_ratio != null &&
    scannerContext?.stop_line_ratio  != null &&
    scannerContext?.target_line_ratio != null
  );

  const pct = (r: number) => (r * 100).toFixed(1);
  const entryColor = scannerContext?.scanner_colors?.entryZone?.hex ?? '#E67E22';

  const geometrySection = hasGeometry ? `
PIXEL GEOMETRY (from pre-scan analysis — use these to locate each label):
- Entry price label: ${pct(scannerContext!.entry_line_ratio!)}% from the TOP of the full chart image
${scannerContext!.entry_label_candidate_ratio != null ? `- Configured entry-color pill candidate: ${pct(scannerContext!.entry_label_candidate_ratio)}% from the TOP of the full chart image` : ''}
- Stop price label:  ${pct(scannerContext!.stop_line_ratio!)}% from the TOP of the full chart image
- Target price label:${pct(scannerContext!.target_line_ratio!)}% from the TOP of the full chart image
- Trade direction hint: ${scannerContext!.direction_hint ?? 'unknown'}
- User configured entry-zone color: ${entryColor}

The dedicated label crops (entry-label-focus, entry-color-label-focus when present, stop-label-focus, target-label-focus)
have been 2× upscaled with nearest-neighbour interpolation so digits are crisp.
` : `
No geometry hints available. Read all visible price labels from the price axis.
`;

  return `Read the exact price values for entry, stop-loss, and take-profit from the chart.
${geometrySection}
READING PROCEDURE — follow every step:

STEP 1 — Examine the price-label-focus image (full right-hand price axis).
  Identify the labelled price levels that correspond to the trade box.
  CRITICAL: TradingView displays a floating green box label on the right axis showing the current live market price.
  This is NOT a trade level — it is where price is right now, not entry/SL/TP.
  IGNORE IT COMPLETELY. Do not assign it to entry, stop-loss, or take-profit under any circumstances.

STEP 2 — Examine the trade-box-focus image.
  Identify the coloured boxes (red = SL zone, teal/green = TP zone).
  Note where each box begins and ends relative to the price axis.

AUTHORITY RULE: The dedicated crops (entry-label-focus, entry-color-label-focus when present, stop-label-focus, target-label-focus) are
  the ONLY authoritative source for each price. Read the digits in THAT crop for THAT field only.
  Never substitute a value from the general price axis or from any other crop into a different field.
  If entry-color-label-focus clearly shows the configured entry-color position pill, it overrides entry-label-focus for entry_price.

STEP 3 — For the ENTRY price:
  Look at the entry-label-focus crop. If entry-color-label-focus is attached, examine it too.
  Read every digit left to right. Do not guess. Do not round.
  Cross-check: the entry price should be the TradingView position label using the configured entry-zone color (${entryColor}). If this crop contains a black/white horizontal-line label and a separate configured-color or grey position label is visible elsewhere, do NOT use the black/white value as entry_price.
  IMPORTANT: Black or white right-axis labels such as horizontal key levels are not entry labels. The configured entry-color pill wins; grey is only a fallback.

STEP 4 — For the STOP-LOSS price:
  Look at the stop-label-focus crop. It is centred on the stop level.
  Read every digit left to right. Do not guess. Do not round.
  IMPORTANT: The crop label tells you what level this is — trust it. Do NOT swap this value with the target.

STEP 5 — For the TAKE-PROFIT price:
  Look at the target-label-focus crop. It is centred on the target level.
  Read every digit left to right. Do not guess. Do not round.
  IMPORTANT: The crop label tells you what level this is — trust it. Do NOT swap this value with the stop.

STEP 6 — DIGIT VERIFICATION:
  For each price, spell out the digits you read (e.g., "2 1 3 4 5 point 5 0").
  If any digit is ambiguous between two values (e.g., 3 vs 8, 1 vs 7), read the
  full-price-axis image to find a nearby unambiguous label for context.

STEP 7 — RETURN JSON:
  Only return prices you are certain about. Return null for any price you cannot
  read with full confidence.

Return ONLY this JSON with no preamble:
{
  "entry_price": number | null,
  "sl_price": number | null,
  "tp_price": number | null,
  "direction": "Long" | "Short" | null,
  "entry_digits_read": string,
  "sl_digits_read": string,
  "tp_digits_read": string,
  "entry_confidence": "high" | "medium" | "low",
  "sl_confidence": "high" | "medium" | "low",
  "tp_confidence": "high" | "medium" | "low"
}`;
}

async function extractExactPriceLevels(
  images: ChartImageInput[],
  scannerContext?: ScannerContext
): Promise<ExactPriceRead> {
  const systemPrompt = `You are a price-axis OCR engine. You read exact numerical values from TradingView
chart screenshots with zero tolerance for errors. You never estimate or interpolate.
You never round to a "nice" number. You read the digits that are literally printed
on screen. Return only valid JSON.`;

  const imageContent = images.map(image => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mimeType as ImageMimeType,
      data: image.base64Image,
    },
  }));

  const imageGuide = images
    .map((image, index) => `Image ${index + 1} (${image.label}): ${describeImageLabel(image.label)}`)
    .join('\n');

  const response = await (anthropic as unknown as { messages: { create: (params: unknown, options?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } }).messages.create(
    {
      model: MODEL,
      max_tokens: 4000,
      temperature: 0,
      thinking: { type: 'enabled', budget_tokens: 2000 },
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: `${buildPriceExtractionPrompt(scannerContext)}\n\nAttached views:\n${imageGuide}`,
            },
          ],
        },
      ],
    },
    { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } }
  );

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');

  return sanitizeExactPriceRead(parseJsonObject(text.trim()));
}

async function verifyPriceDigits(
  priceImages: ChartImageInput[],
  candidate: { entry_price: number | null; sl_price: number | null; tp_price: number | null; direction: string | null },
  scannerContext?: ScannerContext
): Promise<{ entry_price: number | null; sl_price: number | null; tp_price: number | null; changed: boolean }> {
  if (!candidate.entry_price && !candidate.sl_price && !candidate.tp_price) {
    return { ...candidate, changed: false };
  }

  const imageContent = priceImages.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as ImageMimeType, data: img.base64Image },
  }));

  const pct = (r: number | undefined | null) => r != null ? (r * 100).toFixed(1) : 'unknown';

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    temperature: 0,
    system: 'You verify that price numbers read from a chart are correct. You double-check digit by digit. Return only JSON.',
    messages: [{
      role: 'user',
      content: [
        ...imageContent,
        {
          type: 'text',
          text: `A previous read extracted these prices from the chart:
- Entry: ${candidate.entry_price ?? 'not found'}
- Stop Loss: ${candidate.sl_price ?? 'not found'}
- Take Profit: ${candidate.tp_price ?? 'not found'}
- Direction: ${candidate.direction ?? 'unknown'}
${scannerContext?.entry_line_ratio != null ? `
Pixel positions (% from top of image):
- Entry label at: ${pct(scannerContext.entry_line_ratio)}%
- Stop label at:  ${pct(scannerContext.stop_line_ratio)}%
- Target label at:${pct(scannerContext.target_line_ratio)}%` : ''}

For each price that was found, look at the corresponding label crop image and verify:
1. Are the digits correct? Read them left-to-right explicitly.
2. Could any digit be misread (3↔8, 1↔7, 5↔6, 0↔9)?
3. Is the decimal point in the right place?
4. Does the price order make sense for a ${candidate.direction ?? 'unknown'} trade?

If a price is CORRECT, return it unchanged.
If a price has a WRONG DIGIT, return the corrected value.
If you CANNOT VERIFY a price (label not visible), return the original value unchanged.

Return ONLY:
{
  "entry_price": number | null,
  "sl_price": number | null,
  "tp_price": number | null,
  "entry_verified": boolean,
  "sl_verified": boolean,
  "tp_verified": boolean,
  "corrections": string[]
}`,
        },
      ],
    }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    const changed =
      parsed.entry_price !== candidate.entry_price ||
      parsed.sl_price    !== candidate.sl_price    ||
      parsed.tp_price    !== candidate.tp_price;

    return {
      entry_price: parseNullableNumber(parsed.entry_price) ?? candidate.entry_price,
      sl_price:    parseNullableNumber(parsed.sl_price)    ?? candidate.sl_price,
      tp_price:    parseNullableNumber(parsed.tp_price)    ?? candidate.tp_price,
      changed,
    };
  } catch {
    return { ...candidate, changed: false };
  }
}

function applyExactPriceRead(base: ExtractedTradeData, exactPriceRead: ExactPriceRead | null): ExtractedTradeData {
  if (!exactPriceRead) {
    return base;
  }

  const exactValueCount = [
    exactPriceRead.entry_price,
    exactPriceRead.sl_price,
    exactPriceRead.tp_price,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).length;

  if (exactValueCount < 2) {
    return base;
  }

  const repairedStructure = repairTradeStructure(
    pickMostCommonString(exactPriceRead.direction, base.direction),
    chooseConsensusNumber(exactPriceRead.entry_price, base.entry_price),
    chooseConsensusNumber(exactPriceRead.sl_price, base.sl_price),
    chooseConsensusNumber(exactPriceRead.tp_price, base.tp_price),
    {
      entries: [exactPriceRead.entry_price, base.entry_price],
      stops: [exactPriceRead.sl_price, base.sl_price],
      targets: [exactPriceRead.tp_price, base.tp_price],
    }
  );

  return {
    ...base,
    direction: repairedStructure.direction ?? base.direction,
    entry_price: repairedStructure.entry_price ?? base.entry_price,
    sl_price: repairedStructure.sl_price ?? base.sl_price,
    tp_price: repairedStructure.tp_price ?? base.tp_price,
  };
}

function applyHeaderIdentityRead(base: ExtractedTradeData, headerIdentityRead: HeaderIdentityRead | null): ExtractedTradeData {
  if (!headerIdentityRead) {
    return base;
  }

  return {
    ...base,
    symbol: headerIdentityRead.symbol ?? base.symbol,
    timeframe_minutes: headerIdentityRead.timeframe_minutes ?? base.timeframe_minutes,
  };
}

async function callClaudeJson(
  system: string,
  images: ChartImageInput[],
  userText: string,
  maxTokens = 1024
): Promise<Record<string, unknown>> {
  const imageContent = images.map(image => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mimeType,
      data: image.base64Image,
    },
  }));

  const imageGuide = images
    .map((image, index) => `Image ${index + 1} (${image.label}): ${describeImageLabel(image.label)}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: 'user',
        content: [
          ...imageContent,
          {
            type: 'text',
            text: `${userText}\n\nAttached views:\n${imageGuide}`,
          },
        ],
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  return parseJsonObject(content.text.trim());
}

async function extractTradeFacts(
  images: ChartImageInput[],
  entryDate: string,
  fallbackEntryTime: string,
  scannerContext?: ScannerContext
): Promise<ExtractedTradeData> {
  const systemPrompt = `You are a futures trade data extractor analysing TradingView screenshots with a risk/reward box.
${MANUAL_READING_PROCESS}

Read these facts directly from the screenshot:
- symbol
- direction
- entry_price
- entry_time
- sl_price
- tp_price
- timeframe_minutes

Symbol rules:
- Read the symbol from the top-left chart label only
- Return the tradable root ticker such as MNQ, NQ, MES, ES, MYM, YM, M2K, RTY, CL, MCL, GC, MGC, SI, SIL, 6E, 6B, 6J, BTC, MBT, ETH, MET
- If the header shows an expiry code like MNQM26 or NQU6, return MNQ or NQ
- Never return generic words like Futures, Micro, E-mini, CME, CBOT, or TradingView as the symbol

Timeframe rules:
- Read timeframe_minutes from the top-left header only
- The timeframe is the interval value printed immediately beside the symbol/ticker
- Example: "MNQM6 · 1 · CME" means timeframe_minutes = 1
- Do not infer timeframe from the x-axis, candle spacing, zoom level, or trade duration

Never estimate price labels. Read the exact numbers shown on the right axis labels.
If entry-label-focus, entry-color-label-focus, stop-label-focus, or target-label-focus are attached, use those as the primary source for the exact prices.
If entry-color-label-focus clearly contains the configured entry-color TradingView entry pill, it is the source of truth for entry_price. Grey is only a fallback.
If entry time is not clearly readable, return null for entry_time and low or null confidence.

Return ONLY a raw JSON object with these exact keys:
symbol, direction, entry_price, entry_time, entry_time_confidence, sl_price, tp_price, timeframe_minutes, exit_reason, pnl_result, trade_length_seconds, candle_count

Rules for these extra fields:
- You may include exit_reason, pnl_result, trade_length_seconds, candle_count if the chart is clear.
- If unclear, return null for them.
- exit_reason must be TP or SL only if you can visibly determine which was touched first.`;

  return sanitizeExtractedTradeData(await callClaudeJson(
    systemPrompt,
    images,
    `Trade date: ${entryDate}. Fallback entry time hint if the x-axis is unclear: ${fallbackEntryTime}. ${formatScannerContext(scannerContext)} Extract the trade facts from this screenshot.`,
    1100
  ));
}

async function verifyExitOrder(
  images: ChartImageInput[],
  entryDate: string,
  baseRead: ExtractedTradeData,
  scannerContext?: ScannerContext
): Promise<ExitVerificationResult> {
  const exitImages = selectImagesByLabels(images, [
    'full_chart',
    'exit-path-focus',
    'trade-box-focus',
    'price-label-focus',
  ]);

  if (!baseRead.direction || !baseRead.entry_price || !baseRead.sl_price || !baseRead.tp_price) {
    return {
      exit_reason: null,
      trade_length_seconds: null,
      candle_count: null,
      timeframe_minutes: baseRead.timeframe_minutes ?? null,
      exit_confidence: 'low',
      first_touch_candle_index: null,
      first_touch_evidence: null,
    };
  }

  const direction = baseRead.direction;
  const entry     = baseRead.entry_price;
  const sl        = baseRead.sl_price;
  const tp        = baseRead.tp_price;
  const isShort   = direction === 'Short';

  const geoHints = scannerContext?.entry_line_ratio != null ? `
PIXEL GEOMETRY (pre-calculated — use to orient yourself):
- Entry level is at ${(scannerContext.entry_line_ratio! * 100).toFixed(1)}% from top of image
- Stop level is at ${(scannerContext.stop_line_ratio! * 100).toFixed(1)}% from top of image
- Target level is at ${(scannerContext.target_line_ratio! * 100).toFixed(1)}% from top of image
- Trade box spans ${(scannerContext.box_left_ratio! * 100).toFixed(1)}%–${(scannerContext.box_right_ratio! * 100).toFixed(1)}% of image width
` : '';

  const imageContent = exitImages.map(img => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: img.mimeType as ImageMimeType,
      data: img.base64Image,
    },
  }));

  const response = await (anthropic as unknown as { messages: { create: (params: unknown, options?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } }).messages.create(
    {
      model: MODEL,
      max_tokens: 3000,
      temperature: 0,
      thinking: { type: 'enabled', budget_tokens: 2000 },
      system: `You are a chart exit analyst. You determine whether a trade hit its stop loss
or take profit by visually reading a TradingView candlestick chart. You are precise,
methodical, and never guess. You only report what you can directly see.`,
      messages: [{
        role: 'user',
        content: [
          ...imageContent,
          {
            type: 'text',
            text: `Determine whether this trade exited at Stop Loss or Take Profit.

TRADE DETAILS:
- Instrument: ${baseRead.symbol ?? 'unknown'}
- Direction: ${direction}
- Entry Price: ${entry}
- Stop Loss: ${sl} (${isShort ? 'ABOVE entry — a SHORT stop, price must NOT exceed this' : 'BELOW entry — a LONG stop, price must NOT fall below this'})
- Take Profit: ${tp} (${isShort ? 'BELOW entry — target price for the short' : 'ABOVE entry — target price for the long'})
- Entry Date: ${entryDate}
${geoHints}

READING PROCEDURE — follow every step exactly:

STEP 1 — LOCATE THE PRICE AXIS
Look at the right edge of the chart. Find the numerical price labels.
Confirm you can see labels near ${sl} and ${tp} on the axis.

STEP 2 — DRAW MENTAL HORIZONTAL LINES
From the ${sl} label, trace a horizontal line LEFT across the entire chart.
From the ${tp} label, trace a horizontal line LEFT across the entire chart.
These are your two trigger lines.

STEP 3 — IDENTIFY THE ENTRY CANDLE
Find the candle at the entry point (approximately where the trade box ends on the right side).
Everything to the LEFT of this candle is irrelevant — ignore it.

STEP 4 — SCAN CANDLES AFTER ENTRY (left to right, one by one)
For each candle AFTER the entry candle, check:

${isShort ? `- Does the candle HIGH (top of wick) reach OR exceed ${sl}?
  If YES → this candle triggered the STOP LOSS
- Does the candle LOW (bottom of wick) reach OR go below ${tp}?
  If YES → this candle triggered the TAKE PROFIT` : `- Does the candle LOW (bottom of wick) reach OR go below ${sl}?
  If YES → this candle triggered the STOP LOSS
- Does the candle HIGH (top of wick) reach OR exceed ${tp}?
  If YES → this candle triggered the TAKE PROFIT`}

STEP 5 — DETERMINE WHICH CAME FIRST
The FIRST candle (leftmost / earliest) that triggered either level = the exit.
If stop was triggered before target → exit_reason = "SL"
If target was triggered before stop → exit_reason = "TP"
If neither level was reached in the visible chart → exit_reason = null

STEP 6 — CHECK THE CURRENT PRICE LABEL
Look at the current price shown on the right axis (the highlighted marker).
${isShort ? `If current price > ${sl}, price has already blown through the stop.` : `If current price < ${sl}, price has already blown through the stop.`}
Use this as a final confirmation.

STEP 7 — COUNT CANDLES
Count how many 1-minute candles elapsed between entry and exit.
Multiply by 60 to get trade_length_seconds.

STEP 8 — WRITE YOUR EVIDENCE
In first_touch_evidence, describe in one sentence exactly what you saw.
Example: "The candle at approximately 10:17 has a wick that rises above the 25,773.75 stop level, while no candle reached the 25,704 target."

Return ONLY this JSON:
{
  "exit_reason": "TP" | "SL" | null,
  "exit_confidence": "high" | "medium" | "low",
  "sl_triggered": boolean,
  "tp_triggered": boolean,
  "sl_triggered_first": boolean | null,
  "tp_triggered_first": boolean | null,
  "candles_after_entry_checked": number,
  "candle_count": number | null,
  "trade_length_seconds": number | null,
  "timeframe_minutes": 1,
  "first_touch_candle_index": number | null,
  "first_touch_evidence": string
}`,
          },
        ],
      }],
    },
    { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } }
  );

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');

  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>;

    let exitReason = parseNullableExitReason(parsed.exit_reason);
    if (parsed.sl_triggered && parsed.tp_triggered) {
      exitReason = parsed.sl_triggered_first ? 'SL' : 'TP';
    } else if (parsed.sl_triggered && !parsed.tp_triggered) {
      exitReason = 'SL';
    } else if (parsed.tp_triggered && !parsed.sl_triggered) {
      exitReason = 'TP';
    }

    return {
      exit_reason:              exitReason,
      trade_length_seconds:     parseNullableNumber(parsed.trade_length_seconds),
      candle_count:             parseNullableNumber(parsed.candle_count),
      timeframe_minutes:        parseNullableNumber(parsed.timeframe_minutes) ?? baseRead.timeframe_minutes ?? null,
      exit_confidence:          parseNullableExitConfidence(parsed.exit_confidence) ?? 'low',
      first_touch_candle_index: parseNullableNumber(parsed.first_touch_candle_index),
      first_touch_evidence:     parseNullableString(parsed.first_touch_evidence),
    };
  } catch {
    throw new Error('verifyExitOrder: failed to parse response');
  }
}

async function sanityCheckLevelTouches(
  images: ChartImageInput[],
  entryDate: string,
  baseRead: ExtractedTradeData
): Promise<LevelTouchSanityResult> {
  const sanityImages = selectImagesByLabels(images, [
    'full_chart',
    'trade-box-focus',
    'exit-path-focus',
  ]);

  if (!baseRead.direction || !baseRead.entry_price || !baseRead.sl_price || !baseRead.tp_price) {
    return { stop_touched: null, target_touched: null, first_touch: null, evidence: null };
  }

  const isShort = baseRead.direction === 'Short';
  const sl      = baseRead.sl_price;
  const tp      = baseRead.tp_price;

  const imageContent = sanityImages.map(img => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: img.mimeType as ImageMimeType,
      data: img.base64Image,
    },
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    temperature: 0,
    system: 'You are a binary chart level checker. Answer only with JSON. No explanations outside the JSON.',
    messages: [{
      role: 'user',
      content: [
        ...imageContent,
        {
          type: 'text',
          text: `Look at this TradingView chart from ${entryDate}. Answer two yes/no questions about candles that appear AFTER the trade entry.

Trade:
- Direction: ${baseRead.direction}
- Entry: ${baseRead.entry_price}
- Stop Loss: ${sl}
- Take Profit: ${tp}

The entry candle is where the coloured trade box ends on the right side.
Only look at candles to the RIGHT of the trade box.

QUESTION 1: Do any candle ${isShort ? 'HIGHS (wicks)' : 'LOWS (wicks)'} touch or cross the Stop Loss level of ${sl}?
Answer yes if you can see any wick reach that price level.

QUESTION 2: Do any candle ${isShort ? 'LOWS (wicks)' : 'HIGHS (wicks)'} touch or cross the Take Profit level of ${tp}?
Answer yes if you can see any wick reach that price level.

QUESTION 3: Which happened on an earlier candle (further left on the chart)?

Return ONLY:
{
  "stop_touched": true | false,
  "target_touched": true | false,
  "first_touch": "SL" | "TP" | null,
  "evidence": "one sentence describing what you saw"
}`,
        },
      ],
    }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { text: string }).text)
    .join('');

  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    return {
      stop_touched:   parseNullableBoolean(parsed.stop_touched),
      target_touched: parseNullableBoolean(parsed.target_touched),
      first_touch:    parseNullableExitReason(parsed.first_touch),
      evidence:       parseNullableString(parsed.evidence),
    };
  } catch {
    return { stop_touched: null, target_touched: null, first_touch: null, evidence: null };
  }
}

async function humanStyleReview(
  images: ChartImageInput[],
  entryDate: string,
  fallbackEntryTime: string,
  scannerContext?: ScannerContext
): Promise<ExtractedTradeData> {
  const reviewPrompt = `Review this chart exactly like a skilled human trader filling out a trade journal by eye.
${MANUAL_READING_PROCESS}
${FIRST_TOUCH_RULE}

Use only the screenshot itself and read it in this exact order:
1. Read the symbol and timeframe from the top-left label.
   The timeframe is the interval shown immediately beside the ticker in the header.
2. Read entry, stop loss, and take profit from the exact right-axis labels.
3. Infer long or short from the box layout.
4. Read the entry time from the x-axis using the left edge of the risk/reward box.
5. Follow candles from the entry candle until the first touch of stop or target.
6. Count candles to the exit and compute trade_length_seconds.

You should make the most likely decision even when the chart is slightly messy, but do not invent price labels.

Return ONLY a raw JSON object with these exact keys:
symbol, direction, entry_price, entry_time, entry_time_confidence, sl_price, tp_price, timeframe_minutes, exit_reason, pnl_result, trade_length_seconds, candle_count, exit_confidence, first_touch_evidence`;

  return sanitizeExtractedTradeData(await callClaudeJson(
    reviewPrompt,
    images,
    `Trade date: ${entryDate}. ${buildEntryTimeHint(null)} Fallback time for the form is ${fallbackEntryTime}, but do not let that override the chart itself. Read this chart the same way a human would fill a journal entry.`,
    1200
  ));
}

async function decisiveFinalReview(
  images: ChartImageInput[],
  entryDate: string,
  fallbackEntryTime: string,
  extraction: ExtractedTradeData,
  verification: ExitVerificationResult,
  humanReview: ExtractedTradeData,
  scannerContext?: ScannerContext
): Promise<ExtractedTradeData> {
  const decisivePrompt = `You are the final decision-maker for a futures trade journal scanner.

Your job is to read the TradingView screenshot exactly the way an experienced trader would manually journal it.
You must return one single best final answer, not an abstention.

${MANUAL_READING_PROCESS}
${FIRST_TOUCH_RULE}

Use header-focus for symbol/timeframe, the three label-focus crops for exact levels, entry-window-focus for the exact entry anchor, and exit-path-focus for the first-touch path after entry.
When deciding timeframe_minutes, trust the header-focus interval immediately beside the ticker over every other clue.
If a comparison chart is visible anywhere, ignore it unless it is the chart with the colored risk/reward box.

If the earlier passes disagree, use them only as hints. The screenshot itself is the source of truth.
Do not return manual review text. Choose the single most likely final interpretation.
Never invent price levels that are not visible on the screenshot. If one field is slightly unclear, use the best supported value from the hints below.

Hint pass 1:
${JSON.stringify({
  symbol: extraction.symbol,
  direction: extraction.direction,
  entry_price: extraction.entry_price,
  entry_time: extraction.entry_time,
  sl_price: extraction.sl_price,
  tp_price: extraction.tp_price,
  timeframe_minutes: extraction.timeframe_minutes,
  exit_reason: extraction.exit_reason,
  trade_length_seconds: extraction.trade_length_seconds,
  candle_count: extraction.candle_count,
}, null, 2)}

Hint pass 2:
${JSON.stringify(verification, null, 2)}

Hint pass 3:
${JSON.stringify({
  symbol: humanReview.symbol,
  direction: humanReview.direction,
  entry_price: humanReview.entry_price,
  entry_time: humanReview.entry_time,
  sl_price: humanReview.sl_price,
  tp_price: humanReview.tp_price,
  timeframe_minutes: humanReview.timeframe_minutes,
  exit_reason: humanReview.exit_reason,
  trade_length_seconds: humanReview.trade_length_seconds,
  candle_count: humanReview.candle_count,
  first_touch_evidence: humanReview.first_touch_evidence,
}, null, 2)}

Return ONLY a raw JSON object with these exact keys:
symbol, direction, entry_price, entry_time, entry_time_confidence, sl_price, tp_price, timeframe_minutes, exit_reason, pnl_result, trade_length_seconds, candle_count, exit_confidence, first_touch_evidence`;

  return sanitizeExtractedTradeData(await callClaudeJson(
    decisivePrompt,
    images,
    `Trade date: ${entryDate}. ${buildEntryTimeHint(extraction.entry_time ?? humanReview.entry_time)} ${formatScannerContext(scannerContext)} Fallback time for the form is ${fallbackEntryTime}, but do not let that override the chart itself. Produce the single best final journal-ready trade analysis from this screenshot.`,
    1400
  ));
}

async function directExitRead(
  images: ChartImageInput[],
  trade: { direction: string; entry: number; sl: number; tp: number },
  entryDate: string
): Promise<{ exit_reason: 'TP' | 'SL' | null; confidence: 'high' | 'medium' | 'low'; evidence: string }> {
  const isShort = trade.direction === 'Short';
  const imageContent = images.map(img => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mimeType as ImageMimeType, data: img.base64Image },
  }));
  const imageGuide = images.map((img, i) => `Image ${i + 1} (${img.label}): ${describeImageLabel(img.label)}`).join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    temperature: 0,
    system: `You are a precise chart reader. You look at a TradingView candlestick chart and determine whether a trade exited at Stop Loss or Take Profit. You answer decisively based only on what you can see. Return only valid JSON.`,
    messages: [{
      role: 'user',
      content: [
        ...imageContent,
        {
          type: 'text',
          text: `This is a ${trade.direction.toUpperCase()} trade on ${entryDate}.

PRICE LEVELS:
- Entry: ${trade.entry}
- Stop Loss: ${trade.sl} — this is ${isShort ? 'ABOVE' : 'BELOW'} entry (${isShort ? 'price must NOT rise above this' : 'price must NOT fall below this'})
- Take Profit: ${trade.tp} — this is ${isShort ? 'BELOW' : 'ABOVE'} entry (${isShort ? 'price drops to this target' : 'price rises to this target'})

TASK: Starting from the entry candle (at the LEFT edge of the coloured trade box), scan candles left-to-right.
- ONLY look at candles inside and immediately after the trade box. Do NOT look at candles far to the right that occur long after the trade.
- For a ${isShort ? 'SHORT' : 'LONG'} trade: if ${isShort ? 'the candle HIGH (wick tip) reaches or exceeds' : 'the candle LOW (wick bottom) reaches or drops below'} ${trade.sl} → SL hit.
- For a ${isShort ? 'SHORT' : 'LONG'} trade: if ${isShort ? 'the candle LOW (wick bottom) reaches or drops below' : 'the candle HIGH (wick tip) reaches or exceeds'} ${trade.tp} → TP hit.
- The FIRST level touched decides the result. Stop immediately at that candle.
- IGNORE any price labels or candles outside the trade box region and to the far right of the chart.

Return this JSON exactly:
{
  "exit_reason": "TP" or "SL",
  "confidence": "high" or "medium" or "low",
  "evidence": "one sentence describing which candle after entry touched which level first"
}

Attached views:
${imageGuide}`,
        },
      ],
    }],
  });

  const text = (response.content[0] as { type: string; text: string }).text.trim();
  const parsed = parseJsonObject(text) as { exit_reason?: string; confidence?: string; evidence?: string };
  const exitReason = parsed.exit_reason === 'TP' ? 'TP' : parsed.exit_reason === 'SL' ? 'SL' : null;
  const confidence = (['high', 'medium', 'low'] as const).includes(parsed.confidence as 'high' | 'medium' | 'low')
    ? (parsed.confidence as 'high' | 'medium' | 'low')
    : 'low';
  return { exit_reason: exitReason, confidence, evidence: parsed.evidence ?? '' };
}

function resolveExitReason(
  verification: ExitVerificationResult,
  humanReview: ExtractedTradeData,
  decisiveReview: ExtractedTradeData,
  extraction: ExtractedTradeData
): 'TP' | 'SL' | null {
  if (verification.exit_reason && humanReview.exit_reason === verification.exit_reason) {
    return verification.exit_reason;
  }

  if (verification.exit_reason && decisiveReview.exit_reason === verification.exit_reason) {
    return verification.exit_reason;
  }

  if (humanReview.exit_reason && decisiveReview.exit_reason === humanReview.exit_reason) {
    return humanReview.exit_reason;
  }

  return verification.exit_reason
    ?? humanReview.exit_reason
    ?? decisiveReview.exit_reason
    ?? extraction.exit_reason;
}

function buildManualReaderBase(
  extraction: ExtractedTradeData,
  humanReview: ExtractedTradeData,
  fallbackEntryTime: string
): ExtractedTradeData {
  const warnings = [
    ...(extraction.warnings ?? []),
    ...(humanReview.warnings ?? []),
  ];

  const humanStructureValid = hasValidLevelStructure(
    humanReview.direction,
    humanReview.entry_price,
    humanReview.sl_price,
    humanReview.tp_price
  );
  const extractionStructureValid = hasValidLevelStructure(
    extraction.direction,
    extraction.entry_price,
    extraction.sl_price,
    extraction.tp_price
  );

  const repairedStructure = repairTradeStructure(
    humanReview.direction ?? extraction.direction,
    chooseConsensusNumber(humanReview.entry_price, extraction.entry_price),
    chooseConsensusNumber(humanReview.sl_price, extraction.sl_price),
    chooseConsensusNumber(humanReview.tp_price, extraction.tp_price),
    {
      entries: [humanReview.entry_price, extraction.entry_price],
      stops: [humanReview.sl_price, extraction.sl_price],
      targets: [humanReview.tp_price, extraction.tp_price],
    }
  );

  const direction = humanStructureValid
    ? humanReview.direction
    : extractionStructureValid
      ? extraction.direction
      : repairedStructure.direction;
  const entryPrice = humanStructureValid
    ? humanReview.entry_price
    : extractionStructureValid
      ? extraction.entry_price
      : repairedStructure.entry_price;
  const stopPrice = humanStructureValid
    ? humanReview.sl_price
    : extractionStructureValid
      ? extraction.sl_price
      : repairedStructure.sl_price;
  const targetPrice = humanStructureValid
    ? humanReview.tp_price
    : extractionStructureValid
      ? extraction.tp_price
      : repairedStructure.tp_price;

  return {
    symbol: humanReview.symbol ?? extraction.symbol,
    direction,
    entry_price: entryPrice,
    entry_time: humanReview.entry_time ?? extraction.entry_time ?? parseNullableTime(fallbackEntryTime),
    entry_time_confidence: normalizeExitConfidence(humanReview.entry_time_confidence, extraction.entry_time_confidence, 'low'),
    sl_price: stopPrice,
    tp_price: targetPrice,
    trade_length_seconds: null,
    candle_count: null,
    timeframe_minutes: humanReview.timeframe_minutes ?? extraction.timeframe_minutes ?? 1,
    exit_reason: null,
    pnl_result: null,
    exit_confidence: null,
    first_touch_candle_index: null,
    first_touch_evidence: null,
    warnings,
  };
}

function finalizeManualReaderResult(
  baseRead: ExtractedTradeData,
  verification: ExitVerificationResult,
  extraction: ExtractedTradeData,
  humanReview: ExtractedTradeData
): ExtractedTradeData {
  const exitReason = verification.exit_reason
    ?? humanReview.exit_reason
    ?? extraction.exit_reason
    ?? null;

  return {
    ...baseRead,
    exit_reason: exitReason,
    pnl_result: exitReason === 'TP' ? 'Win' : exitReason === 'SL' ? 'Loss' : null,
    trade_length_seconds: verification.trade_length_seconds
      ?? humanReview.trade_length_seconds
      ?? extraction.trade_length_seconds
      ?? null,
    candle_count: verification.candle_count
      ?? humanReview.candle_count
      ?? extraction.candle_count
      ?? null,
    timeframe_minutes: verification.timeframe_minutes
      ?? baseRead.timeframe_minutes
      ?? null,
    exit_confidence: verification.exit_confidence
      ?? humanReview.exit_confidence
      ?? extraction.exit_confidence
      ?? 'low',
    first_touch_candle_index: verification.first_touch_candle_index
      ?? humanReview.first_touch_candle_index
      ?? extraction.first_touch_candle_index
      ?? null,
    first_touch_evidence: verification.first_touch_evidence
      ?? humanReview.first_touch_evidence
      ?? extraction.first_touch_evidence
      ?? null,
  };
}

function applySanityOverride(
  result: ExtractedTradeData,
  sanity: LevelTouchSanityResult | null
): ExtractedTradeData {
  if (!sanity) {
    return result;
  }

  const next = { ...result };

  if (sanity.target_touched === false && sanity.stop_touched === true) {
    next.exit_reason = 'SL';
  } else if (sanity.target_touched === true && sanity.stop_touched === false) {
    next.exit_reason = 'TP';
  } else if (sanity.first_touch) {
    next.exit_reason = sanity.first_touch;
  }

  if (next.exit_reason) {
    next.pnl_result = next.exit_reason === 'TP' ? 'Win' : 'Loss';
  }

  if (sanity.evidence) {
    next.first_touch_evidence = sanity.evidence;
  }

  return next;
}

function hasHighConfidenceExit(
  source: ExtractedTradeData | ExitVerificationResult,
  exitReason: 'TP' | 'SL'
): boolean {
  return source.exit_reason === exitReason && source.exit_confidence === 'high';
}

function applyConservativeExitDecision(
  result: ExtractedTradeData,
  verification: ExitVerificationResult,
  humanReview: ExtractedTradeData,
  decisiveReview: ExtractedTradeData,
  extraction: ExtractedTradeData,
  sanity: LevelTouchSanityResult | null
): ExtractedTradeData {
  const next = { ...result };

  // Cross-check: if we have all three prices, the direction must produce a sane P&L sign
  if (next.entry_price != null && next.sl_price != null && next.tp_price != null) {
    const tpRisk    = next.tp_price - next.entry_price;
    const slRisk    = next.sl_price - next.entry_price;
    const looksLong  = tpRisk > 0 && slRisk < 0;
    const looksShort = tpRisk < 0 && slRisk > 0;

    if (looksLong && next.direction === 'Short') {
      next.direction = 'Long';
      appendWarning(
        next.warnings ?? (next.warnings = []),
        'Direction corrected to Long: price structure (TP above entry, SL below) contradicted Short.'
      );
    } else if (looksShort && next.direction === 'Long') {
      next.direction = 'Short';
      appendWarning(
        next.warnings ?? (next.warnings = []),
        'Direction corrected to Short: price structure (TP below entry, SL above) contradicted Long.'
      );
    }

    const entryIsValid = next.direction === 'Long'
      ? (next.sl_price < next.entry_price && next.tp_price > next.entry_price)
      : (next.sl_price > next.entry_price && next.tp_price < next.entry_price);

    if (!entryIsValid && next.sl_price != null && next.tp_price != null) {
      const swappedSlValid = next.direction === 'Long'
        ? (next.tp_price < next.entry_price && next.sl_price > next.entry_price)
        : (next.tp_price > next.entry_price && next.sl_price < next.entry_price);

      if (swappedSlValid) {
        [next.sl_price, next.tp_price] = [next.tp_price, next.sl_price];
        appendWarning(
          next.warnings ?? (next.warnings = []),
          'SL and TP were swapped — corrected based on direction and entry price.'
        );
      }
    }
  }

  const votes = countVotes(
    verification.exit_reason,
    humanReview.exit_reason,
    decisiveReview.exit_reason,
    extraction.exit_reason
  );
  const hasSanityConfirmation = Boolean(
    sanity && (sanity.first_touch || sanity.stop_touched !== null || sanity.target_touched !== null)
  );

  if (sanity?.stop_touched === true && sanity?.target_touched === false) {
    next.exit_reason = 'SL';
  } else if (sanity?.target_touched === true && sanity?.stop_touched === false) {
    next.exit_reason = 'TP';
  } else if (votes.SL >= 2 && votes.TP <= 1) {
    next.exit_reason = 'SL';
  } else if (votes.TP >= 2 && votes.SL === 0) {
    next.exit_reason = 'TP';
  } else if (
    next.exit_reason === 'TP' &&
    votes.SL >= 1 &&
    !hasHighConfidenceExit(verification, 'TP') &&
    !hasHighConfidenceExit(humanReview, 'TP') &&
    !hasHighConfidenceExit(decisiveReview, 'TP')
  ) {
    appendWarning(
      next.warnings ?? (next.warnings = []),
      'Exit-order signals disagreed — kept the primary extraction result.'
    );
  } else if (
    next.exit_reason === 'TP' &&
    votes.TP < 3 &&
    votes.SL >= 1 &&
    !hasSanityConfirmation
  ) {
    appendWarning(
      next.warnings ?? (next.warnings = []),
      'TP was not confirmed by the sanity pass — kept the primary extraction result.'
    );
  }

  if (next.exit_reason) {
    next.pnl_result = next.exit_reason === 'TP' ? 'Win' : 'Loss';
  }

  return next;
}

function buildConsensusTradeAnalysis(
  extraction: ExtractedTradeData,
  verification: ExitVerificationResult,
  humanReview: ExtractedTradeData,
  decisiveReview: ExtractedTradeData,
  fallbackEntryTime: string
): ExtractedTradeData {
  const warnings = [
    ...(extraction.warnings ?? []),
    ...(humanReview.warnings ?? []),
    ...(decisiveReview.warnings ?? []),
  ];

  const resolvedStructure = repairTradeStructure(
    pickMostCommonString(decisiveReview.direction, humanReview.direction, extraction.direction),
    chooseConsensusNumber(decisiveReview.entry_price, humanReview.entry_price, extraction.entry_price),
    chooseConsensusNumber(decisiveReview.sl_price, humanReview.sl_price, extraction.sl_price),
    chooseConsensusNumber(decisiveReview.tp_price, humanReview.tp_price, extraction.tp_price),
    {
      entries: [decisiveReview.entry_price, humanReview.entry_price, extraction.entry_price],
      stops: [decisiveReview.sl_price, humanReview.sl_price, extraction.sl_price],
      targets: [decisiveReview.tp_price, humanReview.tp_price, extraction.tp_price],
    }
  );

  const result: ExtractedTradeData = {
    symbol: decisiveReview.symbol
      ?? pickMostCommonString(humanReview.symbol, extraction.symbol)
      ?? pickFirstNonNull(humanReview.symbol, extraction.symbol),
    direction: resolvedStructure.direction,
    entry_price: resolvedStructure.entry_price,
    entry_time: pickFirstNonNull(decisiveReview.entry_time, humanReview.entry_time, extraction.entry_time, parseNullableTime(fallbackEntryTime)),
    entry_time_confidence: normalizeExitConfidence(decisiveReview.entry_time_confidence, humanReview.entry_time_confidence, extraction.entry_time_confidence, 'low'),
    sl_price: resolvedStructure.sl_price,
    tp_price: resolvedStructure.tp_price,
    trade_length_seconds: null,
    candle_count: null,
    timeframe_minutes: decisiveReview.timeframe_minutes
      ?? chooseConsensusNumber(humanReview.timeframe_minutes, verification.timeframe_minutes, extraction.timeframe_minutes),
    exit_reason: null,
    pnl_result: null,
    exit_confidence: null,
    first_touch_candle_index: null,
    first_touch_evidence: null,
    warnings,
  };

  if (!hasValidLevelStructure(result.direction, result.entry_price, result.sl_price, result.tp_price)) {
    result.direction = inferDirectionFromLevels(result.entry_price, result.sl_price, result.tp_price);
  }

  const votes = countVotes(decisiveReview.exit_reason, extraction.exit_reason, verification.exit_reason, humanReview.exit_reason);
  result.exit_reason = resolveExitReason(verification, humanReview, decisiveReview, extraction);

  const durationSource = [
    verification.exit_reason === result.exit_reason ? verification : null,
    humanReview.exit_reason === result.exit_reason ? humanReview : null,
    decisiveReview.exit_reason === result.exit_reason ? decisiveReview : null,
    extraction.exit_reason === result.exit_reason ? extraction : null,
  ].find(Boolean) as (ExtractedTradeData | ExitVerificationResult | null);

  result.trade_length_seconds = chooseConsensusNumber(
    durationSource?.trade_length_seconds,
    verification.trade_length_seconds,
    humanReview.trade_length_seconds,
    decisiveReview.trade_length_seconds,
    extraction.trade_length_seconds
  );
  result.candle_count = chooseConsensusNumber(
    durationSource?.candle_count,
    verification.candle_count,
    humanReview.candle_count,
    decisiveReview.candle_count,
    extraction.candle_count
  );
  result.timeframe_minutes = result.timeframe_minutes ?? durationSource?.timeframe_minutes ?? null;
  result.pnl_result = result.exit_reason === 'TP' ? 'Win' : result.exit_reason === 'SL' ? 'Loss' : null;
  result.exit_confidence = verification.exit_confidence
    ?? humanReview.exit_confidence
    ?? decisiveReview.exit_confidence
    ?? (votes.TP === 3 || votes.SL === 3
    ? 'high'
    : votes.TP >= 2 || votes.SL >= 2
      ? 'medium'
      : normalizeExitConfidence(extraction.exit_confidence, 'low'));
  result.first_touch_candle_index = pickFirstNonNull(verification.first_touch_candle_index, humanReview.first_touch_candle_index, result.candle_count);
  result.first_touch_evidence = pickFirstNonNull(verification.first_touch_evidence, humanReview.first_touch_evidence, decisiveReview.first_touch_evidence, extraction.first_touch_evidence);

  if (result.trade_length_seconds === null && result.candle_count !== null && result.timeframe_minutes !== null) {
    result.trade_length_seconds = result.candle_count * result.timeframe_minutes * 60;
  }

  if (result.entry_time === null) {
    result.entry_time = parseNullableTime(fallbackEntryTime);
    result.entry_time_confidence = 'low';
  }

  return result;
}

async function upscaleLabelCrops(
  images: ChartImageInput[]
): Promise<ChartImageInput[]> {
  const LABEL_CROP_NAMES = new Set(['entry-label-focus', 'entry-color-label-focus', 'stop-label-focus', 'target-label-focus']);

  return Promise.all(images.map(async (img) => {
    if (!LABEL_CROP_NAMES.has(img.label)) return img;
    try {
      const buffer = Buffer.from(img.base64Image, 'base64');
      const metadata = await sharp(buffer).metadata();
      const upscaledBuffer = await sharp(buffer)
        .resize(
          Math.round((metadata.width ?? 100) * 2),
          Math.round((metadata.height ?? 100) * 2),
          { kernel: 'nearest' }
        )
        .png()
        .toBuffer();
      return {
        ...img,
        base64Image: upscaledBuffer.toString('base64'),
        mimeType: 'image/png' as ImageMimeType,
      };
    } catch {
      return img;
    }
  }));
}

async function cropImageToBoxBoundary(
  images: ChartImageInput[],
  scannerContext?: ScannerContext
): Promise<ChartImageInput[]> {
  if (!scannerContext?.box_right_ratio) return images;
  return Promise.all(images.map(async (img) => {
    const buffer = Buffer.from(img.base64Image, 'base64');
    const metadata = await sharp(buffer).metadata();
    const cropWidth = Math.round((metadata.width ?? 0) * scannerContext.box_right_ratio!);
    const cropped = await sharp(buffer)
      .extract({ left: 0, top: 0, width: cropWidth, height: metadata.height ?? 0 })
      .png()
      .toBuffer();
    return { ...img, base64Image: cropped.toString('base64'), mimeType: 'image/png' as ImageMimeType };
  }));
}


export async function analyzeIndividualTrade(trade: Trade, statsContext: string | null = null): Promise<string> {
  const rr = trade.sl_price && trade.entry_price && trade.tp_price
    ? Math.abs(trade.tp_price - trade.entry_price) / Math.abs(trade.sl_price - trade.entry_price)
    : 0;

  const sessionContext = trade.sessionContext;
  const sessionContextLines: string[] = [];
  if (sessionContext) {
    if (sessionContext.emotion) sessionContextLines.push(`Pre-session state of mind: ${sessionContext.emotion}`);
    if (sessionContext.readiness) {
      const readinessParts = [
        sessionContext.readiness.status,
        typeof sessionContext.readiness.score === 'number' ? `${sessionContext.readiness.score}/100` : null,
        sessionContext.readiness.summary,
      ].filter(Boolean);
      if (readinessParts.length) sessionContextLines.push(`Readiness: ${readinessParts.join(' | ')}`);
      if (Array.isArray(sessionContext.readiness.reasons) && sessionContext.readiness.reasons.length) {
        sessionContextLines.push(`Readiness reasons: ${sessionContext.readiness.reasons.join(' | ')}`);
      }
    }
    if (sessionContext.bias && typeof sessionContext.bias === 'object') {
      const biasPairs = Object.entries(sessionContext.bias)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([symbol, value]) => `${symbol}: ${value}`);
      if (biasPairs.length) sessionContextLines.push(`Pre-session market bias: ${biasPairs.join(' | ')}`);
    }
    if (sessionContext.note) sessionContextLines.push(`Pre-session note: ${sessionContext.note}`);
    if (Array.isArray(sessionContext.sessionPlan) && sessionContext.sessionPlan.length) {
      const planLines = sessionContext.sessionPlan
        .map(item => item?.rule)
        .filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0);
      if (planLines.length) sessionContextLines.push(`Pre-session plan: ${planLines.join(' | ')}`);
    }
    const daily = sessionContext.dailyReflection;
    if (daily) {
      if (daily.pre) sessionContextLines.push(`Daily pre-market plan: ${daily.pre}`);
      const dailyParts = [
        daily.bias ? `daily bias ${daily.bias}` : null,
        daily.newsRisk ? `news risk ${daily.newsRisk}` : null,
        typeof daily.sessionTarget === 'number' ? `session target ${daily.sessionTarget}` : null,
        typeof daily.marketRespectedBias === 'boolean' ? `market respected bias ${daily.marketRespectedBias ? 'yes' : 'no'}` : null,
      ].filter(Boolean);
      if (dailyParts.length) sessionContextLines.push(`Daily context: ${dailyParts.join(' | ')}`);
    }
  }
  const sessionContextBlock = sessionContextLines.length
    ? `\n\n## Pre-session Context\n${sessionContextLines.join('\n')}`
    : '';

  const contextBlock = statsContext
    ? `\n\n## Trader's Historical Data (use ONLY these numbers — do not invent or estimate any figures not present here)\n${statsContext}`
    : `\n\n## Trader's Historical Data\nNo historical stats available. Do not output N/A rows; say there is not enough logged history yet only if a comparison is unavailable.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 900,
    system: `You are a professional trading performance analyst reviewing a trader's logged trade. You have their full historical statistics. Your job is to produce a genuine analysis — not a summary of what happened, but an examination of why it happened, what pattern it represents across their history, and what it reveals about their edge and its breakdown points.

An analysis reasons across the data. It finds the causal chain: what led to this decision, how it connects to prior behaviour, what the stats prove about where the edge exists and where it doesn't.

CRITICAL: Every dollar amount, win rate, P&L figure, and trade count you cite MUST come verbatim from the "Trader's Historical Data" section provided. Never invent, estimate, or extrapolate any numerical figure. If a comparison is unavailable, skip it or say there is not enough logged history yet. Do not output filler N/A rows.

Use the pre-session context when it is provided. Judge whether this trade aligned with the trader's stated state of mind, readiness, session plan, and market bias. Treat pre-session bias as context, not a guarantee: a counter-bias trade can still be valid if the notes explain the shift.

Do not write generic coaching advice. Do not restate what is already visible in the trade data. Write what the trader cannot see without this analysis. Do not create a new permanent trading rule after every reviewed trade; only recommend a hard rule when repeated historical evidence supports it.`,
    messages: [
      {
        role: 'user',
        content: `Trade to analyse:
${trade.symbol} ${trade.direction} | ${trade.trade_date} ${trade.trade_time || ''}
Entry ${trade.entry_price} → Exit ${trade.exit_price} | SL ${trade.sl_price} | TP ${trade.tp_price}
P&L: $${trade.pnl.toFixed(2)} | Planned R:R: ${rr.toFixed(2)} | Duration: ${trade.trade_length_seconds ? Math.round(trade.trade_length_seconds / 60) + 'min' : 'unknown'}
Emotional state: ${trade.emotional_state} | Confidence: ${trade.confidence_level}/10 | Followed plan: ${trade.followed_plan ? 'Yes' : 'No'}
Confluences: ${Array.isArray(trade.confluences) && trade.confluences.length > 0 ? trade.confluences.join(', ') : 'None tagged'}
Notes: ${[trade.pre_trade_notes, trade.post_trade_notes].filter(Boolean).join(' | ') || 'None'}${sessionContextBlock}${contextBlock}

Write a structured analysis using exactly these three sections:

## Your Stats
Anchor the analysis in their data. Write 2-3 bullets maximum. Use only the strongest available stats. Skip weak or unavailable categories. Do not write N/A.

## The Read
**[One sharp verdict sentence — what this trade actually represents, beyond the surface result]**
> [First insight — WHY this decision was made. One sentence, max 18 words. Include a number where possible.]
> [Second insight — what setup quality, pre-session state/bias, and plan adherence together reveal. One sentence.]

## Next Focus
**[The one thing to pay attention to before or during the next similar setup, framed as an execution focus rather than a logging task.]**
FOCUS: [One sentence. Give a practical trading focus such as bias alignment, invalidation clarity, entry timing, risk placement, emotional state, or setup threshold. Do not tell the user to log, record, track, or collect the next N trades.]
IMPORTANT: Do not recommend a new hard rule unless the historical data shows the same leak repeatedly. Most trade reviews should produce a small observation or test, not a restriction.
Final output constraints:
- Section 01 must contain only 2-3 relevant stats. Skip weak or unavailable categories. Do not write N/A.
- Section 02 must contain one verdict sentence and exactly two > insight lines.
- Section 03 must be titled Next Focus and use FOCUS:, not RULE: or ADJUSTMENT:.
- Section 03 must not ask the user to log, record, track, monitor, or collect future trades; every trade is already logged. The focus should change how they prepare, decide, execute, or manage risk.
- Do not output a TAGS line.
- If a matching sample has fewer than 5 trades, call it an early signal or something to track, not proof.
- Do not turn this into a permanent trading-plan rule unless repeated historical evidence clearly supports it.`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function analyzePatterns(trades: Trade[]): Promise<string> {
  const tradeSummaries = trades.map(t => ({
    symbol: t.symbol,
    direction: t.direction,
    date: t.trade_date,
    time: t.trade_time,
    session: t.session,
    pnl: t.pnl,
    exit_reason: t.exit_reason,
    emotional_state: t.emotional_state,
    confidence: t.confidence_level,
    followed_plan: t.followed_plan,
    confluences: Array.isArray(t.confluences) ? t.confluences : [],
    rr: t.sl_price && t.entry_price && t.tp_price
      ? (Math.abs(t.tp_price - t.entry_price) / Math.abs(t.sl_price - t.entry_price)).toFixed(2)
      : 'N/A',
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a professional trading performance analyst specialising in pattern recognition and behavioral finance.
Analyse trading data to find actionable patterns, both profitable and detrimental.
Be specific with numbers and percentages. Identify root causes of problems.`,
    messages: [
      {
        role: 'user',
        content: `Analyse these ${trades.length} futures trades and identify all significant patterns:

${JSON.stringify(tradeSummaries, null, 2)}

Provide a comprehensive pattern analysis covering:
1. Best performing setups (time, session, symbol, direction)
2. Worst performing patterns and why
3. Emotional state impact on performance
4. Plan adherence correlation with results
5. Risk management patterns
6. Time-of-day and session edge analysis
7. Confidence calibration (do high confidence trades perform better?)
8. Confluence performance (which tagged confluences are most profitable vs most costly)
9. Most critical behavioural improvements needed
10. Top 3 strengths to capitalise on
11. Top 3 weaknesses that are costing the most money`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function generateWeeklyReport(
  trades: Trade[],
  weekStart: string,
  weekEnd: string
): Promise<string> {
  const wins = trades.filter(t => t.exit_reason === 'TP');
  const losses = trades.filter(t => t.exit_reason === 'SL');
  const netPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0';
  const confluenceBuckets = trades.reduce<Record<string, { count: number; pnl: number }>>((acc, trade) => {
    const tags = Array.isArray(trade.confluences) ? trade.confluences : [];
    tags.forEach(tag => {
      if (typeof tag !== 'string' || !tag.trim()) return;
      const key = tag.trim().toLowerCase();
      if (!acc[key]) {
        acc[key] = { count: 0, pnl: 0 };
      }
      acc[key].count += 1;
      acc[key].pnl += trade.pnl;
    });
    return acc;
  }, {});

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a professional trading performance coach generating weekly review reports.
Create comprehensive, structured reports that help traders improve systematically.
Be specific, actionable, and data-driven. Format your response with clear sections using markdown.`,
    messages: [
      {
        role: 'user',
        content: `Generate a comprehensive weekly performance report for the week of ${weekStart} to ${weekEnd}.

Summary Statistics:
- Total Trades: ${trades.length}
- Wins: ${wins.length} | Losses: ${losses.length}
- Win Rate: ${winRate}%
- Net P&L: $${netPnL.toFixed(2)}

Confluence Breakdown:
${JSON.stringify(
  Object.entries(confluenceBuckets)
    .map(([confluence, data]) => ({ confluence, trades: data.count, net_pnl: data.pnl }))
    .sort((a, b) => b.net_pnl - a.net_pnl),
  null,
  2
)}

Individual Trades:
${JSON.stringify(trades.map(t => ({
  date: t.trade_date,
  time: t.trade_time,
  symbol: t.symbol,
  direction: t.direction,
  session: t.session,
  pnl: t.pnl,
  exit_reason: t.exit_reason,
  emotional_state: t.emotional_state,
  confidence: t.confidence_level,
  followed_plan: t.followed_plan,
  confluences: Array.isArray(t.confluences) ? t.confluences : [],
})), null, 2)}

Create a report with these sections:
# Weekly Performance Report: ${weekStart} to ${weekEnd}

## Executive Summary
## Performance Statistics
## Best Trades of the Week
## Worst Trades and Lessons
## Psychological Performance
## Plan Adherence Analysis
## Key Patterns Observed
## Confluence Performance (best vs worst tagged confluences)
## Goals for Next Week
## Action Items (specific, numbered list)`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function generatePsychologyReport(
  trades: Trade[],
  psychLogs: Array<{
    date: string;
    mood: string;
    mindset_score: number;
    pre_session_notes: string;
    post_session_notes: string;
  }>
): Promise<string> {
  const emotionalBreakdown = trades.reduce<Record<string, { count: number; pnl: number }>>((acc, t) => {
    const state = t.emotional_state || 'Unknown';
    if (!acc[state]) acc[state] = { count: 0, pnl: 0 };
    acc[state].count++;
    acc[state].pnl += t.pnl;
    return acc;
  }, {});

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a trading psychologist specialising in performance psychology and behavioral finance.
Provide deep, insightful analysis of a trader's psychological patterns.
Be empathetic but brutally honest about destructive patterns.
Give concrete, practical psychological techniques to improve performance.`,
    messages: [
      {
        role: 'user',
        content: `Perform a deep psychology analysis for this futures trader.

Emotional State vs Performance:
${JSON.stringify(emotionalBreakdown, null, 2)}

Plan Adherence: ${trades.filter(t => t.followed_plan).length}/${trades.length} trades followed the plan

Psychology Logs (recent):
${JSON.stringify(psychLogs.slice(-14), null, 2)}

Trades Not Following Plan:
${JSON.stringify(trades.filter(t => !t.followed_plan).map(t => ({
  date: t.trade_date,
  emotional_state: t.emotional_state,
  pnl: t.pnl,
  notes: t.post_trade_notes,
})), null, 2)}

Provide a comprehensive psychology report:
# Trading Psychology Report

## Emotional State Analysis
## Behavioral Patterns
## Tilt and Revenge Trading Assessment
## FOMO and Overconfidence Patterns
## Discipline and Plan Adherence
## Mindset Score Trends
## Root Cause Analysis
## Recommended Psychological Strategies
## Daily Routine Recommendations
## Affirmations and Mental Framework`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function compareTradeToPlaybook(
  trade: Trade,
  playbookEntries: Array<{
    setup_name: string;
    description: string;
    rules: string;
    ideal_conditions: string;
  }>
): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 2048,
    system: `You are a trading coach that specialises in evaluating whether trades adhere to established trading playbooks and rules.
Be specific about which rules were followed and which were violated.
Provide a structured compliance assessment.`,
    messages: [
      {
        role: 'user',
        content: `Evaluate this trade against the trading playbook.

Trade Details:
${JSON.stringify({
  symbol: trade.symbol,
  direction: trade.direction,
  date: trade.trade_date,
  time: trade.trade_time,
  session: trade.session,
  entry_price: trade.entry_price,
  sl_price: trade.sl_price,
  tp_price: trade.tp_price,
  exit_reason: trade.exit_reason,
  pnl: trade.pnl,
  emotional_state: trade.emotional_state,
  confidence_level: trade.confidence_level,
  followed_plan: trade.followed_plan,
  confluences: Array.isArray(trade.confluences) ? trade.confluences : [],
  pre_trade_notes: trade.pre_trade_notes,
  post_trade_notes: trade.post_trade_notes,
}, null, 2)}

Playbook Entries:
${JSON.stringify(playbookEntries, null, 2)}

Provide a detailed compliance assessment:
# Playbook Compliance Report

## Best Matching Setup
## Rules Followed
## Rules Violated
## Ideal Conditions Match
## Compliance Score (0-100%)
## Specific Violations and Impact
## How to Better Execute This Setup Next Time`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function answerFlyxaQuestion(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<string> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error('Question is required');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 700,
    system: `You are Flyxa's built-in product assistant.

Flyxa is a futures trading journal and review workspace. Key areas include:
- Trade journaling and daily reflections
- Dashboard analytics and performance review
- AI Coach analysis
- Risk Manager and daily risk controls
- Trade Scanner and chart import workflows
- Backtesting / replay
- Playbook and psychology tracking

Rules:
- Answer questions about Flyxa clearly and helpfully.
- Be concise, practical, and product-focused.
- If the user asks how to do something in Flyxa, give direct steps.
- If the user asks about account-specific data, explain you cannot see their private data from the chat widget.
- If the question is unrelated to Flyxa, gently steer back to Flyxa and what the product does.
- Do not invent features that Flyxa does not clearly have.
- Keep responses in plain text, usually 2-6 short sentences.`,
    messages: [
      ...history
        .filter(message => message.content.trim() !== '')
        .slice(-8)
        .map(message => ({
          role: message.role,
          content: message.content,
        })),
      {
        role: 'user',
        content: trimmedQuestion,
      },
    ],
  });

  const textBlocks = response.content.filter(block => block.type === 'text');
  const combined = textBlocks.map(block => block.text.trim()).filter(Boolean).join('\n\n');

  if (!combined) {
    throw new Error('Unexpected response type from Claude');
  }

  return combined;
}

// ── Ask Flyxa — data-grounded trade query ─────────────────────────────────────

export async function answerTradeDataQuery(
  question: string,
  stats: Record<string, unknown>
): Promise<string> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Question is required');

  const statsJson = JSON.stringify(stats, null, 2);

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 700,
    system: `You are Flyxa AI — a sharp, brutally honest trading performance analyst embedded inside a trade journal app.

The user just asked you a question about their trading. You have been given their complete computed trading statistics below. Your job is to:
1. Understand exactly what the user is asking (even if phrased casually or ambiguously).
2. Locate the relevant numbers from the provided stats.
3. Give a direct, precise, data-driven answer using their actual figures — never invent numbers.
4. Proactively surface any important pattern you notice (good or bad) that's relevant to their question.
5. End with one specific, actionable recommendation.

Style rules:
- Plain conversational English. No bullet lists. No markdown headers.
- 3–5 sentences. Concise and meaty — no filler phrases.
- Lead with the answer, not with preamble like "Based on your data..." or "Great question!".
- Use specific percentages and dollar amounts from the provided stats.
- If a specific breakdown has fewer than 5 samples, note the small sample size and caveat accordingly.
- If the stats don't contain enough information to answer the question, say so plainly and suggest what data the user should log.

TRADE STATISTICS (JSON):
${statsJson}`,
    messages: [{ role: 'user', content: trimmed }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text.trim())
    .filter(Boolean)
    .join('\n\n');

  if (!text) throw new Error('No response from Claude');
  return text;
}

// ── Market news AI filter ─────────────────────────────────────────────────────

export interface NewsFilterItem {
  headline: string;
  summary: string;
  impact: 'high' | 'medium' | 'low';
  category: string;
  marketImpact: { es: string; nq: string; note?: string };
  isBreaking: boolean;
  source: string;
  timestamp: string;
  url?: string;
}

export async function filterNewsItems(
  headlines: Array<{ headline: string; source: string; timestamp: string; summary?: string; url?: string }>
): Promise<NewsFilterItem[]> {
  if (headlines.length === 0) return [];

  const system = `You are a market news filter for a futures trader who trades ES and NQ.
Your job is to filter a list of news headlines and return ONLY items that are likely to move US equity index futures (ES, NQ, YM) today.

For each relevant item return:
{
  "headline": string (keep original or slightly cleaned),
  "summary": string (1-2 sentences, plain English, explain WHY it matters for futures traders specifically),
  "impact": "high" | "medium" | "low",
  "category": "Fed" | "Earnings" | "Geopolitical" | "Macro" | "Energy" | "Political" | "Crypto" | "Other",
  "marketImpact": {
    "es": "bullish" | "bearish" | "neutral",
    "nq": "bullish" | "bearish" | "neutral",
    "note": string (optional, e.g. "wait for reaction")
  },
  "isBreaking": boolean,
  "source": string,
  "timestamp": string
}

Rules:
- Return max 10 items total
- If nothing is relevant return []
- Assign "high" only for Fed decisions, major geopolitical events, top-10 S&P500 earnings misses/beats, systemic risk events
- Assign "medium" for economic data releases, sector earnings, political policy announcements
- Assign "low" for background context items
- isBreaking = true only if timestamp is within 30 minutes of now AND impact is high
- Do NOT include crypto news unless it has clear equity market implications
- Respond with ONLY valid JSON array, no markdown, no code fences`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1800,
    system,
    messages: [{
      role: 'user',
      content: JSON.stringify(headlines.map(h => ({
        headline: h.headline,
        source: h.source,
        timestamp: h.timestamp,
        summary: h.summary?.substring(0, 200),
      }))),
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
  const clean = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NewsFilterItem =>
      typeof item === 'object' && item !== null &&
      typeof item.headline === 'string' &&
      typeof item.summary === 'string' &&
      ['high', 'medium', 'low'].includes(item.impact)
    ).map(item => ({
      ...item,
      url: headlines.find(h => h.headline.slice(0, 30) === item.headline.slice(0, 30))?.url,
    }));
  } catch {
    return [];
  }
}

export interface JournalInsightPattern {
  id: string;
  type: 'Risk' | 'Edge' | 'Psychology' | 'Behaviour';
  status: 'Active' | 'Improving' | 'Confirmed' | 'Resolved';
  title: string;
  description: string;
  confidence: number;
  tradeDates: string[];
  tags: Array<{ label: string; sentiment: 'positive' | 'negative' | 'neutral' }>;
  instrument: string;
  session: 'RTH open' | 'Overlap' | 'Midday';
}

export async function analyzeJournalInsights(
  entries: Array<{
    date: string;
    trades: Array<{
      symbol: string;
      direction: string;
      result: string;
      pnl: number;
      rr: number;
      entryTime?: string;
      followedPlan?: boolean | null;
      processGrade?: number;
      thesis?: string;
      execution?: string;
      adjustment?: string;
    }>;
    pre?: string;
    post?: string;
    lessons?: string;
  }>
): Promise<JournalInsightPattern[]> {
  const totalTrades = entries.reduce((n, e) => n + e.trades.length, 0);
  if (totalTrades === 0) return [];

  const digest = entries.map(e => ({
    date: e.date,
    pre: e.pre?.trim() || null,
    post: e.post?.trim() || null,
    lessons: e.lessons?.trim() || null,
    trades: e.trades.map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      result: t.result,
      pnl: t.pnl,
      rr: Number(t.rr?.toFixed(2)),
      entryTime: t.entryTime,
      followedPlan: t.followedPlan,
      processGrade: t.processGrade,
      thesis: t.thesis?.trim() || null,
      execution: t.execution?.trim() || null,
      adjustment: t.adjustment?.trim() || null,
    })),
  }));

  const prompt = `You are a professional trading coach analysing a trader's complete journal.

Analyse these ${totalTrades} trades across ${entries.length} trading days and identify 4–8 real behavioural and performance patterns.
Focus heavily on the written reflections (thesis, execution, lessons) — these contain the truth about why trades won or lost.

Journal data:
${JSON.stringify(digest, null, 2)}

Return ONLY a JSON array (no other text, no markdown). Each item must match exactly:
{
  "id": "p1",                          // unique string
  "type": "Risk" | "Edge" | "Psychology" | "Behaviour",
  "status": "Active" | "Improving" | "Confirmed",
  "title": string,                     // max 70 chars, specific
  "description": string,               // 2–3 sentences referencing actual journal text
  "confidence": number,                // 50–99 integer
  "tradeDates": string[],              // dates (YYYY-MM-DD) where this pattern appears
  "tags": [{ "label": string, "sentiment": "positive"|"negative"|"neutral" }],
  "instrument": string,                // e.g. "NQ" or "Mixed"
  "session": "RTH open" | "Overlap" | "Midday"
}

Rules:
- "Edge" type = consistently profitable behaviours to reinforce
- "Risk" type = behaviours costing money
- "Psychology" type = emotional or cognitive patterns
- "Behaviour" type = execution or process patterns
- Only report patterns with at least 2 data points in the journal
- Be specific — reference actual entry times, symbols, written notes where possible
- Return at minimum 2 Edge patterns and 2 Risk/Psychology patterns`;

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') return [];

  try {
    const raw = content.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as JournalInsightPattern[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      p => p.id && p.type && p.title && p.description && Array.isArray(p.tradeDates)
    );
  } catch {
    return [];
  }
}
