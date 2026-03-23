"""Background service — manages worker threads for background processing.

Owns two threads:
* **db_worker** — processes frame summarization and memory consolidation
  (all background DB writes serialized through DBService).
  After summarizing a frame, automatically chains memory consolidation
  for each agent with memory_enabled.
* **idle_scanner** — periodically scans for idle frames and submits
  SummarizeFrameTask (consolidation is chained automatically).
"""

import asyncio
import logging
import os
import threading
from datetime import datetime, timedelta
from queue import Queue

from kurisuassistant.workers.tasks import (
    ConsolidateMemoryTask,
    SummarizeFrameTask,
)

logger = logging.getLogger(__name__)

FRAME_IDLE_THRESHOLD_MINUTES = int(os.getenv("FRAME_IDLE_THRESHOLD_MINUTES", "30"))
SCAN_INTERVAL_SECONDS = 60


class BackgroundService:
    """Manages background worker threads and task routing."""

    def __init__(self):
        self._db_queue: Queue = Queue()
        self._stopping = threading.Event()
        self._threads: list[threading.Thread] = []

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
        if isinstance(task, (SummarizeFrameTask, ConsolidateMemoryTask)):
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
                if isinstance(task, SummarizeFrameTask):
                    asyncio.run(self._handle_summarize(task))
                elif isinstance(task, ConsolidateMemoryTask):
                    asyncio.run(self._handle_consolidate(task))
            except Exception:
                logger.error("db-worker failed to process %s", task, exc_info=True)

    def _idle_scanner(self):
        """Periodically scan for idle frames and submit SummarizeFrameTask."""
        logger.info(
            "Idle scanner started (interval=%ds, threshold=%dmin)",
            SCAN_INTERVAL_SECONDS,
            FRAME_IDLE_THRESHOLD_MINUTES,
        )
        while not self._stopping.is_set():
            self._stopping.wait(timeout=SCAN_INTERVAL_SECONDS)
            if self._stopping.is_set():
                break
            try:
                self._scan_idle_frames()
            except Exception:
                logger.error("Idle scanner error", exc_info=True)
        logger.info("Idle scanner stopped")

    # ------------------------------------------------------------------
    # Task handlers
    # ------------------------------------------------------------------

    async def _handle_summarize(self, task: SummarizeFrameTask):
        """Summarize a frame, then chain memory consolidation for all agents."""
        from kurisuassistant.utils.frame_summary import summarize_frame

        await summarize_frame(
            frame_id=task.frame_id,
            model_name=task.model_name,
            api_url=task.api_url,
        )

        # Chain: after summary completes, consolidate memory for each agent
        self._chain_consolidation(task)

    def _chain_consolidation(self, summary_task: SummarizeFrameTask):
        """Submit ConsolidateMemoryTask for each agent with memory_enabled."""
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _get_agents(session):
            from kurisuassistant.db.models import Agent, Conversation, Frame

            frame = session.query(Frame).filter_by(id=summary_task.frame_id).first()
            if not frame:
                return []

            conv = session.query(Conversation).filter_by(id=frame.conversation_id).first()
            if not conv:
                return []

            agents = (
                session.query(Agent.id)
                .filter(Agent.user_id == conv.user_id, Agent.memory_enabled.is_(True))
                .all()
            )
            return [(conv.user_id, a.id) for a in agents]

        agent_pairs = db.execute_sync(_get_agents)

        for user_id, agent_id in agent_pairs:
            self.submit(ConsolidateMemoryTask(
                user_id=user_id,
                agent_id=agent_id,
                frame_ids=[summary_task.frame_id],
                model_name=summary_task.model_name,
                api_url=summary_task.api_url,
            ))

    @staticmethod
    async def _handle_consolidate(task: ConsolidateMemoryTask):
        from kurisuassistant.utils.memory_consolidation import consolidate_agent_memory

        await consolidate_agent_memory(
            user_id=task.user_id,
            agent_id=task.agent_id,
            frame_ids=task.frame_ids,
            model_name=task.model_name,
            api_url=task.api_url,
        )

    # ------------------------------------------------------------------
    # Idle frame scanning
    # ------------------------------------------------------------------

    def _scan_idle_frames(self):
        """Query DB for idle frames and submit SummarizeFrameTask only.

        Consolidation is chained automatically after each summary completes.
        """
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _query_idle_data(session):
            from kurisuassistant.db.models import Conversation, Frame, Message, User
            from sqlalchemy import func

            idle_threshold = timedelta(minutes=FRAME_IDLE_THRESHOLD_MINUTES)
            cutoff = datetime.utcnow() - idle_threshold

            idle_frames = (
                session.query(Frame.id, Frame.conversation_id)
                .join(Message, Frame.id == Message.frame_id)
                .filter(Frame.summary.is_(None), Frame.updated_at < cutoff)
                .group_by(Frame.id, Frame.conversation_id)
                .having(func.count(Message.id) > 0)
                .all()
            )

            if not idle_frames:
                return None

            conv_ids = list({f.conversation_id for f in idle_frames})
            conv_users = (
                session.query(Conversation.id, Conversation.user_id)
                .filter(Conversation.id.in_(conv_ids))
                .all()
            )
            conv_to_user = {c.id: c.user_id for c in conv_users}

            user_ids = list(set(conv_to_user.values()))
            users = session.query(User).filter(User.id.in_(user_ids)).all()
            user_prefs = {
                u.id: {"summary_model": u.summary_model, "ollama_url": u.ollama_url}
                for u in users
            }

            return {
                "idle_frames": [(f.id, f.conversation_id) for f in idle_frames],
                "conv_to_user": conv_to_user,
                "user_prefs": user_prefs,
            }

        data = db.execute_sync(_query_idle_data)
        if data is None:
            return

        for frame_id, conv_id in data["idle_frames"]:
            user_id = data["conv_to_user"].get(conv_id)
            if not user_id:
                continue

            prefs = data["user_prefs"].get(user_id, {})
            summary_model = prefs.get("summary_model")
            ollama_url = prefs.get("ollama_url")
            if not summary_model:
                continue

            # Only submit SummarizeFrameTask — consolidation chains automatically
            self.submit(SummarizeFrameTask(
                frame_id=frame_id,
                model_name=summary_model,
                api_url=ollama_url,
            ))

            logger.info("Queued idle processing for frame %d (user %d)", frame_id, user_id)
