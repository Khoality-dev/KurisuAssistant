/**
 * Documentation screenshots for the desktop client.
 *
 * Deliberately NOT named `*.spec.ts`: playwright.config.ts matches `/.*\.spec\.ts$/`,
 * so this never runs as part of `npm run test:e2e`. Run it on purpose:
 *
 *   npx vite build
 *   npx playwright test --testMatch='**\/capture.screens.ts'
 *
 * It renders the built renderer in headless Chromium rather than Electron. That is
 * sound here because every use of the preload bridge in the renderer is guarded
 * (`if (!window.electron)` / `window.electron?.x`), so nothing dereferences it at
 * module scope — and `package.json` runs the same `vite` command for `dev` and
 * `electron:dev`, i.e. the renderer is an ordinary web bundle that Electron merely
 * points a BrowserWindow at. We still install a stub bridge below so the screenshots
 * do not depend on those guards staying correct.
 *
 * Every byte of content comes from `tests/mock/server.ts`. Nothing touches a real
 * backend, so no private conversation can leak into a public repo.
 */

import { test, expect, Page } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { MockBackend } from '../mock/server';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(PROJECT_ROOT, 'dist');
// Screenshots belong to this package, next to the doc that shows them.
const OUT = path.resolve(PROJECT_ROOT, 'docs', 'assets');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.onnx': 'application/octet-stream',
};

/** Serve `dist/` with SPA fallback. Vite emits relative asset paths, so this is enough. */
function serveDist(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Stub the preload bridge. The renderer guards every access, so this is belt and
 * braces — but it also lets the MCP/tool surfaces render populated instead of empty.
 */
async function installBridge(page: Page, backendUrl: string) {
  await page.addInitScript((url) => {
    const noop = () => {};
    const off = () => noop;
    (window as unknown as { electron: unknown }).electron = {
      mcp: {
        startServer: async () => ({ ok: true }),
        listTools: async () => [],
        listToolsByServer: async () => ({}),
        callTool: async () => ({ content: '', isError: false }),
      },
      appTools: {
        listTools: async () => [],
        callTool: async () => ({ content: '', isError: false }),
        isAppTool: async () => false,
        onExecute: off,
        sendResult: noop,
      },
      hostTools: { listTools: async () => [], isHostTool: async () => false },
      onMCPToolsChanged: off,
    };
    localStorage.setItem('kurisu_backend_url', url);
    localStorage.setItem('kurisu_remember_me', 'false');
    localStorage.removeItem('kurisu_auth_token');
    localStorage.removeItem('kurisu_refresh_token');
  }, backendUrl);
}

/**
 * Invented fixture content. Nothing here comes from a real install — these screenshots
 * end up in a public repo, so every persona, prompt and message below is made up.
 */
const FIXTURE = {
  personas: [
    {
      id: 1,
      name: 'Kurisu',
      description: 'Dry, precise, allergic to hand-waving.',
      system_prompt:
        'You are Kurisu. Be precise and a little sharp. Never pad an answer to sound thorough.',
      preferred_name: 'Okabe',
      voice_reference: 'kurisu-neutral.wav',
      enabled: true,
    },
    {
      id: 2,
      name: 'Coach',
      description: 'Warm, direct, keeps you moving.',
      system_prompt:
        'You are Coach. Encourage briefly, then give the next concrete step. No lectures.',
      preferred_name: 'champ',
      voice_reference: 'coach-warm.wav',
      enabled: true,
    },
    {
      id: 3,
      name: 'Archivist',
      description: 'Answers from what was actually said.',
      system_prompt:
        'You are the Archivist. Quote the record. If it is not in the history, say so plainly.',
      preferred_name: null,
      voice_reference: null,
      enabled: true,
    },
  ],
  assistant: {
    model_name: 'qwen3:8b',
    provider_type: 'ollama',
    available_tools: null,
    think: true,
    use_deferred_tools: false,
    memory:
      'Prefers short answers with the reasoning shown only when it changes the conclusion.\n'
      + 'Works in a monorepo: backend (FastAPI), desktop (Electron), android (Compose).',
    memory_enabled: true,
    trigger_word: 'kurisu',
    default_persona_id: 1,
  },
  subAgents: [
    {
      id: 10,
      name: 'code-reader',
      description: 'Reads a file and reports what it actually does.',
      model_name: 'qwen3:4b',
      provider_type: 'ollama',
      available_tools: ['history_read', 'history_search'],
      enabled: true,
    },
    {
      id: 11,
      name: 'summariser',
      description: 'Collapses a long transcript into the decisions taken.',
      model_name: 'qwen3:1.7b',
      provider_type: 'ollama',
      available_tools: ['history_list'],
      enabled: true,
    },
  ],
  tools: {
    builtin: [
      { name: 'history_list', description: 'List past conversations.', builtin: true },
      { name: 'history_read', description: 'Read one past conversation.', builtin: true },
      { name: 'history_search', description: 'Search across past conversations.', builtin: true },
      {
        name: 'get_skill_instructions',
        description: 'Fetch a skill by name.',
        builtin: true,
      },
    ],
    mcp: [
      { name: 'fs_read_file', description: 'Read a file from the workspace.' },
      { name: 'fs_list_dir', description: 'List a workspace directory.' },
    ],
  },
  mcpServers: [
    {
      id: 1,
      name: 'filesystem',
      transport_type: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '~/workspace'],
      enabled: true,
      location: 'client' as const,
    },
    {
      id: 2,
      name: 'search',
      transport_type: 'sse' as const,
      url: 'http://127.0.0.1:8931/sse',
      enabled: true,
      location: 'server' as const,
    },
  ],
};

/** Open the settings pane and click through to one section. */
async function settingsSection(page: Page, label: string) {
  await page.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(400);
}

test('capture desktop screenshots', async ({ browser }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });

  const mock = new MockBackend(FIXTURE);
  await mock.start();
  const site = await serveDist();

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console error]', m.text());
  });

  try {
    await installBridge(page, mock.url);
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });

    // 1. Login — proves the bundle boots in a plain browser at all.
    await expect(page.getByRole('heading', { name: 'KurisuAssistant' })).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: path.join(OUT, '01-login.png') });
    console.log('captured 01-login.png');

    // 2. Chat, with an actual exchange in it. An empty transcript documents nothing.
    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    const composer = page.getByPlaceholder('Type your message...');
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await composer.fill('Which persona is answering, and what model is behind it?');
    await composer.press('Enter');
    // Wait for the streamed reply to settle rather than a fixed sleep.
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(OUT, '02-chat.png') });
    console.log('captured 02-chat.png');

    // 3. The v3 model change itself: three settings sections where there was one.
    const settingsBtn = page
      .locator('button')
      .filter({
        has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
      })
      .first();
    await settingsBtn.click();
    await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    const sections: Array<[string, string]> = [
      ['Assistant', '03-settings-assistant.png'],
      ['Personas', '04-settings-personas.png'],
      ['Sub-Agents', '05-settings-sub-agents.png'],
      ['Tools & MCP', '06-settings-tools-mcp.png'],
      ['Skills', '07-settings-skills.png'],
    ];
    for (const [label, file] of sections) {
      try {
        await settingsSection(page, label);
        await page.screenshot({ path: path.join(OUT, file) });
        console.log(`captured ${file}`);
      } catch (err) {
        // Report rather than silently shipping a missing screenshot.
        console.log(`FAILED ${file} (${label}):`, (err as Error).message);
      }
    }
  } finally {
    await context.close();
    await site.close();
    await mock.stop();
  }
});
