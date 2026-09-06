/**
 * Config for the documentation screenshot capture only.
 *
 * Kept separate from playwright.config.ts so `npm run test:e2e` never picks it up:
 * that config matches `/.*\.spec\.ts$/`, and the capture file deliberately is not a
 * `.spec.ts`. Run it on purpose after a build:
 *
 *   npx vite build
 *   npx playwright test -c playwright.screenshots.config.ts
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/screenshots',
  testMatch: /capture\.screens\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
});
