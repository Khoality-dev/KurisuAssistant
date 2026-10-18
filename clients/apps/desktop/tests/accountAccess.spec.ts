/**
 * Handing my account to another device, and letting a program run on this
 * one (#312).
 *
 * The login QR (Settings → Account) is read module by module from the canvas
 * and compared with the code `qrcode` makes for the payload the Android client
 * expects (`{v, server, username, password}`), so a blank or wrong code fails.
 * The spawn consent (`electron/mcp.ts askToSpawn`) is a native dialog no
 * Playwright locator reaches: the main process's `dialog.showMessageBox` is
 * replaced for the run, recording what it was asked and answering for me.
 */
import QRCode from 'qrcode';
import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openSection(page: Page, section: string) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first().click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(section, { exact: true }).first().click();
}

/** Each module of the canvas's code, dark or light, sampled at its centre. */
async function readModules(page: Page, size: number, margin: number): Promise<boolean[]> {
  return page.locator('[role="dialog"] canvas').evaluate((canvas: HTMLCanvasElement, { size, margin }) => {
    const ctx = canvas.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cell = canvas.width / (size + 2 * margin);
    const dark: boolean[] = [];
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const x = Math.floor((col + margin + 0.5) * cell);
        const y = Math.floor((row + margin + 0.5) * cell);
        const i = (y * canvas.width + x) * 4;
        // Opaque and dark: a blank canvas is transparent black, which is no code.
        dark.push(data[i + 3] > 128 && data[i] < 128);
      }
    }
    return dark;
  }, { size, margin });
}

test.describe('the login QR code', () => {
  test('after my password, it holds the server, my username and my password', async ({ page, mock }) => {
    mock.setPassword('correct horse');
    await login(page);
    await openSection(page, 'Account');
    await page.getByRole('button', { name: 'Show login QR' }).click();

    const dialog = page.getByRole('dialog', { name: 'Login QR code' });
    await dialog.getByLabel('Password').fill('correct horse');
    await dialog.getByRole('button', { name: 'Generate' }).click();
    await expect(dialog.getByText('Anyone who scans this can sign in as you.')).toBeVisible();

    const username = (await (await fetch(`${mock.url}/users/me`)).json()).username;
    const payload = JSON.stringify({ v: 1, server: mock.url, username, password: 'correct horse' });
    const expected = QRCode.create(payload, { errorCorrectionLevel: 'M' }).modules;
    const read = await readModules(page, expected.size, 2);
    const want = Array.from({ length: expected.size * expected.size }, (_, i) => !!expected.data[i]);
    expect(read.filter(Boolean).length).toBeGreaterThan(0);
    expect(read).toEqual(want);
  });

  test('a wrong password makes no code, and says so', async ({ page, mock }) => {
    mock.setPassword('correct horse');
    await login(page);
    await openSection(page, 'Account');
    await page.getByRole('button', { name: 'Show login QR' }).click();

    const dialog = page.getByRole('dialog', { name: 'Login QR code' });
    await dialog.getByLabel('Password').fill('battery staple');
    await dialog.getByRole('button', { name: 'Generate' }).click();
    await expect(dialog.getByText('Incorrect username or password')).toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('canvas')).toHaveCount(0);
    // Still signed in: checking a password is not signing in again.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByLabel('Username')).toHaveCount(0);
  });
});

/** Answer the spawn consent with `button` and record what it showed. */
async function answerConsent(electronApp: ElectronApplication, button: 'Cancel' | 'Allow once' | 'Always allow') {
  await electronApp.evaluate(({ dialog }, answer) => {
    const g = globalThis as unknown as { __consents: unknown[] };
    g.__consents = [];
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_window: unknown, options: { buttons: string[] }) => {
      g.__consents.push(options);
      return { response: options.buttons.indexOf(answer), checkboxChecked: false };
    };
  }, button);
  return () => electronApp.evaluate(() => (globalThis as unknown as { __consents: Array<Record<string, unknown>> }).__consents);
}

test.describe('the consent before a program runs here', () => {
  test('starting Playwright asks first, names the command line, and Cancel runs nothing', async ({ page, electronApp, appPaths }) => {
    const consents = await answerConsent(electronApp, 'Cancel');
    await login(page);
    await openSection(page, 'Tools');

    // The row opens to show its actions.
    await page.getByText('Playwright', { exact: true }).click();
    await page.getByRole('button', { name: 'Reconnect' }).click();

    await expect.poll(async () => (await consents()).length, { timeout: 10_000 }).toBe(1);
    const [asked] = await consents();
    expect(asked).toMatchObject({
      title: 'Run a local MCP server?',
      message: 'An MCP server wants to run a program on this computer.',
      buttons: ['Cancel', 'Allow once', 'Always allow'],
    });
    expect(String(asked.detail)).toMatch(/^Playwright would run:\n\nnpx -y @playwright\/mcp@/);
    await expect(page.getByText('Playwright', { exact: true }).locator('..').getByText('Not running')).toBeVisible();
    // Nothing was approved for next time.
    const fs = await import('fs');
    const settings = fs.existsSync(appPaths.settingsFile) ? JSON.parse(fs.readFileSync(appPaths.settingsFile, 'utf-8')) : {};
    expect(JSON.stringify(settings)).not.toContain('@playwright/mcp');
  });
});
