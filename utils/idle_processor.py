"""Background task that periodically processes idle frames.

Scans all users for frames that have been idle longer than the threshold
and triggers summarization, memory consolidation, and knowledge graph insertion.
Runs as an asyncio task started during application lifespan.
"""

import asyncio
import logging
import os
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

FRAME_IDLE_THRESHOLD_MINUTES = int(os.getenv("FRAME_IDLE_THRESHOLD_MINUTES", "30"))
SCAN_INTERVAL_SECONDS = 60  # How often to check for idle frames
_task = None


async def _process_idle_frames():
    """Scan for idle frames and process them."""
    from db.session import get_session
    from db.models import Frame, Message, User, Agent
    from sqlalchemy import func, desc

    idle_threshold = timedelta(minutes=FRAME_IDLE_THRESHOLD_MINUTES)
    cutoff = datetime.utcnow() - idle_threshold

    with get_session() as session:
        # Find frames that are idle (last activity before cutoff),
        # have messages, and haven't been summarized yet
        idle_frames = (
            session.query(
                Frame.id,
                Frame.conversation_id,
            )
            .join(Message, Frame.id == Message.frame_id)
            .filter(
                Frame.summary.is_(None),
                Frame.updated_at < cutoff,
            )
            .group_by(Frame.id, Frame.conversation_id)
            .having(func.count(Message.id) > 0)
            .all()
        )

        if not idle_frames:
            return

        # Map conversation_id -> user_id for user preferences lookup
        from db.models import Conversation
        conv_ids = list(set(f.conversation_id for f in idle_frames))
        conv_users = (
            session.query(Conversation.id, Conversation.user_id)
            .filter(Conversation.id.in_(conv_ids))
            .all()
        )
        conv_to_user = {c.id: c.user_id for c in conv_users}

        # Get user preferences (summary_model, ollama_url)
        user_ids = list(set(conv_to_user.values()))
        users = session.query(User).filter(User.id.in_(user_ids)).all()
        user_prefs = {
            u.id: {"summary_model": u.summary_model, "ollama_url": u.ollama_url}
            for u in users
        }

        # Get agents with memory enabled, grouped by user
        agents_with_memory = (
            session.query(Agent.id, Agent.user_id)
            .filter(Agent.user_id.in_(user_ids), Agent.memory_enabled.is_(True))
            .all()
        )
        user_agents = {}
        for a in agents_with_memory:
            user_agents.setdefault(a.user_id, []).append(a.id)

    # Process each idle frame
    for frame_row in idle_frames:
        frame_id = frame_row.id
        conv_id = frame_row.conversation_id
        user_id = conv_to_user.get(conv_id)
        if not user_id:
            continue

        prefs = user_prefs.get(user_id, {})
        summary_model = prefs.get("summary_model")
        ollama_url = prefs.get("ollama_url")

        if not summary_model:
            continue

        # Summarize frame
        from utils.frame_summary import summarize_frame
        asyncio.create_task(summarize_frame(
            frame_id=frame_id,
            model_name=summary_model,
            api_url=ollama_url,
        ))

        # Memory consolidation for each agent with memory enabled
        from utils.memory_consolidation import consolidate_agent_memory
        for agent_id in user_agents.get(user_id, []):
            asyncio.create_task(consolidate_agent_memory(
                agent_id=agent_id,
                frame_ids=[frame_id],
                model_name=summary_model,
                api_url=ollama_url,
            ))

        # Knowledge graph insertion for each agent
        from utils.knowledge_graph import insert_conversation_knowledge
        for agent_id in user_agents.get(user_id, []):
            asyncio.create_task(insert_conversation_knowledge(
                user_id=user_id,
                agent_id=agent_id,
                frame_ids=[frame_id],
                model_name=summary_model,
                api_url=ollama_url,
            ))

        logger.info(f"Queued idle processing for frame {frame_id} (user {user_id})")


async def _idle_processor_loop():
    """Background loop that periodically scans for idle frames."""
    logger.info(f"Idle frame processor started (interval={SCAN_INTERVAL_SECONDS}s, threshold={FRAME_IDLE_THRESHOLD_MINUTES}min)")
    while True:
        try:
            await asyncio.sleep(SCAN_INTERVAL_SECONDS)
            await _process_idle_frames()
        except asyncio.CancelledError:
            logger.info("Idle frame processor stopped")
            break
        except Exception as e:
            logger.error(f"Idle frame processor error: {e}", exc_info=True)


def start_idle_processor():
    """Start the background idle frame processor task."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_idle_processor_loop())


def stop_idle_processor():
    """Stop the background idle frame processor task."""
    global _task
    if _task and not _task.done():
        _task.cancel()
        _task = None
