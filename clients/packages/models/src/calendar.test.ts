import { describe, expect, it } from 'vitest';
import {
  CALENDAR_TOOL_NAMES,
  calendarWindow,
  describeRepeat,
  describeWhen,
  entriesForDay,
  entryKey,
  formatWindowTitle,
  layoutTimed,
  localDateKey,
  parseCalendarToolResult,
  startOfWeek,
  timedSpan,
  type CalendarEntry,
} from './calendar';

// Everything here is local time: the tests build their instants from local
// wall-clock Dates, so they hold in whatever zone the runner is in.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

function entry(partial: Partial<CalendarEntry>): CalendarEntry {
  return {
    id: 1,
    kind: 'event',
    title: 'Untitled',
    notes: null,
    all_day: false,
    starts_at: null,
    ends_at: null,
    start_date: null,
    end_date: null,
    done: false,
    done_at: null,
    repeat: null,
    repeat_days: [],
    repeat_from: null,
    created_at: null,
    updated_at: null,
    ...partial,
  };
}

describe('the window a view shows', () => {
  it('a week starts on Monday', () => {
    expect(localDateKey(startOfWeek(at(2026, 10, 13, 15)))).toBe('2026-10-12');
    expect(localDateKey(startOfWeek(at(2026, 10, 18, 23)))).toBe('2026-10-12');
    expect(localDateKey(startOfWeek(at(2026, 10, 19)))).toBe('2026-10-19');
  });

  it('week: seven local days from Monday midnight', () => {
    const w = calendarWindow('week', at(2026, 10, 13, 15));
    expect(w.days.map(localDateKey)).toEqual([
      '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
    ]);
    expect(w.start.getTime()).toBe(at(2026, 10, 12).getTime());
    expect(w.end.getTime()).toBe(at(2026, 10, 19).getTime());
  });

  it('day: one local day', () => {
    const w = calendarWindow('day', at(2026, 10, 13, 15));
    expect(w.days.map(localDateKey)).toEqual(['2026-10-13']);
    expect(w.end.getTime()).toBe(at(2026, 10, 14).getTime());
  });

  it('names the window like a calendar header', () => {
    expect(formatWindowTitle('week', at(2026, 10, 13))).toBe('12 – 18 October 2026');
    expect(formatWindowTitle('week', at(2026, 10, 29))).toBe('26 October – 1 November 2026');
    expect(formatWindowTitle('week', at(2026, 12, 30))).toBe('28 December 2026 – 3 January 2027');
    expect(formatWindowTitle('day', at(2026, 10, 13))).toBe('Tuesday 13 October 2026');
  });
});

describe('which day an entry is on', () => {
  const lunch = entry({
    id: 1, title: 'Lunch', starts_at: at(2026, 10, 13, 12).toISOString(), ends_at: at(2026, 10, 13, 13).toISOString(),
  });
  const birthday = entry({ id: 2, title: 'Birthday', all_day: true, start_date: '2026-10-18', end_date: '2026-10-18' });
  const trip = entry({ id: 3, title: 'Trip', all_day: true, start_date: '2026-10-16', end_date: '2026-10-19' });
  const call = entry({ id: 4, kind: 'reminder', title: 'Call Mom', starts_at: at(2026, 10, 16, 19).toISOString() });

  it('timed entries by their local start, all-day ones by their dates', () => {
    expect(entriesForDay([lunch, birthday, trip, call], at(2026, 10, 13))).toEqual({ allDay: [], timed: [lunch] });
    expect(entriesForDay([lunch, birthday, trip, call], at(2026, 10, 16))).toEqual({ allDay: [trip], timed: [call] });
    expect(entriesForDay([lunch, birthday, trip, call], at(2026, 10, 18))).toEqual({ allDay: [birthday, trip], timed: [] });
  });

  it('an event over midnight shows on both days, clipped to each', () => {
    const late = entry({
      title: 'Late', starts_at: at(2026, 10, 13, 23).toISOString(), ends_at: at(2026, 10, 14, 1).toISOString(),
    });
    expect(timedSpan(late, at(2026, 10, 13))).toEqual({ startMinute: 23 * 60, endMinute: 24 * 60 });
    expect(timedSpan(late, at(2026, 10, 14))).toEqual({ startMinute: 0, endMinute: 60 });
    expect(entriesForDay([late], at(2026, 10, 14)).timed).toEqual([late]);
  });

  it('a reminder is a moment', () => {
    expect(timedSpan(call, at(2026, 10, 16))).toEqual({ startMinute: 19 * 60, endMinute: 19 * 60 });
    expect(timedSpan(call, at(2026, 10, 15))).toBeNull();
  });
});

describe('side by side', () => {
  it('overlapping events share the column; the rest take it whole', () => {
    const a = entry({ id: 1, starts_at: at(2026, 10, 13, 9).toISOString(), ends_at: at(2026, 10, 13, 11).toISOString() });
    const b = entry({ id: 2, starts_at: at(2026, 10, 13, 10).toISOString(), ends_at: at(2026, 10, 13, 12).toISOString() });
    const c = entry({ id: 3, starts_at: at(2026, 10, 13, 14).toISOString(), ends_at: at(2026, 10, 13, 15).toISOString() });
    const placed = layoutTimed([a, b, c], at(2026, 10, 13));
    expect(placed.map((p) => [p.entry.id, p.lane, p.lanes])).toEqual([[1, 0, 2], [2, 1, 2], [3, 0, 1]]);
  });
});

