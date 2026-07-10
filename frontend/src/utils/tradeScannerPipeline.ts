interface CropPreset {
  name: string
  x: number
  y: number
  width: number
  height: number
}

interface ComponentBounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  count: number
}

export interface ScannerContext {
  direction_hint?: 'Long' | 'Short'
  chart_left_ratio?: number
  chart_right_ratio?: number
  box_left_ratio?: number
  box_right_ratio?: number
  entry_line_ratio?: number
  stop_line_ratio?: number
  target_line_ratio?: number
  red_box?: Omit<ComponentBounds, 'count'>
  green_box?: Omit<ComponentBounds, 'count'>
  time_axis_entry_x_ratio?: number  // where the entry candle sits within the time-axis-focus crop (0–1)
  label_anchored?: boolean          // line ratios came from right-axis label pills, not zone fills
}

const SYMBOL_MAP: Record<string, string> = {
  NQM26: 'NQ',
  NQH26: 'NQ',
  NQU26: 'NQ',
  NQZ26: 'NQ',
  ESM26: 'ES',
  ESH26: 'ES',
  ESU26: 'ES',
  ESZ26: 'ES',
  MNQM26: 'MNQ',
  MNQH26: 'MNQ',
  MNQU26: 'MNQ',
  MNQZ26: 'MNQ',
  MESM26: 'MES',
  MESH26: 'MES',
  MESU26: 'MES',
  MESZ26: 'MES',
}

// Fallback crops used when pixel detection fails. Deliberately EXCLUDES the
// dedicated label strips (entry/stop/target-label-focus): without detected
// geometry their positions would be arbitrary, and the backend prompt treats
// those crop names as boundary-centered — shipping mispositioned ones makes
// Gemini trust the wrong labels.
const DEFAULT_FOCUS_CROPS: CropPreset[] = [
  { name: 'header-focus', x: 0, y: 0, width: 0.34, height: 0.12 },
  { name: 'trade-box-focus', x: 0.46, y: 0.1, width: 0.3, height: 0.72 },
  { name: 'exit-path-focus', x: 0.46, y: 0.16, width: 0.24, height: 0.62 },
  { name: 'price-label-focus', x: 0.78, y: 0, width: 0.22, height: 1 },
  // wide strip of the x-axis bottom — entry position unknown in fallback mode
  { name: 'time-axis-focus', x: 0.08, y: 0.88, width: 0.72, height: 0.12 },
]

const DEFAULT_SCANNER_COLORS = {
  entry: '#E67E22',
  stopLoss: '#C0392B',
  takeProfit: '#1A6B5A',
}

function resolveSymbol(raw: string): string {
  return SYMBOL_MAP[raw.toUpperCase()] ?? raw.toUpperCase()
}

export function normalizeResolvedSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null
  const normalized = resolveSymbol(raw.trim())
  return ['UNKNOWN', 'UNKWN', 'N/A', 'NA', 'NONE', 'NULL'].includes(normalized) ? null : normalized
}

export function inferSymbolFromFileName(fileName: string): string | null {
  const upper = fileName.toUpperCase()
  const match = upper.match(/(?:^|[^A-Z0-9])(MNQ|MES|NQ|ES|MYM|YM|M2K|RTY|CL|MCL|GC|SI|6E)(?=[^A-Z0-9]|$)/)
  return match ? match[1] : null
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function formatDateParts(year: number, month: number, day: number): string | null {
  if (!isValidDateParts(year, month, day)) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function inferTradeDateFromFileName(fileName: string): string | null {
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const yearFirst = baseName.match(/(?:^|[^0-9])((?:20)\d{2})[-_. ]?([01]?\d)[-_. ]?([0-3]?\d)(?=[^0-9]|$)/)
  if (yearFirst) {
    const parsed = formatDateParts(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]))
    if (parsed) return parsed
  }

  const dayOrMonthFirst = baseName.match(/(?:^|[^0-9])([0-3]?\d)[-_. ]([0-3]?\d)[-_. ]((?:20)\d{2})(?=[^0-9]|$)/)
  if (dayOrMonthFirst) {
    const first = Number(dayOrMonthFirst[1])
    const second = Number(dayOrMonthFirst[2])
    const year = Number(dayOrMonthFirst[3])
    const dayFirst = formatDateParts(year, second, first)
    if (dayFirst) return dayFirst
    return formatDateParts(year, first, second)
  }

  return null
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load chart image for scanner crops'))
    }
    image.src = objectUrl
  })
}

