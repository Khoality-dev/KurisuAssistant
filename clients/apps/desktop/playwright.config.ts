import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  // Specs tagged @gpu assert a rendered WebGL frame; CI has no GPU and passes
  // no GPU flags, so they run only when a developer asks (docs/testing.md).
  grepInvert: process.env.KURISU_E2E_GPU ? undefined : /@gpu/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The slowest test takes about seven seconds. A hang should say so in
  // seconds, not burn a minute per test before failing.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
