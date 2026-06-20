import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ExtractedTradeData } from '../types/index';

const GEMINI_MODEL_FALLBACK_CHAIN = ['gemini-2.5-flash', 'gemini-2.5-pro'];
const GEMINI_MAX_RETRIES_PER_MODEL = 4;
const GEMINI_BASE_RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('503') ||
    text.includes('service unavailable') ||
    text.includes('high demand') ||
    text.includes('overloaded') ||
    text.includes('deadline exceeded') ||
    text.includes('timed out') ||
    text.includes('timeout')
  );
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
    'Image 1 label: full_chart. Use it for overall chart structure, candles, ticker, timeframe, and exit path.',
    {
      inlineData: {
        mimeType,
        data: base64Image,
      },
    },
    ...selectedFocusImages.flatMap((image, index) => [
      `Image ${index + 2} label: ${image.label}. This is a scanner-generated crop. Crops labelled price-label-focus and entry-color-label-focus are more authoritative for price-axis labels than the full chart.`,
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
        const result = await model.generateContent(content);
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

        // Exponential backoff: 2s, 4s, 8s, 16s
        const delayMs = GEMINI_BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delayMs);
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
  let sl = sl_price;
  let tp = tp_price;

  if (direction === 'Long') {
    // Expected: TP > entry > SL
    if (tp < entry_price && sl > entry_price) {
      // TP and SL are clearly swapped — auto-correct
      [sl, tp] = [tp, sl];
      newWarnings.push('TP/SL were swapped for a Long trade — auto-corrected.');
    } else if (tp < entry_price || sl > entry_price) {
      newWarnings.push(`Price levels may be misread: Long trade but entry=${entry_price}, SL=${sl}, TP=${tp}.`);
    }
  } else {
    // Short — Expected: TP < entry < SL
    if (tp > entry_price && sl < entry_price) {
      // TP and SL are clearly swapped — auto-correct
      [sl, tp] = [tp, sl];
      newWarnings.push('TP/SL were swapped for a Short trade — auto-corrected.');
    } else if (tp > entry_price || sl < entry_price) {
      newWarnings.push(`Price levels may be misread: Short trade but entry=${entry_price}, SL=${sl}, TP=${tp}.`);
    }
  }

  return { sl_price: sl, tp_price: tp, warnings: newWarnings };
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
  evidence: string | null;
  warnings: string[];
}> {
  const colorSection = userColors
    ? (() => {
        const entryName = hexToColorName(userColors.entry);
        const slName    = hexToColorName(userColors.stopLoss);
        const tpName    = hexToColorName(userColors.takeProfit);
        return `
PRICE LEVEL IDENTIFICATION — FOLLOW THESE STEPS EXACTLY:

Step 1. Look at the right-hand price axis of the chart. You will see colored price labels — these may be rounded pills, sharp rectangles, or any other colored tag shape depending on the trading platform (TradingView standalone, TopstepX, Apex, FTMO, Tradovate, etc.). Shape does not matter — only the background color and the number inside matter.
IMPORTANT: The ENTRY label should match the user's configured Entry zone color when they have changed it. Use grey only as a fallback for default position-tool labels. Never use a black/white horizontal-line label as entry when a colored or grey entry label is visible.
If an attached crop is labelled price-label-focus, use it to read all visible right-axis labels. If an attached crop is labelled entry-color-label-focus, use it to resolve the entry label only.
FALLBACK — if no colored labels are visible on the right axis at all: trace each zone boundary (entry line, outer edge of pink zone, outer edge of teal zone) horizontally to the price axis gridlines and read the nearest grid price.

Step 2. The user has set these three zone colors in their settings:
  • Entry zone color   = ${entryName} (${userColors.entry})
  • Stop Loss color    = ${slName} (${userColors.stopLoss})
  • Take Profit color  = ${tpName} (${userColors.takeProfit})

Step 3. Find the right-axis price labels attached to the position tool:
  • Label with ${entryName} background  → that price number is entry_price
  • Grey label at the entry boundary    → entry_price ONLY if no ${entryName} entry label is visible
  • Label with ${slName} background     → that price number is sl_price
  • Label with ${tpName} background     → that price number is tp_price

Step 4. IGNORE everything else on the chart completely:
  • Horizontal lines (black, white, or any color) drawn across the chart = key levels, NOT trade prices
  • Black or white right-axis labels attached to horizontal key levels = ignore for entry_price
  • The live floating price label on the far right (the highlight showing current price) = ignore
  • Any price label whose background color does NOT match the configured position-tool colors = ignore, except grey is allowed as an entry fallback
  • Do not use a nearby black horizontal-line label when a configured-color or grey entry label exists. The entry label is the source of truth.
`;
      })()
    : `
PRICE LEVEL IDENTIFICATION:
Look at the right-hand price axis. Find the three colored price labels (any shape — pill, rectangle, tag):
  • Grey background label = entry_price
  • Red or pink background label = sl_price
  • Teal or green background label = tp_price
Ignore all horizontal lines across the chart and any other price labels. In particular, never use a black/white right-axis key-level label as entry_price when a grey entry label is visible.
FALLBACK — if no colored labels are visible: trace each zone boundary to the price axis gridlines and read the nearest grid price.
`;

  const systemPrompt = `You are a professional futures chart reader. Your ONLY job is to extract exact trade data from a P&L card screenshot — the chart may come from TradingView, TopstepX, Apex Trader, FTMO, Tradovate, or any other platform.
You may receive the full chart plus labelled scanner crops. The crop labels are included as text immediately before each image.
Use price-label-focus as the primary OCR view for right-axis price labels. Use entry-color-label-focus as the primary OCR view for the entry price label. If entry-label-focus, stop-label-focus, or target-label-focus show black/white horizontal-line labels, treat them as crop hints only and ignore those black/white values as trade prices.

STEP 1 — READ THE TICKER:
Look at the top-left corner of the chart for the instrument header.
Read the ticker symbol. Examples:
- 'NQM26 · 1 · CME' → symbol is NQ, timeframe_minutes is 1
- 'MNQM26 · 1' → symbol is MNQ, timeframe_minutes is 1
- 'ESM26 · 5' → symbol is ES, timeframe_minutes is 5
Always return the ROOT ticker only (NQ not NQM26, MNQ not MNQM26).
Valid roots: NQ, MNQ, ES, MES, YM, MYM, RTY, M2K, CL, MCL, GC, MGC, SI, 6E, 6B, BTC, MBT

STEP 2 — IDENTIFY entry_price, sl_price, tp_price:
${colorSection}

STEP 3 — DETERMINE DIRECTION:
${directionHint
  ? `Pixel-level color analysis of the chart has pre-determined the direction as ${directionHint}. Return direction = "${directionHint}".
Consistency check (${directionHint === 'Long' ? 'Long: TP > entry > SL' : 'Short: TP < entry < SL'}): if your prices conflict with this, re-examine the price labels first. Keep direction = "${directionHint}" regardless, but add a warning if prices still look inconsistent.`
  : `- If take profit price > entry price → LONG
- If take profit price < entry price → SHORT
Use the prices you found in Step 2 to determine this. Never guess direction from box position alone.`}

STEP 4 — FIND THE EXIT (FIRST TOUCH ONLY, INSIDE THE P&L CARD ONLY):
The P&L card is the colored overlay on the chart — the region covered by the red/pink zone and the teal zone together. You must ONLY read candles whose bodies and wicks fall physically inside this colored overlay. Nothing outside it exists for this analysis.
${boxBounds
  ? `The P&L card occupies image columns ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% from the left edge.
The FIRST candle inside the card (at the ${Math.round(boxBounds.leftRatio * 100)}% left edge) is the entry candle — start here.
HARD RULE: Any candle whose center x-position is to the LEFT of ${Math.round(boxBounds.leftRatio * 100)}% does not exist. Do not look at it. Do not count it. Even if a large wick from a pre-trade candle visually extends into the price range of SL or TP, that candle is outside the P&L card and must be completely disregarded.
HARD RULE: Any candle whose center x-position is to the RIGHT of ${Math.round(boxBounds.rightRatio * 100)}% does not exist. Do not look at it.
Scan only the candles physically inside the card, left to right, starting from the entry candle.
If neither SL nor TP is touched by any candle inside the card, set exit_reason to null.`
  : `Scan only candles physically inside the colored P&L overlay. Ignore all candles to the left (pre-trade) and right (post-trade) of the overlay — treat them as if they are not on the chart.`}

DO NOT USE ANY COLOR OR SIZE BIAS — CANDLE WICKS ARE THE ONLY EVIDENCE.
Do NOT use the background color of the teal zone, the red/pink zone, or any P&L label to decide the outcome.
Those zone colors are fixed regardless of what happened. A large teal zone just means TP was far away — it says nothing about whether TP was hit.
Do NOT use the size of either zone as a signal. Ignore all color cues. The answer comes only from candle wicks inside the P&L card.

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

FIRST TOUCH RULE: The first candle (leftmost) that triggers either level decides the result. Stop scanning immediately at that candle.
If price partially moves toward TP then reverses and hits SL — the result is SL, regardless of how far into the TP zone it went.
NEVER stop scanning early just because price moved deep into one zone. You must check whether it actually reached the outer boundary.

When in doubt on a borderline wick (barely grazing the line), set exit_reason to null.
If a wick clearly breaks THROUGH the zone boundary (extends past the outer edge entirely), that is an unambiguous hit.
NEVER use the live floating current-price label on the right axis as a trade level.

STEP 5 — ESTIMATE DURATION:
entry_time: Read the x-axis time label at the LEFT EDGE of the colored P&L box (where the box starts). This is when the trade was entered.
close_time: Read the x-axis time label at the candle where price first crossed SL or TP (from Step 4). If exit_reason is null, use the right edge of the P&L box.
trade_length_seconds: Count candles from the left edge of the box to the exit candle, then multiply by timeframe_minutes × 60.

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

      const direction = parseDirection(parsed.direction);
      const entryPrice = parseNullableNumber(parsed.entry_price);
      const parsedConfidence = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low' as const;
      const baseWarnings: string[] = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : [];

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

      return {
        symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
        direction,
        entry_price: entryPrice,
        sl_price,
        tp_price,
        exit_reason: exitReason,
        trade_length_seconds: durationSeconds,
        timeframe_minutes: timeframeMinutes,
        entry_time: entryTime,
        close_time: explicitCloseTime ?? addSecondsToHHMM(entryTime, durationSeconds),
        confidence: parsedConfidence,
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

  const result = await readTradeChart(base64Image, mimeType, focusImages, userColors, boxBounds, directionHint);

  return {
    symbol: result.symbol,
    direction: result.direction,
    entry_price: result.entry_price,
    entry_time: result.entry_time ?? entryTime ?? null,
    close_time: result.close_time,
    entry_time_confidence: result.confidence,
    sl_price: result.sl_price,
    tp_price: result.tp_price,
    trade_length_seconds: result.trade_length_seconds,
    candle_count: null,
    timeframe_minutes: result.timeframe_minutes,
    exit_reason: result.exit_reason,
    pnl_result: result.exit_reason === 'TP' ? 'Win' : result.exit_reason === 'SL' ? 'Loss' : null,
    exit_confidence: result.confidence,
    first_touch_candle_index: null,
    first_touch_evidence: result.evidence,
    warnings: result.warnings ?? [],
  };
}
