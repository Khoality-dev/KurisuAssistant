/**
 * My session expiring while I use the app (#312).
 *
 * An access token lasts an hour and a refresh token thirty days (backend
 * CLAUDE.md, Authentication). When the first runs out the app refreshes on
 * the 401 — or on the socket's 4001 — and carries on without me noticing;
 * when the second has too, the session is over and I am back at sign-in.
 * The mock ages a token out on every route on request (`expireAccessToken`).
 */
import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('Type your message...').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function openConversations(page: Page) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
  }).first().click();
}

test.describe('a session that expires mid-use', () => {
  test('an expired token is refreshed on the next request, and the request goes through', async ({ page, mock }) => {
    mock.addConversation({ title: 'Trip plans', agoMinutes: 30, messages: [
      { role: 'user', content: 'Where should we go?' },
      { role: 'assistant', content: 'Somewhere warm.' },
    ] });
    await login(page);
    mock.expireAccessToken('test-access-token');

    await openConversations(page);
    await expect(page.getByRole('listitem').filter({ hasText: 'Trip plans' })).toBeVisible({ timeout: 10_000 });
    expect(mock.refreshCount).toBeGreaterThan(0);
    // Still signed in.
    await expect(page.getByLabel('Password')).toHaveCount(0);
  });

  test('a reconnect with an expired token refreshes, and the chat carries on', async ({ page, mock }) => {
    await login(page);
    mock.expireAccessToken('test-access-token');
    // The socket drops — a network blip — and comes back with the old token,
    // which the server now closes with 4001.
    mock.dropAllWebSockets();

    await expect.poll(() => mock.refreshCount, { timeout: 15_000 }).toBeGreaterThan(0);
    await send(page, 'Still there?');
    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Password')).toHaveCount(0);
  });

  test('when the session cannot be refreshed, I am back at sign-in', async ({ page, mock }) => {
    await login(page);
    mock.expireAccessToken('test-access-token');
    mock.refuseRefresh();

    // The next request finds out — this one, or one the app was making anyway,
    // which can sign out first and take the button with it.
    await Promise.race([
      openConversations(page).catch(() => undefined),
      page.getByLabel('Password').waitFor({ timeout: 10_000 }),
    ]);
    await expect(page.getByLabel('Password')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();

    // Signing in again works, with a token the server takes.
    mock.refuseRefresh(false);
    await login(page);
  });

  test('when only the chat finds the session over, I am back at sign-in too', async ({ page, mock }) => {
    await login(page);
    mock.expireAccessToken('test-access-token');
    mock.refuseRefresh();
    // Nothing but the socket notices: it drops, comes back with the old token,
    // is closed with 4001, and the refresh is refused.
    mock.dropAllWebSockets();
    await expect(page.getByLabel('Password')).toBeVisible({ timeout: 15_000 });
  });
});
