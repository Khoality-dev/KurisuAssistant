/**
 * The explorer on this computer's own files (#312): a folder the assistant
 * opens, and making, renaming, deleting and editing files in it — checked on
 * disk, in a temporary folder of the test's own.
 *
 * The folder is opened the way the assistant opens one (`app_open_folder`, one
 * of the app's own tools), which also works on Windows CI, where there is no
 * `/` to walk down from.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { MockBackend } from './mock/server';

let dir: string;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-local-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'first line');
  fs.mkdirSync(path.join(dir, 'Projects'));
});

test.afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

/** The assistant opens the test's folder. */
async function openFolder(page: Page, mock: MockBackend) {
  mock.setStream({
    chunks: [
      { content: '', role: 'tool', name: 'app_open_folder', onClient: true, toolArgs: { path: dir } },
      { content: 'It is open.', role: 'assistant', delayMs: 10 },
    ],
  });
  await page.getByPlaceholder('Type your message...').fill('Open my folder');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('It is open.').first()).toBeVisible({ timeout: 15_000 });
}

const cell = (page: Page, name: string) => page.getByRole('cell', { name, exact: true });

async function folderMenu(page: Page, item: string) {
  const pane = page.getByRole('table').locator('..');
  const box = (await pane.boundingBox())!;
  await pane.click({ button: 'right', position: { x: box.width / 2, y: box.height - 20 } });
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('the explorer on this computer', () => {
  test('a folder the assistant opens is the one on screen', async ({ page, mock }) => {
    await signIn(page);
    await openFolder(page, mock);
    await expect(cell(page, 'notes.txt')).toBeVisible({ timeout: 10_000 });
    await expect(cell(page, 'Projects')).toBeVisible();
    expect(mock.toolCallResponses[0]).toMatchObject({ tool: 'app_open_folder', isError: false });
  });

  test('New File and New Folder make them on disk', async ({ page, mock }) => {
    await signIn(page);
    await openFolder(page, mock);
    await expect(cell(page, 'notes.txt')).toBeVisible({ timeout: 10_000 });

    await folderMenu(page, 'New File');
    await page.getByPlaceholder('filename.txt').fill('ideas.md');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(cell(page, 'ideas.md')).toBeVisible({ timeout: 10_000 });
    expect(fs.existsSync(path.join(dir, 'ideas.md'))).toBe(true);

    await folderMenu(page, 'New Folder');
    await page.getByPlaceholder('folder-name').fill('Drafts');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(cell(page, 'Drafts')).toBeVisible({ timeout: 10_000 });
    expect(fs.statSync(path.join(dir, 'Drafts')).isDirectory()).toBe(true);
  });

  test('Rename and Delete change the disk', async ({ page, mock }) => {
    await signIn(page);
    await openFolder(page, mock);

    await cell(page, 'notes.txt').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename' });
    await dialog.getByRole('textbox').fill('journal.txt');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(cell(page, 'journal.txt')).toBeVisible({ timeout: 10_000 });
    expect(fs.readFileSync(path.join(dir, 'journal.txt'), 'utf8')).toBe('first line');
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(false);

    await cell(page, 'Projects').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(cell(page, 'Projects')).toHaveCount(0, { timeout: 10_000 });
    expect(fs.existsSync(path.join(dir, 'Projects'))).toBe(false);
  });

  test('an edit saved with Ctrl+S is on disk', async ({ page, mock }) => {
    await signIn(page);
    await openFolder(page, mock);
    await cell(page, 'notes.txt').dblclick();
    await expect(page.getByText('first line')).toBeVisible({ timeout: 15_000 });

    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nsecond line');
    await page.keyboard.press('Control+s');
    // The editor breaks the line the platform's way (CRLF on Windows).
    await expect.poll(() => fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n'), { timeout: 10_000 }).toBe('first line\nsecond line');
  });
});
