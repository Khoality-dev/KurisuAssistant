"""Assistant memory consolidation from an idle conversation.

Memory is **one document per user**, stored on that user's single ``Assistant``
row. After a conversation has been idle past the threshold this module rewrites
that document from ``Conversation.compacted_context`` + the recent messages (no
frames).

Personas do not have memory. The persona bound to the consolidated conversation
only contributes its ``system_prompt`` as context for *what* that session was
about — the resulting document is shared by every persona the user has, so it
must stay persona-neutral.
"""

import asyncio
import logging
from typing import Optional

from kurisuassistant.models.llm import create_llm_provider

logger = logging.getLogger(__name__)

MEMORY_SYSTEM_PROMPT = (
    "You are a memory manager for an AI assistant. You are given the instructions the "
    "assistant was following in a recent session, the assistant's current memory, and "
    "the conversation data from that session.\n"
    "Produce an UPDATED memory document.\n\n"
    "Rules:\n"
    "- Output ONLY the updated memory document (no wrapping, no explanation)\n"
    "- Keep the total document under 3500 characters\n"
    "- Use markdown formatting for organization\n"
    "- This is ONE memory shared by every persona the assistant speaks as. Record durable "
    "facts about the user, their projects, preferences and decisions — not the tone, "
    "wording or personality of the session you were given\n"
    "- Never write anything that only makes sense while speaking as one particular "
    "persona; a different persona will read this document next\n"
    "- Update or merge existing entries rather than duplicating\n"
    "- Remove information the user has explicitly corrected\n"
    "- Keep entries concise but informative\n"
    "- If nothing new to remember, output the current memory unchanged"
)

MAX_TRANSCRIPT_CHARS = 8000
MAX_MEMORY_CHARS = 4000


def _load_transcript(db, user_id: int, conversation_id: int) -> tuple[str, str]:
    """Load (compacted_context, transcript) from a conversation.

    Transcript is the concatenation of messages in chronological order,
    truncated to ``MAX_TRANSCRIPT_CHARS``. Compacted context is the
    rolling summary already stored on the conversation (may be empty).
    The conversation lookup is scoped to ``user_id`` — a conversation that
    is not this user's contributes nothing to this user's memory.
    """
    from kurisuassistant.db.models import Message
    from kurisuassistant.db.repositories import ConversationRepository

    def _query(session):
        conv = ConversationRepository(session).get_by_user_and_id(user_id, conversation_id)
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


async def consolidate_assistant_memory(
    user_id: int,
    conversation_id: int,
    model_name: str,
    api_url: Optional[str] = None,
    provider_type: str = "ollama",
    api_key: Optional[str] = None,
) -> None:
    """Consolidate the user's assistant memory from a single idle conversation.

    There is one assistant — and therefore one memory document — per user, so
    the assistant is derived from ``user_id``; no agent id is passed in.

    Fire-and-forget — errors are logged, never raised. Empty LLM output
    is logged (so missing updates are visible), not silently dropped.

    .. warning::
       **This is a read-modify-write on a row shared by the whole user.** The
       assistant's memory is read below, an LLM call is awaited (seconds), and
       the result is written back over whatever the row holds at that point.
       Two idle conversations belonging to the same user therefore target the
       *same* row — under the old per-agent model they hit different rows and
       could never collide.

       The only thing making that safe is that ``BackgroundService._db_worker``
       is a single thread running one ``asyncio.run`` per task, so consolidations
       are strictly sequential. Nothing enforces that invariant: adding a second
       db-worker thread, awaiting several of these concurrently, or running a
       second API process against the same database will silently drop one
       conversation's memory update. If concurrency is ever introduced here,
       this needs an atomic read-modify-write (row lock, or a compare-and-set on
       the memory column) instead.
    """
    try:
        from kurisuassistant.db.repositories import (
            AssistantRepository,
            ConversationRepository,
            PersonaRepository,
        )
        from kurisuassistant.db.service import get_db_service

        db = get_db_service()

        def _load_assistant(session):
            """Read the user's assistant + the bound persona's prompt.

            One round trip: the assistant supplies the memory to rewrite, the
            conversation's persona supplies the instructions that session ran
            under (the assistant itself has no system prompt).
            """
            assistant = AssistantRepository(session).get_by_user(user_id)
            if not assistant:
                return None
            if not assistant.memory_enabled:
                return None

            session_prompt = ""
            conv = ConversationRepository(session).get_by_user_and_id(
                user_id, conversation_id
            )
            if conv and conv.persona_id:
                persona = PersonaRepository(session).get_by_user_and_id(
                    user_id, conv.persona_id
                )
                if persona:
                    session_prompt = persona.system_prompt or ""

            return session_prompt, assistant.memory or ""

        # --- read (start of the read-modify-write described above) ---
        assistant_data = db.execute_sync(_load_assistant)
        if assistant_data is None:
            logger.info(
                "Skipping memory consolidation: user %d has no assistant or memory is disabled",
                user_id,
            )
            return

        session_prompt, current_memory = assistant_data

        compacted, transcript = _load_transcript(db, user_id, conversation_id)
        if not transcript.strip() and not compacted.strip():
            logger.info(
                "Skipping memory consolidation: empty transcript for conversation %d",
                conversation_id,
            )
            return

        llm = create_llm_provider(provider_type, api_url=api_url, api_key=api_key)

        parts = []
        if session_prompt.strip():
            parts.append(f"## Session Instructions (persona)\n{session_prompt}")
        parts.append(f"## Current Memory\n{current_memory or '(empty)'}")
        if compacted.strip():
            parts.append(f"## Earlier Context (summary)\n{compacted}")
        if transcript.strip():
            parts.append(f"## Recent Conversation\n{transcript}")
        memory_user_content = "\n\n".join(parts)

        # --- modify: seconds of LLM latency between the read and the write ---
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
                "Memory consolidation for user %d produced empty output — skipping write",
                user_id,
            )
            return

        if len(new_memory) > MAX_MEMORY_CHARS:
            new_memory = new_memory[:MAX_MEMORY_CHARS]

        if new_memory == (current_memory or ""):
            logger.info("Memory consolidation for user %d: no changes", user_id)
            return

        def _store_memory(session):
            # --- write: blind overwrite of whatever the row holds now. Safe only
            # while consolidations are serialized on the single db-worker thread.
            repo = AssistantRepository(session)
            assistant = repo.get_by_user(user_id)
            if assistant:
                repo.update_memory(assistant, new_memory)

        db.execute_sync(_store_memory)
        logger.info(
            "Consolidated memory for user %d from conversation %d: %d chars",
            user_id, conversation_id, len(new_memory),
        )

    except Exception as e:
        logger.error(
            "Failed to consolidate memory for user %d (conversation %d): %s",
            user_id, conversation_id, e, exc_info=True,
        )
