"""Background service — worker threads for memory consolidation and the retrieval index.

Owns four threads:
* **db_worker** — processes ``ConsolidateMemoryTask`` sequentially (all
  background DB writes serialized through ``DBService``).
* **idle_scanner** — periodically scans for conversations that have been
  idle past ``CONVERSATION_IDLE_THRESHOLD_MINUTES`` and submits one
  ``ConsolidateMemoryTask`` per idle conversation.
* **index_worker** — processes ``ChunkConversationTask``, ``ChunkDriveFileTask``
  and ``EmbedPassagesTask`` (#6), one at a time, on its own queue. It is a
  separate thread from ``db_worker`` on purpose: that thread's serialization is
  what keeps two memory consolidations for one user from clobbering each other,
  and indexing has no such read-modify-write — sharing the queue would only
  make each wait for the other.
* **index_scanner** — once a minute finds conversations changed since they were
  last chunked, drive files whose checksum differs from the one last indexed,
  and passages with no embedding yet, and queues bounded batches of each. The
  chat handler and the drive writes submit directly for low latency; the
  scanner is what catches a restart, a crash between write and submit, and the
  backfill of a deployment that predates the index.

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

from kurisuassistant.workers.tasks import (
    ChunkConversationTask,
    ChunkDriveFileTask,
    ConsolidateMemoryTask,
    EmbedPassagesTask,
)

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

# The retrieval index (#6). Per scan: this many conversations, this many drive
# files, and this many passages to embed (in EMBED_BATCH_SIZE-row tasks). When
# the embedding provider is unreachable the embedding side pauses — doubling
# from a minute to half an hour — and resumes on the first success; nothing is
# written to the rows for a failure that was the provider's, not theirs.
INDEX_SCAN_INTERVAL_SECONDS = 60
INDEX_SCAN_LIMIT = 50
EMBED_SCAN_LIMIT = 256
EMBED_PAUSE_BASE_SECONDS = 60
EMBED_PAUSE_MAX_SECONDS = 30 * 60


def retry_delay(attempts: int) -> timedelta:
    """Backoff for the ``attempts``-th failure (1-based): doubling, capped."""
    minutes = min(RETRY_BASE_MINUTES * (2 ** max(attempts - 1, 0)), RETRY_MAX_MINUTES)
    return timedelta(minutes=minutes)


def _index_key(task) -> tuple:
    """What makes two index tasks the same piece of work."""
    if isinstance(task, ChunkConversationTask):
        return ("conv", task.conversation_id)
    if isinstance(task, ChunkDriveFileTask):
        return ("drive", task.node_id)
    return ("embed", tuple(task.passage_ids))


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
        # The retrieval index's own queue and in-flight reservations: ("conv", id),
        # ("drive", id), and the passage ids of embed batches not yet written.
        self._index_queue: Queue = Queue()
        self._index_queued: set = set()
        self._embedding_in_flight: set[int] = set()
        self._embed_paused_until: datetime | None = None
        self._embed_pause_failures = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self):
        """Start all worker threads."""
        for target, name in [
            (self._db_worker, "db-worker"),
            (self._idle_scanner, "idle-scanner"),
            (self._index_worker, "index-worker"),
            (self._index_scanner, "index-scanner"),
        ]:
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
            logger.info("Started background thread: %s", name)

    def stop(self, timeout: float = 30.0):
        """Signal all threads to stop, drain queues, and join."""
        self._stopping.set()
        self._db_queue.put(None)
        self._index_queue.put(None)
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
        """Route a task to its worker's queue.

        Index tasks are deduplicated on the way in: a conversation or file
        already waiting is not queued twice, and passages already being embedded
        are not handed out again. The reservation is released by the worker.
        """
        if isinstance(task, ConsolidateMemoryTask):
            self._db_queue.put(task)
        elif isinstance(task, (ChunkConversationTask, ChunkDriveFileTask, EmbedPassagesTask)):
            key = _index_key(task)
            with self._queued_lock:
                if key in self._index_queued:
                    return
                self._index_queued.add(key)
                if isinstance(task, EmbedPassagesTask):
                    self._embedding_in_flight.update(task.passage_ids)
            self._index_queue.put(task)
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

    def _index_worker(self):
        """Process retrieval-index tasks one at a time.

        Plain synchronous functions: everything they do with the database goes
        through ``DBService.execute_sync``, and the extraction and embedding
        calls in between are the reason this runs on its own thread rather
        than inside a database callable.
        """
        from kurisuassistant.utils import indexing

        while not self._stopping.is_set():
            task = self._index_queue.get()
            if task is None:
                break
            try:
                if isinstance(task, ChunkConversationTask):
                    indexing.chunk_conversation(task.conversation_id)
                elif isinstance(task, ChunkDriveFileTask):
                    indexing.chunk_drive_file(task.user_id, task.node_id)
                elif isinstance(task, EmbedPassagesTask):
                    self._handle_embed(task)
            except Exception:
                logger.error("index-worker failed to process %s", task, exc_info=True)
            finally:
                with self._queued_lock:
                    self._index_queued.discard(_index_key(task))
                    if isinstance(task, EmbedPassagesTask):
                        self._embedding_in_flight.difference_update(task.passage_ids)

    def _handle_embed(self, task: EmbedPassagesTask):
        from kurisuassistant.utils import indexing
        from kurisuassistant.utils.embeddings import EmbeddingDisabled, TransientEmbedError

        try:
            indexing.embed_pending(task.passage_ids)
        except EmbeddingDisabled:
            # The operator switched embeddings off between the scan and now.
            return
        except TransientEmbedError as e:
            self._pause_embedding(e)
        else:
            if self._embed_pause_failures:
                logger.info("Embedding provider is back; resuming the backlog")
            self._embed_pause_failures = 0
            self._embed_paused_until = None

    def _pause_embedding(self, exc: Exception):
        self._embed_pause_failures += 1
        seconds = min(
            EMBED_PAUSE_BASE_SECONDS * (2 ** (self._embed_pause_failures - 1)),
            EMBED_PAUSE_MAX_SECONDS,
        )
        self._embed_paused_until = datetime.utcnow() + timedelta(seconds=seconds)
        logger.warning(
            "Embedding failed (%s); pausing the embedding backlog for %ds", exc, seconds,
        )

    def _index_scanner(self):
        """Once a minute, queue what the retrieval index is missing."""
        from kurisuassistant.utils import embeddings as embedding_service
        from kurisuassistant.utils import indexing

        logger.info("Index scanner started (interval=%ds)", INDEX_SCAN_INTERVAL_SECONDS)
        # A changed EMBEDDING_MODEL means every stored vector is from the wrong
        # model. Forget them once, here, in bounded batches; the backlog scan
        # below re-embeds them in the background while recall keeps answering
        # from whatever the current model has already produced.
        try:
            if embedding_service.enabled():
                reset = indexing.sweep_stale_embeddings(embedding_service.current_model())
                if reset:
                    logger.info(
                        "Embedding model is now %r: %d passage(s) queued for re-embedding",
                        embedding_service.current_model(), reset,
                    )
        except Exception:
            logger.error("Index scanner could not sweep stale embeddings", exc_info=True)

        while not self._stopping.is_set():
            self._stopping.wait(timeout=INDEX_SCAN_INTERVAL_SECONDS)
            if self._stopping.is_set():
                break
            try:
                self._scan_index()
            except Exception:
                logger.error("Index scanner error", exc_info=True)
        logger.info("Index scanner stopped")

    def _scan_index(self):
        from kurisuassistant.utils import embeddings as embedding_service
        from kurisuassistant.utils import indexing
        from kurisuassistant.utils.embeddings import EMBED_BATCH_SIZE

        for conversation_id, user_id in indexing.due_conversations(INDEX_SCAN_LIMIT):
            self.submit(ChunkConversationTask(user_id=user_id, conversation_id=conversation_id))
        for node_id, user_id in indexing.due_drive_files(INDEX_SCAN_LIMIT):
            self.submit(ChunkDriveFileTask(user_id=user_id, node_id=node_id))

        if not embedding_service.enabled():
            return
        if self._embed_paused_until and datetime.utcnow() < self._embed_paused_until:
            return
        with self._queued_lock:
            in_flight = list(self._embedding_in_flight)
        pending = indexing.pending_passages(EMBED_SCAN_LIMIT, exclude=in_flight)
        for start in range(0, len(pending), EMBED_BATCH_SIZE):
            self.submit(EmbedPassagesTask(passage_ids=pending[start:start + EMBED_BATCH_SIZE]))

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
