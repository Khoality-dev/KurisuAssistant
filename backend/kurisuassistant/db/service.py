"""Central database service — single-threaded owner of all DB access.

All reads and writes go through one dedicated thread via a queue.
Async callers use ``await db.execute(op)``, sync callers use ``db.execute_sync(op)``.

The single thread is deliberate (it is what makes the memory read-modify-write
safe), which is exactly why it must not be blockable without notice. Three
guards keep a slow or broken database from turning into a silent hang (#153):

* a failing operation is logged here, with its traceback, before the exception
  is handed to the caller — the caller may or may not surface it;
* both ``execute`` paths wait at most ``DB_OPERATION_TIMEOUT_SECONDS`` and then
  raise :class:`DBUnavailableError`, which the HTTP layer turns into a 503;
* the engine itself has a connect timeout and a statement timeout
  (``kurisuassistant.db.session``), so the worker cannot be held forever by a
  database that accepts TCP and never answers, or by one pathological query.
"""

import asyncio
import logging
import os
import threading
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeoutError
from queue import Queue
from typing import Callable, Optional, TypeVar

from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException

from kurisuassistant.db.session import get_session

T = TypeVar("T")
logger = logging.getLogger(__name__)

# How long a caller waits for the DB thread before giving up. Generous, because
# the queue is serialized: an operation waits behind everything queued before it.
OPERATION_TIMEOUT_SECONDS = float(os.getenv("DB_OPERATION_TIMEOUT_SECONDS", "60"))

# Exceptions an operation raises on purpose — a refusal, not a failure. They are
# the caller's to handle and would only add noise as tracebacks in the log.
_EXPECTED_ERRORS = (HTTPException, ValueError, LookupError)


class DBUnavailableError(RuntimeError):
    """The database thread did not answer within the operation timeout.

    Raised to the caller instead of blocking it forever. ``core/errors.py``
    maps it to a 503, so a router that wraps its handler in ``internal_error``
    needs no special case.
    """


def _describe(operation: Callable) -> str:
    return getattr(operation, "__qualname__", None) or repr(operation)


class DBService:
    """Single-threaded database owner.  All DB access goes through here."""

    def __init__(self):
        self._queue: Queue = Queue()
        self._thread = threading.Thread(target=self._worker, name="db-service", daemon=True)

    def start(self):
        self._thread.start()
        logger.info("DBService started")

    def stop(self, timeout: float = 30.0):
        self._queue.put(None)
        self._thread.join(timeout=timeout)
        logger.info("DBService stopped")

    def execute_sync(self, operation: Callable, timeout: Optional[float] = None):
        """Submit a DB operation and block until the result is ready.

        ``operation`` receives a SQLAlchemy *Session* and returns a value.
        The session is committed automatically on success or rolled back on error
        (handled by :func:`get_session`).

        Use from worker threads or sync FastAPI dependencies.

        Raises:
            DBUnavailableError: the DB thread did not answer within ``timeout``
                (default ``DB_OPERATION_TIMEOUT_SECONDS``). An operation still
                queued at that point is cancelled and never runs.
        """
        future: Future = Future()
        self._queue.put((operation, future))
        try:
            return future.result(timeout=OPERATION_TIMEOUT_SECONDS if timeout is None else timeout)
        except FutureTimeoutError:
            future.cancel()
            raise self._timed_out(operation, timeout) from None

    async def execute(self, operation: Callable, timeout: Optional[float] = None):
        """Submit a DB operation and *await* the result.

        Same contract as :meth:`execute_sync` but suitable for async callers.
        The calling coroutine is suspended (not blocking the event loop) until
        the DB thread finishes processing.
        """
        future: Future = Future()
        self._queue.put((operation, future))
        loop = asyncio.get_running_loop()
        try:
            return await asyncio.wait_for(
                asyncio.wrap_future(future, loop=loop),
                OPERATION_TIMEOUT_SECONDS if timeout is None else timeout,
            )
        except asyncio.TimeoutError:
            # wait_for has already cancelled the wrapper, which cancels the
            # queued future; a running one finishes and is discarded.
            raise self._timed_out(operation, timeout) from None

    def _timed_out(self, operation: Callable, timeout: Optional[float]) -> DBUnavailableError:
        seconds = OPERATION_TIMEOUT_SECONDS if timeout is None else timeout
        logger.error(
            "DB operation %s got no answer from the db-service thread in %.1fs "
            "(%d more queued); the database is stuck or unreachable",
            _describe(operation), seconds, self._queue.qsize(),
        )
        return DBUnavailableError(
            f"database did not answer within {seconds:g}s ({_describe(operation)})"
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _worker(self):
        """Background thread: pull operations from the queue and execute them."""
        while True:
            item = self._queue.get()
            if item is None:
                break
            operation, future = item
            # Marks the future RUNNING, after which a caller that has given up
            # cannot cancel it under us — or reports that it already did, in
            # which case the operation is skipped entirely.
            if not future.set_running_or_notify_cancel():
                continue
            try:
                with get_session() as session:
                    result = operation(session)
            except Exception as e:
                self._log_failure(operation, e)
                future.set_exception(e)
            else:
                future.set_result(result)

    @staticmethod
    def _log_failure(operation: Callable, exc: Exception) -> None:
        """Write the failure to the log; the caller may never surface it."""
        if isinstance(exc, _EXPECTED_ERRORS) and not isinstance(exc, SQLAlchemyError):
            logger.debug("DB operation %s refused: %s", _describe(operation), exc)
            return
        logger.exception("DB operation %s failed: %s", _describe(operation), exc)


# ------------------------------------------------------------------
# Module-level singleton
# ------------------------------------------------------------------

_service: DBService | None = None


def get_db_service() -> DBService:
    """Return the global *DBService* instance (must have been started)."""
    assert _service is not None, "DBService not started — call start_db_service() first"
    return _service


def start_db_service():
    global _service
    _service = DBService()
    _service.start()


def stop_db_service():
    global _service
    if _service:
        _service.stop()
        _service = None
