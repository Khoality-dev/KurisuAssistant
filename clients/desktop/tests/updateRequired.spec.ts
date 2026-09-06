/**
 * The wire-protocol gate must not be a dead end (#150).
 *
 *   - a mismatch found at startup shows both numbers, says which side to
 *     update, and "Change server" leads back to the login form with the
 *     Server URL editable
 *   - a 426 from a live server mid-session raises the same screen instead of
 *     a generic request failure
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { WIRE_PROTOCOL } from '../src/constants';
import { MOCK_BACKEND_VERSION } from './mock/server';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

test.describe('update required', () => {
  test('a newer server at startup names both numbers and offers a way back to the login form', async ({ page, mock }) => {
    // `mock` starts before Electron boots, so this is what `/version` says first.
    mock.setWireProtocol(WIRE_PROTOCOL + 1);
    await page.reload();

    await expect(page.getByText('Update required')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(`This app speaks wire protocol ${WIRE_PROTOCOL} but the server speaks ${WIRE_PROTOCOL + 1}. Update the app.`),
    ).toBeVisible();
    await expect(page.getByText(`Server: ${MOCK_BACKEND_VERSION} · wire ${WIRE_PROTOCOL + 1}`)).toBeVisible();

    await page.getByRole('button', { name: 'Change server' }).click();

    // Back on the login form, with the one field the user needs reachable.
    await expect(page.getByLabel('Server URL')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel('Server URL')).toHaveValue(mock.url);
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
  });

  test('an older server says the operator has to update', async ({ page, mock }) => {
    mock.setWireProtocol(WIRE_PROTOCOL - 1);
    await page.reload();

    await expect(page.getByText('Update required')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(`This app speaks wire protocol ${WIRE_PROTOCOL} but the server speaks ${WIRE_PROTOCOL - 1}. Ask the operator to update the server.`),
    ).toBeVisible();
  });

  test('a 426 on a request mid-session raises the same screen', async ({ page, mock }) => {
    await login(page);

    // The server is updated under a running client. The next REST call is
    // refused — opening Settings makes one, but a background request (tool
    // policies, the connection check) often gets there first, in which case
    // the gate has already replaced the layout and the button is gone. Either
    // way the screen must appear, so the click is a nudge, not an assertion.
    mock.setWireProtocol(WIRE_PROTOCOL + 1);
    const settingsBtn = page.locator('button').filter({
      has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
    }).first();
    await settingsBtn.click({ timeout: 5_000 }).catch(() => { /* already gated */ });

    await expect(page.getByText('Update required')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`Server: ${MOCK_BACKEND_VERSION} · wire ${WIRE_PROTOCOL + 1}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change server' })).toBeVisible();
  });
});
