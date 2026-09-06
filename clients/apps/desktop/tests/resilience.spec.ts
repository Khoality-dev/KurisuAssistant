/**
 * WebSocket resilience tests.
 *
 * Simulates a silent backend WebSocket drop (HTTP surface still healthy) and
 * verifies the client transparently reconnects on the next send — the user
 * should see their message + assistant stream without any broken state.
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

test.describe('websocket resilience', () => {
  test('send after silent WS drop reconnects and streams normally', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Reconnected ', role: 'assistant', delayMs: 50 },
        { content: 'and responding.', role: 'assistant', delayMs: 50 },
      ],
    });

    await login(page);

    // First send establishes the conversation + confirms WS works from the start.
    await send(page, 'warm up');
    await expect(page.getByText('Reconnected and responding.').first()).toBeVisible({ timeout: 10_000 });

    // Now silently drop the server-side socket. The backend is still up (HTTP ok),
    // but the socket is gone. The client should auto-reconnect with backoff.
    mock.dropAllWebSockets();

    // Give the client a moment to notice the close + schedule reconnect.
    await page.waitForTimeout(200);

    // User sends a new message. sendChatRequest awaits connect() which kicks off
    // the reconnect; once the WS opens, the queued message is flushed.
    mock.setStream({
      chunks: [
        { content: 'Second ', role: 'assistant', delayMs: 50 },
        { content: 'message streamed.', role: 'assistant', delayMs: 50 },
      ],
    });
    await send(page, 'after drop');

    // Response arrives. Allow a few seconds for the reconnect backoff (default 1s first attempt).
    await expect(page.getByText('Second message streamed.').first()).toBeVisible({ timeout: 15_000 });

    // No error toast is shown to the user (errors render as MUI Alert).
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });

  test('status indicator recovers to Online after drop + reconnect', async ({ page, mock }) => {
    await login(page);

    // Connection status indicator (ActivityBar) shows "Online" when connected.
    await expect(page.getByRole('button', { name: 'Online' })).toBeVisible({ timeout: 10_000 });

    mock.dropAllWebSockets();

    // Briefly shows Connecting / Offline between attempts — then returns to Online.
    await expect(page.getByRole('button', { name: 'Online' })).toBeVisible({ timeout: 15_000 });
  });
});