function canvasToFile(canvas: HTMLCanvasElement, fileName: string, sourceType: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to create scanner crop'))
        return
      }
      resolve(new File([blob], fileName, { type: sourceType || 'image/png' }))
    }, sourceType || 'image/png', 0.95)
  })
}

async function buildUploadImage(image: HTMLImageElement, fileName: string): Promise<File> {
  const maxWidth = 1800
  const scale = Math.min(1, maxWidth / Math.max(1, image.naturalWidth || image.width))
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Failed to prepare scanner upload image')
  context.drawImage(image, 0, 0, width, height)

  return canvasToFile(canvas, `${fileName.replace(/\.[^.]+$/, '')}.webp`, 'image/webp')
}

function clampRatio(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function isGreenOverlay(r: number, g: number, b: number): boolean {
  return g > r + 6 && b > r + 2 && g > 140 && b > 140
}

function isRedOverlay(r: number, g: number, b: number): boolean {
  return r > g + 12 && r > b + 6 && r > 150
}

function hexToRgbParts(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace('#', '')
  if (cleaned.length !== 6) return null
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  }
}

// Build a pixel matcher from a configured zone hex color.
// TradingView zone fills are semi-transparent so rendered pixels are darker
// than the raw color — we check channel *dominance* rather than brightness.
function makeZoneMatcher(
  hex: string,
  fallback: (r: number, g: number, b: number) => boolean,
): (r: number, g: number, b: number) => boolean {
  const ref = hexToRgbParts(hex)
  if (!ref) return fallback
  const { r: cr, g: cg, b: cb } = ref
  const maxCh = Math.max(cr, cg, cb)

  if (maxCh === cr && cr > cg + 20 && cr > cb + 20) {
    // Red-dominant (e.g. #C0392B, #E74C3C)
    return (pr, pg, pb) => pr > pg + 8 && pr > pb + 5 && pr > 60
  }
  if (cr > cg + 20 && cg > cb + 20) {
    // Orange (r > g > b, e.g. #E67E22)
    return (pr, pg, pb) => pr > pb + 30 && pr > pg - 20 && pr > 80
  }
  if (maxCh === cg && cg > cr + 10) {
    // Green-dominant (e.g. #27AE60, #2ECC71)
    return (pr, pg, _pb) => pg > pr + 6 && pg > 70
  }
  if (maxCh === cb && cb > cr + 10) {
    // Blue-dominant
    return (pr, pg, pb) => pb > pr + 6 && pb > pg - 20 && pb > 70
  }
  if (cg > cr - 20 && cb > cr - 20 && cg > 60 && cb > 60 && cr < 80) {
    // Teal/cyan (e.g. #1A6B5A — low R, similar G+B)
    return (pr, pg, pb) => pg > pr + 15 && pb > pr + 10 && pg > 50
  }
  if (cr > cg + 10 && cb > cg + 10) {
    // Purple/magenta (r ≈ b, both above g, e.g. #8E44AD, #FF00FF)
    return (pr, pg, pb) => pr > pg + 8 && pb > pg + 8 && Math.max(pr, pb) > 60
  }
  if (cr > cb + 10 && cg > cb + 10) {
    // Yellow (r ≈ g, both above b, e.g. #F1C40F, #FFD700)
    return (pr, pg, pb) => pr > pb + 10 && pg > pb + 10 && Math.min(pr, pg) > 70
  }
  // Neutral/grey — low saturation
  const sat = Math.max(cr, cg, cb) - Math.min(cr, cg, cb)
  if (sat < 35) {
    return (pr, pg, pb) => {
      const mx = Math.max(pr, pg, pb)
      const mn = Math.min(pr, pg, pb)
      return (mx - mn) < 30 && mx > 65 && mx < 215
    }
  }
  // Generic fallback: match pixels where the same channel that dominates the
  // configured hex also dominates in the rendered pixel — covers any remaining
  // color that didn't fit the named branches above.
  if (cr >= cg && cr >= cb) return (pr, pg, pb) => pr > pg && pr > pb && pr > 55
  if (cg >= cr && cg >= cb) return (pr, pg, pb) => pg > pr && pg > pb && pg > 55
  return (pr, pg, pb) => pb > pr && pb > pg && pb > 55
}

