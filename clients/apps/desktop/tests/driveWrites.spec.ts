/**
 * Writing to Kurisu Drive (#312): upload, download, rename, move, delete and
 * saving an edit, each checked against the mock's drive — the copy every one
 * of my devices sees. `drive.spec.ts` has the reading side.
 *
 * Upload and download go through the main process (`electron/driveTransfers.ts`):
 * the file picker is a native dialog, replaced for the run, and downloads land
 * in the app's Downloads folder, pointed at the test's own directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Sources', { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function enterDrive(page: Page) {
  await page.getByRole('row', { name: /Kurisu Drive/ }).first().dblclick();
  await expect(page.getByRole('columnheader', { name: 'Where it lives' })).toBeVisible({ timeout: 15_000 });
}

const cell = (page: Page, name: string) => page.getByRole('cell', { name, exact: true });

async function menuOn(page: Page, name: string, item: string) {
  await cell(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('writing to Kurisu Drive', () => {
  test('Upload puts the picked file on the drive, in the folder on screen', async ({ page, mock, electronApp }) => {
    mock.addDriveEntry({ path: '/Receipts', isDir: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-upload-'));
    const local = path.join(dir, 'march.txt');
    fs.writeFileSync(local, 'coffee 4.50\nbread 3.20\n');
    await electronApp.evaluate(({ dialog }, picked) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, local);

    try {
      await signIn(page);
      await enterDrive(page);
      await cell(page, 'Receipts').dblclick();
      await page.getByRole('button', { name: 'Upload', exact: true }).click();

      await expect(cell(page, 'march.txt')).toBeVisible({ timeout: 15_000 });
      expect(mock.getDriveContent('/Receipts/march.txt')?.toString('utf8')).toBe('coffee 4.50\nbread 3.20\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Download brings the server\'s bytes to this computer', async ({ page, mock, electronApp }) => {
    mock.addDriveEntry({ path: '/report.md', content: '# Q3\nRevenue up.' });
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-downloads-'));
    await electronApp.evaluate(({ app }, dir) => app.setPath('downloads', dir), downloads);

    try {
      await signIn(page);
      await enterDrive(page);
      await cell(page, 'report.md').click();
      await page.getByRole('button', { name: 'Download', exact: true }).click();

      const landed = path.join(downloads, 'report.md');
      await expect.poll(() => fs.existsSync(landed) && fs.readFileSync(landed, 'utf8'), { timeout: 15_000 }).toBe('# Q3\nRevenue up.');
      // No partial file is left behind.
      expect(fs.readdirSync(downloads)).toEqual(['report.md']);
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
    }
  });

  test('Rename renames it on the server', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/draft.md', content: 'hello' });
    await signIn(page);
    await enterDrive(page);
    await menuOn(page, 'draft.md', 'Rename');
    const dialog = page.getByRole('dialog', { name: 'Rename' });
    await dialog.getByRole('textbox').fill('final.md');
    await dialog.getByRole('button', { name: 'Rename' }).click();

    await expect(cell(page, 'final.md')).toBeVisible({ timeout: 10_000 });
    expect(mock.getDrivePaths()).toEqual(['/final.md']);
    expect(mock.getDriveContent('/final.md')?.toString('utf8')).toBe('hello');
  });

  test('Cut and Paste moves it into another folder on the server', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/Archive', isDir: true });
    mock.addDriveEntry({ path: '/old.md', content: 'last year' });
    await signIn(page);
    await enterDrive(page);
    await menuOn(page, 'old.md', 'Cut');
    await cell(page, 'Archive').dblclick();
    await expect(page.getByText(/^This folder is empty/)).toBeVisible({ timeout: 10_000 });
    // The folder's own menu is on the space around the rows.
    const pane = page.getByRole('table').locator('..');
    const box = (await pane.boundingBox())!;
    await pane.click({ button: 'right', position: { x: box.width / 2, y: box.height - 20 } });
    await page.getByRole('menuitem', { name: 'Paste (old.md)' }).click();

    await expect(cell(page, 'old.md')).toBeVisible({ timeout: 10_000 });
    expect(mock.getDrivePaths()).toEqual(['/Archive', '/Archive/old.md']);
  });

  test('Delete takes it off the server', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/scratch.md', content: 'tmp' });
    mock.addDriveEntry({ path: '/keep.md', content: 'keep' });
    await signIn(page);
    await enterDrive(page);
    await menuOn(page, 'scratch.md', 'Delete');

    await expect(cell(page, 'scratch.md')).toHaveCount(0, { timeout: 10_000 });
    expect(mock.getDrivePaths()).toEqual(['/keep.md']);
  });

  test('an edit saved with Ctrl+S is the drive\'s copy', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/todo.md', content: 'buy milk' });
    await signIn(page);
    await enterDrive(page);
    await cell(page, 'todo.md').dblclick();
    await expect(page.getByText('buy milk')).toBeVisible({ timeout: 15_000 });

    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nbuy eggs');
    await page.keyboard.press('Control+s');

    // The editor breaks the line the platform's way (CRLF on Windows).
    await expect.poll(() => mock.getDriveContent('/todo.md')?.toString('utf8').replace(/\r\n/g, '\n'), { timeout: 10_000 }).toBe('buy milk\nbuy eggs');
  });

  test('a name the server refuses says why, and nothing changes', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/draft.md', content: 'hello' });
    await signIn(page);
    await enterDrive(page);
    await menuOn(page, 'draft.md', 'Rename');
    const dialog = page.getByRole('dialog', { name: 'Rename' });
    await dialog.getByRole('textbox').fill('notes\\draft.md');
    await dialog.getByRole('button', { name: 'Rename' }).click();

    await expect(page.getByText('A name cannot contain a slash or a null byte.')).toBeVisible({ timeout: 10_000 });
    expect(mock.getDrivePaths()).toEqual(['/draft.md']);
  });
});
