"""Agent memory consolidation from completed session frames.

After a frame is summarized, this module updates Agent.memory
(short essential text, always in system prompt).
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


def _load_transcript(db, frame_ids: list[int]) -> str:
    """Load conversation transcript from frame IDs."""
    from kurisuassistant.db.repositories import MessageRepository

    def _query(session):
        msg_repo = MessageRepository(session)
        lines = []
        total_chars = 0
        for fid in frame_ids:
            messages = msg_repo.get_by_frame(fid, limit=500)
            for msg in messages:
                role = msg.role.capitalize()
                name = msg.name or role
                line = f"{name}: {msg.message}"
                if total_chars + len(line) > MAX_TRANSCRIPT_CHARS:
                    lines.append("... (truncated)")
                    break
                lines.append(line)
                total_chars += len(line)
            else:
                continue
            break
        return "\n".join(lines)

    return db.execute_sync(_query)


async def consolidate_agent_memory(
    user_id: int,
    agent_id: int,
    frame_ids: list[int],
    model_name: str,
    api_url: Optional[str] = None,
    provider_type: str = "ollama",
    api_key: Optional[str] = None,
) -> None:
    """Consolidate agent memory from completed session frames.

    Fire-and-forget — errors are logged, never raised.
    """
    try:
        from kurisuassistant.db.repositories import AgentRepository
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        # Load agent data
        def _load_agent(session):
            agent = AgentRepository(session).get_by_id(agent_id)
            if not agent:
                return None
            return agent.system_prompt or "", agent.memory or ""

        agent_data = db.execute_sync(_load_agent)
        if agent_data is None:
            logger.warning("Agent %d not found for memory consolidation", agent_id)
            return

        agent_system_prompt, current_memory = agent_data

        # Load transcript
        transcript = _load_transcript(db, frame_ids)
        if not transcript.strip():
            return

        llm = create_llm_provider(provider_type, api_url=api_url, api_key=api_key)

        # --- Step 1: Update Agent.memory (short essential text) ---
        memory_user_content = (
            f"## Agent Description\n{agent_system_prompt}\n\n"
            f"## Current Memory\n{current_memory or '(empty)'}\n\n"
            f"## Recent Conversation\n{transcript}"
        )

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
        if new_memory:
            if len(new_memory) > MAX_MEMORY_CHARS:
                new_memory = new_memory[:MAX_MEMORY_CHARS]

            def _store_memory(session):
                agent = AgentRepository(session).get_by_id(agent_id)
                if agent:
                    AgentRepository(session).update_agent(agent, memory=new_memory)

            db.execute_sync(_store_memory)
            logger.info("Consolidated memory for agent %d: %d chars", agent_id, len(new_memory))

    except Exception as e:
        logger.error("Failed to consolidate memory for agent %d: %s", agent_id, e, exc_info=True)
