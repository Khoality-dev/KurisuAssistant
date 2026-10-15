"""The Tasks screen's routes (#352).

Tasks are planned by the assistant (``tools/tasks.py``), so there is no create
route: the screen lists them, shows one with its recent runs, and changes,
pauses, stops or deletes them, and answers a run waiting for approval
(``/tasks/approvals``). A task or approval that is not the caller's is a 404.
"""

import logging
from typing import Any, Dict, List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.errors import internal_error
from kurisuassistant.db.models import User
from kurisuassistant.db.service import get_db_service
from kurisuassistant.tasks import approvals, service
from kurisuassistant.tasks.operations import (
    TaskNotFound,
    delete_task,
    get_task,
    list_views,
    schedule_from,
    task_view,
    update_task,
)
from kurisuassistant.tasks.schedule import ScheduleError
from kurisuassistant.tools.tasks import account_zone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["tasks"])


class ScheduleBody(BaseModel):
    repeat: str
    timezone: Optional[str] = None
    at: Optional[str] = None
    time: Optional[str] = None
    days: Optional[List[Union[str, int]]] = None
    every_hours: Optional[int] = None


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    instructions: Optional[str] = None
    paused: Optional[bool] = None
    schedule: Optional[ScheduleBody] = None


def _not_found(task_id: int) -> HTTPException:
    return HTTPException(status_code=404, detail="Task not found")


@router.get("")
async def list_tasks(include_finished: bool = False, user: User = Depends(get_authenticated_user)):
    """The user's tasks: running, waiting for approval, scheduled or paused.

    A one-off that has run is ``finished`` and left out unless
    ``include_finished`` asks for it — the Tasks screen shows what the assistant
    will still do, and the run it made is a conversation.
    """
    try:
        return await get_db_service().execute(
            lambda s: list_views(s, user.id, include_finished=include_finished)
        )
    except Exception as e:
        raise internal_error(e, "Error listing tasks")


class ApprovalAnswer(BaseModel):
    approved: bool
    modified_args: Optional[Dict[str, Any]] = None


@router.get("/approvals")
async def list_approvals(user: User = Depends(get_authenticated_user)):
    """Tool calls the user's task runs are waiting on them to approve, oldest first."""
    try:
        return await get_db_service().execute(lambda s: approvals.pending_views(s, user.id))
    except Exception as e:
        raise internal_error(e, "Error listing task approvals")


@router.post("/approvals/{approval_id}")
async def answer_approval(approval_id: int, body: ApprovalAnswer, user: User = Depends(get_authenticated_user)):
    """Approve or deny a waiting call; the run carries on with the answer.

    404 when it is not the user's; 409 when the run no longer waits for it —
    answered already, expired, stopped, or cut off by a restart.
    """
    try:
        view = await approvals.answer(user.id, approval_id, body.approved, body.modified_args)
    except approvals.ApprovalClosed:
        raise HTTPException(status_code=409, detail="This run is no longer waiting for an answer.")
    except LookupError:
        raise HTTPException(status_code=404, detail="Approval not found")
    except Exception as e:
        raise internal_error(e, f"Error answering approval {approval_id}")
    return view


@router.get("/{task_id}")
async def read_task(task_id: int, user: User = Depends(get_authenticated_user)):
    """One task with its ten most recent runs, newest first."""
    try:
        return await get_db_service().execute(
            lambda s: task_view(s, get_task(s, user.id, task_id), with_runs=True)
        )
    except TaskNotFound:
        raise _not_found(task_id)
    except Exception as e:
        raise internal_error(e, f"Error reading task {task_id}")


@router.patch("/{task_id}")
async def change_task(task_id: int, body: TaskUpdate, user: User = Depends(get_authenticated_user)):
    """Change the title, the instructions or the schedule, or pause and resume."""
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    try:
        def _update(session):
            # A schedule that names no zone is in the account's (core/timezone.py).
            schedule = (
                schedule_from(fields["schedule"], default_timezone=account_zone(session, user.id))
                if fields.get("schedule") else None
            )
            task = get_task(session, user.id, task_id)
            update_task(
                session, task,
                title=fields.get("title"),
                instructions=fields.get("instructions"),
                schedule=schedule,
                paused=fields.get("paused"),
            )
            return task_view(session, task, with_runs=True)

        view = await get_db_service().execute(_update)
    except TaskNotFound:
        raise _not_found(task_id)
    except ValueError as e:
        if isinstance(e, ScheduleError):  # a sentence this code wrote, for the user
            raise HTTPException(status_code=400, detail=str(e))
        raise internal_error(e, f"Error updating task {task_id}")
    except Exception as e:
        raise internal_error(e, f"Error updating task {task_id}")
    service.kick()
    await service.broadcast_tasks_changed(user.id, task_id)
    return view


@router.post("/{task_id}/stop")
async def stop_task(task_id: int, user: User = Depends(get_authenticated_user)):
    """Stop the run that is going now. 409 when nothing is running."""
    try:
        await get_db_service().execute(lambda s: get_task(s, user.id, task_id))
    except TaskNotFound:
        raise _not_found(task_id)
    if not await service.scheduler.stop_run(task_id):
        raise HTTPException(status_code=409, detail="This task is not running.")
    await service.broadcast_tasks_changed(user.id, task_id)
    return {"stopped": True}


@router.delete("/{task_id}")
async def remove_task(task_id: int, user: User = Depends(get_authenticated_user)):
    """Delete a task, stopping its run first. Its runs' conversations stay."""
    try:
        await get_db_service().execute(lambda s: get_task(s, user.id, task_id))
    except TaskNotFound:
        raise _not_found(task_id)
    await service.scheduler.stop_run(task_id)
    try:
        await get_db_service().execute(lambda s: delete_task(s, get_task(s, user.id, task_id)))
    except TaskNotFound:
        raise _not_found(task_id)
    except Exception as e:
        raise internal_error(e, f"Error deleting task {task_id}")
    await service.broadcast_tasks_changed(user.id, task_id)
    return {"message": "Task deleted"}
