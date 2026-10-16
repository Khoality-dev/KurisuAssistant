# Tasks

Work the assistant does on its own, now or on a schedule (#352). A chat turn
needs someone in the chat waiting for the reply; a task does not. The assistant
plans tasks itself with six task tools, a scheduler on the event loop runs
them, and each run is an ordinary assistant turn with nobody attached, saved to
a conversation of its own.

A task is the assistant doing work. Reminding the *user* to do something is a
calendar reminder (#282), not a task.

## Where the code is

| Piece | File |
|---|---|
| Schedules: parse, next run, label (pure) | `kurisuassistant/tasks/schedule.py` |
| Create, change, delete, serialize | `kurisuassistant/tasks/operations.py`, `tasks/records.py` |
| The scheduler | `kurisuassistant/tasks/service.py` |
| One run | `kurisuassistant/tasks/runner.py` |
| Waiting for approval | `kurisuassistant/tasks/approvals.py` |
| The account's time zone | `kurisuassistant/core/timezone.py` |
| The assistant's tools | `kurisuassistant/tools/tasks.py` |
| The Tasks screen's routes | `kurisuassistant/routers/tasks.py` |
| Tables | `tasks`, `task_runs`, `task_approvals`; `conversations.task_run` / `task_id`; `users.timezone` (`database.md`) |

## Schedules

Six repeats, enough for "every morning", "every Monday" and "every hour" without
a cron dialect the model would have to write:

| `repeat` | Needs | Runs |
|---|---|---|
| `now` | — | once, as soon as it is created (`task_start`) |
| `once` | `at` (`2026-10-14T08:00`, or with an offset) | once, then the task is `finished` |
| `daily` | `time` (`HH:MM`) | every day |
| `weekdays` | `time` | Monday to Friday |
| `weekly` | `time`, `days` (`mon`…`sun`) | on those days |
| `hourly` | `every_hours` (≥ 1) | every N hours, counted from the last run |

Wall times are in the schedule's `timezone` (an IANA name), so a daily 07:30
stays at 07:30 across a clock change. A schedule that names no zone — the
tools' default, and every schedule change from the Tasks screen — takes **the
account's**: `users.timezone`, which each client fills from its device the first
time it is empty and the user can change in account settings, read only through
`core/timezone.py::user_timezone` (UTC when unset). The tools accept an explicit
zone only for when the user names another. The system prompt's "Current time"
is the user's clock in that zone, with the weekday, so the model's "tomorrow at
8" is theirs. Every stored time is naive UTC, as
in the rest of the schema. A `once` time already
past is refused. `describe()` makes the label every client shows ("Weekdays at
07:30 (Europe/Paris)"); the `tzdata` package is a dependency so `zoneinfo` works
in an image with no system time zone database.

## A task's life

`state` is `active`, `paused` or `finished`; whether it is *running* is not a
state but a `task_runs` row with `status` `running` (or `waiting_for_approval`).
The API serves one `status` — `waiting_for_approval`, `running`, `scheduled`,
`paused`, `finished` — which is how the Tasks screen groups them. A finished
one-off is left out of `GET /tasks` (and `task_list`) unless asked for with
`?include_finished=true`: the screen shows what the assistant will still do, and
the run it made stays a conversation. `GET /tasks/{id}` serves any task.

- **Claiming.** Every `TASK_SCAN_INTERVAL_SECONDS` (30), and at once when kicked
  — `task_start` and every change kick it — the scheduler claims the due tasks
  in **one** database call: for each, a `running` run row is written and the
  task's `next_run_at` moved on (one-offs become `finished`) *before* the run
  starts. A crash or a restart therefore never runs one occurrence twice.
- **Missed runs.** A run due while the server was down is due when it comes
  back and runs **once**; the next one is counted from then, so a day of missed
  hourly runs is one run, not twenty-four. An occurrence that comes due while
  the previous run is still going is skipped.
- **Interrupted runs.** At start, a run still marked `running` was cut off by
  the restart: it is marked `failed`, "The server restarted before this run
  finished." A run left `waiting_for_approval` is not resumed — its turn lived in
  memory — so its approval is closed and it fails saying so.
- **Concurrency.** At most `TASK_MAX_CONCURRENT_RUNS` (2) runs at once across the
  server; the rest wait, already `running`. Waiting is part of the run, so a run
  stopped while it waits is recorded as stopped. A run waiting for approval
  gives its place back (`approvals.RunSlot`) and takes one again to carry on.
- **Stop and delete.** `POST /tasks/{id}/stop` and `task_stop` cancel the run's
  asyncio task; it records `stopped`. Deleting a task stops its run first; its
  runs go with it (cascade) and their conversations stay, with `task_id` set to
  null and `task_run` still true.

## A run

`runner.run_task` is the chat's turn with nobody attached:

1. One DB call reads the account's settings, the assistant and **the persona in
   use** (`persona_for_run`, through `agents/selection.py::persona_in_use` as every
   chat turn does, #354), creates the run's
   conversation (title = the task's, `task_run = true`, `task_id`), points the
   run at it, and saves the task's instructions as its opening user message.
2. `MainAgent` runs with the run's approver as its handler and the account's
   permission mode (`assistants.permission_mode`, #360). The
   system prompt gains a `## Task run` section (via the user-prompt slot):
   nobody is in the chat, finish with an account of what was done, notify the
   user if they should hear now.
3. The chat's own `_stream_and_save_agent` saves the messages, on
   `_HeadlessTurn`, a `ChatSessionHandler` with no socket whose `send_event`
   only notes a refused tool — so a run's messages are stored exactly as a chat
   turn's are.
4. The run is finished `done`, `failed` (with a reason the screen shows) or
   `stopped`; the conversation is queued for the retrieval index; every open
   client of the account hears `tasks_changed`.

**A tool call the permission mode puts to the user waits for them.** The mode
applies first, as everywhere (`BaseAgent.execute_tool`): Full access runs every
call, Read only runs a tool that only looks and refuses the rest, and only under
Always ask — every call, reads included, except `notify_user` — is a call put to
`approvals.RunApprover`, which stands in for the chat session:
it writes a pending `task_approvals` row (the run, the tool, its arguments, the
tool's own description of the call, when it was asked, when it expires), moves
the run to `waiting_for_approval`, sends `tasks_changed`, notifies the user —
`notify_approval_needed`, through `notifications.notify` like any other
notification, so it reaches every device and is read once for all (#353) — and
waits. The answer comes over REST
(`GET /tasks/approvals`, `POST /tasks/approvals/{id}`), from the run's
conversation or the Tasks screen, and resolves the waiting future: approved, the
call runs with the user's changed arguments if any and the turn carries on;
denied, the call ends as denied and so does the turn, as in the chat. Nobody
answering within `TASK_APPROVAL_TIMEOUT_SECONDS` (24 h) denies it. The run's
failure says which: "You denied *tool*", "Nobody approved *tool* within 24
hours", or "*tool* changes something and the permission mode is Read only".

A run cannot plan tasks: the five task tools that change something refuse in a
run — no session attached, or the approver (`is_task_run`) in its place
(`task_list` stays available). Nobody would see a
task appear, and a task that schedules tasks is a loop with nobody to stop it.

A run tells the user something the way any turn does — the notification tool
(#353). Nothing here sends a client anything but `tasks_changed`.

## The tools

All six go through the permission mode like any other tool; `task_list` only
looks, the other five change something:

| Tool | Does |
|---|---|
| `task_start` | `title`, `instructions` → a `now` task, started at once |
| `task_schedule` | `title`, `instructions`, `repeat` and what it needs, `timezone` |
| `task_list` | every task with id, status, schedule label, next run |
| `task_update` | `task_id` and any of `title`, `instructions`, `paused`, a new schedule |
| `task_stop` | stop the task's run |
| `task_delete` | stop it if running, then delete it |

Every result is JSON: `{"action": "started"|"scheduled"|"updated"|"stopped"|"not_running"|"deleted", "task": {…}}`
with the task as `GET /tasks/{id}` serves it minus its runs — which is what the
clients render as a card in the chat (`parseTaskToolResult` on desktop,
`TaskModels.kt` on Android) — or `{"error": "…"}`, which marks the call failed
and gives the model a sentence to read back (a bad time, an unknown timezone, a
time already past).

## Planning in the chat

The task the assistant plans in a chat remembers that chat
(`planned_in_conversation_id`), which the Tasks screen links back to.
`task_start` and `task_schedule` take their `conversation_id` from the turn's
context, as every tool's call arguments carry it.
