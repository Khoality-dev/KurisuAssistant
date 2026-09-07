"""Conversation history tools — read-only access to past conversations via DB.

Frame-based segmentation was removed; these tools now operate at the
conversation level. ``history_list`` enumerates the user's conversations
with their titles and compacted context. ``history_read`` reads messages
from a specific conversation by ID. Searching is ``recall_regex`` and
``recall_semantic`` in ``tools/recall.py`` (#6), which cover drive files too;
the old ``history_search`` — an unindexed ``ILIKE`` that truncated every hit
to 200 characters and cited no message — is gone.
"""

import logging
from typing import Dict, Any

from .base import BaseTool

logger = logging.getLogger(__name__)


class HistoryListTool(BaseTool):
    """List the user's past conversations with summaries."""

    name = "history_list"
    description = (
        "List past conversations with titles, compacted summaries, message counts, "
        "and timestamps. Returns most recent first. Use to find which conversation "
        "to read in detail."
    )
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of conversations to return (default: 20).",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.models import Conversation, Message
        from sqlalchemy import func, desc

        user_id = args.get("user_id")
        if not user_id:
            return "Error: No user context available."

        limit = args.get("limit", 20)

        try:
            def _query(session):
                rows = (
                    session.query(
                        Conversation.id,
                        Conversation.title,
                        Conversation.compacted_context,
                        Conversation.created_at,
                        Conversation.updated_at,
                        func.count(Message.id).label("message_count"),
                    )
                    .outerjoin(Message, Conversation.id == Message.conversation_id)
                    .filter(Conversation.user_id == user_id)
                    .group_by(Conversation.id)
                    .order_by(desc(Conversation.updated_at))
                    .limit(limit)
                    .all()
                )

                if not rows:
                    return "No past conversations found."

                lines = []
                for c in rows:
                    updated = c.updated_at.strftime("%Y-%m-%d %H:%M") if c.updated_at else "unknown"
                    title = c.title or "Untitled"
                    summary_preview = (c.compacted_context or "").strip()
                    if summary_preview:
                        summary_preview = summary_preview[:200] + ("…" if len(summary_preview) > 200 else "")
                    else:
                        summary_preview = "(no summary yet)"
                    lines.append(
                        f"- **#{c.id} {title}** ({updated}, {c.message_count} messages): {summary_preview}"
                    )
                return "\n".join(lines)

            db = get_db_service()
            return await db.execute(_query)

        except Exception as e:
            logger.error("history_list failed: %s", e, exc_info=True)
            return f"Error: Failed to list conversations: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        limit = args.get("limit", 20)
        return f"List past conversations (limit={limit})"


class HistoryReadTool(BaseTool):
    """Read messages from a specific past conversation by ID."""

    name = "history_read"
    description = (
        "Read messages from a specific past conversation. Use history_list first "
        "to find the conversation_id, then read it in detail."
    )
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "target_conversation_id": {
                            "type": "integer",
                            "description": "The conversation ID to read.",
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Number of messages to skip (default: 0).",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of messages to return (default: 100).",
                        },
                    },
                    "required": ["target_conversation_id"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.models import Conversation, Message

        user_id = args.get("user_id")
        if not user_id:
            return "Error: No user context available."

        target = args.get("target_conversation_id")
        if not target:
            return "Error: target_conversation_id is required."

        offset = args.get("offset", 0)
        limit = args.get("limit", 100)

        try:
            def _query(session):
                conv = (
                    session.query(Conversation)
                    .filter(Conversation.id == target, Conversation.user_id == user_id)
                    .first()
                )
                if not conv:
                    return f"Error: Conversation {target} not found."

                messages = (
                    session.query(Message)
                    .filter(Message.conversation_id == target)
                    .order_by(Message.created_at.asc())
                    .offset(offset)
                    .limit(limit)
                    .all()
                )

                total = session.query(Message).filter(Message.conversation_id == target).count()

                lines = []
                if conv.compacted_context:
                    lines.append(f"**Summary**: {conv.compacted_context}\n")
                for msg in messages:
                    name = msg.name or msg.role.capitalize()
                    lines.append(f"**{name}**: {msg.message}")

                result = "\n\n".join(lines)
                if offset + limit < total:
                    result += (
                        f"\n\n*Showing {offset + 1}–{offset + len(messages)} of {total} messages. "
                        f"Use offset={offset + limit} for more.*"
                    )
                return result

            db = get_db_service()
            return await db.execute(_query)

        except Exception as e:
            logger.error("history_read failed: %s", e, exc_info=True)
            return f"Error: Failed to read conversation: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Read conversation {args.get('target_conversation_id')}"