describe('describeWhen', () => {
  it('says the time the way the calendar shows it', () => {
    expect(describeWhen(entry({ starts_at: at(2026, 10, 12, 9, 30).toISOString(), ends_at: at(2026, 10, 12, 10, 30).toISOString() })))
      .toBe('09:30 – 10:30');
    expect(describeWhen(entry({ kind: 'reminder', starts_at: at(2026, 10, 16, 19).toISOString() }))).toBe('19:00');
    expect(describeWhen(entry({ all_day: true, start_date: '2026-10-18', end_date: '2026-10-18' }))).toBe('All day');
  });
});

describe('the chat card', () => {
  const created = {
    summary: 'Added the reminder “Call Mom” on Fri 16 Oct 2026, 19:00 (America/Los_Angeles).',
    entry: entry({ id: 42, kind: 'reminder', title: 'Call Mom', starts_at: '2026-10-17T02:00:00Z' }),
    time_zone: 'America/Los_Angeles',
  };

  it('reads what calendar_create and calendar_move answered', () => {
    expect(parseCalendarToolResult('calendar_create', JSON.stringify(created))).toEqual({
      action: 'created', summary: created.summary, entry: created.entry,
    });
    expect(parseCalendarToolResult('calendar_move', JSON.stringify(created))?.action).toBe('moved');
  });

  it('reads a delete', () => {
    const body = { summary: 'Deleted …', deleted: { id: 42, kind: 'reminder', title: 'Call Mom' } };
    expect(parseCalendarToolResult('calendar_delete', JSON.stringify(body))).toEqual({
      action: 'deleted', summary: 'Deleted …', deleted: body.deleted,
    });
  });

  it('is nothing for an error, another tool, or text', () => {
    expect(parseCalendarToolResult('calendar_create', JSON.stringify({ error: 'A reminder needs a date and a time.' }))).toBeNull();
    expect(parseCalendarToolResult('drive_write', JSON.stringify(created))).toBeNull();
    expect(parseCalendarToolResult('calendar_list', 'On the calendar from …')).toBeNull();
    expect(parseCalendarToolResult('calendar_create', 'not json')).toBeNull();
  });
});

describe('a reminder that repeats (#355)', () => {
  it('says how it repeats', () => {
    expect(describeRepeat(entry({ kind: 'reminder', repeat: 'daily' }))).toBe('Every day');
    expect(describeRepeat(entry({ kind: 'reminder', repeat: 'weekdays' }))).toBe('Every weekday');
    expect(describeRepeat(entry({ kind: 'reminder', repeat: 'weekly', repeat_days: ['mon', 'thu'] })))
      .toBe('Every Monday and Thursday');
    expect(describeRepeat(entry({ kind: 'reminder', repeat: 'weekly', repeat_days: ['mon', 'wed', 'fri'] })))
      .toBe('Every Monday, Wednesday and Friday');
    expect(describeRepeat(entry({ kind: 'reminder', repeat: 'weekly', repeat_days: ['sat'] }))).toBe('Every Saturday');
    expect(describeRepeat(entry({ kind: 'reminder' }))).toBeNull();
  });

  it('keys each of its times apart, since they share an id', () => {
    const friday = entry({ id: 7, kind: 'reminder', repeat: 'daily', starts_at: '2026-10-16T15:00:00Z' });
    const saturday = { ...friday, starts_at: '2026-10-17T15:00:00Z' };
    expect(entryKey(friday)).not.toBe(entryKey(saturday));
    expect(entryKey(friday)).toBe(entryKey({ ...friday }));
    expect(entryKey(entry({ id: 9, all_day: true, start_date: '2026-10-18' }))).toBe('9@2026-10-18');
  });

  it('each time sits on its own day', () => {
    const friday = entry({ id: 7, kind: 'reminder', repeat: 'daily', starts_at: at(2026, 10, 16, 8).toISOString() });
    const saturday = { ...friday, starts_at: at(2026, 10, 17, 8).toISOString() };
    expect(entriesForDay([friday, saturday], at(2026, 10, 17)).timed).toEqual([saturday]);
  });

  it('reads what calendar_repeat answered as a change', () => {
    expect(CALENDAR_TOOL_NAMES).toContain('calendar_repeat');
    const body = {
      summary: 'The reminder “Take the pills” now repeats every weekday at 08:00, from Fri 16 Oct 2026 (UTC).',
      entry: entry({ id: 42, kind: 'reminder', title: 'Take the pills', repeat: 'weekdays', starts_at: '2026-10-16T08:00:00Z' }),
    };
    expect(parseCalendarToolResult('calendar_repeat', JSON.stringify(body))?.action).toBe('changed');
  });
});
