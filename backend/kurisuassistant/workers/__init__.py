"""Background worker system — public API.

Usage::

    import kurisuassistant.workers

    workers.start()           # Called during app startup
    workers.submit(task)      # Submit a background task from anywhere
    workers.stop()            # Called during app shutdown
"""

from .reminders import ReminderScanner
from .service import BackgroundService
from .tasks import (
    ChunkConversationTask,
    ChunkDriveFileTask,
    ConsolidateMemoryTask,
    EmbedPassagesTask,
)

__all__ = [
    "start",
    "stop",
    "submit",
    "ConsolidateMemoryTask",
    "ChunkConversationTask",
    "ChunkDriveFileTask",
    "EmbedPassagesTask",
]

_service: BackgroundService | None = None
_reminders: ReminderScanner | None = None


def start():
    """Start the background service (worker threads + idle scanner) and, on
    the app's event loop, the due-reminder scanner (#282)."""
    global _service, _reminders
    _service = BackgroundService()
    _service.start()
    _reminders = ReminderScanner()
    _reminders.start()


def stop():
    """Stop the background service gracefully."""
    global _service, _reminders
    if _reminders:
        _reminders.stop()
        _reminders = None
    if _service:
        _service.stop()
        _service = None


def submit(task):
    """Submit a task to the background service for processing."""
    if _service:
        _service.submit(task)
