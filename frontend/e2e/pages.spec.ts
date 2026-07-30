import { test, expect } from '@playwright/test';

// Broad render smoke: every main page mounts without crashing. Catches the
// class of bug unit tests can't see — a component throwing on real data.

const PAGES = [
  { path: '/', probe: /log trade/i },
  { path: '/scanner', probe: /import trades from csv/i },
  { path: '/analytics', probe: /analytics|no trades/i },
  { path: '/market-news', probe: /market news|calendar|headlines/i },
  { path: '/journal', probe: /journal|new entry/i },
  { path: '/trading-plan', probe: /rule|plan/i },
  { path: '/rivals', probe: /rivals|invite traders|add rival/i },
  { path: '/billing', probe: /billing|account/i },
  { path: '/evaluation-coach', probe: /evaluation/i },
  { path: '/goals', probe: /goal/i },
  { path: '/achievements', probe: /achievement/i },
  { path: '/settings', probe: /settings|profile/i },
];

for (const { path, probe } of PAGES) {
  test(`${path} renders without crashing`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', err => consoleErrors.push(String(err)));
    await page.goto(path);
    await expect(page.getByText('Something went wrong')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(probe).first()).toBeVisible({ timeout: 15_000 });
    expect(consoleErrors, `uncaught page errors on ${path}`).toEqual([]);
  });
}

test('theme toggle cycles Default -> Light -> Midnight -> Default', async ({ page }) => {
  await page.goto('/settings');
  const toggle = page.locator('.theme-toggle-button').first();
  const themeAttr = () => page.evaluate(() => document.documentElement.dataset.theme);

  await expect(toggle).toBeVisible();
  expect(await themeAttr()).toBe('dark');
  await toggle.click();
  expect(await themeAttr()).toBe('light');
  await toggle.click();
  expect(await themeAttr()).toBe('midnight');
  await toggle.click();
  expect(await themeAttr()).toBe('dark');
});

test('rivals add-rival modal opens fully styled', async ({ page }) => {
  await page.goto('/rivals');
  await page.getByRole('button', { name: /invite traders|add rival/i }).first().click();
  const modal = page.locator('.rv-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByPlaceholder('@username')).toBeVisible();
  // Regression guard: the modal once rendered with unresolved CSS variables —
  // a transparent card floating over the page. Assert the card actually paints.
  const background = await modal.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Escape');
});

test('journal deep link lands on the exact requested day', async ({ page }) => {
  await page.goto('/scanner?date=2026-07-10');
  // The day may have no entry — the journal materializes a blank day rather
  // than silently falling back to the most recent day.
  await expect(page.getByText(/July 10, 2026/).first()).toBeVisible({ timeout: 15_000 });
});
