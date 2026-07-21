/**
 * Scanner eval harness.
 *
 * Runs ground-truth chart screenshots through the real Gemini scanner
 * (analyzeChartImage — no HTTP, no auth) and diffs the result against
 * expected.json per case. Also runs static prompt-construction checks so
 * prompt regressions (ordering, competing authority claims) fail fast
 * without spending API calls.
 *
 * Usage (from backend/):
 *   npm run evals                 — prompt checks + all cases
 *   npm run evals -- --prompt-only    — static prompt checks only (no API)
 *   npm run evals -- --case my-case   — run a single case by folder name
 *
 * Case layout (repo root):
 *   scanner-evals/cases/<name>/
 *     chart.png|jpg|webp   — the full chart screenshot (required)
 *     expected.json        — ground truth (required, see README)
 *     context.json         — optional scannerContext (geometry hints + colors)
 *     crops/               — optional focus crops; filename minus extension
 *                            becomes the crop label (e.g. exit-path-focus.png)
 */
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { analyzeChartImage, buildMainExtractionPrompt } from '../src/services/gemini';

const CASES_DIR = path.join(__dirname, '..', '..', 'scanner-evals', 'cases');

interface ExpectedResult {
  symbol?: string;
  direction?: 'Long' | 'Short';
  entry_price?: number;
  sl_price?: number;
  tp_price?: number;
  exit_reason?: 'TP' | 'SL' | null;
  entry_time?: string;
  timeframe_minutes?: number;
  entry_time_tolerance_minutes?: number;
  close_time?: string;
  close_time_tolerance_minutes?: number;
  trade_length_minutes?: number;
  trade_length_tolerance_minutes?: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function findChartFile(caseDir: string): string | null {
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const candidate = path.join(caseDir, `chart${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function loadImage(filePath: string): { base64Image: string; mimeType: string } {
  const ext = path.extname(filePath).toLowerCase();
  return {
    base64Image: fs.readFileSync(filePath).toString('base64'),
    mimeType: MIME_BY_EXT[ext] ?? 'image/png',
  };
}

function minutesFromHHMM(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// ── Static prompt-construction checks (no API) ───────────────────────────────

function runPromptChecks(): { name: string; pass: boolean; detail?: string }[] {
  const checks: { name: string; pass: boolean; detail?: string }[] = [];
  const colors = { entry: '#787B8E', stopLoss: '#C0392B', takeProfit: '#1A6B5A' };
  const withGeometry = buildMainExtractionPrompt(
    colors,
    { leftRatio: 0.5, rightRatio: 0.65 },
    'Short',
    { entryLineRatio: 0.5, stopLineRatio: 0.3, targetLineRatio: 0.7, timeAxisEntryXRatio: 0.4 },
  );
  const withoutGeometry = buildMainExtractionPrompt(colors);

  const orderedMarkers = [
    'GEOMETRY',
    'PRICE LABEL DECISION TREE',
    'Reject cursor/live labels',
    'Reject drawn-level labels',
    'Apply role colors',
    'FINAL PRICE CHECK',
  ];
  let lastIndex = -1;
  let orderOk = true;
  let orderDetail = '';
  for (const marker of orderedMarkers) {
    const index = withGeometry.indexOf(marker);
    if (index === -1) { orderOk = false; orderDetail = `missing marker "${marker}"`; break; }
    if (index < lastIndex) { orderOk = false; orderDetail = `"${marker}" appears out of order`; break; }
    lastIndex = index;
  }
  checks.push({ name: 'decision-tree ordering (geometry → tree → cursor → line test → role colors → final check)', pass: orderOk, detail: orderDetail });

  checks.push({
    name: 'no competing "HIGHEST PRIORITY" claims',
    pass: !withGeometry.includes('HIGHEST PRIORITY') && !withGeometry.includes('CROP AUTHORITY'),
  });

  checks.push({
    name: 'extraction pass forbids exit decisions',
    pass: withGeometry.includes('Do not decide win/loss'),
  });

  checks.push({
    name: 'fallback prompt admits crops are not boundary-centered',
    pass: withoutGeometry.includes('No boundary-centered crops are available')
      && !withoutGeometry.includes('entry_price: entry-label-focus at the shared'),
  });

  checks.push({
    name: 'same-color line test rejects drawn levels',
    pass: withGeometry.includes('SAME COLOR') && withGeometry.includes('drawn level'),
  });

  const duplicateRule = (text: string, needle: string) => text.split(needle).length - 1;
  checks.push({
    name: 'cursor-label rule stated once (no duplicate rule soup)',
    pass: duplicateRule(withGeometry, 'cursor price tracker') <= 1,
    detail: `${duplicateRule(withGeometry, 'cursor price tracker')} occurrence(s)`,
  });

  // Time geometry mode: the model must OCR anchor labels, never count candles.
  const withTimeGeometry = buildMainExtractionPrompt(
    colors,
    { leftRatio: 0.5, rightRatio: 0.65 },
    'Short',
    { entryLineRatio: 0.5, stopLineRatio: 0.3, targetLineRatio: 0.7, timeAxisEntryXRatio: 0.4 },
    { pitchRatio: 0.008, gridlineRatios: [0.2, 0.4, 0.6], boxLeftRatio: 0.5 },
  );
  checks.push({
    name: 'time-geometry prompt asks for anchor labels and forbids model candle counting',
    pass: withTimeGeometry.includes('anchor_labels')
      && withTimeGeometry.includes('Do NOT count candles')
      && !withTimeGeometry.includes('candle-count interpolation'),
  });
  checks.push({
    name: 'fallback prompt keeps candle-count interpolation when no gridline geometry exists',
    pass: withGeometry.includes('candle-count interpolation')
      && withGeometry.includes('anchor_labels as an empty array'),
  });

  return checks;
}

// ── Case runner ───────────────────────────────────────────────────────────────

interface FieldResult { field: string; expected: unknown; actual: unknown; pass: boolean }

interface CaptureBundle {
  chart: { base64: string; mimeType: string };
  crops?: Array<{ label: string; base64: string; mimeType: string }>;
  context?: Record<string, unknown>;
  expected?: ExpectedResult;
}

async function runCase(caseName: string): Promise<{ name: string; fields: FieldResult[]; error?: string }> {
  const caseDir = path.join(CASES_DIR, caseName);
  const expectedFile = path.join(caseDir, 'expected.json');
  const bundleFile = path.join(caseDir, 'bundle.json');

  let chart: { base64Image: string; mimeType: string };
  let focusImages: Array<{ base64Image: string; mimeType: string; label: string }>;
  let scannerContext: Record<string, unknown> | undefined;
  let expected: ExpectedResult;

  if (fs.existsSync(bundleFile)) {
    // Bundle captured in-app via localStorage flag 'flyxa-eval-capture' — the
    // exact images/context of a real scan. expected.json (if present) overrides
    // the bundle's pre-filled expectation.
    const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8')) as CaptureBundle;
    if (!bundle.chart?.base64) return { name: caseName, fields: [], error: 'bundle.json has no chart image' };
    chart = { base64Image: bundle.chart.base64, mimeType: bundle.chart.mimeType || 'image/webp' };
    focusImages = (bundle.crops ?? []).map(crop => ({
      base64Image: crop.base64,
      mimeType: crop.mimeType || 'image/png',
      label: crop.label,
    }));
    scannerContext = bundle.context;
    const override = fs.existsSync(expectedFile)
      ? (JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as ExpectedResult)
      : undefined;
    expected = override ?? bundle.expected ?? {};
    if (Object.keys(expected).length === 0) {
      return { name: caseName, fields: [], error: 'no expectations (bundle.expected empty and no expected.json)' };
    }
  } else {
    const chartFile = findChartFile(caseDir);
    if (!chartFile) return { name: caseName, fields: [], error: 'no bundle.json or chart.png/jpg/webp found' };
    if (!fs.existsSync(expectedFile)) return { name: caseName, fields: [], error: 'no expected.json found' };

    expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as ExpectedResult;
    chart = loadImage(chartFile);

    const cropsDir = path.join(caseDir, 'crops');
    focusImages = fs.existsSync(cropsDir)
      ? fs.readdirSync(cropsDir)
          .filter(file => MIME_BY_EXT[path.extname(file).toLowerCase()])
          .map(file => ({
            ...loadImage(path.join(cropsDir, file)),
            label: path.basename(file, path.extname(file)),
          }))
      : [];

    const contextFile = path.join(caseDir, 'context.json');
    scannerContext = fs.existsSync(contextFile)
      ? (JSON.parse(fs.readFileSync(contextFile, 'utf8')) as Record<string, unknown>)
      : undefined;
  }

  const started = Date.now();
  const result = await analyzeChartImage(
    chart.base64Image,
    chart.mimeType,
    new Date().toISOString().slice(0, 10),
    '09:30',
    focusImages,
    scannerContext,
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const fields: FieldResult[] = [];
  const check = (field: string, expectedValue: unknown, actualValue: unknown, pass: boolean) =>
    fields.push({ field, expected: expectedValue, actual: actualValue, pass });

  if (expected.symbol !== undefined) check('symbol', expected.symbol, result.symbol, result.symbol === expected.symbol);
  if (expected.direction !== undefined) check('direction', expected.direction, result.direction, result.direction === expected.direction);
  if (expected.entry_price !== undefined) check('entry_price', expected.entry_price, result.entry_price, result.entry_price === expected.entry_price);
  if (expected.sl_price !== undefined) check('sl_price', expected.sl_price, result.sl_price, result.sl_price === expected.sl_price);
  if (expected.tp_price !== undefined) check('tp_price', expected.tp_price, result.tp_price, result.tp_price === expected.tp_price);
  if (expected.exit_reason !== undefined) check('exit_reason', expected.exit_reason, result.exit_reason, result.exit_reason === expected.exit_reason);
  if (expected.timeframe_minutes !== undefined) check('timeframe_minutes', expected.timeframe_minutes, result.timeframe_minutes, result.timeframe_minutes === expected.timeframe_minutes);
  if (expected.entry_time !== undefined) {
    const tolerance = expected.entry_time_tolerance_minutes ?? 2;
    const want = minutesFromHHMM(expected.entry_time);
    const got = result.entry_time ? minutesFromHHMM(result.entry_time) : null;
    const pass = want !== null && got !== null && Math.abs(got - want) <= tolerance;
    check(`entry_time (±${tolerance}m)`, expected.entry_time, result.entry_time, pass);
  }
  if (expected.close_time !== undefined) {
    // Default tolerance = one candle: close time is quantized to the first-touch candle.
    const tolerance = expected.close_time_tolerance_minutes ?? Math.max(2, expected.timeframe_minutes ?? 2);
    const want = minutesFromHHMM(expected.close_time);
    const got = result.close_time ? minutesFromHHMM(result.close_time) : null;
    const pass = want !== null && got !== null && Math.abs(got - want) <= tolerance;
    check(`close_time (±${tolerance}m)`, expected.close_time, result.close_time, pass);
  }
  if (expected.trade_length_minutes !== undefined) {
    const tolerance = expected.trade_length_tolerance_minutes ?? Math.max(2, expected.timeframe_minutes ?? 2);
    const got = typeof result.trade_length_seconds === 'number' ? result.trade_length_seconds / 60 : null;
    const pass = got !== null && Math.abs(got - expected.trade_length_minutes) <= tolerance;
    check(`trade_length (±${tolerance}m)`, expected.trade_length_minutes, got, pass);
  }

  console.log(`  [${caseName}] completed in ${elapsed}s${result.warnings?.length ? ` — ${result.warnings.length} warning(s)` : ''}`);
  return { name: caseName, fields };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const promptOnly = args.includes('--prompt-only');
  const caseFilter = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;

  console.log('── Prompt-construction checks ──');
  const promptChecks = runPromptChecks();
  let promptFailures = 0;
  for (const checkResult of promptChecks) {
    console.log(`  ${checkResult.pass ? 'PASS' : 'FAIL'}  ${checkResult.name}${!checkResult.pass && checkResult.detail ? ` (${checkResult.detail})` : ''}`);
    if (!checkResult.pass) promptFailures += 1;
  }

  if (promptOnly) {
    process.exit(promptFailures > 0 ? 1 : 0);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY missing — set it in backend/.env to run image cases.');
    process.exit(1);
  }

  if (!fs.existsSync(CASES_DIR)) {
    console.log(`\nNo cases directory at ${CASES_DIR} — add cases per scanner-evals/README.md.`);
    process.exit(promptFailures > 0 ? 1 : 0);
  }

  const caseNames = fs.readdirSync(CASES_DIR)
    .filter(name => fs.statSync(path.join(CASES_DIR, name)).isDirectory())
    .filter(name => !caseFilter || name === caseFilter);

  if (caseNames.length === 0) {
    console.log('\nNo eval cases found.');
    process.exit(promptFailures > 0 ? 1 : 0);
  }

  console.log(`\n── Running ${caseNames.length} case(s) ──`);
  let fieldFailures = 0;
  const summaries: string[] = [];

  for (const caseName of caseNames) {
    const { name, fields, error } = await runCase(caseName);
    if (error) {
      summaries.push(`SKIP  ${name} — ${error}`);
      continue;
    }
    const failed = fields.filter(field => !field.pass);
    fieldFailures += failed.length;
    summaries.push(`${failed.length === 0 ? 'PASS' : 'FAIL'}  ${name}  (${fields.length - failed.length}/${fields.length} fields)`);
    for (const field of failed) {
      summaries.push(`        ${field.field}: expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.actual)}`);
    }
  }

  console.log('\n── Results ──');
  for (const line of summaries) console.log(`  ${line}`);
  console.log(`\nPrompt checks: ${promptChecks.length - promptFailures}/${promptChecks.length} · Field failures: ${fieldFailures}`);
  process.exit(promptFailures + fieldFailures > 0 ? 1 : 0);
}

void main();
