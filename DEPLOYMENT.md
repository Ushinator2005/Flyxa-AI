# Flyxa deployment — current architecture

Everything is already live on a single domain:

| Piece | Where | Notes |
|---|---|---|
| Frontend (app + landing) | Vercel → **flyxa.app** (`www` canonical) | Auto-deploys from `master`; SPA rewrite in `frontend/vercel.json` |
| Landing page | Served from the same deploy at **/landing/index.html** | Static handoff files in `frontend/public/landing/` |
| Backend API | Railway → `flyxa-ai-production.up.railway.app` | Express; frontend points at it via `VITE_API_URL` |
| Database/auth | Supabase | |

Routing behavior: logged-out visitors to `/` are sent to the landing page — a
pre-boot script in `frontend/index.html` does it instantly (checks for the
Supabase session key), with `ProtectedRoute` as the authoritative fallback.
Logged-in users get the Dashboard. Deep links (`/settings`, …) go to `/auth`.

## Config worth double-checking (Vercel / Railway dashboards)

- **Railway `FRONTEND_URL`** must contain every browser origin, comma-separated:
  `https://www.flyxa.app,https://flyxa.app` — anything missing gets CORS-blocked.
- **Railway `AI_DAILY_CALL_LIMIT`** — set before opening more beta seats; the
  scanner and Ask Flyxa spend Anthropic tokens per request.
- **Vercel env**: `VITE_API_URL` (Railway URL), `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`.
- Landing meta tags (`og:url`, images) reference
  `https://www.flyxa.app/landing/...` — update if the URL scheme changes.
- Analytics: none installed; paste a snippet into
  `frontend/public/landing/index.html` `<head>` when chosen.

## Post-deploy smoke test

1. Incognito `flyxa.app` → landing page appears immediately (no app flash).
2. "Join waitlist" → `/auth` with the waitlist tab active; the bottom email
   form carries the address through pre-filled; "Log in" → sign-in tab.
3. Waitlist signup with a test email → confirmation email → invite → redeem
   → username prompt → add account → log a trade.
4. Browser console shows no CORS errors; Railway `/health` returns 200.

## Optional later: subdomain split (marketing at apex, app at app.flyxa.app)

Cleaner URLs (landing at `flyxa.app/` instead of `/landing/index.html`) and
independent marketing deploys. When wanted:

1. New Vercel project, root directory `frontend/public/landing`, domain `flyxa.app`.
2. Move the app project's domain to `app.flyxa.app`; add it to Railway
   `FRONTEND_URL`.
3. Point the landing CTAs at the app origin (`https://app.flyxa.app/auth...`)
   and update `og:url`/canonical/`og:image` to apex-root URLs.
4. Remove the pre-boot redirect from `frontend/index.html` (the app no longer
   hosts the marketing entry point).
