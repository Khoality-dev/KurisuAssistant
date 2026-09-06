/**
 * Kurisu Drive in the running app (#17).
 *
 * The unit tests pin `fileSource`'s routing and the store's lifecycle against
 * stubs. This pins what those cannot: that the explorer really does show two
 * roots, that clicking through to the drive lists what the server has, and that
 * a row says where it lives — which is the whole point of putting the drive
 * *in* the explorer rather than beside it.
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

/**
 * The ActivityBar wraps each IconButton in a Tooltip/Box, so the button has no
 * intrinsic accessible name — the settings suite finds them by icon test id and
 * this does the same.
 */
function activityButton(page: Page, testId: string) {
  return page.locator('button').filter({ has: page.locator(`[data-testid="${testId}"]`) }).first();
}

/** Workspace is the landing page, so this is a wait, not a navigation. */
async function openWorkspace(page: Page) {
  await expect(page.getByText('Sources', { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Into the drive from the root listing, the way a user would. */
async function enterDrive(page: Page) {
  await page.getByRole('row', { name: /Kurisu Drive/ }).first().dblclick();
  await expect(page.getByRole('columnheader', { name: 'Where it lives' })).toBeVisible({ timeout: 15_000 });
}

test.describe('Kurisu Drive', () => {
  test('appears as a second root beside this computer', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/Reports/Q3-revenue-notes.md', content: '# Q3' });

    await signIn(page);
    await openWorkspace(page);

    // The sources tree is the design's headline: one explorer, two roots.
    await expect(page.getByText('Kurisu Drive').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Where it lives' })).toBeVisible();
  });

  test('lists what the server holds', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/Reports/Q3-revenue-notes.md', content: '# Q3 revenue notes' });
    mock.addDriveEntry({ path: '/Notes/reading-list.md', content: '# Reading list' });

    await signIn(page);
    await openWorkspace(page);
    await enterDrive(page);

    await expect(page.getByRole('cell', { name: 'Reports', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('cell', { name: 'Notes', exact: true })).toBeVisible();
  });

  test("opens a drive file in the editor with the server's bytes", async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/Notes/reading-list.md', content: '# Reading list\nSilero VAD paper' });

    await signIn(page);
    await openWorkspace(page);
    await enterDrive(page);

    await page.getByRole('cell', { name: 'Notes', exact: true }).dblclick();
    await page.getByRole('cell', { name: 'reading-list.md', exact: true }).dblclick();

    await expect(page.getByText('Silero VAD paper')).toBeVisible({ timeout: 15_000 });
  });

  test('shows how full the drive is', async ({ page, mock }) => {
    mock.addDriveEntry({ path: '/big.bin', content: 'x'.repeat(4096) });

    await signIn(page);
    await openWorkspace(page);

    // The quota bar sits at the foot of the sources tree, so the ceiling is
    // learned before an upload is refused rather than by being refused.
    await expect(page.getByText(/of [\d.]+ GB/)).toBeVisible({ timeout: 15_000 });
  });

  test('creating a folder on the drive puts it on the server', async ({ page, mock }) => {
    await signIn(page);
    await openWorkspace(page);
    await enterDrive(page);

    await page.locator('button')
      .filter({ has: page.locator('[data-testid="CreateNewFolderIcon"]') })
      .first()
      .click();
    await page.getByPlaceholder('folder-name').fill('Receipts');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect(page.getByRole('cell', { name: 'Receipts', exact: true })).toBeVisible({ timeout: 15_000 });
    expect(mock.getDrivePaths()).toContain('/Receipts');
  });

  test('the transfer tray is reachable and says when nothing is moving', async ({ page }) => {
    await signIn(page);

    // From the activity bar rather than the explorer, because a transfer keeps
    // running while the user is elsewhere.
    await activityButton(page, 'SwapVertIcon').click();

    await expect(page.getByText(/Nothing moving/)).toBeVisible({ timeout: 10_000 });
  });

  test("Settings carries the assistant's drive policy", async ({ page }) => {
    await signIn(page);

    await activityButton(page, 'SettingsOutlinedIcon').click();
    await page.getByText('Kurisu Drive', { exact: true }).first().click();

    await expect(page.getByRole('heading', { name: 'Kurisu Drive' })).toBeVisible({ timeout: 15_000 });
    // The three the design names, and the reason this is its own section rather
    // than four switches in Tools & MCP.
    await expect(page.getByText('Read only')).toBeVisible();
    await expect(page.getByText('Ask before writing')).toBeVisible();
    await expect(page.getByText('Full access')).toBeVisible();
  });
});