// Strict matcher for right-axis label pills. Unlike zone fills (semi-transparent,
// blended with whatever sits behind them), label pills render at full opacity in
// the exact configured hex — a tight RGB distance is reliable here.
function makeLabelMatcher(hex: string): ((r: number, g: number, b: number) => boolean) | null {
  const ref = hexToRgbParts(hex)
  if (!ref) return null
  return (pr, pg, pb) =>
    Math.abs(pr - ref.r) < 55 && Math.abs(pg - ref.g) < 55 && Math.abs(pb - ref.b) < 55
}

interface LabelAnchors {
  entryY?: number
  stopY?: number
  tpY?: number
}

// Locate the position tool's three price pills on the right axis. This is the
// robust anchor: overlapping drawn zones corrupt zone-fill detection (they merge
// into one blob), but they cannot corrupt the solid pills in the axis column.
// When all three are found with a consistent ordering, their y-centers ARE the
// entry/SL/TP lines.
function detectAxisLabelAnchors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  colors: { entry: string; stopLoss: string; takeProfit: string },
): LabelAnchors {
  const bandStart = Math.floor(width * 0.865)
  const bandWidth = width - bandStart
  if (bandWidth < 6) return {}

  const findPill = (hex: string): number | undefined => {
    const match = makeLabelMatcher(hex)
    if (!match) return undefined
    const mask = new Uint8Array(width * height)
    const yStart = Math.round(height * 0.03)
    for (let y = yStart; y < height; y += 1) {
      for (let x = bandStart; x < width; x += 1) {
        const index = (y * width + x) * 4
        if (match(data[index], data[index + 1], data[index + 2])) mask[y * width + x] = 1
      }
    }
    // A pill is a short, wide, dense rectangle spanning most of the axis column.
    // Axis text and gridline ticks fail the width/density filters.
    const pill = findComponents(mask, width, height)
      .filter(component => {
        const pillHeight = componentHeight(component)
        const pillWidth = componentWidth(component)
        return pillHeight >= height * 0.008 && pillHeight <= height * 0.05
          && pillWidth >= bandWidth * 0.5
          && componentDensity(component) >= 0.45
      })
      .sort((a, b) => b.count - a.count)[0]
    return pill ? ((pill.yMin + pill.yMax) / 2) / height : undefined
  }

  return {
    entryY: findPill(colors.entry),
    stopY: findPill(colors.stopLoss),
    tpY: findPill(colors.takeProfit),
  }
}

// The trio is trustworthy only when entry sits strictly between stop and target.
function anchorsConsistent(anchors: LabelAnchors): anchors is Required<LabelAnchors> {
  const { entryY, stopY, tpY } = anchors
  if (typeof entryY !== 'number' || typeof stopY !== 'number' || typeof tpY !== 'number') return false
  return (stopY < entryY && entryY < tpY) || (tpY < entryY && entryY < stopY)
}

function findComponents(mask: Uint8Array, width: number, height: number): ComponentBounds[] {
  const visited = new Uint8Array(mask.length)
  const components: ComponentBounds[] = []
  const queue = new Int32Array(mask.length)

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue

    let head = 0
    let tail = 0
    visited[index] = 1
    queue[tail++] = index

    let count = 0
    let xMin = width
    let xMax = 0
    let yMin = height
    let yMax = 0

    while (head < tail) {
      const current = queue[head++]
      const x = current % width
      const y = Math.floor(current / width)

      count += 1
      xMin = Math.min(xMin, x)
      xMax = Math.max(xMax, x)
      yMin = Math.min(yMin, y)
      yMax = Math.max(yMax, y)

      const neighbors = [current - 1, current + 1, current - width, current + width]
      neighbors.forEach(next => {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) return
        const nextX = next % width
        if (Math.abs(nextX - x) > 1) return
        visited[next] = 1
        queue[tail++] = next
      })
    }

    components.push({ xMin, xMax, yMin, yMax, count })
  }

  return components
}

