/**
 * Exporting a persona with its character, and importing it back (#248).
 *
 * The unit tests pin the request shapes and the dialog's sentences; this pins
 * that the real Settings screen asks the server what the character weighs
 * before the download, that "Export" with the box ticked saves a zip holding
 * the model, that unticking it saves the JSON file, and that picking a .zip in
 * Import sends it to the bundle route and shows the new persona with its model.
 * Downloads are caught in the main process and written to the test's own
 * directory, so no save dialog opens.
 */

import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { VRM_CHARACTER_WITH_MODEL } from './mock/server';
import { VRM_MODEL_BYTES, VRM_MODEL_SHA256 } from './mock/vrmFixture';
import { readZip } from './mock/zip';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openPersonas(page: Page) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('Personas', { exact: true }).first().click();
}

/** Save every download into `dir` under the name the page gave it, and hand back the saved paths. */
async function catchDownloads(electronApp: ElectronApplication, dir: string): Promise<() => string[]> {
  await electronApp.evaluate(({ session }, target) => {
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(`${target}/${item.getFilename()}`);
    });
  }, dir);
  return () => fs.readdirSync(dir).map((name) => path.join(dir, name));
}

function exportButtonOf(page: Page, cardText: string) {
  return page.getByText(cardText).locator('xpath=ancestor::*[.//button[@aria-label="Export"]][1]')
    .getByRole('button', { name: 'Export' });
}

test.describe('persona export and import with the character', () => {
  test('the dialog says what the character weighs, and the zip holds the model', async ({ page, mock, electronApp, appPaths }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const saved = fs.mkdtempSync(path.join(appPaths.userDataDir, 'downloads-'));
    const downloads = await catchDownloads(electronApp, saved);

    await login(page);
    await openPersonas(page);
    await exportButtonOf(page, '3D model · kurisu_v2.vrm').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Export Kurisu')).toBeVisible();
    const include = dialog.getByLabel(/Its 3D character · 1 file · 0\.0 MB/);
    await expect(include).toBeChecked({ timeout: 10_000 });
    await expect(dialog.getByText(/Importing it uses 0\.0 MB of the 3D character storage/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByText('Persona "Kurisu" exported with its character.', { exact: false })).toBeVisible();
    expect(mock.lastExportRequest).toEqual({ personaId: 1, character: true });

    await expect.poll(() => downloads().filter((f) => f.endsWith('Kurisu.zip')).length, { timeout: 10_000 }).toBe(1);
    const zipPath = downloads().find((f) => f.endsWith('Kurisu.zip'))!;
    await expect.poll(() => readZip(fs.readFileSync(zipPath)) !== null).toBe(true);
    const files = readZip(fs.readFileSync(zipPath))!;
    expect(JSON.parse(files.get('persona.json')!.toString('utf8')).version).toBe(4);
    expect(files.get(`character/vrm/${VRM_MODEL_SHA256}.vrm`)!.equals(VRM_MODEL_BYTES)).toBe(true);
  });

  test('unticking the box exports the JSON file alone', async ({ page, mock, electronApp, appPaths }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const saved = fs.mkdtempSync(path.join(appPaths.userDataDir, 'downloads-'));
    const downloads = await catchDownloads(electronApp, saved);

    await login(page);
    await openPersonas(page);
    await exportButtonOf(page, '3D model · kurisu_v2.vrm').click();
    const dialog = page.getByRole('dialog');
    const include = dialog.getByLabel(/Its 3D character/);
    await expect(include).toBeChecked({ timeout: 10_000 });
    await include.uncheck();
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();

    await expect(page.getByText('Persona "Kurisu" exported. Avatar, voice and character stay behind.')).toBeVisible();
    expect(mock.lastExportRequest).toEqual({ personaId: 1, character: false });
    await expect.poll(() => downloads().filter((f) => f.endsWith('Kurisu.json')).length, { timeout: 10_000 }).toBe(1);
  });

  test('a .zip picked in Import comes back as a new persona with its model', async ({ page, mock, appPaths }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const bundle = await fetch(`${mock.url}/personas/1/export?character=true`).then((r) => r.arrayBuffer());
    const bundlePath = path.join(appPaths.userDataDir, 'Kurisu.zip');
    fs.writeFileSync(bundlePath, Buffer.from(bundle));

    await login(page);
    await openPersonas(page);
    await page.locator('input[type="file"][accept=".zip,.json"]').setInputFiles(bundlePath);

    await expect(page.getByText('Persona "Kurisu (2)" imported with its character.')).toBeVisible({ timeout: 10_000 });
    expect(mock.lastBundleImport).toEqual({ bytes: bundle.byteLength, personaId: 2 });
    await expect(page.getByText('3D model · kurisu_v2.vrm')).toHaveCount(2);
  });

  test('a bundle that does not fit the 3D storage says so and adds nothing', async ({ page, mock, appPaths }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    const bundle = await fetch(`${mock.url}/personas/1/export?character=true`).then((r) => r.arrayBuffer());
    const bundlePath = path.join(appPaths.userDataDir, 'Kurisu.zip');
    fs.writeFileSync(bundlePath, Buffer.from(bundle));
    mock.setCharacterQuotaBytes(VRM_MODEL_BYTES.length + 10);

    await login(page);
    await openPersonas(page);
    await page.locator('input[type="file"][accept=".zip,.json"]').setInputFiles(bundlePath);

    await expect(page.getByText(/That persona's 3D character does not fit/)).toBeVisible({ timeout: 10_000 });
    expect(mock.lastBundleImport?.personaId).toBeNull();
    expect(mock.getPersonas()).toHaveLength(1);
  });
});
