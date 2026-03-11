"""Knowledge graph management using LightRAG for per-user entity/relationship extraction."""

import asyncio
import logging
import os
from typing import Dict, Optional

from lightrag import LightRAG, QueryParam
from lightrag.llm.ollama import ollama_model_complete, ollama_embed

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "qwen3-embedding"
EMBEDDING_DIM = 1024
MAX_TRANSCRIPT_CHARS = 8000
DATA_DIR = os.path.join("data", "lightrag")

_instances: Dict[int, LightRAG] = {}


async def _get_instance(user_id: int, model_name: str, api_url: str = None) -> LightRAG:
    """Get or create a LightRAG instance for a user."""
    if user_id in _instances:
        return _instances[user_id]

    ollama_host = api_url or os.getenv("LLM_API_URL", "http://localhost:11434")

    working_dir = os.path.join(DATA_DIR, str(user_id))
    os.makedirs(working_dir, exist_ok=True)

    rag = LightRAG(
        working_dir=working_dir,
        llm_model_func=ollama_model_complete,
        llm_model_name=model_name,
        llm_model_kwargs={"host": ollama_host},
        embedding_func=ollama_embed,
        embedding_func_kwargs={
            "host": ollama_host,
            "embed_model": EMBEDDING_MODEL,
        },
        embedding_dim=EMBEDDING_DIM,
    )
    await rag.initialize_storages()

    _instances[user_id] = rag
    return rag


async def insert_conversation_knowledge(
    user_id: int,
    frame_ids: list[int],
    model_name: str,
    api_url: str = None,
) -> None:
    """Insert conversation transcript into LightRAG for knowledge extraction.

    Fire-and-forget — errors are logged, never raised.
    """
    try:
        from db.session import get_session
        from db.repositories import MessageRepository

        # Load messages from all frame_ids (same pattern as memory_consolidation.py)
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
                break

            transcript = "\n".join(lines)

        if not transcript.strip():
            return

        rag = await _get_instance(user_id, model_name, api_url)
        await rag.ainsert(transcript)

        logger.info(f"Inserted conversation knowledge for user {user_id} ({len(transcript)} chars)")

    except Exception as e:
        logger.error(f"Failed to insert knowledge for user {user_id}: {e}", exc_info=True)


async def query_knowledge(
    user_id: int,
    question: str,
    model_name: str,
    mode: str = "hybrid",
    api_url: str = None,
) -> str:
    """Query the user's knowledge graph."""
    rag = await _get_instance(user_id, model_name, api_url)
    return await rag.aquery(question, param=QueryParam(mode=mode))
