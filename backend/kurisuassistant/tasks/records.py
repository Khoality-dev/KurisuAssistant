"""A task as stored, as served, and as told to the model (#352).

One shape for the REST surface and the tools, so the Tasks screen and the
chat's task cards read the same fields.
"""

from datetime import datetime
from typing import Dict, Iterable, Optional

from .schedule import DAY_NAMES, Schedule, describe

#: What a task is doing, as the Tasks screen groups it.
STATUS_RUNNING = "running"
STATUS_WAITING = "waiting_for_approval"
STATUS_SCHEDULED = "scheduled"
STATUS_PAUSED = "paused"
STATUS_FINISHED = "finished"


def schedule_columns(schedule: Schedule) -> Dict:
    """The task row's schedule columns for ``schedule``."""
    from .schedule import _once_utc

    return {
        "repeat": schedule.repeat,
        "timezone": schedule.timezone,
        "run_at": _once_utc(schedule) if schedule.repeat == "once" else None,
        "time_of_day": schedule.time,
        "days": list(schedule.days) if schedule.repeat == "weekly" else None,
        "every_hours": schedule.every_hours,
    }


def schedule_of(task) -> Schedule:
    """The ``Schedule`` a task row stores. ``once`` comes back as an aware UTC time."""
    at = None
    if task.repeat == "once" and task.run_at is not None:
        from datetime import timezone

        at = task.run_at.replace(tzinfo=timezone.utc)
    return Schedule(
        repeat=task.repeat,
        timezone=task.timezone or "UTC",
        at=at,
        time=task.time_of_day,
        days=tuple(task.days or ()),
        every_hours=task.every_hours,
    )


def _iso(moment: Optional[datetime]) -> Optional[str]:
    return moment.isoformat() + "Z" if moment else None


def status_of(task, running: bool, waiting: bool = False) -> str:
    if waiting:
        return STATUS_WAITING
    if running:
        return STATUS_RUNNING
    if task.state == "paused":
        return STATUS_PAUSED
    if task.state == "finished":
        return STATUS_FINISHED
    return STATUS_SCHEDULED


def run_dict(run) -> Dict:
    return {
        "id": run.id,
        "status": run.status,
        "error": run.error,
        "conversation_id": run.conversation_id,
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
    }


def task_dict(task, *, running: bool, runs: Optional[Iterable] = None,
              pending_approval: Optional[Dict] = None) -> Dict:
    schedule = schedule_of(task)
    data = {
        "id": task.id,
        "title": task.title,
        "instructions": task.instructions,
        "status": status_of(task, running, waiting=pending_approval is not None),
        # The tool call the running task waits on the user to approve, if any.
        "pending_approval": pending_approval,
        "repeat": task.repeat,
        "timezone": task.timezone or "UTC",
        "run_at": _iso(task.run_at),
        "time": task.time_of_day,
        "days": [DAY_NAMES[d] for d in (task.days or [])],
        "every_hours": task.every_hours,
        "schedule_label": describe(schedule),
        "next_run_at": _iso(task.next_run_at),
        "last_run_at": _iso(task.last_run_at),
        "planned_in_conversation_id": task.planned_in_conversation_id,
        "created_at": _iso(task.created_at),
        "updated_at": _iso(task.updated_at),
    }
    if runs is not None:
        data["runs"] = [run_dict(r) for r in runs]
    return data
