"""Central database service — single-threaded owner of all DB access.

All reads and writes go through one dedicated thread via a queue.
Async callers use ``await db.execute(op)``, sync callers use ``db.execute_sync(op)``.
"""

import asyncio
import logging
import threading
from concurrent.futures import Future
from queue import Queue
from typing import Callable, TypeVar

from kurisuassistant.db.session import get_session

T = TypeVar("T")
logger = logging.getLogger(__name__)


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

    def execute_sync(self, operation: Callable):
        """Submit a DB operation and block until the result is ready.

        ``operation`` receives a SQLAlchemy *Session* and returns a value.
        The session is committed automatically on success or rolled back on error
        (handled by :func:`get_session`).

        Use from worker threads or sync FastAPI dependencies.
        """
        future: Future = Future()
        self._queue.put((operation, future))
        return future.result()

    async def execute(self, operation: Callable):
        """Submit a DB operation and *await* the result.

        Same contract as :meth:`execute_sync` but suitable for async callers.
        The calling coroutine is suspended (not blocking the event loop) until
        the DB thread finishes processing.
        """
        future: Future = Future()
        self._queue.put((operation, future))
        loop = asyncio.get_running_loop()
        return await asyncio.wrap_future(future, loop=loop)

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
            if future.cancelled():
                continue
            try:
                with get_session() as session:
                    result = operation(session)
                future.set_result(result)
            except Exception as e:
                if not future.cancelled():
                    future.set_exception(e)


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
