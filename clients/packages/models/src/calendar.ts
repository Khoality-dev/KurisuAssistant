/**
 * The calendar (#282): its wire shapes, and the date arithmetic every screen
 * that shows it needs.
 *
 * The server stores instants in UTC and all-day entries as plain dates. A
 * screen shows them in the device's own zone: a timed entry is on the day it
 * starts locally, an all-day one on its dates wherever the device is. A week
 * starts on Monday. Android makes the same decisions in
 * `domain/calendar/CalendarMath.kt`.
 *
 * Nothing on the calendar says who put it there, and nothing on it starts the
 * assistant — work it does by itself is a task (#352).
 */

export type CalendarEntryKind = 'event' | 'reminder';
export type CalendarView = 'day' | 'week';

/** One entry as `GET /calendar/entries` answers it. */
export interface CalendarEntry {
  id: number;
  kind: CalendarEntryKind;
  title: string;
  notes: string | null;
  all_day: boolean;
  /** ISO 8601 UTC with `Z`; null for an all-day event. */
  starts_at: string | null;
  /** A timed event's end; null for a reminder and an all-day event. */
  ends_at: string | null;
  /** `YYYY-MM-DD`, an all-day event's first and last day (inclusive). */
  start_date: string | null;
  end_date: string | null;
  /** Reminders only. */
  done: boolean;
  done_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CalendarEntryCreate {
  kind: CalendarEntryKind;
  title: string;
  notes?: string | null;
  all_day?: boolean;
  starts_at?: string;
  ends_at?: string;
  start_date?: string;
  end_date?: string;
}

/** Only the fields sent change. A moved event keeps its length unless `ends_at` is sent. */
export interface CalendarEntryUpdate {
  title?: string;
  notes?: string | null;
  all_day?: boolean;
  starts_at?: string;
  ends_at?: string;
  start_date?: string;
  end_date?: string;
  done?: boolean;
}

/** The tools the assistant keeps the calendar with (`backend/kurisuassistant/tools/calendar.py`). */
export const CALENDAR_TOOL_NAMES = ['calendar_create', 'calendar_list', 'calendar_move', 'calendar_delete'] as const;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes());
}

/** Monday of `d`'s week, at local midnight. */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const sinceMonday = (day.getDay() + 6) % 7;
  return addDays(day, -sinceMonday);
}

