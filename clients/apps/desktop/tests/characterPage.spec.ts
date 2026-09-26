/**
 * The committed Android character page, run in Chromium (#245).
 *
 * Not the desktop app: a bare Electron window (`characterPage/host.main.cjs`)
 * opens `clients/android/app/src/main/assets/character/index.html` from a
 * local server that stands where Android's `WebViewAssetLoader` does — the
 * page at `/assets/character/index.html` and the persona's files at
 * `/character-assets/` on the same origin. The spec pushes the golden
 * messages the Android JVM tests decode, as `evaluateJavascript` would, and
 * watches the page's `data-status` and the events it sent back.
 *
 * Software GL (SwiftShader) is asked for explicitly: CI has no GPU, and the
 * page's WebGL probe is part of what is under test — with GL switched off
 * altogether it must say so instead of drawing a black box.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { VRM_MODEL_BYTES, VRM_MODEL_SHA256 } from './mock/vrmFixture';

const PAGE_FILE = path.resolve(__dirname, '../../../android/app/src/main/assets/character/index.html');
const FIXTURES = path.resolve(__dirname, '../../../packages/vrm/src/page/fixtures');
const HOST_MAIN = path.join(__dirname, 'characterPage', 'host.main.cjs');
const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const NO_GL = ['--disable-gpu', '--disable-software-rasterizer'];

interface Served {
  url: string;
  requests: Array<{ path: string; authorization: string | null }>;
  close(): Promise<void>;
}

async function servePage(): Promise<Served> {
  const requests: Served['requests'] = [];
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url ?? '/').split('?')[0];
    requests.push({ path: pathOnly, authorization: req.headers.authorization ?? null });
    if (pathOnly === '/assets/character/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(PAGE_FILE));
    }
    if (pathOnly === '/character-assets/1/vrm/model') {
      res.setHeader('Content-Type', 'model/gltf-binary');
      return res.end(VRM_MODEL_BYTES);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/assets/character/index.html`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function openPage(served: Served, flags: string[]): Promise<{ app: ElectronApplication; page: Page; cspViolations: string[] }> {
  const app = await electron.launch({
    args: [HOST_MAIN, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...flags],
    env: { ...process.env, KURISU_PAGE_URL: served.url },
  });
  const page = await app.firstWindow();
  const cspViolations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) cspViolations.push(msg.text());
    if (msg.type() === 'error' || process.env.RENDERER_DEBUG) console.log(`[page ${msg.type()}]`, msg.text());
  });
  page.on('pageerror', (err) => console.log('[page pageerror]', err.message));
  return { app, page, cspViolations };
}

function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

async function events(page: Page): Promise<Array<{ t: string; code?: string; message?: string }>> {
  return page.evaluate(() => (window as any).__kurisu.events);
}

test.describe('the Android character page', () => {
  let served: Served;
  let app: ElectronApplication | undefined;

  test.beforeEach(async () => {
    served = await servePage();
  });
  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
    await served.close();
  });

  test('says it is ready, loads the pushed model from its own origin with no token, and draws it', async () => {
    const opened = await openPage(served, SOFTWARE_GL);
    app = opened.app;
    const { page } = opened;
    await expect(page.locator('html')).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
    expect(await events(page)).toEqual([{ t: 'ready' }]);

    const config = fixture('config');
    config.character.vrm.model.sha256 = VRM_MODEL_SHA256;
    config.character.vrm.model.bytes = VRM_MODEL_BYTES.length;
    config.character.vrm.clips = [];
    config.character.vrm.idle.idle_clip_ids = [];
    // What `evaluateJavascript("window.__kurisu.push(<json>)")` does.
    await page.evaluate((json) => (window as any).__kurisu.push(json), JSON.stringify(config));

    await expect(page.locator('html')).toHaveAttribute('data-status', /ready|failed/, { timeout: 30_000 });
    const modelRequests = served.requests.filter((r) => r.path === '/character-assets/1/vrm/model');
    expect(modelRequests).toEqual([{ path: '/character-assets/1/vrm/model', authorization: null }]);
    expect(await page.locator('html').getAttribute('data-status'), JSON.stringify(await events(page))).toBe('ready');
    await expect.poll(async () => (await events(page)).map((e) => e.t)).toContain('first-frame');

    // The rest of the golden messages go through without an error.
    for (const name of ['speech', 'speech-sync', 'feed', 'gestures', 'faces', 'subtitle', 'resting', 'speech-null']) {
      await page.evaluate((json) => (window as any).__kurisu.push(json), fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
    }
    await expect(page.locator('#subtitle')).toHaveText('Hello there.');
    expect((await events(page)).filter((e) => e.t === 'error')).toEqual([]);
    expect(opened.cspViolations).toEqual([]);
  });

  test('takes its messages over a MessagePort once the host hands one over', async () => {
    const opened = await openPage(served, SOFTWARE_GL);
    app = opened.app;
    const { page } = opened;
    await expect(page.locator('html')).toHaveAttribute('data-status', 'idle', { timeout: 15_000 });
    // What WebViewCompat.postWebMessage with a WebMessagePort does, from the page's side.
    await page.evaluate(() => {
      const channel = new MessageChannel();
      (window as any).__hostPort = channel.port1;
      window.postMessage('kurisu:port', '*', [channel.port2]);
    });
    await page.evaluate((json) => (window as any).__hostPort.postMessage(json), JSON.stringify({ t: 'config', character: null, personaName: null }));
    await expect(page.locator('html')).toHaveAttribute('data-status', 'no-model');
    await page.evaluate(() => (window as any).__hostPort.postMessage('{"t":"dance"}'));
    await expect.poll(async () => (await events(page)).filter((e) => e.t === 'error')).toEqual([
      { t: 'error', code: 'message', message: 'unknown message type "dance"' },
    ]);
  });

  test('says so, and loads nothing, on a display with no WebGL', async () => {
    const opened = await openPage(served, NO_GL);
    app = opened.app;
    const { page } = opened;
    await expect(page.locator('html')).toHaveAttribute('data-status', 'nogl', { timeout: 15_000 });
    await expect(page.locator('#message')).toHaveText('This device cannot show a 3D character.');
    expect(await events(page)).toEqual([{ t: 'error', code: 'nogl', message: 'This device cannot show a 3D character.' }]);
    expect(served.requests.map((r) => r.path).filter((p) => p !== '/favicon.ico')).toEqual(['/assets/character/index.html']);
  });
});
