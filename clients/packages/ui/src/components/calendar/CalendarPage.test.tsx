/**
 * The Calendar page (#282) and the chat's calendar card.
 *
 * The page shows the week (or a day) the store is anchored on, with timed
 * entries in an hour grid, all-day ones above it, and a side panel for the
 * selected entry. The card is how a calendar tool call looks in the chat:
 * "Reminder added to your calendar", with Open in Calendar and Undo.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listCalendarEntries: vi.fn(async () => [] as unknown[]),
  getUpcomingCalendar: vi.fn(async () => [] as unknown[]),
  getCalendarEntry: vi.fn(),
  createCalendarEntry: vi.fn(async (body: object) => ({ id: 99, ...body })),
  updateCalendarEntry: vi.fn(async (id: number, body: object) => ({ id, ...body })),
  deleteCalendarEntry: vi.fn(async () => undefined),
}));

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: api,
}));

import { useCalendarStore, useLayoutStore } from '@kurisu/state';
import { CalendarPage } from './CalendarPage';
import { CalendarToolCard } from './CalendarToolCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCalendarStore.setState(useCalendarStore.getInitialState());
  useCalendarStore.getState().setAnchor(new Date(2026, 9, 13, 15));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

const callMom = {
  id: 7, kind: 'reminder', title: 'Call Mom', notes: null, all_day: false,
  starts_at: local(16, 19), ends_at: null, start_date: null, end_date: null,
  done: false, done_at: null, created_at: null, updated_at: null,
};
const lunch = {
  ...callMom, id: 8, kind: 'event', title: 'Lunch with Anna', starts_at: local(13, 12), ends_at: local(13, 13),
};
const birthday = {
  ...callMom, id: 9, kind: 'event', title: "Linh's birthday", all_day: true,
  starts_at: null, start_date: '2026-10-18', end_date: '2026-10-18',
};

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

describe('the Calendar page', () => {
  it('shows the week with its entries where they belong', async () => {
    api.listCalendarEntries.mockResolvedValue([callMom, lunch, birthday]);
    await act(async () => { root.render(<CalendarPage />); });

    expect(container.textContent).toContain('12 – 18 October 2026');
    const fri = container.querySelector('[data-day="2026-10-16"]')!;
    expect(fri.textContent).toContain('Call Mom');
    const tue = container.querySelector('[data-day="2026-10-13"]')!;
    expect(tue.textContent).toContain('Lunch with Anna');
    const allDaySun = container.querySelector('[data-all-day="2026-10-18"]')!;
    expect(allDaySun.textContent).toContain("Linh's birthday");
    // The calendar is the user's: nothing says who put an entry there.
    expect(container.textContent).not.toMatch(/set by/i);
  });

  it('selecting a reminder opens its panel; Done marks it done on the server', async () => {
    api.listCalendarEntries.mockResolvedValue([callMom]);
    await act(async () => { root.render(<CalendarPage />); });

    await act(async () => { (container.querySelector('[data-entry-id="7"]') as HTMLElement).click(); });
    const panel = container.querySelector('[aria-label="Selected entry"]')!;
    expect(panel.textContent).toContain('Call Mom');
    expect(panel.textContent).toContain('19:00');

    await act(async () => { button('Done')!.click(); });
    expect(api.updateCalendarEntry).toHaveBeenCalledWith(7, { done: true });
  });

  it('Delete removes it', async () => {
    api.listCalendarEntries.mockResolvedValue([callMom]);
    await act(async () => { root.render(<CalendarPage />); });
    await act(async () => { (container.querySelector('[data-entry-id="7"]') as HTMLElement).click(); });
    await act(async () => { button('Delete')!.click(); });
    expect(api.deleteCalendarEntry).toHaveBeenCalledWith(7);
  });

  it('switches to a day, and steps back and forth', async () => {
    await act(async () => { root.render(<CalendarPage />); });
    await act(async () => { button('Day')!.click(); });
    expect(container.textContent).toContain('Tuesday 13 October 2026');
    await act(async () => { button('Next')!.click(); });
    expect(container.textContent).toContain('Wednesday 14 October 2026');
  });
});

describe('the chat card', () => {
  const created = JSON.stringify({
    summary: 'Added the reminder “Call Mom” on Fri 16 Oct 2026, 19:00 (UTC).',
    entry: callMom,
    time_zone: 'UTC',
  });

  it('says what was added and when, and opens it in the calendar', async () => {
    await act(async () => { root.render(<CalendarToolCard toolName="calendar_create" content={created} />); });
    expect(container.textContent).toContain('Reminder added to your calendar');
    expect(container.textContent).toContain('Call Mom');
    await act(async () => { button('Open in Calendar')!.click(); });
    expect(useLayoutStore.getState().activePage).toBe('calendar');
    await vi.waitFor(() => expect(useCalendarStore.getState().selectedId).toBe(7));
  });

  it('Undo takes it off the calendar again', async () => {
    await act(async () => { root.render(<CalendarToolCard toolName="calendar_create" content={created} />); });
    await act(async () => { button('Undo')!.click(); });
    expect(api.deleteCalendarEntry).toHaveBeenCalledWith(7);
    expect(container.textContent).toContain('Removed from your calendar');
  });

  it('renders nothing for a result it cannot read', async () => {
    await act(async () => { root.render(<CalendarToolCard toolName="calendar_create" content='{"error":"no"}' />); });
    expect(container.textContent).toBe('');
  });
});
