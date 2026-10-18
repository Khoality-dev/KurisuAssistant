/**
 * A reply that does not go as planned (#312): the server fails partway, I stop
 * it partway, or I send again while it is still streaming.
 *
 * The server's side of each is the mock's (`fail` in a script, the cancel
 * handler, the message queue), shaped after `websocket/handlers.py`: a failed
 * turn sends `error` and no `done` and keeps only the messages it finished; a
 * message sent mid-turn waits and is answered as one more turn.
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

/** The composer's Stop, which is there while a reply streams. */
const stopButton = (page: Page) => page.locator('button[title="Stop"]');

test.describe('a reply the server cannot finish', () => {
  test('says why, and keeps my message and what the server finished', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Let me look. ', role: 'assistant', delayMs: 10 },
        { content: '2 files', role: 'tool', name: 'drive_list', delayMs: 10 },
        { content: 'Half a sente', role: 'assistant', delayMs: 10 },
        { content: '', fail: 'Something went wrong on the server. (reference: 7f3a)', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'What is on my drive?');

    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong on the server. (reference: 7f3a)' }))
      .toBeVisible({ timeout: 10_000 });
    // What the server kept is what stays: my message, and the reply up to the
    // tool. The sentence it was writing when it failed was never saved.
    await expect(page.getByText('What is on my drive?', { exact: true })).toBeVisible();
    await expect(page.getByText('Let me look.').first()).toBeVisible();
    await expect(page.getByText('drive_list').first()).toBeVisible();
    await expect(page.getByText('Half a sente')).toHaveCount(0);
    await expect(stopButton(page)).toHaveCount(0);
    // "Let me look." was spoken; once it has been, no bubble still says Stop —
    // the last one kept its speech Stop up for good after a failure.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 10_000 });

    // And the chat carries on in the same conversation.
    mock.setStream({ chunks: [{ content: 'Second try worked.', role: 'assistant', delayMs: 10 }] });
    await send(page, 'Try again');
    await expect(page.getByText('Second try worked.').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('What is on my drive?', { exact: true })).toBeVisible();
    expect(mock.getConversations()).toHaveLength(1);
  });
});

test.describe('stopping a reply partway', () => {
  test('keeps what had arrived, shows nothing after, and the composer is mine again', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'The first part. ', role: 'assistant', delayMs: 10 },
        { content: 'The second part. ', role: 'assistant', delayMs: 2_500 },
        { content: 'The third part.', role: 'assistant', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'Tell me a long story');

    await expect(page.getByText('The first part.').first()).toBeVisible({ timeout: 10_000 });
    await stopButton(page).click();
    await expect(stopButton(page)).toHaveCount(0);

    // Well past when the rest would have arrived.
    await page.waitForTimeout(3_500);
    await expect(page.getByText('The first part.').first()).toBeVisible();
    await expect(page.getByText('The second part.')).toHaveCount(0);
    await expect(page.getByText('The third part.')).toHaveCount(0);
    await expect(page.getByText('Tell me a long story', { exact: true })).toBeVisible();

    mock.setStream({ chunks: [{ content: 'Shorter this time.', role: 'assistant', delayMs: 10 }] });
    await send(page, 'Shorter please');
    await expect(page.getByText('Shorter this time.').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Escape in the message box stops it too', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Starting. ', role: 'assistant', delayMs: 10 },
        { content: 'Never shown.', role: 'assistant', delayMs: 2_500 },
      ],
    });
    await login(page);
    await send(page, 'Go');
    await expect(page.getByText('Starting.').first()).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Type your message...').press('Escape');
    await expect(stopButton(page)).toHaveCount(0);
    await page.waitForTimeout(3_000);
    await expect(page.getByText('Never shown.')).toHaveCount(0);
  });
});

test.describe('sending while a reply streams', () => {
  test('the message waits below the reply, and is answered once it is done', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Answering the first. ', role: 'assistant', delayMs: 10 },
        { content: 'Still on the first.', role: 'assistant', delayMs: 2_000 },
      ],
    });
    await login(page);
    await send(page, 'First question');
    await expect(page.getByText('Answering the first.').first()).toBeVisible({ timeout: 10_000 });

    await send(page, 'Second question');
    // It is on screen at once, waiting, and the reply in progress is not cut off.
    await expect(page.getByText('Second question', { exact: true })).toBeVisible();
    await expect(page.getByText('Still on the first.').first()).toBeVisible({ timeout: 10_000 });

    // Then the server answers it as one more turn, in the same conversation.
    await expect(page.getByText('Answering the first.')).toHaveCount(2, { timeout: 10_000 });
    await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
    expect(mock.getConversations()).toHaveLength(1);
    const stored = mock.getConversation(mock.getConversations()[0].id)!;
    expect(stored.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'First question'],
      ['assistant', 'Answering the first. Still on the first.'],
      ['user', 'Second question'],
      ['assistant', 'Answering the first. Still on the first.'],
    ]);

    // Once it is all in, the transcript reads in the order it happened.
    const transcript = await page.getByText(/First question|Second question/).allTextContents();
    expect(transcript.filter((t) => t === 'First question' || t === 'Second question'))
      .toEqual(['First question', 'Second question']);
  });
});
