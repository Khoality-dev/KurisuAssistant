"""Agent memory + notes consolidation from completed session frames.

After a frame is summarized, this module:
1. Updates Agent.memory (short essential text, always in system prompt)
2. Writes/updates note files via the notes MCP server's filesystem
   (catches details the agent missed during the conversation)
"""

import asyncio
import json
import logging
import os
from pathlib import Path
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

NOTES_SYSTEM_PROMPT = (
    "You are a notes manager for an AI agent. You are given the agent's existing notes "
    "(files on disk) and a new conversation transcript.\n\n"
    "Determine what new information from the conversation should be saved as notes. "
    "Only save factual information worth remembering (user preferences, people, projects, "
    "decisions, important facts). Do NOT save greetings, small talk, or transient information.\n\n"
    "Output a JSON array of file operations. Each operation is an object with:\n"
    '- "action": "write" (create/overwrite) or "edit" (modify existing)\n'
    '- "path": relative file path (e.g. "people/family.md", "preferences.md")\n'
    '- "content": full file content (for write) or null (for edit)\n'
    '- "old_text": text to find (for edit only)\n'
    '- "new_text": replacement text (for edit only)\n\n'
    "Rules:\n"
    "- Use descriptive file names and organize into folders\n"
    "- Prefer editing existing files over creating new ones\n"
    "- If nothing new to save, output an empty array: []\n"
    "- Output ONLY the JSON array, no explanation"
)

MAX_TRANSCRIPT_CHARS = 8000
MAX_MEMORY_CHARS = 4000
NOTES_ROOT = os.getenv("NOTES_ROOT", os.path.join("data", "notes"))


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


def _list_notes_files(notes_dir: Path, max_files: int = 20) -> str:
    """List existing note files with first-line previews."""
    if not notes_dir.exists():
        return "(no notes yet)"

    entries = []
    for f in sorted(notes_dir.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            rel = str(f.relative_to(notes_dir))
            try:
                first_line = f.read_text(encoding="utf-8").split("\n", 1)[0][:100]
            except Exception:
                first_line = ""
            entries.append(f"- {rel}: {first_line}")
            if len(entries) >= max_files:
                entries.append("... (more files)")
                break

    return "\n".join(entries) if entries else "(no notes yet)"


async def consolidate_agent_memory(
    user_id: int,
    agent_id: int,
    frame_ids: list[int],
    model_name: str,
    api_url: Optional[str] = None,
    provider_type: str = "ollama",
    api_key: Optional[str] = None,
) -> None:
    """Consolidate agent memory AND notes from completed session frames.

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

        # --- Step 2: Update notes files ---
        notes_dir = Path(NOTES_ROOT) / str(user_id) / str(agent_id)
        existing_notes = _list_notes_files(notes_dir)

        notes_user_content = (
            f"## Agent Description\n{agent_system_prompt}\n\n"
            f"## Existing Notes\n{existing_notes}\n\n"
            f"## Recent Conversation\n{transcript}"
        )

        response = await asyncio.to_thread(
            llm.chat,
            model=model_name,
            messages=[
                {"role": "system", "content": NOTES_SYSTEM_PROMPT},
                {"role": "user", "content": notes_user_content},
            ],
            stream=False,
            format="json",
        )

        raw = response.message.content.strip()
        if not raw or raw == "[]":
            return

        try:
            operations = json.loads(raw)
            if not isinstance(operations, list):
                operations = []
        except json.JSONDecodeError:
            logger.warning("Notes consolidation returned invalid JSON for agent %d", agent_id)
            return

        notes_dir.mkdir(parents=True, exist_ok=True)

        for op in operations:
            try:
                action = op.get("action")
                path = op.get("path", "")

                # Path safety check
                target = (notes_dir / path).resolve()
                if not str(target).startswith(str(notes_dir.resolve())):
                    continue

                if action == "write":
                    content = op.get("content", "")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                    logger.info("Notes: wrote %s for agent %d", path, agent_id)

                elif action == "edit" and target.exists():
                    old_text = op.get("old_text", "")
                    new_text = op.get("new_text", "")
                    if old_text:
                        current = target.read_text(encoding="utf-8")
                        if old_text in current:
                            target.write_text(current.replace(old_text, new_text, 1), encoding="utf-8")
                            logger.info("Notes: edited %s for agent %d", path, agent_id)

            except Exception as e:
                logger.warning("Notes operation failed for agent %d: %s", agent_id, e)

    except Exception as e:
        logger.error("Failed to consolidate memory for agent %d: %s", agent_id, e, exc_info=True)
