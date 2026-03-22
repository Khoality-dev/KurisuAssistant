"""Background worker system — public API.

Usage::

    import workers

    workers.start()           # Called during app startup
    workers.submit(task)      # Submit a background task from anywhere
    workers.stop()            # Called during app shutdown
"""

from .service import BackgroundService
from .tasks import ConsolidateMemoryTask, SummarizeFrameTask

__all__ = [
    "start",
    "stop",
    "submit",
    "SummarizeFrameTask",
    "ConsolidateMemoryTask",
]

_service: BackgroundService | None = None


def start():
    """Start the background service (worker threads + idle scanner)."""
    global _service
    _service = BackgroundService()
    _service.start()


def stop():
    """Stop the background service gracefully."""
    global _service
    if _service:
        _service.stop()
        _service = None


def submit(task):
    """Submit a task to the background service for processing."""
    if _service:
        _service.submit(task)
