import { test, expect } from './fixtures';

test.describe('smoke', () => {
  test('login form renders', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'KurisuAssistant' })).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
  });

  test('login → main layout loads', async ({ page }) => {
    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    // Chat composer is only mounted once MainLayout has rendered.
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
  });

  test('send message receives streamed response', async ({ page, mock }) => {
    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    const composer = page.getByPlaceholder('Type your message...');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await composer.fill('Hello world');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Assistant stream concatenates to "Hello from mock backend."
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });

    // Mock saw a chat_request with the user's text
    expect(mock.lastChatRequest).not.toBeNull();
    expect(mock.lastChatRequest.text).toBe('Hello world');
  });

  test('custom stream script renders chunks in order', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'The ', role: 'assistant', delayMs: 5 },
        { content: 'answer ', role: 'assistant', delayMs: 5 },
        { content: 'is 42.', role: 'assistant', delayMs: 5 },
      ],
    });

    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    const composer = page.getByPlaceholder('Type your message...');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await composer.fill('What is the answer?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('The answer is 42.')).toBeVisible({ timeout: 15_000 });
  });
});
