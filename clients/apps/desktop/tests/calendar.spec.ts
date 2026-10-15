/**
 * The calendar in the running app (#282).
 *
 * The unit tests pin the week arithmetic, the store and the page against
 * stubs. This pins the round trip: the Calendar button on the activity bar,
 * what the server holds showing on the right day, and the changes the page
 * makes — a new reminder, Done, Delete — landing on the server.
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openCalendar(page: Page) {
  await page.locator('button')
    .filter({ has: page.locator('[data-testid="CalendarMonthOutlinedIcon"], [data-testid="CalendarMonthIcon"]') })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible({ timeout: 10_000 });
}

/** Today at `hour`:00 in this machine's zone — the Electron app's zone too. */
function todayAt(hour: number): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0);
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test.describe('the calendar', () => {
  test("shows what is on the server, on its day, and Done marks it done there", async ({ page, mock }) => {
    const at = todayAt(19);
    const call = mock.addCalendarEntry({ kind: 'reminder', title: 'Call Mom', starts_at: at.toISOString() });

    await signIn(page);
    await openCalendar(page);

    const day = page.locator(`[data-day="${dateKey(at)}"]`);
    await expect(day.getByText('Call Mom')).toBeVisible({ timeout: 10_000 });

    await day.locator(`[data-entry-id="${call.id}"]`).click();
    const panel = page.getByRole('region', { name: 'Selected entry' });
    await expect(panel).toContainText('19:00');
    await panel.getByRole('button', { name: 'Done' }).click();

    await expect.poll(() => mock.calendarEntries.find((e) => e.id === call.id)?.done).toBe(true);
  });

  test('a new reminder made here is on the server at the local time chosen', async ({ page, mock }) => {
    await signIn(page);
    await openCalendar(page);

    await page.getByRole('button', { name: 'New' }).click();
    await page.getByRole('button', { name: 'Reminder' }).click();
    await page.getByLabel('Title').fill('Water the plants');
    const at = todayAt(8);
    await page.getByLabel('Date').fill(dateKey(at));
    await page.getByLabel('Time').fill('08:00');
    await page.getByRole('button', { name: 'Add' }).click();

    await expect.poll(() => mock.calendarEntries.map((e) => e.title)).toContain('Water the plants');
    const made = mock.calendarEntries.find((e) => e.title === 'Water the plants')!;
    expect(made.kind).toBe('reminder');
    expect(Date.parse(made.starts_at!)).toBe(at.getTime());
  });

  test('Delete takes it off the server', async ({ page, mock }) => {
    const lunch = mock.addCalendarEntry({
      kind: 'event', title: 'Lunch with Anna', starts_at: todayAt(12).toISOString(), ends_at: todayAt(13).toISOString(),
    });
    await signIn(page);
    await openCalendar(page);

    await page.locator(`[data-entry-id="${lunch.id}"]`).first().click();
    await page.getByRole('region', { name: 'Selected entry' }).getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => mock.calendarEntries.some((e) => e.id === lunch.id)).toBe(false);
  });

});