/** `YYYY-MM-DD` of `d` in local time — how all-day entries name their days. */
export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD`. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export interface CalendarWindow {
  /** Local midnight of the first day. */
  start: Date;
  /** Local midnight after the last day. */
  end: Date;
  days: Date[];
}

/** The days a view shows around `anchor`, and the window to ask the server for. */
export function calendarWindow(view: CalendarView, anchor: Date): CalendarWindow {
  const first = view === 'week' ? startOfWeek(anchor) : startOfDay(anchor);
  const count = view === 'week' ? 7 : 1;
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  return { start: first, end: addDays(first, count), days };
}

/** `12 – 18 October 2026`, `26 October – 1 November 2026`, `Tuesday 13 October 2026`. */
export function formatWindowTitle(view: CalendarView, anchor: Date): string {
  if (view === 'day') {
    const d = startOfDay(anchor);
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  const { days } = calendarWindow('week', anchor);
  const a = days[0];
  const b = days[6];
  if (a.getFullYear() !== b.getFullYear()) {
    return `${a.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }
  if (a.getMonth() !== b.getMonth()) {
    return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }
  return `${a.getDate()} – ${b.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
}

/** `Fri 16 Oct` — a short local date for lists. */
export function formatShortDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isAllDayOn(entry: CalendarEntry, day: Date): boolean {
  if (!entry.all_day || !entry.start_date) return false;
  const key = localDateKey(day);
  return entry.start_date <= key && (entry.end_date ?? entry.start_date) >= key;
}

export interface TimedSpan {
  /** Minutes after local midnight, clipped to the day. */
  startMinute: number;
  endMinute: number;
}

/**
 * Where a timed entry sits on `day`, in minutes from local midnight, clipped
 * to that day; null when it is not on it. A reminder is a moment: its span is
 * empty.
 */
export function timedSpan(entry: CalendarEntry, day: Date): TimedSpan | null {
  if (entry.all_day || !entry.starts_at) return null;
  const start = new Date(entry.starts_at);
  const end = entry.ends_at ? new Date(entry.ends_at) : start;
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const isMoment = end.getTime() === start.getTime();
  if (isMoment ? start < dayStart || start >= dayEnd : end <= dayStart || start >= dayEnd) return null;
  const minutes = (d: Date) => Math.round((d.getTime() - dayStart.getTime()) / 60_000);
  const startMinute = Math.max(0, minutes(start));
  const endMinute = isMoment ? startMinute : Math.min(24 * 60, minutes(end));
  return { startMinute, endMinute };
}

/** What `day` shows: its all-day entries, and its timed ones in order. */
export function entriesForDay(entries: CalendarEntry[], day: Date): { allDay: CalendarEntry[]; timed: CalendarEntry[] } {
  const allDay = entries.filter((e) => isAllDayOn(e, day));
  const timed = entries
    .filter((e) => timedSpan(e, day) !== null)
    .sort((a, b) => timedSpan(a, day)!.startMinute - timedSpan(b, day)!.startMinute || a.id - b.id);
  return { allDay, timed };
}

export interface PlacedEntry extends TimedSpan {
  entry: CalendarEntry;
  /** Which of `lanes` side-by-side columns it takes. */
  lane: number;
  lanes: number;
}

/**
 * Timed entries of one day, each with a lane: entries that overlap share the
 * column, the rest take it whole. Reminders count as a short block so two at
 * the same minute do not sit on top of each other.
 */
export function layoutTimed(entries: CalendarEntry[], day: Date, momentMinutes = 30): PlacedEntry[] {
  const spans = entriesForDay(entries, day).timed.map((entry) => {
    const span = timedSpan(entry, day)!;
    const visibleEnd = Math.max(span.endMinute, span.startMinute + momentMinutes);
    return { entry, ...span, visibleEnd };
  });
  const placed: PlacedEntry[] = [];
  let cluster: typeof spans = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const lanesOf = cluster.map((s) => {
      let lane = laneEnds.findIndex((end) => end <= s.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(s.visibleEnd);
      } else {
        laneEnds[lane] = s.visibleEnd;
      }
      return lane;
    });
    cluster.forEach((s, i) => placed.push({
      entry: s.entry, startMinute: s.startMinute, endMinute: s.endMinute, lane: lanesOf[i], lanes: laneEnds.length,
    }));
    cluster = [];
    clusterEnd = -1;
  };
  for (const s of spans) {
    if (cluster.length && s.startMinute >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.visibleEnd);
  }
  if (cluster.length) flush();
  return placed;
}

/** `09:30 – 10:30`, `19:00`, `All day` — the time as the calendar shows it. */
export function describeWhen(entry: CalendarEntry): string {
  if (entry.all_day) return 'All day';
  if (!entry.starts_at) return '';
  const start = new Date(entry.starts_at);
  if (!entry.ends_at) return formatClock(start);
  const end = new Date(entry.ends_at);
  if (startOfDay(start).getTime() === startOfDay(end).getTime()) {
    return `${formatClock(start)} – ${formatClock(end)}`;
  }
  return `${formatClock(start)} – ${formatShortDate(end)}, ${formatClock(end)}`;
}

/** The local day an entry begins on — what "open it in the calendar" shows. */
export function entryDay(entry: CalendarEntry): Date | null {
  if (entry.all_day && entry.start_date) return fromDateKey(entry.start_date);
  if (entry.starts_at) return startOfDay(new Date(entry.starts_at));
  return null;
}

/** What a calendar tool's answer means for the chat card. */
export interface CalendarToolResult {
  action: 'created' | 'moved' | 'deleted';
  summary: string;
  entry?: CalendarEntry;
  deleted?: { id: number; kind: CalendarEntryKind; title: string };
}

/**
 * Read what `calendar_create`, `calendar_move` or `calendar_delete` answered
 * into the card the chat draws; null for anything else — another tool, an
 * error, a listing, text.
 */
export function parseCalendarToolResult(toolName: string | null | undefined, content: string | null | undefined): CalendarToolResult | null {
  const action = toolName === 'calendar_create' ? 'created'
    : toolName === 'calendar_move' ? 'moved'
      : toolName === 'calendar_delete' ? 'deleted'
        : null;
  if (!action || !content) return null;
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || 'error' in body) return null;
  const { summary, entry, deleted } = body as { summary?: unknown; entry?: CalendarEntry; deleted?: CalendarToolResult['deleted'] };
  if (typeof summary !== 'string') return null;
  if (action === 'deleted') return deleted ? { action, summary, deleted } : null;
  return entry && typeof entry.id === 'number' ? { action, summary, entry } : null;
}

