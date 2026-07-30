import { test, expect, type Page } from '@playwright/test';

// Deletes every account named "E2E Smoke Account" via the Settings table.
// Self-healing: failed historical runs may have left several behind.
async function purgeSmokeAccounts(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tagged = await page.evaluate(() => {
      document.querySelectorAll('[data-e2e-target]').forEach(el => el.removeAttribute('data-e2e-target'));
      const input = Array.from(document.querySelectorAll('input'))
        .find(el => (el as HTMLInputElement).value === 'E2E Smoke Account');
      input?.setAttribute('data-e2e-target', 'row-name');
      return Boolean(input);
    });
    if (!tagged) return;
    const row = page
      .locator('div')
      .filter({ has: page.locator('[data-e2e-target="row-name"]') })
      .filter({ has: page.getByRole('button', { name: /delete/i }) })
      .last();
    await row.getByRole('button', { name: /delete/i }).first().click();
    await page.getByRole('button', { name: /confirm delete/i }).click();
    await expect(page.locator('[data-e2e-target="row-name"]')).toHaveCount(0);
  }
}

// Logged-in critical path: dashboard boots, account creation with firm
// presets works, journal/scanner renders.

test('dashboard loads for a signed-in user', async ({ page }) => {
  await page.goto('/');
  // Must NOT bounce to the landing page or auth.
  await expect(page).toHaveURL(/localhost:5173\/$/);
  await expect(page.getByRole('button', { name: /log trade/i })).toBeVisible({ timeout: 15_000 });
});

test('scanner (trade journal) renders', async ({ page }) => {
  await page.goto('/scanner');
  await expect(page.getByText(/import trades from csv/i).first()).toBeVisible({ timeout: 15_000 });
});

test('add-account flow offers firm presets and applies rules', async ({ page }) => {
  await page.goto('/settings#accounts');
  await purgeSmokeAccounts(page);
  await page.locator('[data-tour-id="settings-add-account"]').click();
  await expect(page.getByText('Add Trading Account')).toBeVisible();

  await page.getByPlaceholder('Account name').last().fill('E2E Smoke Account');

  // Firm dropdown: catalog firms present, no duplicates.
  const firmSelect = page.locator('select:has(option:has-text("Alpha Futures"))').first();
  const options = await firmSelect.locator('option').allTextContents();
  for (const firm of ['Alpha Futures', 'Lucid Trading', 'Topstep', 'Tradeify']) {
    expect(options.filter(o => o === firm)).toHaveLength(1);
  }

  await firmSelect.selectOption('Lucid Trading');
  // Verified rules preview appears with a source link.
  await expect(page.getByText('Rules that will be applied')).toBeVisible();
  await expect(page.getByText(/check official Lucid Trading source/i)).toBeVisible();

  await page.getByRole('button', { name: 'Save Account' }).click();

  // Billing prompt follows account creation — decline it.
  await expect(page.getByText(/track this account in billing/i)).toBeVisible();
  await page.getByRole('button', { name: /not now/i }).click();

  // The account shows in the (always-visible) active accounts table.
  await expect(page.getByText('E2E Smoke Account').first()).toBeVisible();

  // Cleanup so repeated runs stay tidy: purge everything this test created
  // (and anything older failed runs left behind).
  await purgeSmokeAccounts(page);
  await expect(page.getByText('E2E Smoke Account')).toHaveCount(0);
});