function componentWidth(component: ComponentBounds): number {
  return component.xMax - component.xMin + 1
}

function componentHeight(component: ComponentBounds): number {
  return component.yMax - component.yMin + 1
}

function componentDensity(component: ComponentBounds): number {
  const area = componentWidth(component) * componentHeight(component)
  return area > 0 ? component.count / area : 0
}

function horizontalOverlapRatio(a: ComponentBounds, b: ComponentBounds): number {
  const overlap = Math.max(0, Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin) + 1)
  return overlap / Math.max(1, Math.min(componentWidth(a), componentWidth(b)))
}

function verticalGap(a: ComponentBounds, b: ComponentBounds): number {
  if (a.yMax < b.yMin) return b.yMin - a.yMax
  if (b.yMax < a.yMin) return a.yMin - b.yMax
  return 0
}

function scoreZonePair(redBox: ComponentBounds, greenBox: ComponentBounds, width: number, height: number): number | null {
  const redWidth = componentWidth(redBox)
  const greenWidth = componentWidth(greenBox)
  const unionWidth = Math.max(redBox.xMax, greenBox.xMax) - Math.min(redBox.xMin, greenBox.xMin) + 1
  const unionWidthRatio = unionWidth / width
  const redWidthRatio = redWidth / width
  const greenWidthRatio = greenWidth / width

  // Position tools are compact paired boxes. Wide market-structure zones
  // (order blocks / demand zones) often span most of the chart and must not
  // be treated as TP/SL even when their fill color matches the scanner color.
  if (unionWidthRatio > 0.46 || redWidthRatio > 0.42 || greenWidthRatio > 0.42) return null
  if (redWidthRatio < 0.025 || greenWidthRatio < 0.025) return null

  const redHeightRatio = componentHeight(redBox) / height
  const greenHeightRatio = componentHeight(greenBox) / height
  if (redHeightRatio < 0.025 || greenHeightRatio < 0.025) return null

  const overlapRatio = horizontalOverlapRatio(redBox, greenBox)
  if (overlapRatio < 0.32) return null

  const gap = verticalGap(redBox, greenBox)
  if (gap > height * 0.09) return null

  const redDensity = componentDensity(redBox)
  const greenDensity = componentDensity(greenBox)
  const widthSimilarity = 1 - Math.min(1, Math.abs(redWidth - greenWidth) / Math.max(redWidth, greenWidth))
  const edgeSimilarity = 1 - Math.min(1, (
    Math.abs(redBox.xMin - greenBox.xMin) + Math.abs(redBox.xMax - greenBox.xMax)
  ) / Math.max(1, unionWidth * 1.4))
  const compactness = 1 - Math.min(1, Math.abs(unionWidthRatio - 0.13) / 0.33)
  const adjacency = 1 - Math.min(1, gap / Math.max(1, height * 0.09))

  return (
    overlapRatio * 3.5 +
    widthSimilarity * 1.8 +
    edgeSimilarity * 2.4 +
    adjacency * 1.4 +
    compactness +
    Math.min(redDensity, 0.65) +
    Math.min(greenDensity, 0.65)
  )
}

function findBestPositionToolPair(
  redMask: Uint8Array,
  greenMask: Uint8Array,
  width: number,
  height: number,
): { redBox: ComponentBounds; greenBox: ComponentBounds } | null {
  const redCandidates = findComponents(redMask, width, height)
    .filter(component => component.count >= 90 && hasSufficientFillDensity(component, 0.1))
  const greenCandidates = findComponents(greenMask, width, height)
    .filter(component => component.count >= 90 && hasSufficientFillDensity(component, 0.1))

  let best: { redBox: ComponentBounds; greenBox: ComponentBounds; score: number } | null = null

  for (const redBox of redCandidates) {
    for (const greenBox of greenCandidates) {
      const score = scoreZonePair(redBox, greenBox, width, height)
      if (score === null) continue
      if (!best || score > best.score) {
        best = { redBox, greenBox, score }
      }
    }
  }

  return best ? { redBox: best.redBox, greenBox: best.greenBox } : null
}

