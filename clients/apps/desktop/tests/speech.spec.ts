/**
 * The reply, spoken (#312). With speech on — the default — complete sentences
 * of the reply go to `POST /tts` in the persona's voice as they arrive and are
 * played in order; "Read aloud" on a message does the same for it alone. When
 * the server cannot synthesize, the chat says so in one sentence
 * (`describeSpeechFailure`). The mock answers with a real half-second WAV.
 */
import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { MockBackend } from './mock/server';

const LONG_SENTENCE = 'This sentence is long enough to be spoken on its own by the assistant. ';
const SECOND_SENTENCE = 'And here is a second one that is also more than ten words long.';

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

async function giveKurisuAVoice(mock: MockBackend) {
  const res = await fetch(`${mock.url}/personas/1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_reference: 'kurisu_ja_01' }),
  });
  expect(res.status).toBe(200);
}

test.describe('speech', () => {
  test('the reply is spoken sentence by sentence in the persona\'s voice', async ({ page, mock }) => {
    await giveKurisuAVoice(mock);
    mock.setStream({
      chunks: [
        { content: LONG_SENTENCE, role: 'assistant', delayMs: 10 },
        { content: SECOND_SENTENCE, role: 'assistant', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'Talk to me');

    await expect(page.getByText(SECOND_SENTENCE, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => mock.speechRequests.map((r) => r.text), { timeout: 10_000 })
      .toEqual([LONG_SENTENCE.trim(), SECOND_SENTENCE]);
    // The persona's voice, and no model the user did not pick (#200).
    expect(mock.speechRequests.every((r) => r.voice === 'kurisu_ja_01' && r.provider === null)).toBe(true);
    // Played without a complaint.
    await page.waitForTimeout(1_500);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('with speech off nothing is synthesized, and Read aloud speaks one message', async ({ page, mock }) => {
    await page.evaluate(() => localStorage.setItem('kurisu_tts_auto_play', 'false'));
    mock.setStream({ chunks: [{ content: LONG_SENTENCE, role: 'assistant', delayMs: 10 }] });
    await login(page);
    await send(page, 'Talk to me');
    const reply = page.getByText(LONG_SENTENCE.trim()).first();
    await expect(reply).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    expect(mock.speechRequests).toEqual([]);

    await reply.hover();
    await page.getByRole('button', { name: 'Read aloud' }).last().click();
    await expect.poll(() => mock.speechRequests.map((r) => r.text.trim()), { timeout: 10_000 }).toEqual([LONG_SENTENCE.trim()]);
    await page.waitForTimeout(1_500);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a speech service that is down is reported in one sentence, and the reply still reads', async ({ page, mock }) => {
    mock.failSpeech();
    mock.setStream({ chunks: [{ content: LONG_SENTENCE, role: 'assistant', delayMs: 10 }] });
    await login(page);
    await send(page, 'Talk to me');

    await expect(page.getByText(LONG_SENTENCE.trim()).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('alert').filter({ hasText: 'Speech failed: The speech service is unavailable. (reference: mock).' }))
      .toBeVisible({ timeout: 10_000 });
  });

  test('an engine\'s own refusal keeps its reason', async ({ page, mock }) => {
    mock.failSpeech({ status: 400, detail: 'This engine only clones voices, and the persona has no clip.' });
    mock.setStream({ chunks: [{ content: LONG_SENTENCE, role: 'assistant', delayMs: 10 }] });
    await login(page);
    await send(page, 'Talk to me');
    await expect(page.getByRole('alert').filter({ hasText: 'Speech failed: This engine only clones voices, and the persona has no clip.' }))
      .toBeVisible({ timeout: 10_000 });
  });
});
