import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ExtractedTradeData } from '../types/index';

const GEMINI_MODEL_FALLBACK_CHAIN = ['gemini-2.5-pro', 'gemini-2.5-flash'];
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
  }
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

Step 1. Look at the right-hand price axis of the chart. You will see small rectangular pill-shaped labels, each with a colored background and a price number printed inside.
IMPORTANT: The ENTRY label should match the user's configured Entry zone color when they have changed it. Use grey only as a fallback for default TradingView position-tool labels. Never use a black/white horizontal-line label as entry when a colored or grey entry pill is visible.
If an attached crop is labelled price-label-focus, use it to read all visible right-axis labels. If an attached crop is labelled entry-color-label-focus, use it to resolve the entry label only.

Step 2. The user has set these three zone colors in their settings:
  • Entry zone color   = ${entryName} (${userColors.entry})
  • Stop Loss color    = ${slName} (${userColors.stopLoss})
  • Take Profit color  = ${tpName} (${userColors.takeProfit})

Step 3. Find the right-axis labels attached to the TradingView position tool:
  • Pill with ${entryName} background  → that price number is entry_price
  • Grey pill/box at the entry boundary → entry_price ONLY if no ${entryName} entry pill is visible
  • Pill with ${slName} background     → that price number is sl_price
  • Pill with ${tpName} background     → that price number is tp_price

Step 4. IGNORE everything else on the chart completely:
  • Horizontal lines (black, white, or any color) drawn across the chart = key levels, NOT trade prices
  • Black or white right-axis labels attached to horizontal key levels = ignore for entry_price
  • The live floating price label on the far right (the highlight showing current price) = ignore
  • Any price label whose background color does NOT match the configured position-tool colors = ignore, except grey is allowed as an entry fallback
  • Do not use a nearby black horizontal-line label when a configured-color or grey entry pill exists. The entry pill is the source of truth.
`;
      })()
    : `
PRICE LEVEL IDENTIFICATION:
Look at the right-hand price axis. Find the three colored pill labels:
  • Grey background pill = entry_price
  • Red or pink background pill = sl_price
  • Teal or green background pill = tp_price
Ignore all horizontal lines across the chart and any other price labels. In particular, never use a black/white right-axis key-level label as entry_price when a grey entry pill is visible.
`;

  const systemPrompt = `You are a TradingView futures chart reader. Your ONLY job is to extract exact trade data from a P&L card screenshot.
You may receive the full chart plus labelled scanner crops. The crop labels are included as text immediately before each image.
Use price-label-focus as the primary OCR view for right-axis price labels. Use entry-color-label-focus as the primary OCR view for the entry pill. If entry-label-focus, stop-label-focus, or target-label-focus show black/white horizontal-line labels, treat them as crop hints only and ignore those black/white values as trade prices.

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
- If take profit price > entry price → LONG
- If take profit price < entry price → SHORT
Use the prices you found in Step 2 to determine this. Never guess direction from box position alone.

STEP 4 — FIND THE EXIT (FIRST TOUCH ONLY, WITHIN THE P&L BOX ONLY):
${boxBounds
  ? `CRITICAL BOUNDARY: The colored P&L overlay spans from approximately ${Math.round(boxBounds.leftRatio * 100)}% to ${Math.round(boxBounds.rightRatio * 100)}% of the image width from the left edge.
YOU MUST STOP SCANNING AT THE RIGHT EDGE OF THE COLORED BOX (${Math.round(boxBounds.rightRatio * 100)}% from the left).
Any candle positioned to the RIGHT of this boundary is outside the trade — completely ignore it even if price reaches SL or TP there.
If neither SL nor TP is touched within the P&L box boundary, set exit_reason to null.`
  : `Only scan candles that fall within the colored P&L overlay region. Do not read price action outside the box.`}

PRIMARY SIGNAL — P&L BOX BACKGROUND COLOR (CHECK THIS BEFORE SCANNING CANDLES):
Look at the dominant background tint of the entire P&L overlay box:
- Box is predominantly RED or PINK → the trade closed as a LOSS (SL was hit). Bias your candle scan toward finding the SL touch.
- Box is predominantly TEAL or GREEN → the trade closed as a WIN (TP was hit). Bias your candle scan toward finding the TP touch.
This box color is highly reliable. If your candle-by-candle analysis contradicts the box color, re-examine — you have likely made an error in the candle scan.

Starting from the entry candle (left edge of the P&L box), scan candles strictly left to right one by one.