// Rejects components whose matching pixels are too sparse relative to their
// bounding box — this filters out clusters of candlestick bodies (low density)
// while accepting solid filled zone rectangles (high density).
function hasSufficientFillDensity(component: ComponentBounds, minDensity = 0.15): boolean {
  const area = (component.xMax - component.xMin + 1) * (component.yMax - component.yMin + 1)
  return area > 0 && component.count / area >= minDensity
}

function toRatioBounds(bounds: ComponentBounds, width: number, height: number): Omit<ComponentBounds, 'count'> {
  return {
    xMin: bounds.xMin / width,
    xMax: bounds.xMax / width,
    yMin: bounds.yMin / height,
    yMax: bounds.yMax / height,
  }
}

function inferChartPaneBounds(boxLeftRatio: number, boxRightRatio: number): { left: number; right: number } {
  if (boxRightRatio <= 0.48) return { left: 0, right: 0.5 }
  if (boxLeftRatio >= 0.52) return { left: 0.5, right: 1 }
  return { left: 0, right: 1 }
}

// Candles and wicks can cut the translucent position-tool fill into several
// disconnected color components. Recover the complete horizontal span from
// per-column color density instead of trusting the x-range of one component.
function detectOverlayHorizontalSpan(
  redMask: Uint8Array,
  greenMask: Uint8Array,
  width: number,
  _height: number,
  yMin: number,
  yMax: number,
  fallbackLeft: number,
  fallbackRight: number,
): { left: number; right: number } {
  const minPixels = Math.max(4, Math.round((yMax - yMin + 1) * 0.035))
  const strong = new Uint8Array(width)

  for (let x = 0; x < width; x += 1) {
    let count = 0
    for (let y = yMin; y <= yMax; y += 1) {
      const index = y * width + x
      if (redMask[index] || greenMask[index]) count += 1
    }
    if (count >= minPixels) strong[x] = 1
  }

  const runs: Array<{ left: number; right: number; strongColumns: number }> = []
  let runStart = -1
  let lastStrong = -1
  let strongColumns = 0
  const maxGap = Math.max(4, Math.round(width * 0.018))

  for (let x = 0; x < width; x += 1) {
    if (strong[x]) {
      if (runStart < 0) runStart = x
      lastStrong = x
      strongColumns += 1
    } else if (runStart >= 0 && x - lastStrong > maxGap) {
      runs.push({ left: runStart, right: lastStrong, strongColumns })
      runStart = -1
      lastStrong = -1
      strongColumns = 0
    }
  }
  if (runStart >= 0) runs.push({ left: runStart, right: lastStrong, strongColumns })

  const selected = runs
    .filter(run => run.right >= fallbackLeft - maxGap && run.left <= fallbackRight + maxGap)
    .sort((a, b) => {
      const aOverlap = Math.max(0, Math.min(a.right, fallbackRight) - Math.max(a.left, fallbackLeft))
      const bOverlap = Math.max(0, Math.min(b.right, fallbackRight) - Math.max(b.left, fallbackLeft))
      return bOverlap - aOverlap || b.strongColumns - a.strongColumns
    })[0]

  if (!selected) return { left: fallbackLeft, right: fallbackRight }
  return {
    left: Math.min(fallbackLeft, selected.left),
    right: Math.max(fallbackRight, selected.right),
  }
}

