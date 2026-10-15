"""The assistant's task tools (#352): it plans its own work with these.

``task_start`` begins work in the background now; ``task_schedule`` sets it for
later, once or repeating; ``task_list``, ``task_update``, ``task_stop`` and
``task_delete`` look after what exists. All six are built in, so the assistant
always has them, and like every tool they go through the user's tool policy:
asked in the chat unless set to Allow.

A run cannot plan or change tasks. Nobody is there to see a task appear, and a
task that schedules tasks is a loop with no one to stop it, so the five that
change something refuse in a task run (no chat session attached, or the run's
approver standing in for one). ``task_list`` stays available.

Times are wall-clock times in the user's account time zone
(``core/timezone.py``) unless the call names another.

Every result is JSON: what happened and the task as ``GET /tasks/{id}`` serves
it (minus its runs), so the clients render the same card for it in the chat as
the Tasks screen shows, and the model reads the schedule label and next run
back to the user. A refusal or a bad schedule is ``{"error": …}``, which marks
the tool call failed.
"""

import json
import logging
from typing import Any, Dict

from .base import BaseTool

logger = logging.getLogger(__name__)

NOT_IN_A_RUN = (
    "Tasks are planned in a chat with the user. A task run cannot start, schedule, "
    "change, stop or delete tasks."
)

_TITLE = {"type": "string", "description": "A few words naming the task, as the Tasks screen will show it."}
_INSTRUCTIONS = {
    "type": "string",
    "description": (
        "What to do each time the task runs, written to yourself: it is the whole of what "
        "you will be told when it runs, with nobody there to ask."
    ),
}
_SCHEDULE_PROPERTIES = {
    "repeat": {
        "type": "string",
        "enum": ["once", "daily", "weekdays", "weekly", "hourly"],
        "description": "once: at `at`. daily / weekdays: at `time`. weekly: on `days` at `time`. hourly: every `every_hours` hours.",
    },
    "at": {"type": "string", "description": "For once: the local date and time, as 2026-10-14T08:00."},
    "time": {"type": "string", "description": "For daily, weekdays and weekly: the local time of day as HH:MM (24-hour)."},
    "days": {
        "type": "array",
        "items": {"type": "string", "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]},
        "description": "For weekly: the days it runs.",
    },
    "every_hours": {"type": "integer", "description": "For hourly: hours between runs, 1 or more."},
    "timezone": {
        "type": "string",
        "description": (
            "Only when the user names a different time zone: its IANA name, such as Asia/Tokyo. "
            "Otherwise leave it out, and `at` and `time` are read in the user's account time zone."
        ),
    },
}
_TASK_ID = {"type": "integer", "description": "The task's id, from task_list or an earlier result."}


def _schema(name: str, description: str, properties: Dict, required) -> Dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": list(required)},
        },
    }


def _error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _ok(action: str, task: Dict, **extra) -> str:
    return json.dumps({"action": action, "task": task, **extra}, ensure_ascii=False)


async def _after_change(user_id: int, task_id, *, kick: bool = False) -> None:
    from kurisuassistant.tasks import service

    if kick:
        service.kick()
    await service.broadcast_tasks_changed(user_id, task_id)


def account_zone(session, user_id: int) -> str:
    """The account's time zone name, for a schedule that names none."""
    from kurisuassistant.core.timezone import user_timezone_name
    from kurisuassistant.db.repositories import UserRepository

    return user_timezone_name(UserRepository(session).get_by_id(user_id))


async def _db(op):
    from kurisuassistant.db.service import get_db_service

    return await get_db_service().execute(op)


class _TaskTool(BaseTool):
    built_in = True
    #: Whether a task run may call it.
    allowed_in_run = False

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.tasks.operations import TaskNotFound
        from kurisuassistant.tasks.schedule import ScheduleError

        user_id = args.get("user_id")
        if not user_id:
            return _error("No user context available.")
        handler = args.get("_handler")
        in_a_run = handler is None or getattr(handler, "is_task_run", False)
        if not self.allowed_in_run and in_a_run:
            return _error(NOT_IN_A_RUN)
        try:
            return await self.run(user_id, args)
        except (ScheduleError, TaskNotFound) as e:
            return _error(str(e))
        except Exception as e:  # noqa: BLE001 - the model gets a sentence, the log the trace
            logger.error("%s failed: %s", self.name, e, exc_info=True)
            return _error(f"{self.name} failed. Try again, or tell the user it did not work.")

    async def run(self, user_id: int, args: Dict[str, Any]) -> str:  # pragma: no cover - abstract
        raise NotImplementedError


class TaskStartTool(_TaskTool):
    name = "task_start"
    description = (
        "Start a task that runs in the background right now, on its own, while the conversation "
        "carries on or ends. Use it for work that takes a while or that the user does not need to "
        "wait for. Tell the user what you started. Not for reminding the user of something: that "
        "is a calendar reminder."
    )

    def get_schema(self):
        return _schema(self.name, self.description, {"title": _TITLE, "instructions": _INSTRUCTIONS},
                       ["title", "instructions"])

    async def run(self, user_id, args):
        from kurisuassistant.tasks.operations import create_task, task_view
        from kurisuassistant.tasks.schedule import parse_schedule

        def _create(session):
            task = create_task(
                session, user_id, title=args.get("title"), instructions=args.get("instructions"),
                schedule=parse_schedule("now", timezone=account_zone(session, user_id)),
                planned_in_conversation_id=args.get("conversation_id") or None,
            )
            return task_view(session, task)

        view = await _db(_create)
        await _after_change(user_id, view["id"], kick=True)
        return _ok("started", view)

    def describe_call(self, args):
        return f"Start a background task: {args.get('title', '')}"


