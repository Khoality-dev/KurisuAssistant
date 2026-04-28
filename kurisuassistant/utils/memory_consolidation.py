"""Agent memory consolidation from an idle conversation.

After a conversation has been idle past the threshold, this module
updates ``Agent.memory`` for each agent that participated. Reads from
``Conversation.compacted_context`` + recent messages (no frames).
"""

import asyncio
import logging
from typing import Optional

from kurisuassistant.models.llm import create_llm_provider

logger = logging.getLogger(__name__)

MEMORY_SYSTEM_PROMPT = (
    "You are a memory manager for an AI agent. You are given the agent's description, "
    "its current memory, and new conversation data from a recent session.\n"
    "Produce an UPDATED memory document.\n\n"
    "Rules:\n"
    "- Output ONLY the updated memory document (no wrapping, no explanation)\n"
    "- Keep the total document under 3500 characters\n"
    "- Use markdown formatting for organization\n"
    "- The agent decides what is worth remembering based on its own role and personality\n"
    "- Update or merge existing entries rather than duplicating\n"
    "- Remove information the user has explicitly corrected\n"
    "- Keep entries concise but informative\n"
    "- If nothing new to remember, output the current memory unchanged"
)

MAX_TRANSCRIPT_CHARS = 8000
MAX_MEMORY_CHARS = 4000


def _load_transcript(db, conversation_id: int) -> tuple[str, str]:
    """Load (compacted_context, transcript) from a conversation.

    Transcript is the concatenation of messages in chronological order,
    truncated to ``MAX_TRANSCRIPT_CHARS``. Compacted context is the
    rolling summary already stored on the conversation (may be empty).
    """
    from kurisuassistant.db.models import Conversation, Message

    def _query(session):
        conv = session.query(Conversation).filter_by(id=conversation_id).first()
        if not conv:
            return ("", "")
        compacted = conv.compacted_context or ""

        messages = (
            session.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(Message.created_at)
            .all()
        )
        lines = []
        total_chars = 0
        for msg in messages:
            role = (msg.role or "user").capitalize()
            name = msg.name or role
            line = f"{name}: {msg.message}"
            if total_chars + len(line) > MAX_TRANSCRIPT_CHARS:
                lines.append("... (truncated)")
                break
            lines.append(line)
            total_chars += len(line)
        return (compacted, "\n".join(lines))

    return db.execute_sync(_query)


async def consolidate_agent_memory(
    user_id: int,
    agent_id: int,
    conversation_id: int,
    model_name: str,
    api_url: Optional[str] = None,
    provider_type: str = "ollama",
    api_key: Optional[str] = None,
) -> None:
    """Consolidate an agent's memory from a single idle conversation.

    Fire-and-forget — errors are logged, never raised. Empty LLM output
    is logged (so missing updates are visible), not silently dropped.
    """
    try:
        from kurisuassistant.db.repositories import AgentRepository
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _load_agent(session):
            agent = AgentRepository(session).get_by_id(agent_id)
            if not agent:
                return None
            if not agent.memory_enabled:
                return None
            return agent.system_prompt or "", agent.memory or ""

        agent_data = db.execute_sync(_load_agent)
        if agent_data is None:
            logger.info(
                "Skipping memory consolidation: agent %d not found or memory disabled",
                agent_id,
            )
            return

        agent_system_prompt, current_memory = agent_data

        compacted, transcript = _load_transcript(db, conversation_id)
        if not transcript.strip() and not compacted.strip():
            logger.info(
                "Skipping memory consolidation: empty transcript for conversation %d",
                conversation_id,
            )
            return

        llm = create_llm_provider(provider_type, api_url=api_url, api_key=api_key)

        parts = [f"## Agent Description\n{agent_system_prompt}"]
        parts.append(f"## Current Memory\n{current_memory or '(empty)'}")
        if compacted.strip():
            parts.append(f"## Earlier Context (summary)\n{compacted}")
        if transcript.strip():
            parts.append(f"## Recent Conversation\n{transcript}")
        memory_user_content = "\n\n".join(parts)

        response = await asyncio.to_thread(
            llm.chat,
            model=model_name,
            messages=[
                {"role": "system", "content": MEMORY_SYSTEM_PROMPT},
                {"role": "user", "content": memory_user_content},
            ],
            stream=False,
        )

        new_memory = response.message.content.strip()
        if not new_memory:
            logger.warning(
                "Memory consolidation for agent %d produced empty output — skipping write",
                agent_id,
            )
            return

        if len(new_memory) > MAX_MEMORY_CHARS:
            new_memory = new_memory[:MAX_MEMORY_CHARS]

        if new_memory == (current_memory or ""):
            logger.info("Memory consolidation for agent %d: no changes", agent_id)
            return

        def _store_memory(session):
            agent = AgentRepository(session).get_by_id(agent_id)
            if agent:
                AgentRepository(session).update_agent(agent, memory=new_memory)

        db.execute_sync(_store_memory)
        logger.info(
            "Consolidated memory for agent %d from conversation %d: %d chars",
            agent_id, conversation_id, len(new_memory),
        )

    except Exception as e:
        logger.error(
            "Failed to consolidate memory for agent %d (conversation %d): %s",
            agent_id, conversation_id, e, exc_info=True,
        )