function detectTradeBoxContext(
  image: HTMLImageElement,
  stopHex?: string,
  tpHex?: string,
  entryHex?: string,
): ScannerContext | null {
  const targetWidth = Math.min(640, image.naturalWidth || image.width)
  const scale = targetWidth / (image.naturalWidth || image.width)
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  context.drawImage(image, 0, 0, width, height)
  const { data } = context.getImageData(0, 0, width, height)
  const redMask = new Uint8Array(width * height)
  const greenMask = new Uint8Array(width * height)

  const matchStop = stopHex
    ? makeZoneMatcher(stopHex, isRedOverlay)
    : isRedOverlay
  const matchTp = tpHex
    ? makeZoneMatcher(tpHex, isGreenOverlay)
    : isGreenOverlay

  // Skip the top 5 % of the image — chart headers (ticker, OHLCV row,
  // indicator values) often contain teal/green text that would otherwise
  // be mistaken for a TP zone, corrupting the direction hint and entry ratio.
  const yStart = Math.round(height * 0.05)
  for (let y = yStart; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x > width * 0.88) continue
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const pixelIndex = y * width + x

      if (matchStop(r, g, b)) redMask[pixelIndex] = 1
      if (matchTp(r, g, b)) greenMask[pixelIndex] = 1
    }
  }

  // Label pills first: they survive overlapping drawn zones that corrupt fills.
  const anchors = (stopHex && tpHex && entryHex)
    ? detectAxisLabelAnchors(data, width, height, { entry: entryHex, stopLoss: stopHex, takeProfit: tpHex })
    : {}
  const hasAnchorTrio = anchorsConsistent(anchors)

  const zonePair = findBestPositionToolPair(redMask, greenMask, width, height)
  if (!zonePair) {
    // No usable zone pair, but a consistent label trio still gives us direction
    // and all three price lines — enough for label crops and prompt hints.
    if (hasAnchorTrio) {
      return {
        direction_hint: anchors.stopY < anchors.entryY ? 'Short' : 'Long',
        chart_left_ratio: 0,
        chart_right_ratio: 1,
        entry_line_ratio: anchors.entryY,
        stop_line_ratio: anchors.stopY,
        target_line_ratio: anchors.tpY,
        label_anchored: true,
      }
    }
    return null
  }
  const { redBox, greenBox } = zonePair

  const fallbackLeft = Math.min(redBox.xMin, greenBox.xMin)
  const fallbackRight = Math.max(redBox.xMax, greenBox.xMax)
  const overlaySpan = detectOverlayHorizontalSpan(
    redMask,
    greenMask,
    width,
    height,
    Math.min(redBox.yMin, greenBox.yMin),
    Math.max(redBox.yMax, greenBox.yMax),
    fallbackLeft,
    fallbackRight,
  )
  const boxLeftRatio = overlaySpan.left / width
  const boxRightRatio = overlaySpan.right / width
  const chartPane = inferChartPaneBounds(boxLeftRatio, boxRightRatio)
  const redCenterY = (redBox.yMin + redBox.yMax) / 2
  const greenCenterY = (greenBox.yMin + greenBox.yMax) / 2
  let directionHint: 'Long' | 'Short' | undefined =
    redCenterY < greenCenterY ? 'Short' : greenCenterY < redCenterY ? 'Long' : undefined

  let entryLineRatio: number | undefined
  let stopLineRatio: number | undefined
  let targetLineRatio: number | undefined

  if (hasAnchorTrio) {
    // Label pills are the authoritative source for the three lines AND direction.
    // Zone fills stay in play only for the horizontal box span. This is the
    // structural fix for overlapping drawn zones: a supply zone merged into the
    // red fill can push the zone-derived stop line to the wrong level, but it
    // cannot move the solid red pill on the axis.
    directionHint = anchors.stopY < anchors.entryY ? 'Short' : 'Long'
    entryLineRatio = anchors.entryY
    stopLineRatio = anchors.stopY
    targetLineRatio = anchors.tpY
  } else if (directionHint === 'Long') {
    // Entry is the shared boundary between the compact TP and SL zones.
    // Do not use the largest neutral/entry-colored component: charts often
    // contain grey fib/range drawings that can sit inside the position tool and
    // create fake entry prices.
    entryLineRatio = ((greenBox.yMax + redBox.yMin) / 2) / height
    stopLineRatio = redBox.yMax / height
    targetLineRatio = greenBox.yMin / height
  } else if (directionHint === 'Short') {
    entryLineRatio = ((redBox.yMax + greenBox.yMin) / 2) / height
    stopLineRatio = redBox.yMin / height
    targetLineRatio = greenBox.yMax / height
  }
  return {
    direction_hint: directionHint,
    chart_left_ratio: chartPane.left,
    chart_right_ratio: chartPane.right,
    box_left_ratio: boxLeftRatio,
    box_right_ratio: boxRightRatio,
    entry_line_ratio: entryLineRatio,
    stop_line_ratio: stopLineRatio,
    target_line_ratio: targetLineRatio,
    red_box: toRatioBounds(redBox, width, height),
    green_box: toRatioBounds(greenBox, width, height),
    label_anchored: hasAnchorTrio || undefined,
  }
}

