"""Planning, changing and deleting tasks (#352): the rules the tools and REST share.

Each function takes a SQLAlchemy session and runs inside one DB-thread call.
Stopping a run and telling clients are the scheduler's (``service``), which
lives on the event loop; callers do those after the call returns.
"""

from datetime import datetime
from typing import Dict, List, Optional

from kurisuassistant.db.repositories import TaskRepository, TaskRunRepository

from .records import schedule_columns, schedule_of, task_dict
from .schedule import Schedule, ScheduleError, first_run, parse_schedule

TITLE_MAX = 120


class TaskNotFound(LookupError):
    """No task with that id belongs to this user."""


def _clean_title(title: Optional[str]) -> str:
    text = (title or "").strip()
    if not text:
        raise ScheduleError("A task needs a title: a few words naming what it does.")
    return text[:TITLE_MAX]


def _clean_instructions(instructions: Optional[str]) -> str:
    text = (instructions or "").strip()
    if not text:
        raise ScheduleError("A task needs instructions: what to do each time it runs.")
    return text


def schedule_from(fields: Dict, default_timezone: str = "UTC") -> Schedule:
    """A ``Schedule`` from the loose fields a tool call or a PATCH carries.

    ``default_timezone`` is the account's (``core/timezone.py``), used when the
    fields name none.
    """
    return parse_schedule(
        fields.get("repeat") or "",
        timezone=fields.get("timezone") or default_timezone,
        at=fields.get("at"),
        time=fields.get("time"),
        days=fields.get("days"),
        every_hours=fields.get("every_hours"),
    )


def create_task(
    session, user_id: int, *, title: str, instructions: str, schedule: Schedule,
    planned_in_conversation_id: Optional[int] = None, now: Optional[datetime] = None,
):
    now = now or datetime.utcnow()
    return TaskRepository(session).create_task(
        user_id,
        title=_clean_title(title),
        instructions=_clean_instructions(instructions),
        schedule=schedule,
        next_run_at=first_run(schedule, now),
        planned_in_conversation_id=planned_in_conversation_id,
    )


def get_task(session, user_id: int, task_id) -> object:
    try:
        task_id = int(task_id)
    except (TypeError, ValueError):
        raise TaskNotFound(f"There is no task {task_id}.") from None
    task = TaskRepository(session).get_by_user_and_id(user_id, task_id)
    if task is None:
        raise TaskNotFound(f"There is no task {task_id}.")
    return task


def update_task(
    session, task, *, title: Optional[str] = None, instructions: Optional[str] = None,
    schedule: Optional[Schedule] = None, paused: Optional[bool] = None, now: Optional[datetime] = None,
):
    """Change what a task does, when it runs, or whether it is paused."""
    now = now or datetime.utcnow()
    if title is not None:
        task.title = _clean_title(title)
    if instructions is not None:
        task.instructions = _clean_instructions(instructions)

    reschedule = False
    if schedule is not None:
        for column, value in schedule_columns(schedule).items():
            setattr(task, column, value)
        if task.state == "finished":
            task.state = "active"
        reschedule = task.state == "active"
    if paused is True:
        task.state = "paused"
        task.next_run_at = None
        reschedule = False
    elif paused is False and task.state == "paused":
        task.state = "active"
        reschedule = True

    if reschedule:
        task.next_run_at = first_run(schedule or schedule_of(task), now)
    task.updated_at = now
    return task


def delete_task(session, task) -> None:
    session.delete(task)


def is_running(session, task) -> bool:
    return TaskRunRepository(session).running_for_task(task.id) is not None


def task_view(session, task, *, with_runs: bool = False, run_limit: int = 10) -> Dict:
    from kurisuassistant.db.repositories import TaskApprovalRepository
    from kurisuassistant.db.repositories.task import RUN_WAITING

    from .approvals import approval_view

    runs = TaskRunRepository(session).recent_for_task(task.id, run_limit) if with_runs else None
    active = TaskRunRepository(session).running_for_task(task.id)
    pending = None
    if active is not None and active.status == RUN_WAITING:
        approval = TaskApprovalRepository(session).pending_for_run(active.id)
        pending = approval_view(approval) if approval is not None else None
    return task_dict(task, running=active is not None, runs=runs, pending_approval=pending)


def list_views(session, user_id: int, *, include_finished: bool = False) -> List[Dict]:
    """The user's tasks. A finished one-off is left out unless asked for: the Tasks
    screen shows what the assistant will still do, and its run is a conversation."""
    return [
        task_view(session, t)
        for t in TaskRepository(session).list_by_user(user_id)
        if include_finished or t.state != "finished" or is_running(session, t)
    ]
