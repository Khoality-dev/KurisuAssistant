/**
 * The 3D character, end to end, with a model the renderer really loads (#306).
 *
 * A model is only fetched once the display offers WebGL 2, and CI has no GPU,
 * so until this file no spec reached the fetch: the 3D setup asked `file://`
 * for every uploaded model for a whole release (#298) with every suite green.
 * These launch the app with SwiftShader — software WebGL; from the fetch
 * onwards the code path is the one a GPU takes — and hold the app to the
 * mock's store: a model or clip is uploaded or seeded there and has to come
 * back from it with the session's bearer, and the stage has to draw the
 * fixture's red body on its white background.
 */

import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';
import { MockBackend, VRM_CHARACTER_WITH_MODEL } from './mock/server';
import { VRM_MODEL_BYTES, VRMA_CLIP_BYTES } from './mock/vrmFixture';

test.use({ electronArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const BEARER = 'Bearer test-access-token';
const MODEL_PATH = '/character-assets/1/vrm/model';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  const composer = page.getByPlaceholder('Type your message...');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

/** Settings → Personas → the persona's card (found by its character line) → Set up 3D character. */
async function openSetup(page: Page, cardText: string) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await page.getByText('Personas', { exact: true }).first().click();
  const card = page.getByText(cardText);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await page.getByRole('button', { name: /Set up 3D character/ }).click();
}

/** Every request the app made for `path`, as [authorization, status]. */
function requestsFor(mock: MockBackend, path: string) {
  return mock.characterAssetRequests.filter((r) => r.path === path).map((r) => [r.authorization, r.status]);
}

/**
 * The share of sampled pixels that are the fixture's red body, read inside a
 * frame so the driver has just drawn into the buffer (as vrmRender.gpu.spec.ts).
 */
function redShare(page: Page, canvasSelector: string): Promise<number> {
  return page.evaluate((selector) => new Promise<number>((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector(selector) as HTMLCanvasElement | null;
      const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      if (!canvas || !gl) return resolve(0);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let red = 0, sampled = 0;
      for (let i = 0; i < px.length; i += 4 * 7) {
        sampled++;
        if (px[i] > 110 && px[i + 1] < 90 && px[i + 2] < 90) red++;
      }
      resolve(sampled ? red / sampled : 0);
    });
  }), canvasSelector);
}

async function openCharacterWindow(page: Page, electronApp: ElectronApplication) {
  const [characterPage] = await Promise.all([
    electronApp.waitForEvent('window'),
    page.getByRole('button', { name: 'Show character window' }).click(),
  ]);
  characterPage.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning' || process.env.RENDERER_DEBUG) {
      console.log(`[character ${msg.type()}]`, msg.text());
    }
  });
  characterPage.on('pageerror', (err) => console.log('[character pageerror]', err.message));
  return characterPage;
}

