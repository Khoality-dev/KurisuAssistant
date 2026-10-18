/**
 * Attaching an image to a message (#312). The composer takes images dropped
 * on it; each goes to the server inside the `chat_request`, which stores it
 * and serves it back behind the token (`GET /images/u/{uuid}`).
 */
import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

/** A 1×1 PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

/** Drop files on the composer, as dragging them in from a file manager does. */
async function dropOnComposer(page: Page, files: Array<{ name: string; type: string; base64: string }>) {
  const composer = page.getByPlaceholder('Type your message...')
    .locator('xpath=ancestor::div[contains(@class, "MuiPaper-root")][1]');
  const dataTransfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    return dt;
  }, files);
  await composer.dispatchEvent('dragenter', { dataTransfer });
  await composer.dispatchEvent('dragover', { dataTransfer });
  await composer.dispatchEvent('drop', { dataTransfer });
}

test.describe('attaching images', () => {
  test('a dropped image goes with the message, and shows in my bubble', async ({ page, mock }) => {
    await login(page);
    await dropOnComposer(page, [{ name: 'receipt.png', type: 'image/png', base64: PNG_BASE64 }]);
    await expect(page.getByRole('button', { name: 'receipt.png' })).toBeVisible();

    await page.getByPlaceholder('Type your message...').fill('What does this say?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // The chip is gone once it is sent.
    await expect(page.getByRole('button', { name: 'receipt.png' })).toHaveCount(0);

    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.images).toEqual([PNG_BASE64]);

    // In my bubble at once, from its own bytes.
    const image = page.getByRole('img', { name: 'Image 1' });
    await expect(image).toBeVisible({ timeout: 10_000 });
    expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

    // Loaded again, it is the server's copy, fetched with the token.
    await page.getByPlaceholder('Type your message...').fill('/refresh');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => image.getAttribute('src'), { timeout: 10_000 }).toMatch(/\/images\/u\/[0-9a-f-]{36}\?token=/);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
  });

  test('a dropped file that is not an image is not attached', async ({ page, mock }) => {
    await login(page);
    await dropOnComposer(page, [{ name: 'notes.txt', type: 'text/plain', base64: btoa('hello') }]);
    await expect(page.getByRole('button', { name: 'notes.txt' })).toHaveCount(0);

    await page.getByPlaceholder('Type your message...').fill('No attachment here');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.images ?? []).toEqual([]);
  });

  test('an attached image can be taken off before sending', async ({ page, mock }) => {
    await login(page);
    await dropOnComposer(page, [{ name: 'oops.png', type: 'image/png', base64: PNG_BASE64 }]);
    const chip = page.getByRole('button', { name: 'oops.png' });
    await expect(chip).toBeVisible();
    await chip.locator('[data-testid="CloseIcon"]').click();
    await expect(chip).toHaveCount(0);

    await page.getByPlaceholder('Type your message...').fill('Never mind');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.images ?? []).toEqual([]);
  });
});
