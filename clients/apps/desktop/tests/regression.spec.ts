/**
 * Regression tests for known bug classes.
 *
 * These assert *exact counts* of bubbles/messages after a stream completes.
 * Running the suite against `npm run test:e2e:dev` (which uses a development
 * React build) re-enables React.StrictMode's updater double-invocation and
 * exposes side-effect-in-setState-updater bugs. In production builds the
 * duplication doesn't happen, so these tests pass there too.
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

test.describe('regression', () => {
  test('send produces exactly one user bubble and one assistant bubble (no duplication)', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Single ', role: 'assistant', delayMs: 20 },
        { content: 'answer.', role: 'assistant', delayMs: 20 },
      ],
    });

    await login(page);
    await send(page, 'unique-user-prompt-42');

    // Wait for the assistant text to settle (also waits past the 500ms DB reload).
    await expect(page.getByText('Single answer.').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_500);

    // The user's prompt should appear exactly once.
    const userBubbles = page.getByText('unique-user-prompt-42', { exact: true });
    await expect(userBubbles).toHaveCount(1);

    // The assistant reply should appear exactly once (no StrictMode double-append).
    const assistantBubbles = page.getByText('Single answer.');
    await expect(assistantBubbles).toHaveCount(1);
  });
});
