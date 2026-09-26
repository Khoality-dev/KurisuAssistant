/**
 * A VRM persona draws a real frame in the character window (#240). @gpu
 *
 * Not run on CI and not run by default: CI's Electron has no GPU and gets no
 * GPU flags, so WebGL is never proven there (docs/testing.md, "Manual GPU
 * checklist"). A developer runs it with a real VRoid export:
 *
 *   KURISU_E2E_GPU=1 KURISU_VRM_FILE=/path/to/model.vrm \
 *   KURISU_E2E_ELECTRON_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader" \
 *   npx playwright test tests/vrmRender.gpu.spec.ts
 *
 * The model goes into the mock's store and the window has to fetch it from
 * there. It used to be answered by route interception, which matched the path
 * under any origin — a model asked of `file://` (#298) would have passed.
 * That the fetch reaches the server is also covered on CI by vrm.spec.ts,
 * with the fixture model and SwiftShader; this spec is for a real export.
 */

import { test, expect } from './fixtures';
import fs from 'fs';
import type { Page } from '@playwright/test';

const MODEL_FILE = process.env.KURISU_VRM_FILE ?? '';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  const composer = page.getByPlaceholder('Type your message...');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

test.describe('VRM in the character window @gpu', () => {
  test.skip(!MODEL_FILE || !fs.existsSync(MODEL_FILE), 'set KURISU_VRM_FILE to a .vrm exported from VRoid Studio');

  test('loads the model and draws a frame that is not one flat colour @gpu', async ({ page, electronApp, mock }) => {
    const bytes = fs.readFileSync(MODEL_FILE);
    mock.setCharacterConfig(1, {
      kind: 'vrm',
      vrm: {
        model: {
          url: '/character-assets/1/vrm/model',
          sha256: '0'.repeat(64),
          bytes: bytes.byteLength,
          uploaded_at: '2026-09-22T00:00:00Z',
        },
        clips: [],
        reactions: [],
        idle: {
          procedural: true, arms_lowered: true, breath_period_ms: 4000, breath_amplitude_deg: 2,
          sway_amplitude_deg: 1.5, sway_period_ms: 7000,
          blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
          look_at: 'camera', idle_clip_ids: [], idle_clip_interval_ms: [8000, 20000],
        },
        emotion: { enabled: true, default_expression: 'neutral', intensity: 1, attack_ms: 180, release_ms: 400 },
        camera: { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' },
      },
    } as never);
    mock.setCharacterFile('/character-assets/1/vrm/model', bytes);
    const composer = await login(page);

    await page.getByRole('button', { name: 'Show character' }).click();
    const [characterPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.getByRole('button', { name: 'Pop out character' }).click(),
    ]);
    characterPage.on('pageerror', (err) => console.log('[character pageerror]', err.message));

    await composer.fill('Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const surface = characterPage.locator('[data-testid="character-surface"][data-status="ready"]');
    await expect(surface).toBeVisible({ timeout: 60_000 });

    // Read the stage back inside a frame, after the driver has drawn into it.
    const distinct = await characterPage.evaluate(() => new Promise<number>((resolve) => {
      requestAnimationFrame(() => {
        const canvas = document.querySelector('[data-testid="character-surface"] canvas') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
        if (!canvas || !gl) return resolve(0);
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const seen = new Set<number>();
        for (let i = 0; i < px.length; i += 4 * 97) seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        resolve(seen.size);
      });
    }));
    expect(distinct).toBeGreaterThan(8);
  });
});
