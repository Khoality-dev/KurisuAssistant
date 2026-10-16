# Calendar

[← backend](../CLAUDE.md)

The user's events and reminders (#282). Built into the assistant, not a plugin
(#268): both clients have a Calendar on their navigation, and the assistant
keeps it with four tools of its own.

**The calendar is the user's, and it is not agentic.** Nothing on it starts the
assistant. A reminder notifies the user when it is due; work the assistant does
by itself, now or on a schedule, is a task (#352). And nothing records who put
an entry there: whether the user typed it on the Calendar screen or said
"remind me to call Mom on Friday" in a chat, it is theirs.

## The pieces

| Where | What |
|---|---|
| `db/models.py` `CalendarEntry` | One table, `calendar_entries`, for both kinds |
| `calendar/times.py` | Wall-clock time in the account's zone ↔ the naive UTC the table stores, and the words a person reads |
| `calendar/entries.py` | `validate` — what can be on a calendar — and `apply_update` (move, rename, done); the router and the tools both call them |
| `routers/calendar.py` | `/calendar/*` (see `API.md` → Calendar) |
| `tools/calendar.py` | `calendar_create`, `calendar_list`, `calendar_move`, `calendar_delete` |
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

There is no repeat. A weekly reminder is seven entries, or a task (#352) if
the assistant should act on it. Repeating entries are a follow-up if they are
wanted.

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

The calendar is one of the assistant's own features, and all four go through the
account's permission mode like any other tool (#360): `calendar_list` only looks,
the other three change the calendar, so Read only refuses them.

- `calendar_create(kind, title, start, end?, notes?)` and
  `calendar_move(id, start, end?)` answer JSON:
  `{"summary": "Added the reminder “Call Mom” on Fri 16 Oct 2026, 19:00 (America/Los_Angeles).", "entry": {…the REST shape…}, "time_zone": "America/Los_Angeles"}`.
  The `summary` is for the model; the `entry` is what both clients draw the
  chat's calendar card from — "Reminder added to your calendar", with Open in
  Calendar and Undo.
- `calendar_delete(id)` answers `{"summary": …, "deleted": {"id", "kind", "title"}}`.
- `calendar_list(from?, to?)` answers text, one line per entry with its id,
  defaulting to the next two weeks and capped at 100 entries.

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

`delivery.deliver` calls `notifications.notify(user_id, source="calendar",
title=…, body=…, reminder_id=…)` (#353): the notification is stored, sent to
every device and read once for all. A client's notification tap opens the
Calendar on that reminder (the desktop's `useCalendarStore.openEntry`,
Android's `Routes.calendar(reminderId)`).

The notification follows the reminder. When a reminder is marked done, moved
or deleted — over REST or by the assistant's `calendar_move` /
`calendar_delete` — `delivery.withdraw` reads its notification
(`notifications.mark_read(reminder_id=…)`), so it comes down on every device
instead of asking about something already handled; a moved reminder notifies
again at its new time. Renaming one leaves its notification alone.
