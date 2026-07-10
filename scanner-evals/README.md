# Scanner evals

Ground-truth regression suite for the trade scanner. Every prompt or pipeline
change should be validated by running this before it ships — it turns "the
scanner feels better" into a measurable pass/fail table.

## Running

From `backend/`:

```bash
npm run evals                    # prompt checks + all image cases
npm run evals -- --prompt-only   # static prompt checks only (free, no API)
npm run evals -- --case mnq-overlap-short   # one case
```

Image cases call the real Gemini scanner (`analyzeChartImage`) directly — no
HTTP server or auth needed, but `GEMINI_API_KEY` must be set in `backend/.env`.
Each full case costs ~4 Gemini calls.

## Adding a case — the easy way (capture from a real scan)

In the app, open the browser console and run:

```js
localStorage.setItem('flyxa-eval-capture', '1')
```

While the flag is on:
- **Every scan downloads a `bundle.json`** with the exact upload image, all
  crops, the scanner context, the result, and a pre-filled `expected` block.
- **The first manual correction of an AI-scanned trade** downloads a
  `scanner-correction-*.json` telling you which fields the scanner got wrong.

Make it a case: create `cases/<name>/` and drop the bundle in as
`bundle.json`. Fix any wrong values in its `expected` block (or add an
`expected.json` beside it, which overrides). Failed scans capture too — those
are the most valuable cases.

Turn capture off with `localStorage.removeItem('flyxa-eval-capture')`.

## Adding a case — by hand

Create a folder under `cases/` per real chart you know the ground truth for:

```
scanner-evals/cases/<case-name>/
  chart.png          # the full chart screenshot (png/jpg/webp)
  expected.json      # ground truth — only include fields you want checked
  context.json       # optional: scannerContext (geometry hints + scanner_colors)
  crops/             # optional: focus crops; filename = crop label
    exit-path-focus.png
    price-label-focus.png
    ...
```

`expected.json` — every field optional; only present fields are compared:

```json
{
  "symbol": "MNQ",
  "direction": "Short",
  "entry_price": 29704.25,
  "sl_price": 29749.5,
  "tp_price": 29620.75,
  "exit_reason": "TP",
  "entry_time": "10:18",
  "entry_time_tolerance_minutes": 2,
  "timeframe_minutes": 1
}
```

Notes:
- `exit_reason: null` is a valid expectation — use it for genuinely ambiguous
  charts (single candle spans both levels) where the scanner SHOULD refuse.
- Without `crops/` + `context.json`, the case exercises the fallback path
  (full chart only). That's a valid scenario worth covering too — but for
  representative main-path cases, capture the crops.
- Good cases to collect: overlapping drawn zones over the position tool,
  stacked same-price labels (key level at the SL price), black key-level
  labels near boundaries, market-open span candles, one clean Long, one
  clean Short.

## What the prompt checks assert

Run for free with `--prompt-only`:
- Decision-tree ordering: geometry → decision tree → cursor rejection →
  same-color line test → role colors → final check
- No competing "HIGHEST PRIORITY" / "CROP AUTHORITY" claims
- The extraction pass forbids exit decisions (verifiers own the exit)
- The fallback prompt does not claim boundary-centered crops exist
- The same-color line test is present and rules are not duplicated
