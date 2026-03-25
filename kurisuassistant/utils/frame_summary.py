"""Frame summarization utility — generates summaries for completed session frames."""

import asyncio
import logging
from typing import Optional

from kurisuassistant.models.llm import create_llm_provider

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM_PROMPT = (
    "You are a summarizer. Given a conversation transcript, produce a concise summary "
    "(2-4 sentences) capturing the key topics discussed, decisions made, and any important "
    "information. Write in third person. Do not include greetings or filler."
)

MAX_TRANSCRIPT_CHARS = 8000


async def summarize_frame(
    frame_id: int,
    model_name: str,
    api_url: Optional[str] = None,
    provider_type: str = "ollama",
    api_key: Optional[str] = None,
) -> Optional[str]:
    """Summarize a frame's messages and store the result.

    Fire-and-forget — errors are logged, never raised.

    Args:
        frame_id: Frame ID to summarize
        model_name: LLM model for summarization
        api_url: Optional custom Ollama API URL
        provider_type: LLM provider ("ollama", "gemini", "nvidia")
        api_key: Optional API key for cloud providers
    """
    try:
        from kurisuassistant.db.repositories import FrameRepository, MessageRepository
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        # Load messages
        def _load(session):
            messages = MessageRepository(session).get_by_frame(frame_id, limit=500)
            if not messages:
                return None
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
            return "\n".join(lines)

        transcript = db.execute_sync(_load)
        if not transcript:
            return None

        # Call LLM non-streaming
        llm = create_llm_provider(provider_type, api_url=api_url, api_key=api_key)
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
        def _store(session):
            frame_repo = FrameRepository(session)
            frame = frame_repo.get_by_id(frame_id)
            if frame:
                frame_repo.update_summary(frame, summary)

        db.execute_sync(_store)

        logger.info(f"Summarized frame {frame_id}: {summary[:80]}...")
        return summary

    except Exception as e:
        logger.error(f"Failed to summarize frame {frame_id}: {e}", exc_info=True)
        return None
