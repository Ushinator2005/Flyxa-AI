import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ExtractedTradeData } from '../types/index';

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
  focusImages: Array<{ base64Image: string; mimeType: string; label: string }> = []
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

  for (let modelIndex = 0; modelIndex < GEMINI_MODEL_FALLBACK_CHAIN.length; modelIndex++) {
    const modelName = GEMINI_MODEL_FALLBACK_CHAIN[modelIndex];
    const model = genAI.getGenerativeModel({ model: modelName });

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

function buildPriceRules(userColors?: ScannerUserColors): string {
  const entryText = userColors
    ? `${hexToColorName(userColors.entry)} (${userColors.entry})`
    : 'configured entry color, or neutral grey/dark fallback';
  const stopText = userColors
    ? `${hexToColorName(userColors.stopLoss)} (${userColors.stopLoss})`
    : 'red/pink stop-loss color';
  const targetText = userColors
    ? `${hexToColorName(userColors.takeProfit)} (${userColors.takeProfit})`
    : 'teal/green take-profit color';

  return `PRICE LABEL DECISION TREE - FOLLOW IN ORDER
1. Find the compact position tool. It is the paired red/stop and teal/take-profit box with shared horizontal span and a shared entry boundary. Ignore large supply/demand/orderblock/session zones.
2. Read right-axis labels only. Do not use numbers printed inside the chart body, fib labels, R:R labels, confluence labels, or annotations.
3. For each level, start at the geometry crop/line:
   - entry_price: entry-label-focus at the shared red/green boundary.
   - sl_price: stop-label-focus at the outer red/pink stop boundary.
   - tp_price: target-label-focus at the outer teal/green target boundary.
   Use price-label-focus as the full right-axis backup when a dedicated crop contains a rejected label.
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

function buildTimeRules(lineHints?: ScannerLineHints): string {
  return `TIME
1. Read timeframe from the chart header.
2. Read entry_time using candle-count interpolation, not by blindly copying the nearest x-axis label.
${typeof lineHints?.timeAxisEntryXRatio === 'number' ? `3. Use time-axis-focus first. The entry candle is near ${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the left of that crop.` : '3. Use the bottom x-axis labels in full_chart or time-axis-focus.'}
4. Pick the x-axis time label whose candle is closest to the left edge of the P&L box.
5. Count candles from that anchor to the entry candle. entry_time = anchor time + candle count * timeframe.
6. Do not estimate close_time or trade duration. Dedicated exit verifiers handle the exit after this extraction pass.`;
}

export function buildMainExtractionPrompt(
  userColors?: ScannerUserColors,
  boxBounds?: ScannerBoxBounds,
  directionHint?: 'Long' | 'Short',
  lineHints?: ScannerLineHints,
): string {
  const boxText = boxBounds
    ? `The compact position tool spans approximately ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% of the image width.`
    : 'If exact box bounds are unavailable, use the compact colored position tool visible in the chart.';

  return `You are a futures chart extraction assistant. Extract only identity, price levels, direction, and entry time from a TradingView-style risk/reward screenshot.
Do not decide win/loss. Do not decide whether TP or SL was touched. Dedicated verifiers handle exits later.

${buildIdentityRules()}

${buildGeometryRules(directionHint, lineHints)}
${boxText}

${buildPriceRules(userColors)}

${buildTimeRules(lineHints)}

Return ONLY raw JSON:
{
  "symbol": string or null,
  "direction": "Long" or "Short" or null,
  "entry_price": number or null,
  "sl_price": number or null,
  "tp_price": number or null,
  "timeframe_minutes": number or null,
  "entry_time": "HH:MM" or null,
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
): Promise<{
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
}> {
  {
    const systemPrompt = buildMainExtractionPrompt(userColors, boxBounds, directionHint, lineHints);

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
      const { text } = await generateWithFallback(genAI, systemPrompt, mimeType, base64Image, focusImages);
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

      try {
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        const modelDirection = parseDirection(parsed.direction);
        const direction = directionHint ?? modelDirection;
        const entryPrice = parseNullableNumber(parsed.entry_price);
        const baseWarnings: string[] = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : [];
        if (directionHint && modelDirection && modelDirection !== directionHint) {
          baseWarnings.push(`Direction corrected from ${modelDirection} to ${directionHint} using compact position-tool geometry.`);
        }

        const { sl_price, tp_price, warnings: sanityWarnings } = sanitizePriceLevels(
          direction,
          entryPrice,
          parseNullableNumber(parsed.sl_price),
          parseNullableNumber(parsed.tp_price),
          baseWarnings,
        );
        const priceConfidence = parsed.price_confidence === 'high' || parsed.price_confidence === 'medium' ? parsed.price_confidence : 'low';
        const timeConfidence = parsed.time_confidence === 'high' || parsed.time_confidence === 'medium' ? parsed.time_confidence : 'low';
        if (priceConfidence === 'low') {
          sanityWarnings.push('Price read is low confidence; verify entry/SL/TP manually.');
        }

        const timeframeRaw = parseNullableNumber(parsed.timeframe_minutes);
        const timeframeMinutes = timeframeRaw !== null ? Math.max(0, Math.round(timeframeRaw)) : null;

        return {
          symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
          direction,
          entry_price: entryPrice,
          sl_price,
          tp_price,
          exit_reason: null,
          trade_length_seconds: null,
          timeframe_minutes: timeframeMinutes,
          entry_time: parseTimeToken(parsed.entry_time),
          close_time: null,
          confidence: timeConfidence,
          first_touch_candle_index: null,
          evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
          warnings: sanityWarnings,
        };
      } catch {
        return nullResult(['Failed to parse Gemini response']);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini API error';
      return nullResult([msg]);
    }
  }

}

  /*
  Legacy monolithic extraction prompt disabled. The active scanner path above now
  extracts identity, prices, direction, and entry time only; exit resolution is
  owned by the dedicated boundary/verifier passes below.
  const colorSection = userColors
    ? (() => {
        const entryName = hexToColorName(userColors.entry);
        const slName    = hexToColorName(userColors.stopLoss);
        const tpName    = hexToColorName(userColors.takeProfit);
        return `
PRICE LEVEL IDENTIFICATION — FOLLOW THESE STEPS EXACTLY:

Step 1. Look at the right-hand price axis of the chart. You will see colored price labels — these may be rounded pills, sharp rectangles, or any other colored tag shape depending on the trading platform (TradingView standalone, TopstepX, Apex, FTMO, Tradovate, etc.). Shape does not matter — only the background color and the number inside matter.
IMPORTANT: The ENTRY label should match the user's configured Entry zone color when they have changed it. If no configured-color entry label is visible, the entry can be the neutral/grey/black right-axis pill exactly aligned with the shared boundary between the compact take-profit and stop-loss zones. Never use a black/white horizontal-line label as entry when a colored or grey entry label is visible.
If an attached crop is labelled price-label-focus, use it to read all visible right-axis labels. If an attached crop is labelled entry-color-label-focus, use it to resolve the entry label only.
FALLBACK — if no colored labels are visible on the right axis at all: trace each zone boundary (entry line, outer edge of pink zone, outer edge of teal zone) horizontally to the price axis gridlines and read the nearest grid price.

⚠ CURSOR CROSSHAIR LABEL — MANDATORY EXCLUSION BEFORE READING ANY PRICE:
Trading platforms (especially TradingView) render a floating 'cursor price' label on the right axis that tracks the mouse pointer position. This label is NOT a trade level.
How to identify it: the cursor crosshair label has a ⊕ symbol (circle containing a plus/cross), a + icon, or a circle-with-cross marker on its LEFT edge, immediately before the price number. It appears as a white, light-grey, or dark rectangular tag with this icon on the left side. It can appear in ANY crop — entry-label-focus, price-label-focus, or any other.
RULE: If any right-axis price label has a ⊕, +, or circle-with-cross icon on its LEFT side — SKIP THAT LABEL ENTIRELY. Never use it as entry_price, sl_price, or tp_price. Instead find the next label at that level that has no such icon and matches the configured zone color or zone boundary position.

Step 2. The user has configured exactly these three zone colors in their Flyxa settings:
  • Entry zone    = ${entryName} — exact hex: ${userColors.entry}
  • Stop Loss     = ${slName} — exact hex: ${userColors.stopLoss}
  • Take Profit   = ${tpName} — exact hex: ${userColors.takeProfit}
These hex values describe the background color of the position-tool price labels on the right axis. The label whose background most closely matches each hex is the correct one for that level.

MANDATORY - POSITION TOOL vs MARKET-STRUCTURE ZONES:
Charts often contain extra colored boxes such as demand zones, supply zones, order blocks, FVGs, or session zones. These may use the same green/red colors as the scanner settings, but they are NOT the trade.
The active trade is the compact paired position tool: its red/stop zone and teal/take-profit zone share roughly the same horizontal start/end span and touch the same entry boundary. Ignore any large colored zone that spans most of the chart, sits far away from the paired red/teal tool, or continues far beyond the P&L box.
Only read right-axis labels that align with the compact position-tool boundaries. If a green/red price label belongs to a large demand/supply/orderblock zone, ignore it even if its color matches the configured Take Profit or Stop Loss color.

⚠ MANDATORY — KEY-LEVEL LINE LABELS vs POSITION TOOL ENTRY LABELS:
Traders draw horizontal support/resistance lines across their entire chart. These lines can produce their own right-axis labels with TRUE BLACK or VERY DARK backgrounds (close to #000000). Some platforms also use a black/dark right-axis pill for the actual ENTRY label.
How to tell them apart:
  • KEY-LEVEL label: the line it belongs to runs horizontally across the ENTIRE chart, extending far beyond the compact P&L box. Ignore it unless it is exactly the shared entry boundary and no better entry label exists.
  • POSITION TOOL ENTRY label: sits on the right axis at the exact shared boundary where the compact teal/green and red/pink zones meet. It may be grey, black, or dark depending on the platform.
WHEN BOTH APPEAR AT THE SAME PRICE (common case): a key-level line happens to be drawn exactly at the entry/SL/TP price, so two labels stack at the same Y position on the right axis — one black (key-level), one colored/grey (position tool). You MUST use the non-black one.
MANDATORY: Do NOT discard a black/dark right-axis label when it is exactly aligned with the shared boundary between the compact TP and SL zones. In that case it is the entry pill and is the correct entry_price.
MANDATORY: If entry-label-focus shows a black/dark right-axis pill at the shared boundary and no configured-color entry label is visible, read that pill as entry_price.
NEVER read entry_price from numeric annotations printed inside the chart/position tool body (examples: 0, 0.5, 1, -1, -2, fib labels, dashed-line labels). Entry must come from the right-axis pill/label at the shared red/green boundary.

⚠ MATCHING-COLOR LINE TEST — MANDATORY FOR EVERY PRICE LEVEL (ENTRY, SL, TP):
The correct position-tool labels (Entry, SL, TP) are STANDALONE right-axis pills. They NEVER have a horizontal line of THEIR OWN COLOR extending leftward from them onto the chart body. User-drawn levels always do: a horizontal-line drawing produces a right-axis label whose background color MATCHES the color of its line (black label + black line, blue label + blue line, etc.).
THE TEST: for each candidate label, look immediately left of it on the chart. If a horizontal line (solid or dashed) of the SAME COLOR as the label's background extends from it across the chart → that label belongs to a drawn level. REJECT IT for entry_price, sl_price, and tp_price — regardless of how close its price is to the expected level.
WHAT DOES NOT DISQUALIFY A LABEL:
• The P&L box's own zone borders. The true SL label sits exactly at the outer edge of the red zone and the true TP label at the outer edge of the teal zone — the semi-transparent zone fill/border touching the label from the left is part of the position tool, NOT a drawn line. Do NOT reject a configured-color label because the zone edge meets it.
• Lines of a DIFFERENT color passing near or through the label's price.
STACKED SAME-PRICE CASE (very common): a trader draws a key level at exactly the SL/entry/TP price, so TWO labels stack at the same Y on the right axis — e.g. a black key-level label AND the red position-tool SL label, both reading the same price. Apply the test: the label WITH a matching-color line is the drawn level (ignore it); the label WITHOUT any matching-color line is the position-tool label (use it). If two labels have similar colors or similar prices, the one with a matching-color line coming out of it is ALWAYS the one to ignore.
Concrete anchors:
• sl_price = the ${slName}-colored standalone pill that aligns with the outer edge of the red/pink zone of the P&L box, with no ${slName} line extending from it.
• entry_price = the standalone pill matching the configured entry color (or grey/dark fallback) at the shared zone boundary, with NO line of its own color extending from it onto the chart.
• A dashed line inside the colored zone (average-entry indicator, scale-in marker) produces a matching right-axis label — that label MUST be rejected for entry. Read entry from the standalone pill at the zone boundary instead.

⚠ COLOR-ROLE EXCLUSIVITY — ABSOLUTE, OVERRIDES ALL PIXEL-GEOMETRY HINTS AND CROPS:
Traders draw large supply/demand/orderblock zones in colors similar to the position tool, and these drawn zones can OVERLAP or sit directly adjacent to the compact position tool. When that happens the scanner's pixel-derived crops (stop-label-focus, entry-label-focus) may be centered at the DRAWN zone's edge instead of the position tool's edge. The configured-color right-axis labels are the FINAL AUTHORITY — never the crop position.
1. sl_price may ONLY come from a label whose background matches the configured Stop Loss color (${slName}). If the stop-label-focus crop contains NO ${slName}-colored label, do NOT substitute a black, grey, or other-colored label from that crop — the crop is centered on the wrong zone. Re-scan price-label-focus and the full chart for the ${slName}-colored standalone pill and use that price instead.
2. If MULTIPLE ${slName}-family labels are candidates, sl_price is the one CLOSEST to the entry boundary on the risk side. A red label sitting further away at the edge of a larger drawn zone is that zone's boundary, not the stop.
3. entry_price may NEVER equal the price of a ${slName}-colored or ${tpName}-colored label. If the value you are about to output for entry_price matches a ${slName}-colored label's price, you have misread — that label is sl_price. Entry is the grey/dark/${entryName} standalone pill strictly BETWEEN sl_price and tp_price.
4. FINAL CHECK before answering: entry_price must lie strictly between sl_price and tp_price, sl_price must come from a ${slName}-colored label, tp_price from a ${tpName}-colored label, and entry_price from a non-SL-colored, non-TP-colored label. If any of these fail, re-read the labels — do not output the failing combination.

Step 3. Match each right-axis label to the configured hex colors above:
  • Label whose background ≈ ${userColors.entry} (${entryName})  → entry_price
  • Label whose background ≈ ${userColors.stopLoss} (${slName})   → sl_price
  • Label whose background ≈ ${userColors.takeProfit} (${tpName}) → tp_price
  If no ${entryName} entry label is visible, fall back to the grey/black/dark right-axis label at the shared entry boundary as entry_price.
  A Take Profit-colored label can NEVER be used as sl_price. A Stop Loss-colored label can NEVER be used as tp_price. If a dedicated crop contains the wrong color for its role, ignore that label and re-read price-label-focus at the correct compact position-tool boundary.

CRITICAL — STACKED LABELS DISAMBIGUATION:
On many platforms (especially TradingView), you will see TWO labels of identical or very similar color stacked close together at the TP or SL price level. One is the position-tool price label (the correct value). The other is the LIVE floating price label that shows the current market price — it can coincidentally match your configured color and float near the zone boundary.
YOU MUST USE THE ZONE BOUNDARY TO PICK THE CORRECT LABEL:
  • For a LONG trade:
    - The correct TP label is the one whose vertical position aligns with the TOP OUTER EDGE of the teal zone (the highest horizontal boundary line of the teal colored area). It will be INSIDE or exactly ON the zone boundary.
    - Any label that appears ABOVE the top edge of the teal zone (floating beyond the boundary, outside the zone) is the live price marker — IGNORE IT.
    - The correct SL label is the one whose vertical position aligns with the BOTTOM OUTER EDGE of the red/pink zone (the lowest horizontal boundary line of the red area). It will be INSIDE or exactly ON the zone boundary.
    - Any label that appears BELOW the bottom edge of the red zone is the live price marker — IGNORE IT.
  • For a SHORT trade (mirror image):
    - The correct SL label aligns with the TOP OUTER EDGE of the upper red/pink zone — ignore any label floating above it.
    - The correct TP label aligns with the BOTTOM OUTER EDGE of the lower teal zone — ignore any label floating below it.
RULE: When two similarly-colored labels are stacked, ALWAYS choose the inner one (the one sitting at or inside the zone boundary), NOT the one floating outside the boundary.

DIFFERENT-COLOR STACK — LIVE-PRICE PILL vs POSITION LABEL (CRITICAL, COLOR WINS OVER POSITION):
The live/current-price pill is very often a DIFFERENT color from the position label it sits beside, and only 1–4 points away. Discriminate by CONFIGURED COLOR — never by which label is higher, lower, or "outermost":
  • sl_price MUST come from a label whose background matches the configured Stop Loss color (${slName}, ${userColors.stopLoss}). A green/teal label is NEVER the stop loss — not even when it is the topmost/outermost label at the top of a SHORT's red zone. In that exact stack the green live-price pill floats just ABOVE the red stop label; the SL is the ${slName} label sitting one step BELOW it, at the true top edge of the pink fill. Do NOT read sl_price from the green pill just because it is highest.
  • tp_price MUST come from a label whose background matches the configured Take Profit color (${tpName}, ${userColors.takeProfit}). A red/pink label is NEVER the take profit.
  • Concretely: if a GREEN label and a RED/pink label are stacked within a few points at the top of a SHORT's red zone, the RED one is sl_price and the GREEN one is the live price — ignore the green one entirely.
COUNTDOWN-TIMER DISQUALIFIER: the live-price pill usually has a small bar-close countdown timer attached directly beneath or beside it (e.g. "00:29", "0:14", "1:03"). ANY right-axis label that has an attached countdown timer is the live price marker — IGNORE IT for sl_price, tp_price, AND entry_price. Read the adjacent configured-color position label instead.

Step 4. IGNORE everything else on the chart completely:
  • Horizontal lines (black, white, or any color) drawn across the chart = key levels, NOT trade prices
  • Black or white right-axis labels attached to horizontal key levels = ignore for entry_price UNLESS the label is exactly aligned with the shared boundary between the compact TP and SL zones and no configured-color entry label is visible
  • The live floating price label on the far right (the highlight showing current price) = ignore
  • The cursor crosshair label — has a ⊕, + or circle-with-cross icon on its LEFT edge = ALWAYS IGNORE in every crop; it tracks the mouse pointer, not a trade level
  • Any price label whose background color does NOT match the configured position-tool colors = ignore, except grey is allowed as an entry fallback
  • Do not use a nearby black horizontal-line label when a configured-color or grey entry label exists. The entry label is the source of truth.
`;
      })()
    : `
PRICE LEVEL IDENTIFICATION:
Look at the right-hand price axis. Find the three colored price labels (any shape — pill, rectangle, tag):
  • Grey/black/dark label exactly at the shared boundary between the compact teal/green and red/pink position-tool zones = entry_price
  • Red or pink background label = sl_price
  • Teal or green background label = tp_price

⚠ CURSOR CROSSHAIR LABEL — MANDATORY EXCLUSION:
Any right-axis label with a ⊕, + or circle-with-cross icon on its LEFT side is the platform's cursor price tracker — NOT a trade level. ALWAYS IGNORE it. Never use it as entry, SL, or TP.

⚠ KEY-LEVEL LINES: Traders draw horizontal lines across their entire chart. These can produce BLACK or DARK GREY right-axis labels. Ignore them unless the label is exactly on the compact position tool's shared entry boundary and no colored/grey entry label is visible.
NEVER use numeric labels printed inside the chart body (0, 0.5, 1, -1, -2, fib labels, dashed-line labels) as entry/sl/tp.

⚠ MATCHING-COLOR LINE TEST — MANDATORY:
Position-tool price labels (SL, Entry, TP) are standalone right-axis pills. They NEVER have a horizontal line of THEIR OWN COLOR extending left from them onto the chart. A user-drawn level always does — its right-axis label color matches its line color (black label + black line, etc.).
For each candidate label: if a solid or dashed line of the SAME COLOR as the label extends from it onto the chart body, that label is a drawn level — REJECT it for entry/SL/TP, even if its price matches the expected level. When two labels stack at the same price (e.g. a black key-level label and a red SL label), use the one WITHOUT a matching-color line.
The P&L box's own semi-transparent zone borders touching a label do NOT disqualify it — the true SL/TP labels sit exactly at the zone edges. A dashed line inside the colored zone (average-entry marker) has a matching right-axis label that must be rejected for entry; use only the standalone pill at the zone boundary.

⚠ COLOR-ROLE EXCLUSIVITY — ABSOLUTE:
Drawn supply/demand zones can overlap the position tool and mislead the crop positions. The colored labels are the final authority:
1. sl_price ONLY from a red/pink label. If a crop shows no red/pink label, do NOT substitute a black or grey one — find the red/pink standalone pill elsewhere in the image.
2. When multiple red/pink labels are candidates, sl_price is the one CLOSEST to the entry boundary — a red label further out belongs to a drawn zone edge.
3. entry_price may NEVER equal a red/pink or teal/green label's price. If it does, that label is the SL (or TP) — entry is the grey/dark pill strictly BETWEEN sl_price and tp_price.
4. FINAL CHECK: entry strictly between SL and TP; SL from a red/pink label; TP from a teal/green label. If any check fails, re-read — do not output the failing combination.

FALLBACK — if no colored labels are visible: trace each zone boundary to the price axis gridlines and read the nearest grid price.
STACKED LABELS: If two labels of similar color appear stacked near the TP or SL price, use the one that aligns with the OUTER BOUNDARY of the colored zone (the far edge of the zone from entry). The label floating outside the zone boundary is the live price marker — ignore it.
DIFFERENT-COLOR STACK: The live/current-price pill is often a different color from the stop/target label and sits only 1–4 points away. sl_price is the RED/pink label; tp_price is the TEAL/green label. A GREEN label is NEVER the stop loss even when it is the highest label at the top of a SHORT's red zone — in that case the green pill is the live price floating just above the red stop label; read sl_price from the RED label one step below it. A RED/pink label is never the take profit.
COUNTDOWN-TIMER DISQUALIFIER: Any right-axis label with a small bar-close countdown timer attached (e.g. "00:29", "0:14") is the live-price marker — ignore it for entry_price, sl_price, and tp_price and read the adjacent colored position label instead.
`;

  const geometrySection = directionHint || lineHints
    ? `PIXEL GEOMETRY AUTHORITY — USE THIS BEFORE GUESSING:
The browser-side scanner has already matched the user's configured colors and selected the compact paired position-tool zones. Treat this geometry as the source of truth for direction and crop roles.
${directionHint ? `- Detected compact position-tool direction: ${directionHint}` : '- Direction hint: unavailable'}
${typeof lineHints?.entryLineRatio === 'number' ? `- entry-label-focus is centered near ${Math.round(lineHints.entryLineRatio * 100)}% image height: read entry_price from the RIGHT-AXIS pill/label at this shared boundary. If you see TWO labels at this level — one with a ⊕/+ icon on its left (cursor label) and one without — read the one WITHOUT the ⊕/+ icon.` : ''}
${typeof lineHints?.stopLineRatio === 'number' ? `- stop-label-focus is centered near ${Math.round(lineHints.stopLineRatio * 100)}% image height: read sl_price at this stop boundary.` : ''}
${typeof lineHints?.targetLineRatio === 'number' ? `- target-label-focus is centered near ${Math.round(lineHints.targetLineRatio * 100)}% image height: read tp_price at this target boundary.` : ''}
${typeof lineHints?.timeAxisEntryXRatio === 'number' ? `- time-axis-focus crop: a zoomed strip of the chart bottom near the entry candle. The entry candle sits at approximately ${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the LEFT edge of this crop. Use this crop as your primary view for x-axis time labels in Step 5.` : ''}
If a right-axis label away from these geometry lines is easier to read, IGNORE IT. Do not use the live/current price label, the last traded price label, or a large orderblock/demand/supply-zone label as entry/sl/tp.
For a Long position tool, TP/green is above entry and SL/red is below entry. For a Short position tool, SL/red is above entry and TP/green is below entry.
If the numbers you read imply the opposite direction from the detected compact tool, your price read is wrong — re-read the labels at the geometry lines instead of flipping direction.
The entry boundary may have a neutral/black/grey right-axis label if no configured entry-color label is visible. That neutral/dark pill is valid ONLY when it aligns with the shared boundary between the compact TP and SL zones. Do not read entry from a dashed line, fib label, or any number printed inside the chart body.
`
    : '';

  const systemPrompt = `You are a professional futures chart reader. Your ONLY job is to extract exact trade data from a P&L card screenshot — the chart may come from TradingView, TopstepX, Apex Trader, FTMO, Tradovate, or any other platform.
You may receive the full chart plus labelled scanner crops. The crop labels are included as text immediately before each image.
Use price-label-focus as the primary OCR view for right-axis price labels. Use entry-label-focus as the primary OCR view for the entry price pill at the shared red/green boundary. Use entry-color-label-focus only as a secondary entry check. If entry-label-focus shows a black/dark right-axis pill at the shared TP/SL boundary, that can be the valid entry label. If stop-label-focus or target-label-focus show black/white horizontal-line labels, treat them as crop hints only and ignore those black/white values as SL/TP prices.

${geometrySection}

CROP AUTHORITY RULE — HIGHEST PRIORITY FOR SL/TP PRICES:
The crops labelled stop-label-focus and target-label-focus are scanner-generated strips precisely centered on the SL and TP zone boundary lines — each only ~9% of the chart height tall, placed right at that level.
Before trusting any colored label in these crops, run the MATCHING-COLOR LINE TEST from Step 2. A crop can be centered on a drawn horizontal level, so color alone is not enough.
• If stop-label-focus contains a Stop Loss-colored label AND there is no same-color solid/dashed line extending left from that label into the chart body → that label's number is the DEFINITIVE sl_price. It overrides every other reading, including the full chart and price-label-focus.
• If target-label-focus contains a Take Profit-colored label AND there is no same-color solid/dashed line extending left from that label into the chart body → that label's number is the DEFINITIVE tp_price. It overrides every other reading, including the full chart and price-label-focus.
• If a colored label has a same-color horizontal line extending from it, it is a drawn level. Reject it even when it appears in stop-label-focus or target-label-focus, then re-read price-label-focus/full_chart for the standalone position-tool pill at the compact zone boundary.
• Only fall back to price-label-focus or the full chart for a price if the dedicated crop shows only rejected labels: black/white key-level labels, wrong-role colors, live/current-price labels, market-structure zone labels, or colored labels with same-color lines.
IMPORTANT OVERRIDE TO THE CROP RULE ABOVE:
Do NOT treat "any colored label" as valid. The color must match the crop role:
- stop-label-focus is authoritative ONLY when the label background matches the configured Stop Loss color.
- target-label-focus is authoritative ONLY when the label background matches the configured Take Profit color.
- If a dedicated crop contains the wrong role color, a black/white key-level label, a live-price marker, a market-structure zone label, or a same-color horizontal-line label, ignore it and re-read price-label-focus at the correct compact position-tool boundary.

FINAL PRICE-LABEL LINE AUDIT — REQUIRED BEFORE RETURNING JSON:
For entry_price, sl_price, and tp_price separately, look immediately left of the exact right-axis label you chose.
- If a solid or dashed line of the same color as that label extends leftward across the chart body, that chosen label is invalid. Replace it with the standalone position-tool label at the same compact zone boundary.
- If there are two labels at the same Y/price, choose the one without a matching-color line. The one with the matching-color line is a drawn level.
- The only horizontal edges allowed to touch a valid SL/TP label are the P&L box's own semi-transparent zone border/fill edges. Those are not user-drawn horizontal lines.

Read each number in the colored label CHARACTER BY CHARACTER — digit by digit. Do not approximate or round. "823" and "830" are completely different numbers — read every digit individually.

STEP 1 — READ THE TICKER:
Look at the top-left corner of the chart for the instrument header.
Read the ticker symbol. Examples:
- 'NQM26 · 1 · CME' → symbol is NQ, timeframe_minutes is 1
- 'MNQM26 · 1' → symbol is MNQ, timeframe_minutes is 1
- 'ESM26 · 5' → symbol is ES, timeframe_minutes is 5
Always return the ROOT ticker only (NQ not NQM26, MNQ not MNQM26).
Product-name mapping is mandatory:
- "Micro Nasdaq" or "Micro E-mini Nasdaq-100" = MNQ
- "E-mini Nasdaq-100" without the word Micro = NQ
- "Micro S&P" or "Micro E-mini S&P 500" = MES
- "E-mini S&P 500" without the word Micro = ES
Valid roots: NQ, MNQ, ES, MES, YM, MYM, RTY, M2K, CL, MCL, GC, MGC, SI, 6E, 6B, BTC, MBT

STEP 2 — IDENTIFY entry_price, sl_price, tp_price:
${colorSection}

STEP 3 — DETERMINE DIRECTION:
${directionHint
  ? `Pixel-level color analysis of the chart has pre-determined the direction as ${directionHint}. Return direction = "${directionHint}".
Consistency check (${directionHint === 'Long' ? 'Long: TP > entry > SL' : 'Short: TP < entry < SL'}): if your prices conflict with this, re-examine the price labels first. Keep direction = "${directionHint}" regardless, but add a warning if prices still look inconsistent.`
  : `First determine direction from the compact colored position tool layout:
- Teal/take-profit zone above the red/stop zone = LONG.
- Red/stop zone above the teal/take-profit zone = SHORT.
Only use price order as a fallback AFTER you are sure the labels belong to the compact position tool:
- TP > entry > SL = LONG.
- SL > entry > TP = SHORT.
Never use the live/current price label, last traded price label, or a large market-structure zone label to infer direction.`}

STEP 4 — FIND THE EXIT (FIRST TOUCH ONLY, INSIDE THE P&L CARD ONLY):
⚠ CRITICAL: Use the crop labelled exit-path-focus for all exit detection. This crop is generated by the scanner starting exactly at the left edge of the P&L card, so pre-trade candles are physically absent. The full chart image is NOT authoritative for exit detection — it contains pre-trade candles (including the 09:30 market open spike) that must not be counted. If exit-path-focus is not available, fall back to the full chart with the pixel geometry rules below.
The P&L card is the colored overlay on the chart — the region covered by the red/pink zone and the teal zone together. You must ONLY read candles whose bodies and wicks fall physically inside this colored overlay. Nothing outside it exists for this analysis.
${boxBounds
  ? `The P&L card occupies image columns ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% from the left edge.
The FIRST candle inside the card (at the ${Math.round(boxBounds.leftRatio * 100)}% left edge) is the entry candle — start here.
HARD RULE — LEFT: Any candle whose center x-position is to the LEFT of ${Math.round(boxBounds.leftRatio * 100)}% does not exist. Do not look at it. Do not count it. Even if a pre-trade candle's wick extends into SL or TP price range, it is outside the P&L card and must be completely disregarded.
HARD RULE — RIGHT: Any candle whose center x-position is to the RIGHT of ${Math.round(Math.min(boxBounds.rightRatio + 0.03, 1) * 100)}% does not exist. Do not look at it. The exit candle is typically the rightmost candle inside the box or the one whose center sits right at the right edge — include it, but stop there.
STOP ON FIRST HIT: The moment any candle's wick triggers SL or TP, that is the exit. Do not continue scanning further candles after a hit.`
  : `Scan only candles physically inside the colored P&L overlay (left edge to right edge). Ignore all candles to the left (pre-trade). Ignore all candles beyond the right edge of the overlay. Stop scanning the moment SL or TP is first hit.`}

DO NOT USE ANY COLOR OR SIZE BIAS — CANDLE WICKS ARE THE ONLY EVIDENCE.
Do NOT use the background color of the teal zone, the red/pink zone, or any P&L label to decide the outcome.
Those zone colors are fixed regardless of what happened. A large teal zone just means TP was far away — it says nothing about whether TP was hit.
Do NOT use the size of either zone as a signal. Ignore all color cues. The answer comes only from candle wicks inside the P&L card.

ANNOTATION EXCLUSION RULE — IGNORE ALL TEXT LABELS ON THE CHART:
POS Bracket drawing tools (and similar tools) render number labels directly onto the colored zones: commonly −2, −1, 0, +1, +2, +3, etc. These are purely cosmetic design elements of the drawing tool. They do NOT mark price levels that matter, and their position tells you nothing about whether TP or SL was hit.
Also ignore: confluence marker labels, order-block labels, session-range labels, horizontal-line labels, any floating annotation, and any other text overlay you see on the chart.
Your ONLY evidence for an exit decision is the physical position of candle wicks relative to the FAR OUTER BOUNDARY of the colored zones — never text, numbers, or annotation positions.

EXACT RULES — WHAT COUNTS AS A HIT:
You must trace a horizontal line at the exact SL price and another at the exact TP price across the chart.
A level is ONLY hit when a candle wick visually reaches or crosses that exact price line.
Entering the colored zone is NOT enough — the wick must reach the FAR OUTER BOUNDARY of the zone (the price line itself).

Zone boundary clarification (applies to both LONG and SHORT):
- The teal/blue zone spans from the entry price outward to tp_price. Its outer edge IS the TP line.
- The red/pink zone spans from the entry price outward to sl_price. Its outer edge IS the SL line.
- A candle that enters a zone but turns back before reaching the outer edge has NOT triggered that level. Keep scanning.

For SHORT trades:
- SL hit: a candle HIGH wick reaches or exceeds sl_price (top edge of upper red/pink zone)
- TP hit: a candle LOW wick reaches or goes below tp_price (bottom edge of lower teal zone)

For LONG trades:
- SL hit: a candle LOW wick reaches or goes below sl_price (bottom edge of lower red/pink zone)
- TP hit: a candle HIGH wick reaches or exceeds tp_price (top edge of upper teal zone)

FIRST TOUCH RULE: Number the entry candle as candle 0, then candle 1, candle 2, and so on moving left-to-right.
The first numbered candle that triggers either level decides the result. Stop scanning immediately at that candle.
Return that zero-based number as first_touch_candle_index. If no exit is confirmed, return null.
If price partially moves toward TP then reverses and hits SL — the result is SL, regardless of how far into the TP zone it went.
NEVER stop scanning early just because price moved deep into one zone. You must check whether it actually reached the outer boundary.
FORBIDDEN: inferring an exit from penetration depth, speed of movement, zone color/size, or "price was clearly going to hit it". A wick that covers 90% of a zone but stops short of the exact price line triggers NOTHING — keep scanning. Price MUST physically touch or cross the exact sl_price or tp_price line for an exit to exist. When both levels have true touches, the exit is strictly the one whose touch candle comes FIRST (lower candle index) — never the "bigger" move.

SINGLE-CANDLE SPAN RULE — THIS OVERRIDES FIRST TOUCH:
A candle "spans both levels" when its full range covers both the TP price and the SL price simultaneously:
  • For LONG: that candle's LOW wick ≤ sl_price AND its HIGH wick ≥ tp_price in the same candle.
  • For SHORT: that candle's HIGH wick ≥ sl_price AND its LOW wick ≤ tp_price in the same candle.
When the first candle to touch either level also spans the other level in the same candle, the intra-candle order of events is UNKNOWABLE from a static chart image.
In this case you MUST:
  1. Set exit_reason to null.
  2. Set confidence to "low".
  3. Add "Single candle spans both TP and SL — intra-candle order unknown. Verify Win/Loss manually." to warnings.
DO NOT default to TP. DO NOT default to SL. DO NOT guess. This situation is genuinely ambiguous — report it as such.
This rule is especially common on the first 1-minute candle after market open (e.g. 09:30 ET) which often has an outsized range.

When in doubt on a borderline wick (barely grazing the line), set exit_reason to null.
If a wick clearly breaks THROUGH the zone boundary (extends past the outer edge entirely), that is an unambiguous hit.
NEVER use the live floating current-price label on the right axis as a trade level.

STEP 5 — ESTIMATE ENTRY AND CLOSE TIME (CANDLE-COUNT METHOD — MANDATORY):
Do NOT simply read the nearest x-axis label as the entry time. That method is wrong when the entry candle sits between two time labels. You MUST use the candle-count interpolation method described below.
${typeof lineHints?.timeAxisEntryXRatio === 'number' ? `PRIMARY SOURCE: A crop labelled time-axis-focus is provided. It is a zoomed strip of the chart bottom around the entry candle — time labels are much clearer here than in the full chart. The pixel geometry section above told you the entry candle sits at ~${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the left of this crop. In Step A below, read labels from time-axis-focus first. Pick the label whose horizontal position is closest to ${Math.round(lineHints.timeAxisEntryXRatio * 100)}% from the left of that crop as your primary T_anchor.\n` : ''}
A. READ ALL VISIBLE X-AXIS TIME LABELS
   Scan the entire bottom edge of the chart and note every time label printed there (e.g. 08:00, 08:15, 08:30, 09:00, 09:30, 10:00, etc.).
   Each label is printed directly below the candle whose open time it represents — that candle is the reference candle for that label.

B. PICK THE CLOSEST ANCHOR LABEL
   Choose the x-axis time label whose candle sits closest to the left edge of the P&L box (the entry candle). Call this:
     T_anchor = the time shown on that label (e.g. 09:30)
     C_anchor = the horizontal position of that anchor candle on the chart

C. COUNT CANDLES FROM ANCHOR TO ENTRY
   The entry candle is the first candle whose center x-position is at or inside the left edge of the P&L box.
   Count the number of candles between C_anchor and the entry candle, moving left or right:
     N_entry = number of candles from C_anchor to the entry candle
               (positive = entry is to the RIGHT of anchor, negative = to the LEFT)
   Compute: entry_time = T_anchor + (N_entry × timeframe_minutes), expressed as HH:MM in 24-hour ET.
   Example: T_anchor=09:30, N_entry=3, timeframe=1min → entry_time = 09:33

D. COUNT CANDLES FROM ANCHOR TO EXIT
   The exit candle is the one identified in Step 4 (first candle to touch SL or TP). If exit_reason is null, use the last candle inside the right edge of the P&L box.
   Count: N_exit = number of candles from C_anchor to the exit candle
   Compute: close_time = T_anchor + (N_exit × timeframe_minutes), expressed as HH:MM in 24-hour ET.

E. CROSS-CHECK WITH A SECOND ANCHOR (when possible)
   If there is a second visible x-axis time label on the other side of the trade, verify your candle count produces the correct time from that anchor too. If the two anchors disagree, prefer the one whose candle is physically closer to the entry.

F. COMPUTE DURATION
   trade_length_seconds measures from the ENTRY candle to the candle where price FIRST touches TP or SL (the Step-4 exit candle). It is NOT the width of the P&L box and NOT the distance to the box's right edge.
   If an exit was found in Step 4: trade_length_seconds = first_touch_candle_index × timeframe_minutes × 60. Your close_time MUST equal entry_time + trade_length_seconds. If your Step-D anchor count (N_exit − N_entry) disagrees with first_touch_candle_index, TRUST first_touch_candle_index — it comes from the direct candle-by-candle exit scan — and recompute close_time from it.
   If no exit was found (exit_reason null): trade_length_seconds = (N_exit − N_entry) × timeframe_minutes × 60 using the last candle inside the P&L box.

IMPORTANT: If the entire P&L box sits exactly at one x-axis label and there are zero candles between the anchor and the entry, entry_time = T_anchor exactly. Only in that case is it valid to return the anchor time directly.

Return ONLY this raw JSON with no markdown, no explanation, no code fences:
{
  "symbol": string or null,
  "direction": "Long" or "Short" or null,
  "entry_price": number or null,
  "sl_price": number or null,
  "tp_price": number or null,
  "exit_reason": "TP" or "SL" or null,
  "trade_length_seconds": number or null,
  "timeframe_minutes": number or null,
  "entry_time": string or null,
  "close_time": string or null,
  "confidence": "high" or "medium" or "low",
  "first_touch_candle_index": integer or null,
  "evidence": string describing exactly what you saw for the exit decision,
  "warnings": array of strings for anything you were uncertain about
}`;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    const { text } = await generateWithFallback(genAI, systemPrompt, mimeType, base64Image, focusImages);
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      const entryTime = parseTimeToken(parsed.entry_time);
      const explicitCloseTime = parseTimeToken(parsed.close_time);
      const durationSecondsRaw = parseNullableNumber(parsed.trade_length_seconds);
      const durationSeconds = durationSecondsRaw !== null ? Math.max(0, Math.round(durationSecondsRaw)) : null;
      const timeframeMinutesRaw = parseNullableNumber(parsed.timeframe_minutes);
      const timeframeMinutes = timeframeMinutesRaw !== null ? Math.max(0, Math.round(timeframeMinutesRaw)) : null;
      const firstTouchIndexRaw = parseNullableNumber(parsed.first_touch_candle_index);
      const firstTouchCandleIndex = firstTouchIndexRaw !== null ? Math.max(0, Math.round(firstTouchIndexRaw)) : null;

      const modelDirection = parseDirection(parsed.direction);
      const direction = directionHint ?? modelDirection;
      const entryPrice = parseNullableNumber(parsed.entry_price);
      const parsedConfidence = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low' as const;
      const baseWarnings: string[] = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : [];
      if (directionHint && modelDirection && modelDirection !== directionHint) {
        baseWarnings.push(`Direction corrected from ${modelDirection} to ${directionHint} using compact position-tool geometry.`);
      }

      // Price sanity: auto-swap TP/SL if they look reversed for the detected direction
      const { sl_price, tp_price, warnings: sanityWarnings } = sanitizePriceLevels(
        direction,
        entryPrice,
        parseNullableNumber(parsed.sl_price),
        parseNullableNumber(parsed.tp_price),
        baseWarnings,
      );

      // Confidence gating: a low-confidence exit could flip Win/Loss — clear it so user confirms manually
      let exitReason = parseExitReason(parsed.exit_reason);
      const finalWarnings = [...sanityWarnings];
      if (parsedConfidence === 'low' && exitReason !== null) {
        finalWarnings.push('Exit outcome cleared (low confidence) — please verify Win/Loss manually.');
        exitReason = null;
      }

      // Trade length must measure entry → first touch of TP/SL. Gemini's Step-5
      // anchor recount can disagree with its own Step-4 first-touch scan, so when
      // both the exit candle index and timeframe are known, derive the duration
      // from them instead of trusting the model's arithmetic.
      let finalDurationSeconds = durationSeconds;
      let finalCloseTime = explicitCloseTime;
      if (exitReason !== null && firstTouchCandleIndex !== null && timeframeMinutes !== null && timeframeMinutes > 0) {
        const derivedSeconds = firstTouchCandleIndex * timeframeMinutes * 60;
        if (durationSeconds !== null && Math.abs(derivedSeconds - durationSeconds) >= timeframeMinutes * 60) {
          finalWarnings.push(`Trade length corrected from ${Math.round(durationSeconds / 60)}m to ${Math.round(derivedSeconds / 60)}m to match the first-touch exit candle.`);
        }
        finalDurationSeconds = derivedSeconds;
        // The reported close_time came from the same recount — recompute from entry + duration.
        finalCloseTime = addSecondsToHHMM(entryTime, derivedSeconds) ?? explicitCloseTime;
      }

      return {
        symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
        direction,
        entry_price: entryPrice,
        sl_price,
        tp_price,
        exit_reason: exitReason,
        trade_length_seconds: finalDurationSeconds,
        timeframe_minutes: timeframeMinutes,
        entry_time: entryTime,
        close_time: finalCloseTime ?? addSecondsToHHMM(entryTime, finalDurationSeconds),
        confidence: parsedConfidence,
        first_touch_candle_index: exitReason ? firstTouchCandleIndex : null,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
        warnings: finalWarnings,
      };
    } catch {
      return nullResult(['Failed to parse Gemini response']);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gemini API error';
    return nullResult([msg]);
  }
}
*/

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
    const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages);
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

CONSERVATIVE STANDARD: Only return touched=true when you are highly confident the wick unambiguously reaches or exceeds ${price}. If the wick looks close but you are uncertain whether it reaches exactly ${price}, return touched=false. False negatives (missing a touch) are far less damaging than false positives (calling a touch that did not happen).
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
    const { text } = await generateWithFallback(genAI, prompt, mimeType, base64Image, focusImages);
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
  const scannerDebug = scannerContext ? {
    direction_hint: directionHint,
    entry_line_ratio: lineHints.entryLineRatio,
    stop_line_ratio: lineHints.stopLineRatio,
    target_line_ratio: lineHints.targetLineRatio,
    box_left_ratio: boxLeftRatio ?? undefined,
    box_right_ratio: boxRightRatio ?? undefined,
    used_dynamic_crops: boxBounds !== undefined && hasLineHints,
  } : undefined;

  const result = await readTradeChart(
    base64Image,
    mimeType,
    focusImages,
    userColors,
    boxBounds,
    directionHint,
    hasLineHints ? lineHints : undefined,
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
      detectBoundaryTouch(base64Image, mimeType, focusImages, tradeForVerification, 'SL', boxBounds),
      detectBoundaryTouch(base64Image, mimeType, focusImages, tradeForVerification, 'TP', boxBounds),
      verifyTradeExit(base64Image, mimeType, focusImages, tradeForVerification, boxBounds),
    ]);

    // A boundary counts as a confirmed touch only when the conservative scan is NOT
    // low-confidence. A shaky "the wick looked close to the zone edge" read must never
    // flip Win/Loss on its own — a wick that merely enters the colored zone without
    // clearly crossing the outer price line is exactly what produces phantom TP/SL hits.
    const stopConfirmed = stopTouch.touched && stopTouch.first_touch_candle_index !== null && stopTouch.confidence !== 'low';
    const targetConfirmed = targetTouch.touched && targetTouch.first_touch_candle_index !== null && targetTouch.confidence !== 'low';
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
      verificationWarnings.push(
        `SL and TP were both detected on candle ${stopIndex}; intrabar order cannot be determined from the screenshot.`
      );
    }

    // Cross-check the boundary verdict against an independent first-touch pass. The two
    // methods must not contradict; when they name different outcomes the read is untrustworthy,
    // so drop to unconfirmed rather than risk a phantom Win/Loss. An uncorroborated verdict is
    // accepted only when the boundary scan is high-confidence — a lone medium-confidence touch
    // with no second opinion is flagged for manual review instead of auto-scored.
    const contradicted = independentExit.exit_reason !== null && independentExit.exit_reason !== boundaryExit;
    const corroborated = independentExit.exit_reason === boundaryExit;

    if (boundaryExit && contradicted) {
      verificationWarnings.push(
        `Exit unconfirmed: boundary scan reads ${boundaryExit} but the independent verifier reads ${independentExit.exit_reason}. Verify Win/Loss manually.`
      );
    } else if (boundaryExit && (corroborated || boundaryConfidence === 'high')) {
      verifiedExitReason = boundaryExit;
      verifiedFirstTouchIndex = boundaryIndex;
      verifiedConfidence = boundaryConfidence;
      verifiedEvidence = boundaryEvidence;
    } else if (boundaryExit) {
      verificationWarnings.push(
        `Exit unconfirmed: boundary scan reads ${boundaryExit} at medium confidence with no independent corroboration. Verify Win/Loss manually.`
      );
    }

    verificationWarnings.push(
      `Boundary scan: SL=${stopTouch.touched ? `candle ${stopTouch.first_touch_candle_index} (${stopTouch.confidence})` : 'not touched'}, `
      + `TP=${targetTouch.touched ? `candle ${targetTouch.first_touch_candle_index} (${targetTouch.confidence})` : 'not touched'}; `
      + `independent verifier=${independentExit.exit_reason ?? 'null'}.`
    );

    if (!verifiedExitReason) {
      verificationWarnings.push(
        'Exit remains unconfirmed because no agreed, high-confidence first-touch was established.'
      );
    }
  }

  const verifiedDurationSeconds = verifiedExitReason !== null
    && verifiedFirstTouchIndex !== null
    && result.timeframe_minutes !== null
    && result.timeframe_minutes > 0
      ? verifiedFirstTouchIndex * result.timeframe_minutes * 60
      : null;
  const verifiedCloseTime = addSecondsToHHMM(result.entry_time ?? entryTime ?? null, verifiedDurationSeconds);

  return {
    symbol: result.symbol,
    direction: result.direction,
    entry_price: result.entry_price,
    entry_time: result.entry_time ?? entryTime ?? null,
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
