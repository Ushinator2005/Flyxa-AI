import { test, expect } from '@playwright/test';

// Logged-out surface: landing page, auth tabs, waitlist entry.

test('root sends logged-out visitors to the landing page', async ({ page }) => {
  await page.goto('/');
  await page.waitForURL('**/landing/index.html');
  await expect(page).toHaveTitle(/Flyxa/);
  await expect(page.locator('.btn-nav-cta')).toHaveText(/Join waitlist/i);
  await expect(page.locator('.nav-login')).toHaveAttribute('href', '/auth');
});

test('landing waitlist CTA opens the waitlist tab', async ({ page }) => {
  await page.goto('/landing/index.html');
  await page.locator('.btn-nav-cta').click();
  await page.waitForURL(/\/auth\?tab=waitlist/);
  await expect(page.getByText('Join the waitlist.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^join waitlist$/i })).toBeVisible();
});

test('plain /auth shows the sign-in tab', async ({ page }) => {
  await page.goto('/auth');
  await expect(page.getByText(/welcome back/i).first()).toBeVisible();
  await expect(page.locator('form').getByRole('button', { name: /^sign in$/i })).toBeVisible();
});

test('landing email form carries the address into the waitlist form', async ({ page }) => {
  await page.goto('/auth?tab=waitlist&email=smoke%40example.com');
  await expect(page.getByText('Join the waitlist.').first()).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toHaveValue('smoke@example.com');
});

test('auth page has a back link to the landing page', async ({ page }) => {
  await page.goto('/auth');
  const back = page.locator('.auth-back-link');
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', '/landing/index.html');
});