function buildDynamicFocusCrops(scannerContext: ScannerContext | null): CropPreset[] {
  // typeof checks: a box starting exactly at the left edge has box_left_ratio 0,
  // which is falsy — a plain truthiness test would discard valid geometry.
  if (typeof scannerContext?.box_left_ratio !== 'number' || typeof scannerContext.box_right_ratio !== 'number') {
    // Label-anchored-only context: no box span, but the three price lines are
    // known from the axis pills — position the label crops precisely and keep
    // the wide fallback crops for everything else.
    if (
      typeof scannerContext?.entry_line_ratio === 'number'
      && typeof scannerContext.stop_line_ratio === 'number'
      && typeof scannerContext.target_line_ratio === 'number'
    ) {
      const axisLabelCrop = (name: string, yCenter: number): CropPreset => ({
        name,
        x: 0.83,
        y: clampRatio(yCenter - 0.045),
        width: 0.17,
        height: 0.09,
      })
      return [
        ...DEFAULT_FOCUS_CROPS,
        axisLabelCrop('entry-label-focus', scannerContext.entry_line_ratio),
        axisLabelCrop('stop-label-focus', scannerContext.stop_line_ratio),
        axisLabelCrop('target-label-focus', scannerContext.target_line_ratio),
      ]
    }
    return DEFAULT_FOCUS_CROPS
  }

  const chartLeft = scannerContext.chart_left_ratio ?? 0
  const chartRight = scannerContext.chart_right_ratio ?? 1
  const chartWidth = Math.max(0.22, chartRight - chartLeft)
  const left = scannerContext.box_left_ratio
  const right = scannerContext.box_right_ratio
  const boxWidth = Math.max(0.08, right - left)
  const top = Math.min(scannerContext.red_box?.yMin ?? 0.18, scannerContext.green_box?.yMin ?? 0.18)
  const bottom = Math.max(scannerContext.red_box?.yMax ?? 0.78, scannerContext.green_box?.yMax ?? 0.78)
  const boxHeight = Math.max(0.22, bottom - top)
  const entryLine = scannerContext.entry_line_ratio ?? (top + boxHeight / 2)
  const stopLine = scannerContext.stop_line_ratio ?? top
  const targetLine = scannerContext.target_line_ratio ?? bottom

  const labelCrop = (name: string, yCenter: number): CropPreset => ({
    name,
    x: clampRatio(chartRight - chartWidth * 0.17, chartLeft, 0.9),
    y: clampRatio(yCenter - 0.045),
    width: clampRatio(chartWidth * 0.17, 0.1, 0.18),
    height: 0.09,
  })

  return [
    {
      name: 'header-focus',
      x: chartLeft,
      y: 0,
      width: clampRatio(chartWidth * 0.42, 0.24, 0.42),
      height: 0.12,
    },
    {
      name: 'trade-box-focus',
      x: clampRatio(left - boxWidth * 0.25, chartLeft, chartRight - 0.12),
      y: clampRatio(top - boxHeight * 0.18),
      width: clampRatio(boxWidth * 1.7, 0.18, chartRight - clampRatio(left - boxWidth * 0.25, chartLeft, chartRight - 0.12)),
      height: clampRatio(boxHeight * 1.35, 0.3, 0.78),
    },
    {
      name: 'exit-path-focus',
      x: clampRatio(left, chartLeft, chartRight - 0.12),
      y: clampRatio(top - boxHeight * 0.15),
      width: clampRatio(boxWidth * 1.45, 0.18, chartRight - clampRatio(left, chartLeft, chartRight - 0.12)),
      height: clampRatio(boxHeight * 1.2, 0.32, 0.74),
    },
    {
      name: 'price-label-focus',
      x: clampRatio(chartRight - chartWidth * 0.22, chartLeft, 0.86),
      y: 0,
      width: clampRatio(chartWidth * 0.22, 0.14, 0.22),
      height: 1,
    },
    labelCrop('entry-label-focus', entryLine),
    labelCrop('stop-label-focus', stopLine),
    labelCrop('target-label-focus', targetLine),
    // thin strip of the x-axis bottom, centered on the entry candle, for precise time label reading
    (() => {
      const taxX = clampRatio(left - chartWidth * 0.28, chartLeft, 0.72)
      const taxW = clampRatio(chartWidth * 0.56, 0.28, 0.70)
      // Record where the entry candle sits within this crop (0–1) so the prompt
      // can point Gemini at the right time label. Computed HERE, from the same
      // values that position the crop, so the hint can never drift from the crop.
      scannerContext.time_axis_entry_x_ratio = clampRatio((left - taxX) / Math.max(0.01, taxW), 0.05, 0.95)
      return { name: 'time-axis-focus', x: taxX, y: 0.88, width: taxW, height: 0.12 }
    })(),
  ]
}

