/**
 * Notifications reach the desktop with the window closed (#353).
 *
 * The server keeps every notification and whether it has been read; the
 * desktop only displays them. The window hides to the tray rather than
 * quitting, so the renderer — and the notification socket it holds — keeps
 * running. Each notification is shown by the OS through the main process;
 * clicking it brings the window back, opens where it came from and reads it on
 * the server, and one read on another device is taken down here. The main
 * process records what it showed and took down when the suite runs it
 * (`KURISU_E2E`), because an OS notification is not something a test can see.
 */

import { test, expect } from './fixtures';
import { ElectronApplication, Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function send(page: Page, text: string) {
  const input = page.getByPlaceholder('Type your message...');
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText('Hello from mock backend.').last()).toBeVisible({ timeout: 10_000 });
}

/** `/clear`: the slash menu takes the first Enter, the second runs it. */
async function newConversation(page: Page) {
  const input = page.getByPlaceholder('Type your message...');
  await input.fill('/clear');
  await input.press('Enter');
  if ((await input.inputValue()).trim()) await input.press('Enter');
}

async function openNotificationSettings(page: Page) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('Notifications', { exact: true }).first().click();
  await expect(page.getByText('Notifications on this computer')).toBeVisible();
}

/** The activity bar's bell: its accessible name carries the server's unread count. */
const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });

type Shown = { id: number; title: string; body: string; target: { kind: string; conversationId?: number; reminderId?: number | null } };

const shown = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as any).__kurisuNotifications?.shown ?? []) as Shown[]);

const closed = (app: ElectronApplication) =>
  app.evaluate(() => ((globalThis as any).__kurisuNotifications?.closed ?? []) as number[]);

const clickShown = (app: ElectronApplication, index: number) =>
  app.evaluate((_electron, i) => (globalThis as any).__kurisuNotifications.click(i), index);

const windowVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);

test.describe('notifications', () => {
  test('one arrives with the window closed; a click opens its conversation and reads it', async ({ page, electronApp, mock }) => {
    await login(page);
    await send(page, 'remind me about the laundry');
    const [conversation] = mock.getConversations();

    // Leave it, so opening it again is something the click did.
    await newConversation(page);
    await expect(page.getByText('remind me about the laundry')).toHaveCount(0);

    await expect.poll(() => mock.notificationListeners()).toBe(1);

    // Closing the window hides it to the tray; the app keeps listening.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => windowVisible(electronApp)).toBe(false);

    const sent = mock.sendNotification({ sender: 'Kurisu', title: 'Laundry', body: 'The machine is done.', conversation_id: conversation.id });

    await expect.poll(() => shown(electronApp)).toEqual([
      {
        id: sent.id,
        title: 'Kurisu · Laundry',
        body: 'The machine is done.',
        target: { kind: 'conversation', conversationId: conversation.id },
      },
    ]);

    await clickShown(electronApp, 0);
    await expect.poll(() => windowVisible(electronApp)).toBe(true);
    await expect(page.getByText('remind me about the laundry')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => mock.getNotifications()[0].read_at).not.toBeNull();
  });

  test('read on another device, it is taken down here and the bell clears', async ({ page, electronApp, mock }) => {
    await login(page);
    await expect.poll(() => mock.notificationListeners()).toBe(1);
    const reminder = mock.sendNotification({ source: 'calendar', sender: 'Calendar', title: 'Call Mom', body: 'Due at 19:00.', reminder_id: 42 });
    await expect.poll(async () => (await shown(electronApp)).length).toBe(1);
    expect((await shown(electronApp))[0].target).toEqual({ kind: 'calendar', reminderId: 42 });
    await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

    await bell(page).click();
    await expect(page.getByText('Calendar · Call Mom')).toBeVisible();

    // The phone reads it.
    mock.readNotifications((n) => n.id === reminder.id);

    await expect.poll(() => closed(electronApp)).toEqual([reminder.id]);
    await expect(page.getByText('Calendar · Call Mom')).toHaveCount(0);
    await expect(page.getByText('Nothing unread')).toBeVisible();
    // The open list hides the rest of the window from the accessibility tree.
    await page.keyboard.press('Escape');
    await expect(bell(page)).toHaveAccessibleName('Notifications');
  });

  test('opening one from the bell reads it and opens its conversation', async ({ page, mock }) => {
    await login(page);
    await send(page, 'remind me about the laundry');
    const [conversation] = mock.getConversations();
    await newConversation(page);
    await expect(page.getByText('remind me about the laundry')).toHaveCount(0);
    await expect.poll(() => mock.notificationListeners()).toBe(1);
    mock.sendNotification({ sender: 'Kurisu', title: 'Laundry', body: 'The machine is done.', conversation_id: conversation.id });
    await expect(bell(page)).toHaveAccessibleName('Notifications, 1 unread');

    await bell(page).click();
    await page.getByText('Kurisu · Laundry').click();

    await expect(page.getByText('remind me about the laundry')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => mock.getNotifications()[0].read_at).not.toBeNull();
    await expect(bell(page)).toHaveAccessibleName('Notifications');
  });

  test('back from being away: shows only what is new, takes down what was read meanwhile', async ({ page, electronApp, mock }) => {
    await login(page);
    await expect.poll(() => mock.notificationListeners()).toBe(1);
    const early = mock.sendNotification({ sender: 'Kurisu', title: 'Early', body: '' });
    const kept = mock.sendNotification({ sender: 'Kurisu', title: 'Kept', body: '' });
    await expect.poll(async () => (await shown(electronApp)).length).toBe(2);

    // The connection drops; meanwhile one is read elsewhere and one arrives.
    mock.dropNotificationSockets();
    mock.readNotifications((n) => n.id === early.id);
    mock.sendNotification({ sender: 'Kurisu', title: 'While you were away', body: 'A fare dropped.' });
    await expect.poll(() => mock.notificationListeners(), { timeout: 15_000 }).toBe(1);

    await expect.poll(async () => (await shown(electronApp)).map((n) => n.title)).toEqual([
      'Kurisu · Early',
      'Kurisu · Kept',
      'Kurisu · While you were away',
    ]);
    await expect.poll(() => closed(electronApp)).toEqual([early.id]);
    expect(await closed(electronApp)).not.toContain(kept.id);
  });

  test('read all from the bell reads them on the server', async ({ page, mock }) => {
    await login(page);
    await expect.poll(() => mock.notificationListeners()).toBe(1);
    mock.sendNotification({ sender: 'Kurisu', title: 'One', body: '' });
    mock.sendNotification({ sender: 'Kurisu', title: 'Two', body: '' });
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread');

    await bell(page).click();
    await expect(page.getByText('Kurisu · Two')).toBeVisible();
    await page.getByRole('button', { name: 'Mark all read' }).click();

    await expect.poll(() => mock.getNotifications().every((n) => n.read_at !== null)).toBe(true);
    await expect(page.getByText('Nothing unread')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bell(page)).toHaveAccessibleName('Notifications');
  });

  test('turned off in Settings, this computer stops listening, and stays off', async ({ page, mock }) => {
    await login(page);
    await expect.poll(() => mock.notificationListeners()).toBe(1);

    await openNotificationSettings(page);
    await expect(page.getByText('Notification sources')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Notifications on this computer' }).click();
    await expect.poll(() => mock.notificationListeners()).toBe(0);
    await expect(page.getByText("This computer won't get")).toBeVisible();

    // A new window session (the fixture keeps no session across a reload):
    // signed in again, the device remembers it is off.
    await page.reload();
    await login(page);
    await page.waitForTimeout(1_000);
    expect(mock.notificationListeners()).toBe(0);
  });
});
