"""The task scheduler (#352): finds due tasks, starts their runs, stops them.

One asyncio loop in the app's own event loop, started and stopped by the
lifespan in ``main.py``. A run is the assistant's async turn, so it belongs on
the event loop rather than on the worker threads in ``workers/`` — those run
synchronous jobs.

Every ``TASK_SCAN_INTERVAL_SECONDS`` (and at once when kicked — a task the
assistant starts "now" should not wait for the next scan) the scheduler claims
the due tasks in one database call: for each, a ``running`` run row is written
and the task's next run is moved on *before* the run starts, so a crash or a
restart can never run the same occurrence twice. A run missed while the server
was down is due when it comes back and runs once; its next run is counted from
then, so a day of missed hourly runs is one run, not twenty-four. An occurrence
that comes due while the previous run is still going is skipped.

At start, a run still marked ``running`` — or ``waiting_for_approval`` — was
interrupted by the restart and is marked failed with that reason
(``approvals.py`` says why a waiting run is not resumed).
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from kurisuassistant.db.repositories import TaskRepository, TaskRunRepository
from kurisuassistant.db.repositories.task import RUN_FAILED
from kurisuassistant.db.service import get_db_service

from .records import schedule_of
from .schedule import next_run

logger = logging.getLogger(__name__)

TASK_SCAN_INTERVAL_SECONDS = float(os.getenv("TASK_SCAN_INTERVAL_SECONDS", "30"))
#: Runs at once across the server; the rest wait their turn, still "running".
TASK_MAX_CONCURRENT_RUNS = int(os.getenv("TASK_MAX_CONCURRENT_RUNS", "2"))
#: Due tasks claimed per scan; anything beyond waits for the next one.
TASK_SCAN_LIMIT = 50

RESTART_REASON = "The server restarted before this run finished."
WAITING_RESTART_REASON = (
    "The server restarted while this run waited for your approval of {tool}, and a run "
    "cannot pick up where it stopped. Ask the assistant to run it again."
)


class TaskScheduler:
    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._wake: Optional[asyncio.Event] = None
        self._scan_task: Optional[asyncio.Task] = None
        self._semaphore: Optional[asyncio.Semaphore] = None
        # task id → (run id, the asyncio task running it)
        self._runs: Dict[int, Tuple[int, asyncio.Task]] = {}

    # -- lifecycle -------------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        self._semaphore = asyncio.Semaphore(max(TASK_MAX_CONCURRENT_RUNS, 1))
        recovered = await get_db_service().execute(_recover)
        if recovered:
            logger.warning("Marked %d interrupted task run(s) as failed", recovered)
        self._scan_task = asyncio.create_task(self._scan_forever(), name="task-scheduler")
        logger.info("Task scheduler started (scan every %ss)", TASK_SCAN_INTERVAL_SECONDS)

    async def stop(self) -> None:
        if self._scan_task:
            self._scan_task.cancel()
            await asyncio.gather(self._scan_task, return_exceptions=True)
            self._scan_task = None
        running = [task for _, task in self._runs.values()]
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        self._runs.clear()
        self._loop = None

    def kick(self) -> None:
        """Scan now. Safe from any thread."""
        loop, wake = self._loop, self._wake
        if loop is None or wake is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(wake.set)

    # -- scanning --------------------------------------------------------------

    async def _scan_forever(self) -> None:
        while True:
            try:
                await self.scan_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad scan must not end the scheduler
                logger.error("Task scan failed", exc_info=True)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=TASK_SCAN_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    async def scan_once(self) -> None:
        busy = {task_id for task_id, (_, t) in self._runs.items() if not t.done()}
        claimed = await get_db_service().execute(lambda s: _claim_due(s, datetime.utcnow(), busy))
        for claim in claimed:
            self._start(claim)

    def _start(self, claim: Dict) -> None:
        from .runner import run_task

        task = asyncio.create_task(run_task(gate=self._semaphore, **claim), name=f"task-run-{claim['run_id']}")
        self._runs[claim["task_id"]] = (claim["run_id"], task)
        task.add_done_callback(lambda _t, task_id=claim["task_id"], run_id=claim["run_id"]: self._forget(task_id, run_id))

    def _forget(self, task_id: int, run_id: int) -> None:
        current = self._runs.get(task_id)
        if current and current[0] == run_id:
            del self._runs[task_id]

    # -- control ---------------------------------------------------------------

    def is_running(self, task_id: int) -> bool:
        current = self._runs.get(task_id)
        return bool(current and not current[1].done())

    async def stop_run(self, task_id: int) -> bool:
        """Stop the task's run, if one is going. True when one was stopped."""
        current = self._runs.get(task_id)
        if not current or current[1].done():
            return False
        current[1].cancel()
        await asyncio.gather(current[1], return_exceptions=True)
        return True


def _claim_due(session, now: datetime, busy: set) -> List[Dict]:
    """Start a run row for every due task and move its next run on. One transaction."""
    tasks = TaskRepository(session).due(now, TASK_SCAN_LIMIT)
    runs = TaskRunRepository(session)
    claimed = []
    for task in tasks:
        schedule = schedule_of(task)
        following = next_run(schedule, now)
        task.updated_at = now
        if task.id in busy or runs.running_for_task(task.id) is not None:
            # Still running the last one: skip this occurrence rather than stack.
            task.next_run_at = following
            if following is None:
                task.state = "finished"
            continue
        run = runs.start_run(task.id, task.user_id)
        task.last_run_at = now
        task.next_run_at = following
        if schedule.one_off:
            task.state = "finished"
        claimed.append({
            "run_id": run.id,
            "task_id": task.id,
            "user_id": task.user_id,
            "title": task.title,
            "instructions": task.instructions,
        })
    return claimed


def _recover(session) -> int:
    """At start: a run left going, or left waiting for approval, was cut off.

    A waiting run's turn lived in memory, so it is not resumed: its approval is
    closed and the run fails saying why.
    """
    from .approvals import expire_for_restart

    runs = TaskRunRepository(session)
    interrupted = runs.all_running()
    for run in interrupted:
        tool = expire_for_restart(session, run)
        reason = WAITING_RESTART_REASON.format(tool=tool) if tool else RESTART_REASON
        runs.finish(run, RUN_FAILED, reason)
    return len(interrupted)


# -- module API ------------------------------------------------------------------

scheduler = TaskScheduler()


async def start() -> None:
    await scheduler.start()


async def stop() -> None:
    await scheduler.stop()


def kick() -> None:
    scheduler.kick()


def recover_interrupted_runs() -> int:
    """Mark runs left ``running`` as failed. Called at start; safe from any thread."""
    return get_db_service().execute_sync(_recover)


async def broadcast_tasks_changed(user_id: int, task_id: Optional[int]) -> None:
    """Tell the user's open clients to refetch their tasks."""
    from kurisuassistant.websocket.events import TasksChangedEvent
    from kurisuassistant.websocket.manager import manager

    try:
        await manager.send_to_user(user_id, TasksChangedEvent(task_id=task_id).to_dict())
    except Exception:  # noqa: BLE001 - a client that missed it refetches on open
        logger.debug("Could not tell user %s that tasks changed", user_id, exc_info=True)