export async function buildScannerAssets(
  file: File,
  colors?: { entry?: string; stopLoss?: string; takeProfit?: string },
): Promise<{
  focusImages: File[]
  scannerContext: Record<string, unknown>
  uploadImage: File
}> {
  const image = await loadImage(file)
  const sourceType = file.type || 'image/png'
  // Always resolve to a concrete hex — never pass undefined to the detector.
  // This guarantees the entry/stop/TP colors from Settings are used for pixel
  // matching; without this the entry mask would be silently skipped whenever
  // the user hasn't explicitly saved a preference.
  const resolvedColors = {
    stopLoss:   colors?.stopLoss   ?? DEFAULT_SCANNER_COLORS.stopLoss,
    takeProfit: colors?.takeProfit ?? DEFAULT_SCANNER_COLORS.takeProfit,
    entry:      colors?.entry      ?? DEFAULT_SCANNER_COLORS.entry,
  }
  const scannerContext = detectTradeBoxContext(image, resolvedColors.stopLoss, resolvedColors.takeProfit, resolvedColors.entry)

  // Also sets scannerContext.time_axis_entry_x_ratio from the time-axis crop geometry.
  const focusCrops = buildDynamicFocusCrops(scannerContext)

  const focusImages = await Promise.all(
    focusCrops.map(async crop => {
      const sx = Math.max(0, Math.floor(image.width * crop.x))
      const sy = Math.max(0, Math.floor(image.height * crop.y))
      const sw = Math.max(1, Math.floor(image.width * crop.width))
      const sh = Math.max(1, Math.floor(image.height * crop.height))
      const boundedWidth = Math.min(sw, image.width - sx)
      const boundedHeight = Math.min(sh, image.height - sy)

      // Label strips carry the digits that decide the trade — upscale them so
      // Gemini reads characters at 2.5x the source resolution.
      const scale = crop.name.includes('label-focus') ? 2.5 : 1

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(boundedWidth * scale)
      canvas.height = Math.round(boundedHeight * scale)

      const context = canvas.getContext('2d')
      if (!context) throw new Error('Failed to prepare scanner crop canvas')

      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, sx, sy, boundedWidth, boundedHeight, 0, 0, canvas.width, canvas.height)
      return canvasToFile(canvas, `${crop.name}-${file.name}`, sourceType)
    })
  )

  const uploadImage = await buildUploadImage(image, file.name)

  // Ship the resolved colors with the context so the backend prompt always
  // references the exact same hexes the pixel detector used. Call sites should
  // not assemble scanner_colors themselves.
  const contextWithColors: Record<string, unknown> = {
    ...(scannerContext ?? {}),
    scanner_colors: {
      entryZone: { hex: resolvedColors.entry },
      supplyStopZone: { hex: resolvedColors.stopLoss },
      targetDemandZone: { hex: resolvedColors.takeProfit },
    },
  }

  return { focusImages, scannerContext: contextWithColors, uploadImage }
}

