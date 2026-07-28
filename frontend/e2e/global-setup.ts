import { chromium, type FullConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Creates (once) and signs in a dedicated E2E user, then saves the browser
// storage state so logged-in specs skip the login UI. The password is derived
// from the service-role key, so nothing secret is committed.

function readEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export const E2E_EMAIL = 'e2e-smoke@flyxa.app';

export default async function globalSetup(_config: FullConfig) {
  const frontendEnv = readEnv(path.join(__dirname, '..', '.env'));
  const backendEnv = readEnv(path.join(__dirname, '..', '..', 'backend', '.env'));
  const supabaseUrl = frontendEnv.VITE_SUPABASE_URL;
  const serviceKey = backendEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('global-setup: missing VITE_SUPABASE_URL (frontend/.env) or SUPABASE_SERVICE_ROLE_KEY (backend/.env)');
  }
  const password = createHash('sha256').update(`${serviceKey}:flyxa-e2e`).digest('hex').slice(0, 24);

  // Ensure the E2E user exists and is confirmed (idempotent).
  const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: E2E_EMAIL, password, email_confirm: true }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    // 422 "already been registered" is the expected steady state.
    if (!/already|exists/i.test(body)) {
      throw new Error(`global-setup: could not create E2E user: ${createRes.status} ${body}`);
    }
  }

  // Sign in through the real UI and persist the session.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/auth');
  await page.getByPlaceholder('you@example.com').first().fill(E2E_EMAIL);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('form').getByRole('button', { name: /sign in/i }).click();

  // The username prompt blocks everything for a brand-new profile — complete
  // it once; on later runs it never appears.
  await page.waitForURL('**/');
  const usernameField = page.getByPlaceholder(/username/i).first();
  try {
    await usernameField.waitFor({ state: 'visible', timeout: 8_000 });
    await usernameField.fill('e2e-smoke');
    await page.getByRole('button', { name: /save|continue|confirm/i }).first().click();
    await usernameField.waitFor({ state: 'hidden', timeout: 10_000 });
  } catch {
    // Prompt did not appear — profile already exists.
  }

  // Quiet the first-run overlays so specs aren't blocked by the tour.
  await page.evaluate(() => {
    localStorage.setItem('flyxa_website_tour_completed_v1', 'true');
    localStorage.setItem('flyxa_presession_done_date', new Date().toISOString().slice(0, 10));
  });

  fs.mkdirSync(path.join(__dirname, '.auth'), { recursive: true });
  await page.context().storageState({ path: path.join(__dirname, '.auth', 'state.json') });
  await browser.close();
}
