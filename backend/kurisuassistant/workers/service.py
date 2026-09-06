"""Background service — worker threads for conversation-idle memory consolidation.

Owns two threads:
* **db_worker** — processes ``ConsolidateMemoryTask`` sequentially (all
  background DB writes serialized through ``DBService``).
* **idle_scanner** — periodically scans for conversations that have been
  idle past ``CONVERSATION_IDLE_THRESHOLD_MINUTES`` and submits one
  ``ConsolidateMemoryTask`` per idle conversation.

Memory is one document per user (``assistants.memory``), so a conversation
produces exactly one task — not one per participating agent as it did when
memory hung off individual agent rows.
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
# At most this many conversations are queued per scan, oldest first. Anything
# beyond it is picked up by a later scan; the queue is one thread deep anyway.
SCAN_LIMIT = 50
# A failed consolidation is retried after 5, 10, 20, 40, 80 minutes (capped at
# RETRY_MAX_MINUTES); after MAX_ATTEMPTS the conversation is stamped as
# consolidated and left alone until it changes again.
RETRY_BASE_MINUTES = 5
RETRY_MAX_MINUTES = 6 * 60
MAX_ATTEMPTS = 5


def retry_delay(attempts: int) -> timedelta:
    """Backoff for the ``attempts``-th failure (1-based): doubling, capped."""
    minutes = min(RETRY_BASE_MINUTES * (2 ** max(attempts - 1, 0)), RETRY_MAX_MINUTES)
    return timedelta(minutes=minutes)


class BackgroundService:
    """Manages background worker threads and task routing."""

    def __init__(self):
        self._db_queue: Queue = Queue()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []
        # Conversations queued and not yet processed, so a scan that runs while
        # the worker is busy does not queue the same one twice. Only the
        # in-flight window lives here: what has been consolidated, and when a
        # failed one may be retried, is on the ``conversations`` row (#96).
        self._queued: set[int] = set()
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
        """Process background tasks sequentially.

        **This thread's serialization is load-bearing.** Memory consolidation is a
        read-modify-write on ``assistants.memory``, and two idle conversations
        belonging to the same user now target the *same* row. Running one task at
        a time — a single thread, one ``asyncio.run`` per task — is the only thing
        preventing one consolidation from clobbering the other's result. Do not add
        a second db-worker thread or dispatch these concurrently without first
        making the read-modify-write atomic (see
        ``utils.memory_consolidation.consolidate_assistant_memory``).
        """
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
        from kurisuassistant.utils.memory_consolidation import consolidate_assistant_memory

        try:
            await consolidate_assistant_memory(
                user_id=task.user_id,
                conversation_id=task.conversation_id,
                model_name=task.model_name,
                api_url=task.api_url,
                provider_type=task.provider_type,
                api_key=task.api_key,
            )
        except Exception as e:
            self._record_failure(task.conversation_id, e)
        else:
            self._record_success(task.conversation_id)
        finally:
            # Whatever happened, the reservation is released: the row now says
            # whether and when this conversation is due again.
            with self._queued_lock:
                self._queued.discard(task.conversation_id)

    def _record_success(self, conversation_id: int):
        """Stamp the row so the scan skips it until the conversation changes."""
        from kurisuassistant.db.service import get_db_service

        def _stamp(session):
            from kurisuassistant.db.models import Conversation

            conv = session.get(Conversation, conversation_id)
            if conv is None:
                return
            conv.consolidated_at = datetime.utcnow()
            conv.consolidation_attempts = 0
            conv.consolidation_next_retry_at = None

        get_db_service().execute_sync(_stamp)

    def _record_failure(self, conversation_id: int, exc: Exception):
        """Schedule a retry with backoff; give up after MAX_ATTEMPTS.

        Giving up stamps ``consolidated_at`` — the conversation is treated as
        done until it changes again, so a permanently broken one stops costing
        a model call every few hours without being wedged forever.
        """
        from kurisuassistant.db.service import get_db_service

        def _schedule(session):
            from kurisuassistant.db.models import Conversation

            conv = session.get(Conversation, conversation_id)
            if conv is None:
                return None
            conv.consolidation_attempts = (conv.consolidation_attempts or 0) + 1
            if conv.consolidation_attempts >= MAX_ATTEMPTS:
                conv.consolidated_at = datetime.utcnow()
                conv.consolidation_next_retry_at = None
                return (conv.consolidation_attempts, None)
            delay = retry_delay(conv.consolidation_attempts)
            conv.consolidation_next_retry_at = datetime.utcnow() + delay
            return (conv.consolidation_attempts, delay)

        outcome = get_db_service().execute_sync(_schedule)
        if outcome is None:
            return
        attempts, delay = outcome
        if delay is None:
            logger.error(
                "Memory consolidation for conversation %d failed %d times (%s); "
                "giving up until the conversation changes again",
                conversation_id, attempts, exc,
            )
        else:
            logger.warning(
                "Memory consolidation for conversation %d failed (attempt %d/%d): %s; "
                "retrying in %s",
                conversation_id, attempts, MAX_ATTEMPTS, exc, delay,
            )

    # ------------------------------------------------------------------
    # Idle conversation scanning
    # ------------------------------------------------------------------

    def _scan_idle_conversations(self):
        """Find conversations idle past the threshold and queue one consolidation
        each, for users whose assistant has ``memory_enabled``.

        A conversation qualifies when all of these hold:

        * ``updated_at`` is older than the idle threshold;
        * it has not been consolidated since it last changed
          (``consolidated_at`` null or older than ``updated_at``);
        * no retry is pending in the future (``consolidation_next_retry_at``);
        * its owner has an ``assistants`` row with ``memory_enabled = true``;
        * it actually has at least one message.

        Oldest first, at most ``SCAN_LIMIT`` per scan. Before #96 the scan
        selected *every* idle conversation the user had ever finished, every
        minute, forever — a full scan competing with live chat on the single
        database thread — and dedupe lived only in memory, so a failure wedged a
        conversation until restart and a restart forgot what was pending.

        The has-messages check is not cosmetic either. Consolidation reads the
        whole transcript before it can decide there is nothing to do, so
        without it every empty conversation a user ever opened would be queued
        and fully read.
        """
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _query_idle(session):
            from sqlalchemy import or_

            from kurisuassistant.db.models import Assistant, Conversation, Message, User

            now = datetime.utcnow()
            idle_threshold = timedelta(minutes=CONVERSATION_IDLE_THRESHOLD_MINUTES)
            cutoff = now - idle_threshold

            has_messages = (
                session.query(Message.id)
                .filter(Message.conversation_id == Conversation.id)
                .exists()
            )

            idle_convs = (
                session.query(Conversation.id, Conversation.user_id)
                .join(Assistant, Assistant.user_id == Conversation.user_id)
                .filter(
                    Conversation.updated_at < cutoff,
                    or_(
                        Conversation.consolidated_at.is_(None),
                        Conversation.consolidated_at < Conversation.updated_at,
                    ),
                    or_(
                        Conversation.consolidation_next_retry_at.is_(None),
                        Conversation.consolidation_next_retry_at <= now,
                    ),
                    Assistant.memory_enabled.is_(True),
                    has_messages,
                )
                .order_by(Conversation.updated_at)
                .limit(SCAN_LIMIT)
                .all()
            )
            if not idle_convs:
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
                    "poe_api_key": getattr(u, 'poe_api_key', None),
                }
                for u in users
            }

            return [
                {
                    "conversation_id": conv_id,
                    "user_id": user_id,
                    "prefs": user_prefs.get(user_id, {}),
                }
                for conv_id, user_id in conv_to_user.items()
            ]

        candidates = db.execute_sync(_query_idle)

        for c in candidates:
            key = c["conversation_id"]
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
            elif provider == "poe":
                api_key = prefs.get("poe_api_key")

            self.submit(ConsolidateMemoryTask(
                user_id=c["user_id"],
                conversation_id=c["conversation_id"],
                model_name=summary_model,
                api_url=prefs.get("ollama_url"),
                provider_type=provider,
                api_key=api_key,
            ))
            logger.info(
                "Queued memory consolidation: conversation=%d user=%d",
                c["conversation_id"], c["user_id"],
            )
