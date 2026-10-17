# Calendar

[← backend](../CLAUDE.md)

The user's events and reminders (#282). Built into the assistant, not a plugin
(#268): both clients have a Calendar on their navigation, and the assistant
keeps it with five tools of its own. A reminder can repeat (#355).

**The calendar is the user's, and it is not agentic.** Nothing on it starts the
assistant. A reminder notifies the user when it is due; work the assistant does
by itself, now or on a schedule, is a task (#352). And nothing records who put
an entry there: whether the user typed it on the Calendar screen or said
"remind me to call Mom on Friday" in a chat, it is theirs.

## The pieces

| Where | What |
|---|---|
| `db/models.py` `CalendarEntry` | One table, `calendar_entries`, for both kinds |
| `db/models.py` `CalendarOccurrence` | `calendar_occurrences`: the times of a repeating reminder that are done |
| `calendar/times.py` | Wall-clock time in the account's zone ↔ the naive UTC the table stores, and the words a person reads |
| `calendar/repeat.py` | A repeat as times: the rules, the next and the latest time, the words |
| `calendar/entries.py` | `validate` — what can be on a calendar — `apply_update` (move, rename, repeat, done), and `to_response` / `expand` / `coming_up`, which show a series as its times; the router and the tools all call them |
| `routers/calendar.py` | `/calendar/*` (see `API.md` → Calendar) |
| `tools/calendar.py` | `calendar_create`, `calendar_list`, `calendar_move`, `calendar_repeat`, `calendar_delete` |
| `calendar/delivery.py` | One due reminder handed to `kurisuassistant.notifications.notify` (#353) |
| `workers/reminders.py` | The due-reminder scanner |

## An entry

`kind` is `event` or `reminder`.

- **A reminder** is an instant, `starts_at`. It can be marked done
  (`done_at`), and it is delivered once (`delivered_at`).
- **A timed event** is `starts_at`–`ends_at`. With no end it lasts an hour
  (`DEFAULT_EVENT_LENGTH`).
- **An all-day event** is `start_date`–`end_date`, inclusive, with no zone: a
  birthday is a date wherever the user happens to be, not an instant. With no
  end date it is one day.

Instants are naive UTC, like every other column in the schema, and travel as
ISO 8601 with a `Z`. A title is at most 200 characters, notes at most 4000.
Anything else is refused by `validate` with an `EntryError`, whose text is the
sentence the client shows (`400` on REST, `{"error": …}` from a tool).

Moving a timed event's start without naming an end keeps its length; moving an
all-day event's first day keeps its span. Moving a reminder clears
`delivered_at` and `delivery_attempts`, so it is due again at its new time.
Marking an event done is refused — only a reminder can be done.

## A reminder that repeats

A reminder can come back every day, every weekday (Monday to Friday), or every
week on chosen days (#355). Events do not repeat; work the assistant should do
on a schedule is a task (#352), never a repeating reminder.

**One row is the series.** `repeat` (`daily` | `weekdays` | `weekly`) and
`repeat_days` (`mon,thu`) say how, and `starts_at` is its first time. Every
later time is that **wall-clock time** in the account's zone on a later matching
day — 08:00 stays 08:00 when the clocks change, which a 24-hour step would not.
`calendar/repeat.py` is the only code that turns a rule into instants; the
routes, the tools and the scanner all ask it. A change of the account's zone
moves the times with it (the first time's clock is read in the zone in force).

**What a client sees is the times.** A window lists one item per time, all with
the series' `id`, each with that time as `starts_at` and that time's own `done`;
`repeat_from` is the first time, which an edit changes. One entry on its own —
`GET`, or the answer to a create or a change — is its first time from the start
of the user's today, so a notification tapped at 08:05 opens on this morning's.

**Done is per time.** A `calendar_occurrences` row exists while one time is
done; the series' own `done_at` stays empty. Marking a time done says which
(`occurrence_at`), and it must be one of its times. A time done in advance is
not delivered.

**Changing it.** Moving `starts_at` moves the first time and the time of day of
all of them; a new rule replaces the old. Either way the done marks still ahead
are dropped (they were the old rule's times) and the past ones kept. A one-off
reminder given a repeat becomes a series from its own time, its done carried to
that time. **Stopping** (`repeat: null`, or `calendar_repeat` with `none`)
leaves one reminder: at the time given, else its latest time that has come —
stamped delivered, so it does not notify again — else its first.

## Time zones

Every zone lookup in the calendar goes through one function,
`calendar/zone.py::zone_for(user)`, which is the account's zone setting
(`users.timezone`, filled once from the device by the clients, #352) through
`core/timezone.py::user_timezone`, and UTC for an account without one. Tests
pin the calendar's behaviour in a zone by patching `zone_for`.

It is read in three places:

- **The tools.** The model writes wall-clock time — `2026-10-16T19:00` — and
  `times.parse_local` reads it in the account's zone. An explicit offset or `Z`
  is taken as written; a date alone (`2026-10-18`) is a date, which makes an
  all-day event. Every answer names the zone.
- **"Coming up"**, whose "today" (for all-day events) is the account's.
- **The notification.** A reminder says "Due at 19:00" in the account's zone,
  or "Was due Fri 16 Oct 2026, 19:00" when it went out late (the server was
  down at the time).

The system prompt's "Current time" line is the user's local time in the same
zone (#352), so "Friday at 7" lands on the user's Friday.

The clients show everything in the device's own zone.

## The tools

The calendar is one of the assistant's own features, and all five go through the
account's permission mode like any other tool (#360): `calendar_list` only looks,
the other four change the calendar, so Read only refuses them.

- `calendar_create(kind, title, start, end?, notes?, repeat?, repeat_days?)`,
  `calendar_move(id, start, end?)` and `calendar_repeat(id, repeat,
  repeat_days?)` — `repeat` `daily`, `weekdays`, `weekly`, or `none` to stop —
  answer JSON:
  `{"summary": "Added the reminder “Call Mom” on Fri 16 Oct 2026, 19:00 (America/Los_Angeles).", "entry": {…the REST shape…}, "time_zone": "America/Los_Angeles"}`.
  The `summary` is for the model; the `entry` is what both clients draw the
  chat's calendar card from — "Reminder added to your calendar", with Open in
  Calendar and Undo.
- `calendar_delete(id)` answers `{"summary": …, "deleted": {"id", "kind", "title"}}`.
- `calendar_list(from?, to?)` answers text, one line per entry with its id,
  defaulting to the next two weeks and capped at 100 entries. A repeating
  reminder is one line, with its repeat and its first time in the window.

A refusal is `{"error": "<sentence>"}`, which `ToolResult` marks as an error.

## Delivery

`workers/reminders.py` runs every `REMINDER_SCAN_INTERVAL_SECONDS` (30) as an
asyncio task on the app's event loop — not a worker thread like the scanners in
`service.py`, because delivery reaches the clients' open connections, which live
on that loop. `workers.start()` starts it when there is a running loop and
`workers.stop()` cancels it; the test suite parks the interval, as it does the
idle and index scans, and runs `scan_once()` by hand.

Each scan claims up to `SCAN_LIMIT` (100) due reminders — `kind = 'reminder'`,
not done, not delivered, `starts_at <= now`, over the partial index
`ix_calendar_entries_due` — by stamping `delivered_at` in the transaction that
found them, then hands each to `delivery.deliver`. So a reminder goes out once.

A delivery that raises is released for the next scan and `delivery_attempts`
bumped; after `MAX_DELIVERY_ATTEMPTS` (5) the stamp stays and the failure is
logged as an error. The reminder is still on the calendar; it never notified.

A repeating reminder is claimed by its cursor instead, `next_due_at` (over its
own partial index, `ix_calendar_entries_repeat_due`; the one-off index and
query leave series out, so a series is never due by its first time). The claim
moves the cursor past now and delivers the latest time that has come — **one**
notification, however many times a server that was down missed — unless that
time is done. A failed delivery puts the cursor back on that time; after
`MAX_DELIVERY_ATTEMPTS` the time is given up and the series goes on. Creating a
series, or changing its time or its rule, points the cursor at its next time
from now (`entries.schedule`): a time already past today is not delivered late.

`delivery.deliver` calls `notifications.notify(user_id, source="calendar",
title=…, body=…, reminder_id=…)` (#353): the notification is stored, sent to
every device and read once for all. A client's notification tap opens the
Calendar on that reminder (the desktop's `useCalendarStore.openEntry`,
Android's `Routes.calendar(reminderId)`).

The notification follows the reminder. When a reminder is marked done, moved,
repeated differently or deleted — over REST or by the assistant's
`calendar_move` / `calendar_repeat` / `calendar_delete` — `delivery.withdraw`
reads its notification
(`notifications.mark_read(reminder_id=…)`), so it comes down on every device
instead of asking about something already handled; a moved reminder notifies
again at its new time. Renaming one leaves its notification alone.