IMPORTANT — HOW TO CHECK IF A LEVEL WAS HIT:
You must compare the actual pixel height of each candle wick against the pixel height of the SL/TP price line.
A level is only hit if a candle wick visually reaches or crosses that exact price line on the chart.
The colored price labels on the right axis are reference markers only — their presence does NOT mean price touched that level.
Do NOT assume a level was hit just because the label is visible. Only count it if a candle wick inside the box clearly touches or crosses the price line.
When in doubt about borderline cases (wick barely grazing the level), set exit_reason to null. However, if a candle clearly and unambiguously breaks through or beyond the outer boundary of the zone, record the SL/TP hit — do NOT apply doubt to obvious breaches.

CRITICAL — COLORED ZONES vs ACTUAL PRICE LINES:
The chart shows two filled colored zones that span from the entry price outward to the SL and TP levels.
A candle merely entering a colored zone does NOT mean that level was hit — the candle must reach the FAR OUTER EDGE of the zone.
- For SHORT trades: the SL line is the TOP boundary of the upper (red/pink) zone. The TP line is the BOTTOM boundary of the lower (teal/blue) zone. A candle that dips below entry and into the teal zone has NOT hit TP unless its LOW wick reaches all the way to the BOTTOM of that zone.
- For LONG trades: the SL line is the BOTTOM boundary of the lower (red/pink) zone. The TP line is the TOP boundary of the upper (teal/green) zone. A candle that rises above entry and into the teal zone has NOT hit TP unless its HIGH wick reaches all the way to the TOP of that zone.
IMPORTANT: If a candle wick extends BEYOND the outer boundary of a colored zone entirely — i.e., the wick tip is visually above the top of the red/pink zone for a SHORT trade, or below the bottom of the red/pink zone for a LONG trade — this is unambiguously an SL hit. A candle that breaks out past the colored zone is the clearest possible SL trigger. Do not treat this as a borderline case.
Use the exact price numbers from Step 2 to anchor where each boundary is on the price axis. Only confirm a hit when the wick clearly reaches the price label for that level.

CRITICAL MISTAKE TO AVOID — PARTIAL MOVE TOWARD TP BEFORE SL HIT:
A very common error is to see price partially move toward TP early in the trade (candles entering the TP zone) and conclude TP was hit — when in reality price reversed and later hit SL.
RULE: A candle entering the TP zone does NOT count as a TP hit. The wick must reach the FAR OUTER PRICE LINE (the actual TP label price). If the candle turns back before reaching that line, TP was NOT hit. Keep scanning — the SL hit may come later.
Examples:
- SHORT trade: a candle's LOW dips into the lower teal zone but does NOT reach the BOTTOM edge (tp_price) — this is NOT a TP hit. If a subsequent candle's HIGH reaches the TOP edge (sl_price), that is the SL hit.
- LONG trade: a candle's HIGH enters the upper teal zone but does NOT reach the TOP edge (tp_price) — this is NOT a TP hit. If a subsequent candle's LOW reaches the BOTTOM edge (sl_price), that is the SL hit.

For LONG trades:
- SL hit: a candle LOW wick visibly touches or goes below the sl_price line (BOTTOM of lower zone)
- TP hit: a candle HIGH wick visibly touches or exceeds the tp_price line (TOP of upper zone)

For SHORT trades:
- SL hit: a candle HIGH wick visibly touches or exceeds the sl_price line (TOP of upper zone)
- TP hit: a candle LOW wick visibly touches or goes below the tp_price line (BOTTOM of lower zone)

THE MOMENT either level is clearly touched within the box boundary, stop scanning immediately.
Record exit_reason as 'TP' or 'SL'.
IGNORE everything that happens after the first touch or after the right edge of the P&L box.
NEVER use the live floating price label (the highlighted current price box on the right axis that shows where price is right now) as any trade level.

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
      return {
        symbol: typeof parsed.symbol === 'string' ? parsed.symbol : null,
        direction: parseDirection(parsed.direction),
        entry_price: parseNullableNumber(parsed.entry_price),
        sl_price: parseNullableNumber(parsed.sl_price),
        tp_price: parseNullableNumber(parsed.tp_price),
        exit_reason: parseExitReason(parsed.exit_reason),
        trade_length_seconds: durationSeconds,
        timeframe_minutes: timeframeMinutes,
        entry_time: entryTime,
        close_time: explicitCloseTime ?? addSecondsToHHMM(entryTime, durationSeconds),
        confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : null,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w: unknown) => typeof w === 'string') : [],
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
  entryDate: string,
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

  const result = await readTradeChart(base64Image, mimeType, focusImages, userColors, boxBounds);

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
