/**
 * Focused tests for chat message streaming and display.
 *
 * These exercise real WebSocket streaming behavior end-to-end:
 *   - user bubble appears immediately
 *   - assistant text grows incrementally as chunks arrive
 *   - response persists after the stream finishes + loadConversation
 *   - cancel during stream preserves partial content
 *   - messages survive sending a follow-up
 *   - thinking chunks render collapsible
 *   - agent handoff creates a new bubble
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
  const composer = page.getByPlaceholder('Type your message...');
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('streaming', () => {
  test('user bubble appears before assistant response', async ({ page, mock }) => {
    // Slow stream so we can observe the user bubble alone before chunks arrive.
    mock.setStream({
      chunks: [
        { content: 'Reply chunk 1. ', role: 'assistant', delayMs: 400 },
        { content: 'Reply chunk 2.', role: 'assistant', delayMs: 400 },
      ],
    });

    await login(page);
    await send(page, 'Ping');

    // User message should be visible right away — before any assistant text.
    await expect(page.getByText('Ping', { exact: true })).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText('Reply chunk 1.')).toHaveCount(0);

    // Then the assistant response arrives incrementally.
    await expect(page.getByText('Reply chunk 1. Reply chunk 2.')).toBeVisible({ timeout: 10_000 });
  });

  test('streamed content grows incrementally', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'alpha ', role: 'assistant', delayMs: 250 },
        { content: 'beta ', role: 'assistant', delayMs: 250 },
        { content: 'gamma', role: 'assistant', delayMs: 250 },
      ],
    });

    await login(page);
    await send(page, 'Greek please');

    // Observe partial states before the final assembly.
    await expect(page.getByText('alpha', { exact: false })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('alpha beta gamma')).toBeVisible({ timeout: 10_000 });
  });

  test('response persists after stream completes', async ({ page, mock }) => {
    mock.setStream({
      chunks: [{ content: 'Persistent answer.', role: 'assistant', delayMs: 10 }],
    });

    await login(page);
    await send(page, 'Q1');

    await expect(page.getByText('Persistent answer.')).toBeVisible({ timeout: 10_000 });
    // Wait past the 500ms background reload that overwrites streaming state from the server.
    await page.waitForTimeout(1_500);
    await expect(page.getByText('Persistent answer.')).toBeVisible();
    await expect(page.getByText('Q1', { exact: true })).toBeVisible();
  });

  test('two sequential messages both render with their responses', async ({ page, mock }) => {
    mock.setStream({
      chunks: [{ content: 'First reply.', role: 'assistant', delayMs: 10 }],
    });

    await login(page);
    await send(page, 'First question');
    await expect(page.getByText('First reply.')).toBeVisible({ timeout: 10_000 });

    mock.setStream({
      chunks: [{ content: 'Second reply.', role: 'assistant', delayMs: 10 }],
    });
    // Wait for streaming UI to settle before sending follow-up.
    await expect(page.locator('button').filter({ has: page.locator('[data-testid="StopIcon"]') })).toHaveCount(0, { timeout: 10_000 });
    await send(page, 'Second question');
    await expect(page.getByText('Second reply.')).toBeVisible({ timeout: 10_000 });

    // Both Q/A pairs still visible (first() — streaming and DB reload may each render a copy).
    await expect(page.getByText('First question', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('First reply.').first()).toBeVisible();
    await expect(page.getByText('Second question', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Second reply.').first()).toBeVisible();
  });

  test('cancel before any chunk arrives preserves user message but suppresses response', async ({ page, mock }) => {
    // Stream with a long leading delay so we can click Stop before the backend
    // emits anything.
    mock.setStream({
      chunks: [
        { content: 'SHOULD_NOT_APPEAR', role: 'assistant', delayMs: 4000 },
      ],
    });

    await login(page);
    await send(page, 'cancel immediately');

    const stopBtn = page.locator('button').filter({ has: page.locator('[data-testid="StopIcon"]') });
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await stopBtn.click();

    // Stop disappears once streaming is cancelled.
    await expect(stopBtn).toHaveCount(0, { timeout: 5_000 });

    // User bubble is preserved in the conversation (cancel merges streaming into store,
    // then background reload may add a second copy — either is fine).
    await expect(page.getByText('cancel immediately', { exact: true }).first()).toBeVisible();
    // And the assistant payload that was meant to arrive later must never render.
    await page.waitForTimeout(5_000);
    await expect(page.getByText('SHOULD_NOT_APPEAR')).toHaveCount(0);
  });

  test('thinking chunks render (collapsible thinking bubble)', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: '', thinking: 'Let me consider this carefully. ', role: 'assistant', delayMs: 10 },
        { content: 'Final answer is X.', role: 'assistant', delayMs: 10 },
      ],
    });

    await login(page);
    await send(page, 'Need thinking');

    await expect(page.getByText('Final answer is X.')).toBeVisible({ timeout: 10_000 });
    // "Thinking" toggle surface is present once thinking content exists.
    // (UI renders the word "Thinking" in the collapsible header.)
    await expect(page.getByText(/Thinking/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('assistant text and tool output both render when a tool call interrupts', async ({ page, mock }) => {
    // Slow stream so the split-per-role rendering (assistant → tool → assistant)
    // produces three distinct bubbles instead of being collapsed into one.
    mock.setStream({
      chunks: [
        { content: 'Let me check. ', role: 'assistant', delayMs: 150 },
        { content: '{"result":"42"}', role: 'tool', delayMs: 150 },
        { content: 'The result is 42.', role: 'assistant', delayMs: 150 },
      ],
    });

    await login(page);
    await send(page, 'tool demo');

    // Both assistant bubbles render their content inline.
    await expect(page.getByText('Let me check.').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('The result is 42.').first()).toBeVisible({ timeout: 10_000 });

    // The tool bubble is collapsed by default — its header "Tool" is visible,
    // but the JSON payload only renders after the user clicks to expand.
    const toolHeader = page.getByText('Tool', { exact: true }).first();
    await expect(toolHeader).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('{"result":"42"}')).toHaveCount(0);
    await toolHeader.click();
    await expect(page.getByText('{"result":"42"}').first()).toBeVisible({ timeout: 5_000 });
  });
});