async function send(page: Page, composer: ReturnType<Page['getByPlaceholder']>, text: string) {
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('3D character', () => {
  test('a model uploaded in the 3D setup comes back from the server and is drawn in the preview', async ({ page, mock }) => {
    mock.setCharacterConfig(1, { kind: 'vrm' } as never);
    await login(page);
    await openSetup(page, '3D model · none uploaded');
    await expect(page.getByText('Drop a .vrm file here')).toBeVisible({ timeout: 10_000 });

    await page.locator('input[accept=".vrm"]').setInputFiles({
      name: 'kurisu.vrm', mimeType: 'application/octet-stream', buffer: VRM_MODEL_BYTES,
    });

    const preview = page.getByTestId('vrm-preview');
    await expect(preview).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    expect(mock.lastCharacterUpload).toMatchObject({ path: MODEL_PATH, bytes: VRM_MODEL_BYTES.length, status: 200 });
    // The upload's answer names the model by a root-relative path; the preview
    // has to take it to the server, not to the page's own origin (#298).
    expect(requestsFor(mock, MODEL_PATH)).toEqual([[BEARER, 200]]);
    await expect.poll(() => redShare(page, '[data-testid="vrm-preview"] canvas'), { timeout: 10_000 }).toBeGreaterThan(0.02);
  });

  test('reopening the setup of a persona that has a model loads it from the server again', async ({ page, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    await login(page);
    await openSetup(page, '3D model · kurisu_v2.vrm');
    const preview = page.getByTestId('vrm-preview');
    await expect(preview).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(preview).toHaveCount(0);
    await page.getByRole('button', { name: /Set up 3D character/ }).click();
    await expect(preview).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

    // The parsed model is cached by its sha, so the second open may not ask
    // again; whatever did go out went to the server with the bearer.
    const seen = requestsFor(mock, MODEL_PATH);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const [authorization, status] of seen) {
      expect(authorization).toBe(BEARER);
      expect([200, 304]).toContain(status);
    }
    await expect.poll(() => redShare(page, '[data-testid="vrm-preview"] canvas'), { timeout: 10_000 }).toBeGreaterThan(0.02);
  });

  test('an uploaded animation clip is fetched from the server and plays in the preview', async ({ page, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await login(page);
    await openSetup(page, '3D model · kurisu_v2.vrm');
    const preview = page.getByTestId('vrm-preview');
    await expect(preview).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

    await page.getByRole('button', { name: /Fine-tune/ }).click();
    await page.locator('input[accept=".vrma"]').setInputFiles({
      name: 'turn.vrma', mimeType: 'application/octet-stream', buffer: VRMA_CLIP_BYTES,
    });
    await expect(page.getByText('turn', { exact: true })).toBeVisible({ timeout: 10_000 });

    const clip = mock.getPersonas()[0].character_config?.vrm?.clips[0];
    expect(clip, 'the clip reached the store').toBeTruthy();
    await expect.poll(() => requestsFor(mock, clip!.url), { timeout: 30_000 }).toContainEqual([BEARER, 200]);

    await page.getByRole('button', { name: 'Play in the preview' }).click();
    await expect(preview).toHaveAttribute('data-status', 'ready');
    expect(pageErrors).toEqual([]);
  });

  test('removing the model leaves the persona with none, on the server and in the setup', async ({ page, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    await login(page);
    await openSetup(page, '3D model · kurisu_v2.vrm');
    await expect(page.getByTestId('vrm-preview')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

    // "Her model" is the step that is open when the setup opens on a model.
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Remove model' }).click();

    await expect(page.getByText('Drop a .vrm file here')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('vrm-preview')).toHaveCount(0);
    expect(mock.getPersonas()[0].character_config?.vrm?.model ?? null).toBeNull();
  });

  test('the character window fetches the model with the session token and draws it', async ({ page, electronApp, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const composer = await login(page);
    const characterPage = await openCharacterWindow(page, electronApp);

    await send(page, composer, 'Hello');
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });

    const surface = characterPage.getByTestId('character-surface');
    await expect(surface).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    expect(requestsFor(mock, MODEL_PATH)[0]).toEqual([BEARER, 200]);
    await expect.poll(() => redShare(characterPage, '[data-testid="character-surface"] canvas'), { timeout: 10_000 }).toBeGreaterThan(0.02);
  });

  test('two 3D personas in one conversation share one stage; the other waits on a card', async ({ page, electronApp, mock }) => {
    if (!mock.getPersonas().some((p) => p.id === 2)) mock.addPersona({ id: 2, name: 'Amadeus' } as never);
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    mock.setCharacterConfig(2, {
      ...VRM_CHARACTER_WITH_MODEL,
      vrm: { ...VRM_CHARACTER_WITH_MODEL.vrm!, model: { ...VRM_CHARACTER_WITH_MODEL.vrm!.model!, url: '/character-assets/2/vrm/model' } },
    });
    mock.setStream({
      chunks: [
        { content: 'Kurisu speaking.', role: 'assistant', delayMs: 150 },
        { content: 'Amadeus speaking.', role: 'assistant', delayMs: 150, personaId: 2, personaName: 'Amadeus' },
      ],
    });
    const composer = await login(page);
    const characterPage = await openCharacterWindow(page, electronApp);

    await send(page, composer, 'Both of you');
    await expect(page.getByText('Amadeus speaking.')).toBeVisible({ timeout: 15_000 });

    await expect(characterPage.getByTestId('character-surface')).toHaveCount(1);
    await expect(characterPage.getByTestId('character-surface')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(characterPage.getByTestId('character-waiting-card')).toHaveCount(1);
  });
});
