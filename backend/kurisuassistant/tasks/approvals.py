"""A task run waiting for the user's approval (#352).

A run has nobody attached to approve a tool call, so where a chat turn would put
the question to the client, a run writes a pending ``task_approvals`` row, moves
itself to ``waiting_for_approval``, notifies the user and waits. The user answers
over REST — from the run's conversation or the Tasks screen — and the run carries
on where it stopped: approved, the call runs (with the user's changed arguments,
if any); denied, it ends as denied, as in the chat. The account's permission
mode is applied before any of this (``BaseAgent.execute_tool``, #360), so only
calls it puts to the user wait: every call in Always ask, none in Read only or
Full access.

Nobody answering within ``TASK_APPROVAL_TIMEOUT_SECONDS`` (24 h) denies the call
and the run fails saying so. A waiting run gives its concurrency slot back while
it waits, so a day-long wait does not hold up other tasks. A restart while waiting
is not resumed: the run's turn lived in memory, so it is marked failed with that
reason at start (``service._recover``).
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Dict, Optional, Tuple

from kurisuassistant.db.repositories import TaskApprovalRepository, TaskRunRepository
from kurisuassistant.db.repositories.task import APPROVAL_PENDING, RUN_RUNNING, RUN_WAITING
from kurisuassistant.db.service import get_db_service
from kurisuassistant.websocket.events import ToolApprovalRequestEvent, ToolApprovalResponseEvent

logger = logging.getLogger(__name__)

APPROVAL_TIMEOUT_SECONDS = float(os.getenv("TASK_APPROVAL_TIMEOUT_SECONDS", str(24 * 3600)))

# approval id → the future the waiting run awaits. On the event loop only.
_waiters: Dict[int, asyncio.Future] = {}


class ApprovalClosed(LookupError):
    """The approval was already answered, expired or cancelled."""


def describe_timeout(seconds: float) -> str:
    """How long a run waits, in words: "24 hours", "30 minutes", "5 seconds"."""
    for unit, size in (("hour", 3600), ("minute", 60)):
        if seconds >= size:
            n = int(seconds // size)
            return f"{n} {unit}{'' if n == 1 else 's'}"
    n = max(int(seconds), 0)
    return f"{n} second{'' if n == 1 else 's'}"


async def notify_approval_needed(*, user_id: int, task_title: str, tool_name: str,
                                 conversation_id: Optional[int]) -> None:
    """Tell the user a run is waiting on them, on every device (#353)."""
    from kurisuassistant.notifications import notify

    await notify(
        user_id,
        source="assistant",
        title=f"{task_title} is waiting for your approval",
        body=f"It wants to use {tool_name}. Open the task to approve or deny it.",
        conversation_id=conversation_id,
    )


class RunSlot:
    """One of the scheduler's concurrency slots, held at most once.

    A run holds it while it works and gives it back while it waits for approval;
    ``release`` and ``acquire`` are idempotent so the run's ``finally`` can always
    release without counting twice.
    """

    def __init__(self, gate: Optional[asyncio.Semaphore]):
        self._gate = gate
        self._held = False

    async def acquire(self) -> None:
        if self._gate is not None and not self._held:
            await self._gate.acquire()
            self._held = True

    def release(self) -> None:
        if self._gate is not None and self._held:
            self._gate.release()
            self._held = False


class RunApprover:
    """What a run hands ``BaseAgent.execute_tool`` in place of a chat session.

    ``is_task_run`` is how the task tools tell a run from a chat (a run may not
    plan tasks). ``outcome`` says why a call ended denied: ``"denied"`` by the
    user, ``"expired"`` with nobody answering; ``None`` means the stored policy.
    """

    is_task_run = True

    def __init__(self, *, run_id: int, task_id: int, user_id: int, task_title: str, slot: RunSlot):
        self.run_id = run_id
        self.task_id = task_id
        self.user_id = user_id
        self.task_title = task_title
        self.slot = slot
        self.outcome: Optional[str] = None

    async def request_tool_approval(self, request: ToolApprovalRequestEvent) -> ToolApprovalResponseEvent:
        from .service import broadcast_tasks_changed

        db = get_db_service()
        timeout = APPROVAL_TIMEOUT_SECONDS

        def _open(session) -> Tuple[int, Optional[int]]:
            run = TaskRunRepository(session).get_by_id(self.run_id)
            approval = TaskApprovalRepository(session).create_pending(
                run, tool_name=request.tool_name, tool_args=request.tool_args,
                description=request.description, timeout_seconds=timeout,
            )
            run.status = RUN_WAITING
            return approval.id, run.conversation_id

        approval_id, conversation_id = await db.execute(_open)
        future = asyncio.get_running_loop().create_future()
        _waiters[approval_id] = future
        await broadcast_tasks_changed(self.user_id, self.task_id)
        try:
            await notify_approval_needed(
                user_id=self.user_id, task_title=self.task_title,
                tool_name=request.tool_name, conversation_id=conversation_id,
            )
        except Exception:  # noqa: BLE001 - a lost notification must not lose the run
            logger.warning("Could not notify user %s about approval %s", self.user_id, approval_id, exc_info=True)

        self.slot.release()
        try:
            try:
                approved, modified_args = await asyncio.wait_for(future, timeout=timeout)
            except asyncio.TimeoutError:
                approved, modified_args = await db.execute(lambda s: _expire(s, approval_id))
                if not approved:
                    self.outcome = "expired"
        except asyncio.CancelledError:
            await asyncio.shield(db.execute(lambda s: _close(s, approval_id, "cancelled")))
            raise
        finally:
            _waiters.pop(approval_id, None)

        await self.slot.acquire()

        def _resume(session):
            run = TaskRunRepository(session).get_by_id(self.run_id)
            if run is not None and run.status == RUN_WAITING:
                run.status = RUN_RUNNING

        await db.execute(_resume)
        await broadcast_tasks_changed(self.user_id, self.task_id)
        if not approved and self.outcome is None:
            self.outcome = "denied"
        return ToolApprovalResponseEvent(
            approval_id=request.approval_id, approved=approved, modified_args=modified_args or None,
        )


def _expire(session, approval_id: int) -> Tuple[bool, Optional[dict]]:
    """Nobody answered in time: deny — unless an answer landed at the same moment."""
    approval = TaskApprovalRepository(session).get_by_id(approval_id)
    if approval is None:
        return False, None
    if approval.status == APPROVAL_PENDING:
        TaskApprovalRepository(session).decide(approval, "expired")
        return False, None
    return approval.status == "approved", approval.modified_args


def _close(session, approval_id: int, status: str) -> None:
    approval = TaskApprovalRepository(session).get_by_id(approval_id)
    if approval is not None and approval.status == APPROVAL_PENDING:
        TaskApprovalRepository(session).decide(approval, status)


async def answer(user_id: int, approval_id: int, approved: bool, modified_args: Optional[dict] = None) -> Dict:
    """The user's answer. Raises ``LookupError`` (not theirs) or ``ApprovalClosed``."""
    def _decide(session):
        repo = TaskApprovalRepository(session)
        approval = repo.get_for_user(user_id, approval_id)
        if approval is None:
            raise LookupError(f"There is no approval {approval_id}.")
        if approval.status != APPROVAL_PENDING or approval_id not in _waiters:
            raise ApprovalClosed("This run is no longer waiting for an answer.")
        repo.decide(approval, "approved" if approved else "denied", modified_args if approved else None)
        return approval_view(approval)

    view = await get_db_service().execute(_decide)
    future = _waiters.get(approval_id)
    if future is not None and not future.done():
        future.set_result((approved, modified_args if approved else None))
    return view


def approval_view(approval) -> Dict:
    """An approval as the clients read it, with the run and task it belongs to."""
    run = approval.run
    iso = lambda moment: moment.isoformat() + "Z" if moment else None  # noqa: E731
    return {
        "id": approval.id,
        "run_id": approval.run_id,
        "task_id": run.task_id if run is not None else None,
        "task_title": run.task.title if run is not None and run.task is not None else "",
        "conversation_id": run.conversation_id if run is not None else None,
        "tool_name": approval.tool_name,
        "tool_args": approval.tool_args or {},
        "description": approval.description or "",
        "status": approval.status,
        "requested_at": iso(approval.requested_at),
        "expires_at": iso(approval.expires_at),
    }


def pending_views(session, user_id: int):
    return [approval_view(a) for a in TaskApprovalRepository(session).pending_for_user(user_id)]


def expire_for_restart(session, run) -> Optional[str]:
    """At start: close a run's pending approval; the tool it waited on, if any."""
    approval = TaskApprovalRepository(session).pending_for_run(run.id)
    if approval is None:
        return None
    TaskApprovalRepository(session).decide(approval, "expired")
    return approval.tool_name

