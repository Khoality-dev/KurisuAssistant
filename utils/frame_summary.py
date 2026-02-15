"""Frame summarization utility — generates summaries for completed session frames."""

import asyncio
import logging
from typing import Optional

from models.llm import create_llm_provider

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM_PROMPT = (
    "You are a summarizer. Given a conversation transcript, produce a concise summary "
    "(2-4 sentences) capturing the key topics discussed, decisions made, and any important "
    "information. Write in third person. Do not include greetings or filler."
)

MAX_TRANSCRIPT_CHARS = 8000


async def summarize_frame(
    frame_id: int,
    model_name: str = "gemma3:4b",
    api_url: Optional[str] = None,
) -> Optional[str]:
    """Summarize a frame's messages and store the result.

    Fire-and-forget — errors are logged, never raised.

    Args:
        frame_id: Frame ID to summarize
        model_name: LLM model for summarization
        api_url: Optional custom Ollama API URL
    """
    try:
        from db.session import get_session
        from db.repositories import FrameRepository, MessageRepository

        # Load messages
        with get_session() as session:
            msg_repo = MessageRepository(session)
            messages = msg_repo.get_by_frame(frame_id, limit=500)

            if not messages:
                return None

            # Build transcript
            lines = []
            total_chars = 0
            for msg in messages:
                role = msg.role.capitalize()
                name = msg.name or role
                line = f"{name}: {msg.message}"
                if total_chars + len(line) > MAX_TRANSCRIPT_CHARS:
                    lines.append("... (truncated)")
                    break
                lines.append(line)
                total_chars += len(line)

            transcript = "\n".join(lines)

        # Call LLM non-streaming
        llm = create_llm_provider("ollama", api_url=api_url)
        llm_messages = [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ]

        response = await asyncio.to_thread(
            llm.chat,
            model=model_name,
            messages=llm_messages,
            stream=False,
        )

        summary = response.message.content.strip()
        if not summary:
            return None

        # Store summary
        with get_session() as session:
            frame_repo = FrameRepository(session)
            frame = frame_repo.get_by_id(frame_id)
            if frame:
                frame_repo.update_summary(frame, summary)

        logger.info(f"Summarized frame {frame_id}: {summary[:80]}...")
        return summary

    except Exception as e:
        logger.error(f"Failed to summarize frame {frame_id}: {e}", exc_info=True)
        return None
