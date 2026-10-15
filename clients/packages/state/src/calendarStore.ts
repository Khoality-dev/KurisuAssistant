import { create } from 'zustand';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import {
  addDays,
  calendarWindow,
  entryDay,
  type CalendarEntry,
  type CalendarEntryCreate,
  type CalendarEntryUpdate,
  type CalendarView,
} from '@kurisu/models';
import { useLayoutStore } from './layoutStore';

/**
 * The Calendar page (#282): which window it shows, what is in it, and which
 * entry is selected.
 *
 * The server is the record. Every change is sent and then the window and
 * "Coming up" are read again, so what the page shows is what the server has —
 * including what the assistant put there from a chat in the meantime.
 *
 * `openEntry` is the navigation target: the chat card's "Open in Calendar"
 * and, with #353, a reminder notification's tap open the page on that entry's
 * week with it selected.
 */
interface CalendarState {
  view: CalendarView;
  /** Any moment in the day or week shown. */
  anchor: Date;
  entries: CalendarEntry[];
  upcoming: CalendarEntry[];
  selectedId: number | null;
  loading: boolean;
  /** The last refusal or failure, as a sentence. */
  error: string | null;

  setView: (view: CalendarView) => void;
  setAnchor: (anchor: Date) => void;
  /** One day or one week back (-1) or forward (+1), by the view. */
  step: (direction: -1 | 1) => void;
  today: () => void;
  select: (id: number | null) => void;
  load: () => Promise<void>;
  openEntry: (id: number) => void;
  create: (body: CalendarEntryCreate) => Promise<CalendarEntry | null>;
  move: (id: number, changes: CalendarEntryUpdate) => Promise<CalendarEntry | null>;
  setDone: (id: number, done: boolean) => Promise<void>;
  remove: (id: number) => Promise<boolean>;
  clearError: () => void;
}

export const useCalendarStore = create<CalendarState>((set, get) => {
  /** Run a change, then re-read; a failure is kept as a sentence, never thrown. */
  async function change<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      const result = await run();
      set({ error: null });
      await get().load();
      return result;
    } catch (err) {
      set({ error: describeRequestFailure(err, 'The calendar could not be changed.') });
      return null;
    }
  }

  return {
    view: 'week',
    anchor: new Date(),
    entries: [],
    upcoming: [],
    selectedId: null,
    loading: false,
    error: null,

    setView: (view) => {
      set({ view });
      void get().load();
    },
    setAnchor: (anchor) => {
      set({ anchor });
      void get().load();
    },
    step: (direction) => {
      const { view, anchor } = get();
      get().setAnchor(addDays(anchor, direction * (view === 'week' ? 7 : 1)));
    },
    today: () => get().setAnchor(new Date()),
    select: (id) => set({ selectedId: id }),
    clearError: () => set({ error: null }),

    load: async () => {
      const { view, anchor } = get();
      const window = calendarWindow(view, anchor);
      set({ loading: true });
      try {
        const [entries, upcoming] = await Promise.all([
          apiClient.listCalendarEntries(window.start.toISOString(), window.end.toISOString()),
          apiClient.getUpcomingCalendar(),
        ]);
        // A slower answer for a window the user has already left is dropped.
        if (get().anchor !== anchor || get().view !== view) return;
        set({ entries: entries ?? [], upcoming: upcoming ?? [], loading: false });
      } catch (err) {
        set({ loading: false, error: describeRequestFailure(err, 'The calendar could not be loaded.') });
      }
    },

    openEntry: (id) => {
      useLayoutStore.getState().setActivePage('calendar');
      set({ selectedId: id });
      void (async () => {
        try {
          const entry = await apiClient.getCalendarEntry(id);
          const day = entry ? entryDay(entry) : null;
          if (day && get().selectedId === id) get().setAnchor(day);
        } catch {
          // Gone (deleted since), or the server is away: the page still opens.
        }
      })();
    },

    create: async (body) => {
      const made = await change(() => apiClient.createCalendarEntry(body));
      if (made) set({ selectedId: made.id });
      return made;
    },
    move: (id, changes) => change(() => apiClient.updateCalendarEntry(id, changes)),
    setDone: async (id, done) => {
      await change(() => apiClient.updateCalendarEntry(id, { done }));
    },
    remove: async (id) => {
      const ok = (await change(async () => {
        await apiClient.deleteCalendarEntry(id);
        return true;
      })) === true;
      if (ok && get().selectedId === id) set({ selectedId: null });
      return ok;
    },
  };
});

