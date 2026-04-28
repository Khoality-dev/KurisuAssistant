/**
 * Playwright test fixtures for the Electron app.
 *
 * Provides `electronApp`, `page` (main window), and `mock` (mock backend).
 * Each test gets a fresh Electron instance with isolated userData and a new
 * mock backend instance on a random port.
 */

import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MockBackend } from './mock/server';

type Fixtures = {
  mock: MockBackend;
  electronApp: ElectronApplication;
  page: Page;
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist-electron', 'main.js');

export const test = base.extend<Fixtures>({
  mock: async ({}, use) => {
    const server = new MockBackend();
    await server.start();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },

  electronApp: async ({ mock }, use) => {
    if (!fs.existsSync(MAIN_ENTRY)) {
      throw new Error(`Electron entry missing: ${MAIN_ENTRY}. Run "npm run build" first.`);
    }

    // Isolated user data per test — prevents state bleed and the single-instance
    // lock from blocking parallel runs.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-e2e-'));

    const app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        // Ensure the test Electron instance uses an isolated userData dir so the
        // single-instance lock from a real running install doesn't block us.
        KURISU_E2E_USER_DATA_DIR: userDataDir,
        // Ensure production mode (no VITE_DEV_SERVER_URL) so main.ts loads dist/index.html
        VITE_DEV_SERVER_URL: '',
        KURISU_E2E: '1',
      },
    });

    // First window = LoginWindow (renderer)
    const firstPage = await app.firstWindow();

    // Surface renderer console/errors in test output so failures are debuggable.
    firstPage.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning' || process.env.RENDERER_DEBUG) {
        console.log(`[renderer ${type}]`, msg.text());
      }
    });
    firstPage.on('pageerror', (err) => console.log('[renderer pageerror]', err.message));

    // Seed backend URL into localStorage and reload so axios + wsManager pick it up.
    await firstPage.evaluate((url) => {
      localStorage.setItem('kurisu_backend_url', url);
      localStorage.removeItem('kurisu_auth_token');
      localStorage.removeItem('kurisu_refresh_token');
      localStorage.setItem('kurisu_remember_me', 'false');
    }, mock.url);
    await firstPage.reload();

    try {
      await use(app);
    } finally {
      try { await app.close(); } catch { /* noop */ }
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  },

  page: async ({ electronApp }, use) => {
    const page = electronApp.windows()[0] ?? (await electronApp.firstWindow());
    await use(page);
  },
});

export { expect } from '@playwright/test';
