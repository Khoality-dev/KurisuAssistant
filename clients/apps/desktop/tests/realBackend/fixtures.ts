/**
 * The desktop app against the real backend (#313).
 *
 * Every other spec runs against `tests/mock/server.ts`, which mirrors the
 * backend by hand — so when the two disagree the specs follow the mock and the
 * app breaks against the server with everything green. These start nothing of
 * their own: they drive a backend that is already running, with a real
 * database, whose model is the backend's own mock Ollama
 * (`python -m tests.mock_ollama`), scripted over HTTP. CI starts both
 * (`.github/workflows/real-backend-e2e.yml`); `docs/testing.md` says how to run
 * them here.
 *
 * Each test gets an account of its own, made the way a person makes one:
 * registered through the API, then activated as the operator does it — an
 * UPDATE on `users`, since activation is the operator's and has no endpoint.
 */
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { createAppPaths, launchApp, shutDown } from '../fixtures';

const BACKEND_URL = process.env.KURISU_REAL_BACKEND_URL ?? '';
const OLLAMA_URL = process.env.KURISU_MOCK_OLLAMA_URL ?? '';

/** The model the mock Ollama lists from the start. */
export const MOCK_MODEL = 'mock-model:latest';

export interface Account {
  username: string;
  password: string;
  /** A request to the backend as this account. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
  /** The JSON of a request that must succeed. */
  json: <T = any>(path: string, init?: RequestInit) => Promise<T>;
}

export interface MockOllama {
  url: string;
  /** Queue exact replies, consumed in order by the next chats (`Reply.from_dict`). */
  script: (...replies: Array<{ content?: string; thinking?: string; delay_ms?: number; words_per_chunk?: number; status?: number; error?: string; tool_calls?: Array<{ name: string; arguments?: Record<string, unknown> }> }>) => Promise<void>;
  /** What the backend sent to the model: every `/api/chat` body, oldest first. */
  chats: () => Promise<Array<{ model: string; messages: Array<{ role: string; content: string }> }>>;
}

type Fixtures = {
  account: Account;
  ollama: MockOllama;
  electronApp: ElectronApplication;
  page: Page;
};

async function form(path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Activate an account as the operator does: there is no endpoint for it, on purpose. */
async function activate(username: string): Promise<void> {
  const db = new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'kurisu',
    password: process.env.POSTGRES_PASSWORD ?? 'kurisu',
    database: process.env.POSTGRES_DB ?? 'kurisu',
  });
  await db.connect();
  try {
    const result = await db.query('UPDATE users SET is_active = true WHERE username = $1', [username]);
    if (result.rowCount !== 1) throw new Error(`no user ${username} to activate`);
  } finally {
    await db.end();
  }
}

export const test = base.extend<Fixtures>({
  account: async ({}, use) => {
    if (!BACKEND_URL || !OLLAMA_URL) {
      throw new Error('KURISU_REAL_BACKEND_URL and KURISU_MOCK_OLLAMA_URL must name a running backend and mock Ollama (docs/testing.md)');
    }
    const username = `e2e-${randomUUID().slice(0, 8)}`;
    const password = `pw-${randomUUID()}`;
    const registered = await form('/register', { username, password });
    expect(registered.status, await registered.clone().text()).toBe(200);
    await activate(username);
    const login = await form('/login', { username, password });
    expect(login.status, await login.clone().text()).toBe(200);
    const { access_token: token } = await login.json() as { access_token: string };

    const api = (path: string, init: RequestInit = {}) => fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    const json = async (path: string, init?: RequestInit) => {
      const res = await api(path, init);
      if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
      return res.json();
    };
    await use({ username, password, api, json });
  },

  ollama: async ({}, use) => {
    await fetch(`${OLLAMA_URL}/_mock/reset`, { method: 'POST' });
    await use({
      url: OLLAMA_URL,
      script: async (...replies) => {
        const res = await fetch(`${OLLAMA_URL}/_mock/replies`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replies }),
        });
        expect(res.ok).toBe(true);
      },
      chats: async () => {
        // Each record is the request body with the endpoint it came to.
        const { requests } = await (await fetch(`${OLLAMA_URL}/_mock/requests`)).json() as {
          requests: Array<{ endpoint: string; model: string; messages: Array<{ role: string; content: string }> }>;
        };
        return requests.filter((r) => r.endpoint === '/api/chat');
      },
    });
  },

  electronApp: async ({}, use) => {
    const paths = await createAppPaths();
    const app = await launchApp(BACKEND_URL, paths);
    try {
      await use(app);
    } finally {
      await shutDown(app);
      try { fs.rmSync(paths.userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  },

  page: async ({ electronApp }, use) => {
    await use(electronApp.windows()[0] ?? (await electronApp.firstWindow()));
  },
});

export { expect };

/** An account past setup: the mock Ollama as its provider, its model chosen, onboarding done. */
export async function setUp(account: Account, ollama: MockOllama): Promise<void> {
  await account.json('/users/me', { method: 'PATCH', body: JSON.stringify({ ollama_url: ollama.url, onboarded: true }) });
  await account.json('/assistant', { method: 'PATCH', body: JSON.stringify({ model_name: MOCK_MODEL, provider_type: 'ollama' }) });
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Login' }).click();
}

export async function openSection(page: Page, section: string): Promise<void> {
  await page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first().click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(section, { exact: true }).first().click();
}