class TaskScheduleTool(_TaskTool):
    name = "task_schedule"
    description = (
        "Schedule a task to run later on its own: once at a set time, or repeating (every day, "
        "on weekdays, on some days of the week, or every few hours). Use it when the user asks for "
        "something to be done later or regularly, or when you judge that regular work would help "
        "them. Tell the user what you scheduled and when it first runs. Not for reminding the user "
        "of something: that is a calendar reminder."
    )

    def get_schema(self):
        return _schema(
            self.name, self.description,
            {"title": _TITLE, "instructions": _INSTRUCTIONS, **_SCHEDULE_PROPERTIES},
            ["title", "instructions", "repeat"],
        )

    async def run(self, user_id, args):
        from kurisuassistant.tasks.operations import create_task, schedule_from, task_view
        from kurisuassistant.tasks.schedule import ScheduleError

        if (args.get("repeat") or "").strip().lower() == "now":
            raise ScheduleError("To start a task right away, use task_start.")

        def _create(session):
            schedule = schedule_from(args, default_timezone=account_zone(session, user_id))
            task = create_task(
                session, user_id, title=args.get("title"), instructions=args.get("instructions"),
                schedule=schedule, planned_in_conversation_id=args.get("conversation_id") or None,
            )
            return task_view(session, task)

        view = await _db(_create)
        await _after_change(user_id, view["id"], kick=True)
        return _ok("scheduled", view)

    def describe_call(self, args):
        return f"Schedule a task: {args.get('title', '')} ({args.get('repeat', '')})"


class TaskListTool(_TaskTool):
    name = "task_list"
    description = (
        "List the user's tasks: running, scheduled, paused and finished, each with its id, "
        "schedule and next run."
    )
    allowed_in_run = True

    def get_schema(self):
        return _schema(self.name, self.description, {}, [])

    async def run(self, user_id, args):
        from kurisuassistant.tasks.operations import list_views

        views = await _db(lambda s: list_views(s, user_id))
        return json.dumps({"tasks": views}, ensure_ascii=False)

    def describe_call(self, args):
        return "List tasks"


class TaskUpdateTool(_TaskTool):
    name = "task_update"
    description = (
        "Change a task: its title, its instructions, its schedule (give `repeat` and the fields it "
        "needs), or pause or resume it with `paused`."
    )

    def get_schema(self):
        return _schema(
            self.name, self.description,
            {
                "task_id": _TASK_ID, "title": _TITLE, "instructions": _INSTRUCTIONS,
                "paused": {"type": "boolean", "description": "true pauses the task, false resumes it."},
                **_SCHEDULE_PROPERTIES,
            },
            ["task_id"],
        )

    async def run(self, user_id, args):
        from kurisuassistant.tasks.operations import get_task, schedule_from, task_view, update_task

        def _update(session):
            schedule = (
                schedule_from(args, default_timezone=account_zone(session, user_id)) if args.get("repeat") else None
            )
            task = get_task(session, user_id, args.get("task_id"))
            update_task(
                session, task, title=args.get("title"), instructions=args.get("instructions"),
                schedule=schedule, paused=args.get("paused"),
            )
            return task_view(session, task)

        view = await _db(_update)
        await _after_change(user_id, view["id"], kick=True)
        return _ok("updated", view)

    def describe_call(self, args):
        return f"Change task {args.get('task_id')}"


class TaskStopTool(_TaskTool):
    name = "task_stop"
    description = "Stop a task's run that is going now. The task itself stays, with its schedule."

    def get_schema(self):
        return _schema(self.name, self.description, {"task_id": _TASK_ID}, ["task_id"])

    async def run(self, user_id, args):
        from kurisuassistant.tasks import service
        from kurisuassistant.tasks.operations import get_task, task_view

        task_id = await _db(lambda s: get_task(s, user_id, args.get("task_id")).id)
        stopped = await service.scheduler.stop_run(task_id)
        view = await _db(lambda s: task_view(s, get_task(s, user_id, task_id)))
        await _after_change(user_id, task_id)
        return _ok("stopped" if stopped else "not_running", view)

    def describe_call(self, args):
        return f"Stop task {args.get('task_id')}"


class TaskDeleteTool(_TaskTool):
    name = "task_delete"
    description = (
        "Delete a task, stopping it first if it is running. The conversations its runs left stay."
    )

    def get_schema(self):
        return _schema(self.name, self.description, {"task_id": _TASK_ID}, ["task_id"])

    async def run(self, user_id, args):
        from kurisuassistant.tasks import service
        from kurisuassistant.tasks.operations import delete_task, get_task, task_view

        view = await _db(lambda s: task_view(s, get_task(s, user_id, args.get("task_id"))))
        await service.scheduler.stop_run(view["id"])
        await _db(lambda s: delete_task(s, get_task(s, user_id, view["id"])))
        await _after_change(user_id, view["id"])
        return _ok("deleted", view)

    def describe_call(self, args):
        return f"Delete task {args.get('task_id')}"


TASK_TOOLS = (TaskStartTool, TaskScheduleTool, TaskListTool, TaskUpdateTool, TaskStopTool, TaskDeleteTool)
