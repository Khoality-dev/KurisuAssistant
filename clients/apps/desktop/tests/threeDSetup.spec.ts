/**
 * The 3D setup's refusals and its other four steps (#312). `vrm.spec.ts` has
 * the model and the clips, drawn with SwiftShader; this needs no WebGL: a
 * refused upload is the server's answer turned into a card, and each step's
 * choice is autosaved into the persona's `character_config` on the mock.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { VRM_CHARACTER_WITH_MODEL } from './mock/server';
import { VRM_MODEL_BYTES, buildGlb } from './mock/vrmFixture';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openSetup(page: Page, cardText: string) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first().click();
  await page.getByText('Personas', { exact: true }).first().click();
  await page.getByText(cardText).click();
  await page.getByRole('button', { name: /Set up 3D character/ }).click();
}

async function uploadModel(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[accept=".vrm"]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
}

test.describe('the 3D setup refuses what it cannot use', () => {
  test.beforeEach(({ mock }) => {
    mock.setCharacterConfig(1, { kind: 'vrm' } as never);
  });

  test('a file that is not a 3D model at all', async ({ page, mock }) => {
    await login(page);
    await openSetup(page, '3D model · none uploaded');
    await uploadModel(page, 'notes.vrm', Buffer.from('these are my notes, not a model'));
    await expect(page.getByText('That file isn’t a 3D model')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('notes.vrm isn’t a .vrm file.', { exact: false })).toBeVisible();
    expect(mock.getPersonas()[0].character_config?.vrm?.model ?? null).toBeNull();
  });

  test('a plain 3D file that is not a VRM', async ({ page, mock }) => {
    await login(page);
    await openSetup(page, '3D model · none uploaded');
    await uploadModel(page, 'cube.vrm', buildGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }] }));
    await expect(page.getByText('That file isn’t a VRM model')).toBeVisible({ timeout: 10_000 });
    expect(mock.lastCharacterUpload?.status).toBe(415);
    expect(mock.getPersonas()[0].character_config?.vrm?.model ?? null).toBeNull();

    // Dismiss puts the drop zone back.
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('Drop a .vrm file here')).toBeVisible();
  });

  test('a model that does not fit in the space left', async ({ page, mock }) => {
    mock.setCharacterQuotaBytes(1024);
    await login(page);
    await openSetup(page, '3D model · none uploaded');
    await uploadModel(page, 'kurisu.vrm', VRM_MODEL_BYTES);
    await expect(page.getByText('No room left for 3D files')).toBeVisible({ timeout: 10_000 });
    expect(mock.lastCharacterUpload?.status).toBe(507);
    expect(mock.getPersonas()[0].character_config?.vrm?.model ?? null).toBeNull();
  });
});

test.describe('the 3D setup\'s steps', () => {
  test('each step\'s choice is saved to the persona on the server', async ({ page, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    await login(page);
    await openSetup(page, '3D model · kurisu_v2.vrm');
    const saved = page.getByText('Saved', { exact: true });
    const vrm = () => mock.getPersonas()[0].character_config!.vrm!;

    await page.getByRole('button', { name: /How she moves/ }).click();
    await page.getByRole('button', { name: /Calm/ }).click();
    await expect.poll(() => vrm().idle.breath_period_ms, { timeout: 10_000 }).toBe(5200);

    await page.getByRole('button', { name: /^3 Feelings/ }).click();
    await page.getByRole('button', { name: 'Strong', exact: true }).click();
    await expect.poll(() => vrm().emotion.intensity, { timeout: 10_000 }).toBe(1);
    // Her usual face is a chip; the buttons under the preview only try one.
    await page.locator('.MuiChip-root', { hasText: /^Sad$/ }).click();
    await expect.poll(() => vrm().emotion.default_expression, { timeout: 10_000 }).toBe('sad');

    await page.getByRole('button', { name: /^4 Reactions/ }).click();
    const waving = () => vrm().reactions.some((r: { id: string }) => r.id === 'wave');
    const before = waving();
    await page.getByText('Waves back when you wave').click();
    await expect.poll(waving, { timeout: 10_000 }).toBe(!before);

    await page.getByRole('button', { name: /^5 Framing/ }).click();
    await page.getByRole('button', { name: 'Face', exact: true }).click();
    await expect.poll(() => vrm().camera.target, { timeout: 10_000 }).toBe('head');

    await expect(saved).toBeVisible();
    // The model the steps were set up around is untouched.
    expect(vrm().model).toEqual(VRM_CHARACTER_WITH_MODEL.vrm!.model);
  });
});
