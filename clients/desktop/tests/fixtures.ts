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
import net from 'net';
import os from 'os';
import { MockBackend } from './mock/server';

/** Where this run's Electron keeps its state, and what port its MCP server got. */
export interface AppPaths {
  userDataDir: string;
  mcpPort: number;
  /** The main process's settings.json — the MCP bearer token lives here. */
  settingsFile: string;
}

type Fixtures = {
  mock: MockBackend;
  appPaths: AppPaths;
  electronApp: ElectronApplication;
  page: Page;
};

/** An unused port, so the suite never talks to a real install on the default. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'dist-electron', 'main.js');

/**
 * Close the app, and do not let a stuck renderer take the whole worker down.
 *
 * `close()` waits for the app to exit cleanly, which it will not do while a
 * renderer holds a navigation that was blocked on purpose — which is exactly
 * what the navigation-guard tests provoke. On Linux CI that surfaced as
 * "Worker teardown timeout of 60000ms exceeded", failing tests whose own
 * assertions had already passed. The process is a child of this run and its
 * state is discarded either way, so killing it when it will not leave is
 * correct, not a workaround.
 */
async function shutDown(app: ElectronApplication): Promise<void> {
  const kill = () => {
    try { app.process().kill('SIGKILL'); } catch { /* already gone */ }
  };
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(() => { kill(); resolve(); }, 3_000)),
    ]);
  } catch {
    kill();
  }
}

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

  appPaths: async ({}, use) => {
    // Isolated user data per test — prevents state bleed and the single-instance
    // lock from blocking parallel runs.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-e2e-'));
    const paths: AppPaths = {
      userDataDir,
      mcpPort: await freePort(),
      settingsFile: path.join(userDataDir, 'settings.json'),
    };
    try {
      await use(paths);
    } finally {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  },

  electronApp: async ({ mock, appPaths }, use) => {
    if (!fs.existsSync(MAIN_ENTRY)) {
      throw new Error(`Electron entry missing: ${MAIN_ENTRY}. Run "npm run build" first.`);
    }

    const app = await electron.launch({
      // `--no-sandbox` on Linux only, and only here in the tests: Ubuntu 24.04,
      // which is what `ubuntu-latest` is, blocks the unprivileged user
      // namespaces Chromium's sandbox needs, and Electron 43 hangs on shutdown
      // rather than failing outright — every test passes and then the worker
      // dies with "Worker teardown timeout". Windows and the Playwright
      // container are unaffected, which is why this only ever showed on CI.
      // The shipped app is not launched this way.
      args: process.platform === 'linux' ? [MAIN_ENTRY, '--no-sandbox'] : [MAIN_ENTRY],
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        // Ensure the test Electron instance uses an isolated userData dir so the
        // single-instance lock from a real running install doesn't block us.
        KURISU_E2E_USER_DATA_DIR: appPaths.userDataDir,
        // Likewise for the built-in MCP server's port: on the default, the suite
        // would be poking at whatever install is already running on this machine.
        KURISU_E2E_MCP_PORT: String(appPaths.mcpPort),
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
      await shutDown(app);
    }
  },

  page: async ({ electronApp }, use) => {
    const page = electronApp.windows()[0] ?? (await electronApp.firstWindow());
    await use(page);
  },
});

export { expect } from '@playwright/test';
