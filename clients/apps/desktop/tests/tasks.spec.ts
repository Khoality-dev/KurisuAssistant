/**
 * Tasks (#352): the assistant's own work, running now or on a schedule.
 *
 * The Tasks button on the navigation bar opens what the assistant has planned,
 * grouped by what each task is doing; a task opens with its instructions, its
 * schedule and its recent runs, each of which is a conversation; and a task
 * the assistant schedules in a chat shows up there as a card that leads to it.
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import type { MockBackend } from './mock/server';
import { SCENARIOS } from './mock/scenarios';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

function useTasksScenario(mock: MockBackend) {
  const { options } = SCENARIOS.tasks;
  for (const seed of options.conversations ?? []) mock.addConversation(seed);
  mock.setTasks(options.tasks ?? []);
  if (options.stream) mock.setStream(options.stream);
}

async function openTasks(page: Page) {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
}

test.describe('tasks', () => {
  test.beforeEach(async ({ mock }) => useTasksScenario(mock));

  test('the Tasks button opens tasks grouped by what they are doing', async ({ page }) => {
    await login(page);
    await openTasks(page);

    await expect(page.getByTestId('task-group-running')).toContainText('Gather everything about the apartment move');
    await expect(page.getByTestId('task-group-scheduled')).toContainText('Morning briefing');
    await expect(page.getByTestId('task-group-scheduled')).toContainText('Weekdays at 07:30');
    await expect(page.getByTestId('task-group-paused')).toContainText('Weekly French recap');
    await expect(page.getByTestId('task-group-waiting_for_approval')).toContainText('Tidy the downloads folder');
    await expect(page.getByRole('tab', { name: /Finished/ })).toHaveCount(0);

    await page.getByRole('tab', { name: /Paused/ }).click();
    await expect(page.getByTestId('task-group-paused')).toBeVisible();
    await expect(page.getByTestId('task-group-scheduled')).toHaveCount(0);
  });

  test('a task opens with its instructions and runs, and a run opens its conversation', async ({ page }) => {
    await login(page);
    await openTasks(page);
    await page.getByTestId('task-row-2').click();

    const detail = page.getByTestId('task-detail');
    await expect(detail).toContainText('Task instructions');
    await expect(detail).toContainText("Weather and today's calendar, three lines at most.");
    await expect(detail.getByTestId('task-run-20')).toContainText('needed approval');

    await detail.getByTestId('task-run-21').click();
    await expect(page.getByText('Sunny, 14° to 19°. Lunch with Anna at 12:00.')).toBeVisible();
  });

  test('pausing, resuming and stopping go to the server', async ({ page, mock }) => {
    await login(page);
    await openTasks(page);

    await page.getByTestId('task-row-2').getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('task-group-paused')).toContainText('Morning briefing');
    expect(mock.lastTaskPatch).toEqual({ id: 2, body: { paused: true } });

    await page.getByTestId('task-row-3').getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByTestId('task-group-scheduled')).toContainText('Weekly French recap');

    await page.getByTestId('task-row-1').getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('task-group-running')).toHaveCount(0);
    await expect(page.getByTestId('task-row-1')).toHaveCount(0);
  });

  test('editing the schedule shows the new schedule', async ({ page }) => {
    await login(page);
    await openTasks(page);
    await page.getByTestId('task-row-3').click();
    await page.getByTestId('task-detail').getByRole('button', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Mon' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByTestId('task-detail')).toContainText('Mondays and Sundays at 20:00');
  });

  test('deleting a task removes it', async ({ page, mock }) => {
    await login(page);
    await openTasks(page);
    await page.getByTestId('task-row-3').click();
    await page.getByTestId('task-detail').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByTestId('task-row-3')).toHaveCount(0);
    expect(mock.getTasks().map((t) => t.id)).toEqual([1, 2, 5]);
  });

  test('a run that ends on its own updates the screen', async ({ page, mock }) => {
    await login(page);
    await openTasks(page);
    await expect(page.getByTestId('task-group-running')).toBeVisible();

    mock.updateTaskState(1, { status: 'finished' }, {
      id: 11, status: 'done', error: null, conversation_id: null,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    });

    // A finished one-off leaves the Tasks tab; its run stays a conversation.
    await expect(page.getByTestId('task-group-running')).toHaveCount(0);
    await expect(page.getByTestId('task-row-1')).toHaveCount(0);
  });

  test('a task the assistant schedules in the chat is a card that leads to it', async ({ page, mock }) => {
    await login(page);
    // Sign-in opens the newest conversation, here a run waiting for approval
    // (#354): start a new one from the Conversations page.
    await page.locator('button').filter({
      has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
    }).first().click();
    await page.getByRole('button', { name: 'New chat' }).click();
    // The run's approval bar goes with its conversation; type only after, or
    // the composer that replaces it drops the text (it is keyed on the conversation).
    await expect(page.getByText('drive_write')).toHaveCount(0);
    const input = page.getByPlaceholder('Type your message...');
    await expect(input).toBeEditable();
    await input.fill('Check flight prices to Hanoi every morning.');
    await expect(input).toHaveValue('Check flight prices to Hanoi every morning.');
    await input.press('Enter');

    const card = page.getByTestId('task-card-4');
    await expect(card).toContainText('Task scheduled');
    await expect(card).toContainText('Check flight prices to Hanoi');
    await expect(card).toContainText('Every day at 08:00');

    mock.setTasks([...mock.getTasks(), {
      id: 4, title: 'Check flight prices to Hanoi', status: 'scheduled', repeat: 'daily', time: '08:00',
    }]);
    await card.getByRole('button', { name: 'Open in Tasks' }).click();
    await expect(page.getByTestId('task-detail')).toContainText('Check flight prices to Hanoi');
  });

  test('a run waiting for approval is approved from the Tasks tab', async ({ page, mock }) => {
    await login(page);
    await openTasks(page);
    await page.getByTestId('task-row-5').click();
    const pending = page.getByTestId('task-pending-approval');
    await expect(pending).toContainText('Waiting for your approval');
    await expect(pending).toContainText('drive_write');
    await pending.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByTestId('task-group-running')).toContainText('Tidy the downloads folder');
    expect(mock.approvalAnswers).toEqual([{ id: 9, approved: true }]);
  });

  test('a run waiting for approval is answered in its conversation', async ({ page, mock }) => {
    await login(page);
    await openTasks(page);
    await page.getByTestId('task-row-5').click();
    await page.getByTestId('task-run-51').click();
    await expect(page.getByText('I will move them now.')).toBeVisible();
    await page.getByRole('region', { name: 'Tool approval' }).getByText('Deny', { exact: true }).click();
    await expect.poll(() => mock.approvalAnswers).toEqual([{ id: 9, approved: false }]);
  });
});

test.describe('the account time zone', () => {
  test('an empty one is filled from this computer, once', async ({ page, mock }) => {
    await login(page);
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect.poll(() => mock.getTimezone()).toBe(zone);
    expect(mock.timezonePatches).toEqual([zone]);
  });

  test('a set one is left alone, and is changed in Account settings', async ({ page, mock }) => {
    mock.setTimezone('Asia/Tokyo');
    await login(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const field = page.getByLabel('Time zone');
    await expect(field).toHaveValue('Asia/Tokyo');
    expect(mock.timezonePatches).toEqual([]);

    await field.fill('Europe/Paris');
    await page.getByRole('button', { name: /Save/ }).first().click();
    await expect.poll(() => mock.getTimezone()).toBe('Europe/Paris');
  });
});
