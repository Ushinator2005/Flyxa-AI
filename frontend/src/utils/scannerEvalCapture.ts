/**
 * Dev-only eval capture for the trade scanner.
 *
 * Enable in the browser console:
 *   localStorage.setItem('flyxa-eval-capture', '1')
 *
 * While enabled, every scan downloads a self-contained bundle.json (chart,
 * crops, context, result, and a pre-filled `expected` template). Drop it into
 * scanner-evals/cases/<name>/bundle.json, correct any wrong fields in
 * `expected`, and it becomes a regression case for `npm run evals`.
 */

const CAPTURE_FLAG = 'flyxa-eval-capture'

function captureEnabled(): boolean {
  try {
    return localStorage.getItem(CAPTURE_FLAG) === '1'
  } catch {
    return false
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function downloadJson(payload: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

// Crop files are named `${cropName}-${originalFileName}` — recover the crop name.
function cropLabel(fileName: string): string {
  const marker = fileName.indexOf('-focus')
  return marker === -1 ? fileName : fileName.slice(0, marker + '-focus'.length)
}

interface ScanResultShape {
  symbol?: string | null
  direction?: string | null
  entry_price?: number | null
  sl_price?: number | null
  tp_price?: number | null
  exit_reason?: string | null
  entry_time?: string | null
  timeframe_minutes?: number | null
  close_time?: string | null
  trade_length_seconds?: number | null
}

export async function maybeCaptureScanBundle(args: {
  uploadImage: File
  focusImages: File[]
  scannerContext: Record<string, unknown>
  result?: ScanResultShape
  error?: string
  sourceFileName: string
}): Promise<void> {
  if (!captureEnabled()) return
  try {
    const { uploadImage, focusImages, scannerContext, result, error, sourceFileName } = args
    const bundle = {
      version: 1,
      captured_at: new Date().toISOString(),
      source_file: sourceFileName,
      chart: { base64: await fileToBase64(uploadImage), mimeType: uploadImage.type || 'image/webp' },
      crops: await Promise.all(focusImages.map(async file => ({
        label: cropLabel(file.name),
        base64: await fileToBase64(file),
        mimeType: file.type || 'image/png',
      }))),
      context: scannerContext,
      result: result ?? null,
      error: error ?? null,
      // Pre-filled from the scan result — correct any wrong values by hand and
      // this becomes the case's ground truth.
      expected: result ? {
        symbol: result.symbol ?? undefined,
        direction: result.direction ?? undefined,
        entry_price: result.entry_price ?? undefined,
        sl_price: result.sl_price ?? undefined,
        tp_price: result.tp_price ?? undefined,
        exit_reason: result.exit_reason === undefined ? undefined : result.exit_reason,
        entry_time: result.entry_time ?? undefined,
        timeframe_minutes: result.timeframe_minutes ?? undefined,
        close_time: result.close_time ?? undefined,
        trade_length_minutes: typeof result.trade_length_seconds === 'number'
          ? Math.round(result.trade_length_seconds / 60)
          : undefined,
      } : {},
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    downloadJson(bundle, `scanner-eval-${result?.symbol ?? 'unknown'}-${stamp}.json`)
  } catch {
    // Capture must never break a scan.
  }
}

// One correction download per trade per session — corrections mid-typing would
// otherwise fire repeatedly.
const capturedCorrections = new Set<string>()

export function maybeCaptureCorrection(args: {
  tradeId: string
  symbol: string
  date: string
  screenshotUrl?: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}): void {
  if (!captureEnabled()) return
  if (capturedCorrections.has(args.tradeId)) return
  capturedCorrections.add(args.tradeId)
  try {
    downloadJson(
      {
        version: 1,
        kind: 'scanner-correction',
        captured_at: new Date().toISOString(),
        ...args,
      },
      `scanner-correction-${args.symbol}-${args.date}.json`,
    )
  } catch {
    // Never break the edit flow.
  }
}
