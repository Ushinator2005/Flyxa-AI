import { defineConfig } from '@playwright/test';

// Smoke suite: drives the real dev stack (Vite + backend + Supabase).
// Reuses already-running dev servers; starts them if absent.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  retries: 1,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    storageState: 'e2e/.auth/state.json',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'logged-out',
      testMatch: /public\.spec\.ts/,
      use: { storageState: { cookies: [], origins: [] } },
    },
    {
      name: 'logged-in',
      testMatch: /(app|pages)\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      cwd: '../backend',
      url: 'http://localhost:3001/health',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
