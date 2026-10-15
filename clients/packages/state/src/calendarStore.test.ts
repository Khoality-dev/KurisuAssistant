import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Calendar page's state (#282): what window it shows, what is in it, what
 * is selected, and the navigation target a notification tap uses to open one
 * reminder. The server is the record; every change is sent, then re-read.
 */

const api = vi.hoisted(() => ({
  listCalendarEntries: vi.fn(async (_start: string, _end: string) => [] as unknown[]),
  getUpcomingCalendar: vi.fn(async () => [] as unknown[]),
  getCalendarEntry: vi.fn(async (id: number) => ({
    id, kind: 'reminder', title: 'Call Mom', notes: null, all_day: false,
    starts_at: new Date(2026, 9, 16, 19).toISOString(), ends_at: null,
    start_date: null, end_date: null, done: false, done_at: null, created_at: null, updated_at: null,
  })),
  createCalendarEntry: vi.fn(async (body: unknown) => ({ id: 9, ...(body as object) })),
  updateCalendarEntry: vi.fn(async (id: number, body: unknown) => ({ id, ...(body as object) })),
  deleteCalendarEntry: vi.fn(async () => undefined),
}));

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: api,
}));

import { useCalendarStore } from './calendarStore';
import { useLayoutStore } from './layoutStore';

describe('calendarStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCalendarStore.setState(useCalendarStore.getInitialState());
    useLayoutStore.setState({ activePage: 'workspace' });
  });

  it('loads the week around its anchor, Monday to Monday', async () => {
    useCalendarStore.getState().setAnchor(new Date(2026, 9, 13, 15));
    await useCalendarStore.getState().load();
    const calls = api.listCalendarEntries.mock.calls;
    const [start, end] = calls[calls.length - 1];
    expect(new Date(start).getTime()).toBe(new Date(2026, 9, 12).getTime());
    expect(new Date(end).getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(api.getUpcomingCalendar).toHaveBeenCalled();
  });

  it('day view and prev / next / today move the anchor by the view', () => {
    const s = useCalendarStore.getState();
    s.setAnchor(new Date(2026, 9, 13));
    s.step(1);
    expect(useCalendarStore.getState().anchor.getDate()).toBe(20);
    s.setView('day');
    useCalendarStore.getState().step(-1);
    expect(useCalendarStore.getState().anchor.getDate()).toBe(19);
  });

  it('opening a reminder from a notification shows its week with it selected', async () => {
    useCalendarStore.getState().openEntry(42);
    await vi.waitFor(() => expect(useCalendarStore.getState().selectedId).toBe(42));
    expect(useLayoutStore.getState().activePage).toBe('calendar');
    expect(api.getCalendarEntry).toHaveBeenCalledWith(42);
    // The reminder's own week, not whatever week was showing.
    await vi.waitFor(() => expect(useCalendarStore.getState().anchor.getDate()).toBe(16));
  });

  it('done, move, delete and create go to the server and the view is re-read', async () => {
    const s = useCalendarStore.getState();
    await s.setDone(5, true);
    expect(api.updateCalendarEntry).toHaveBeenCalledWith(5, { done: true });
    await s.move(5, { starts_at: '2026-10-18T02:00:00Z' });
    expect(api.updateCalendarEntry).toHaveBeenCalledWith(5, { starts_at: '2026-10-18T02:00:00Z' });
    useCalendarStore.setState({ selectedId: 5 });
    await s.remove(5);
    expect(api.deleteCalendarEntry).toHaveBeenCalledWith(5);
    expect(useCalendarStore.getState().selectedId).toBeNull();
    const made = await s.create({ kind: 'reminder', title: 'Water the plants', starts_at: '2026-10-12T15:00:00Z' });
    expect(made?.id).toBe(9);
    expect(useCalendarStore.getState().selectedId).toBe(9);
    expect(api.listCalendarEntries.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('a refusal is kept as a sentence, not thrown', async () => {
    api.createCalendarEntry.mockRejectedValueOnce({ response: { status: 400, data: { detail: 'A reminder needs a date and a time.' } } });
    const made = await useCalendarStore.getState().create({ kind: 'reminder', title: 'x' });
    expect(made).toBeNull();
    expect(useCalendarStore.getState().error).toBe('A reminder needs a date and a time.');
  });
});
