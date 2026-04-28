"""Background service — worker threads for conversation-idle memory consolidation.

Owns two threads:
* **db_worker** — processes ``ConsolidateMemoryTask`` sequentially (all
  background DB writes serialized through ``DBService``).
* **idle_scanner** — periodically scans for conversations that have been
  idle past ``CONVERSATION_IDLE_THRESHOLD_MINUTES`` and submits one
  ``ConsolidateMemoryTask`` per participating agent.
"""

import asyncio
import logging
import os
import threading
from datetime import datetime, timedelta
from queue import Queue

from kurisuassistant.workers.tasks import ConsolidateMemoryTask

logger = logging.getLogger(__name__)

CONVERSATION_IDLE_THRESHOLD_MINUTES = int(
    os.getenv("CONVERSATION_IDLE_THRESHOLD_MINUTES", "30")
)
SCAN_INTERVAL_SECONDS = 60


class BackgroundService:
    """Manages background worker threads and task routing."""

    def __init__(self):
        self._db_queue: Queue = Queue()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []
        # Track which (conversation_id, agent_id) pairs we've already
        # queued for the current idle period, so we don't re-queue them
        # on every scan while the conversation stays idle.
        self._queued: set[tuple[int, int]] = set()
        self._queued_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self):
        """Start all worker threads."""
        for target, name in [
            (self._db_worker, "db-worker"),
            (self._idle_scanner, "idle-scanner"),
        ]:
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
            logger.info("Started background thread: %s", name)

    def stop(self, timeout: float = 30.0):
        """Signal all threads to stop, drain queues, and join."""
        self._stopping.set()
        self._db_queue.put(None)
        for t in self._threads:
            t.join(timeout=timeout)
            if t.is_alive():
                logger.warning("Background thread %s did not stop in time", t.name)
            else:
                logger.info("Stopped background thread: %s", t.name)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def submit(self, task):
        """Route a task to the worker queue."""
        if isinstance(task, ConsolidateMemoryTask):
            self._db_queue.put(task)
        else:
            logger.warning("Unknown task type: %s", type(task).__name__)

    # ------------------------------------------------------------------
    # Workers
    # ------------------------------------------------------------------

    def _db_worker(self):
        """Process background tasks sequentially."""
        while not self._stopping.is_set():
            task = self._db_queue.get()
            if task is None:
                break
            try:
                if isinstance(task, ConsolidateMemoryTask):
                    asyncio.run(self._handle_consolidate(task))
            except Exception:
                logger.error("db-worker failed to process %s", task, exc_info=True)

    def _idle_scanner(self):
        """Periodically scan for idle conversations and submit consolidation tasks."""
        logger.info(
            "Idle scanner started (interval=%ds, threshold=%dmin)",
            SCAN_INTERVAL_SECONDS,
            CONVERSATION_IDLE_THRESHOLD_MINUTES,
        )
        while not self._stopping.is_set():
            self._stopping.wait(timeout=SCAN_INTERVAL_SECONDS)
            if self._stopping.is_set():
                break
            try:
                self._scan_idle_conversations()
            except Exception:
                logger.error("Idle scanner error", exc_info=True)
        logger.info("Idle scanner stopped")

    # ------------------------------------------------------------------
    # Task handlers
    # ------------------------------------------------------------------

    async def _handle_consolidate(self, task: ConsolidateMemoryTask):
        from kurisuassistant.utils.memory_consolidation import consolidate_agent_memory

        await consolidate_agent_memory(
            user_id=task.user_id,
            agent_id=task.agent_id,
            conversation_id=task.conversation_id,
            model_name=task.model_name,
            api_url=task.api_url,
            provider_type=task.provider_type,
            api_key=task.api_key,
        )

        # After successful consolidation, allow this pair to be re-queued
        # on a future idle cycle.
        with self._queued_lock:
            self._queued.discard((task.conversation_id, task.agent_id))

    # ------------------------------------------------------------------
    # Idle conversation scanning
    # ------------------------------------------------------------------

    def _scan_idle_conversations(self):
        """Find conversations idle past the threshold and queue consolidation
        for each participating agent with ``memory_enabled``.

        "Participating" = any message in the conversation has ``agent_id=X``.
        """
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _query_idle(session):
            from kurisuassistant.db.models import Agent, Conversation, Message, User

            idle_threshold = timedelta(minutes=CONVERSATION_IDLE_THRESHOLD_MINUTES)
            cutoff = datetime.utcnow() - idle_threshold

            idle_convs = (
                session.query(Conversation.id, Conversation.user_id)
                .filter(Conversation.updated_at < cutoff)
                .all()
            )
            if not idle_convs:
                return []

            conv_ids = [c.id for c in idle_convs]
            # Agents that actually spoke in each conversation AND have memory enabled
            participation_rows = (
                session.query(Message.conversation_id, Message.agent_id)
                .join(Agent, Message.agent_id == Agent.id)
                .filter(
                    Message.conversation_id.in_(conv_ids),
                    Message.agent_id.isnot(None),
                    Agent.memory_enabled.is_(True),
                )
                .distinct()
                .all()
            )
            if not participation_rows:
                return []

            conv_to_user = {c.id: c.user_id for c in idle_convs}
            user_ids = list(set(conv_to_user.values()))
            users = session.query(User).filter(User.id.in_(user_ids)).all()
            user_prefs = {
                u.id: {
                    "summary_model": u.summary_model,
                    "ollama_url": u.ollama_url,
                    "summary_provider": getattr(u, 'summary_provider', 'ollama') or 'ollama',
                    "gemini_api_key": u.gemini_api_key,
                    "nvidia_api_key": getattr(u, 'nvidia_api_key', None),
                }
                for u in users
            }

            return [
                {
                    "conversation_id": row.conversation_id,
                    "agent_id": row.agent_id,
                    "user_id": conv_to_user[row.conversation_id],
                    "prefs": user_prefs.get(conv_to_user[row.conversation_id], {}),
                }
                for row in participation_rows
            ]

        candidates = db.execute_sync(_query_idle)

        for c in candidates:
            key = (c["conversation_id"], c["agent_id"])
            with self._queued_lock:
                if key in self._queued:
                    continue
                self._queued.add(key)

            prefs = c["prefs"]
            summary_model = prefs.get("summary_model")
            if not summary_model:
                # No model configured — drop the reservation and skip
                with self._queued_lock:
                    self._queued.discard(key)
                continue

            provider = prefs.get("summary_provider", "ollama")
            api_key = None
            if provider == "gemini":
                api_key = prefs.get("gemini_api_key")
            elif provider == "nvidia":
                api_key = prefs.get("nvidia_api_key")

            self.submit(ConsolidateMemoryTask(
                user_id=c["user_id"],
                agent_id=c["agent_id"],
                conversation_id=c["conversation_id"],
                model_name=summary_model,
                api_url=prefs.get("ollama_url"),
                provider_type=provider,
                api_key=api_key,
            ))
            logger.info(
                "Queued memory consolidation: conversation=%d agent=%d user=%d",
                c["conversation_id"], c["agent_id"], c["user_id"],
            )
