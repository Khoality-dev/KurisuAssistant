"""Agent memory consolidation — updates agent memory from completed session frames."""

import asyncio
import logging
from typing import Optional

from models.llm import create_llm_provider

logger = logging.getLogger(__name__)

CONSOLIDATION_SYSTEM_PROMPT = (
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


async def consolidate_agent_memory(
    agent_id: int,
    frame_ids: list[int],
    model_name: str,
    api_url: Optional[str] = None,
) -> Optional[str]:
    """Consolidate agent memory from completed session frames.

    Fire-and-forget — errors are logged, never raised.

    Args:
        agent_id: Agent ID to update memory for
        frame_ids: Frame IDs containing new conversation data
        model_name: LLM model for consolidation
        api_url: Optional custom Ollama API URL
    """
    try:
        from db.session import get_session
        from db.repositories import AgentRepository, MessageRepository

        # Load agent
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.get_by_id(agent_id)

            if not agent:
                logger.warning(f"Agent {agent_id} not found for memory consolidation")
                return None

            agent_system_prompt = agent.system_prompt or ""
            current_memory = agent.memory or ""

        # Load messages from all frame_ids
        with get_session() as session:
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
                break  # Break outer loop if inner broke due to truncation

            transcript = "\n".join(lines)

        if not transcript.strip():
            return None

        # Build user message
        user_content = (
            f"## Agent Description\n{agent_system_prompt}\n\n"
            f"## Current Memory\n{current_memory or '(empty)'}\n\n"
            f"## Recent Conversation\n{transcript}"
        )

        # Call LLM non-streaming
        llm = create_llm_provider("ollama", api_url=api_url)
        llm_messages = [
            {"role": "system", "content": CONSOLIDATION_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ]

        response = await asyncio.to_thread(
            llm.chat,
            model=model_name,
            messages=llm_messages,
            stream=False,
        )

        new_memory = response.message.content.strip()
        if not new_memory:
            return None

        # Enforce hard character limit
        if len(new_memory) > MAX_MEMORY_CHARS:
            new_memory = new_memory[:MAX_MEMORY_CHARS]

        # Store updated memory
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.get_by_id(agent_id)
            if agent:
                agent_repo.update_agent(agent, memory=new_memory)

        logger.info(f"Consolidated memory for agent {agent_id}: {len(new_memory)} chars")
        return new_memory

    except Exception as e:
        logger.error(f"Failed to consolidate memory for agent {agent_id}: {e}", exc_info=True)
        return None
