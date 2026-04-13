"""Conversation history tools — read-only access to past sessions via DB."""

import logging
from typing import Dict, Any

from .base import BaseTool

logger = logging.getLogger(__name__)


def _parse_date(date_str: str):
    """Parse ISO date string to datetime."""
    from datetime import datetime
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


class HistoryListTool(BaseTool):
    """List past conversation sessions (frames) with summaries."""

    name = "history_list"
    description = (
        "List past conversation sessions with their summaries, dates, and message counts. "
        "Returns most recent sessions first. Use to find which session to read in detail."
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
                            "description": "Maximum number of sessions to return (default: 20).",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.models import Frame, Message
        from sqlalchemy import func, desc

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return "Error: No conversation context available."

        limit = args.get("limit", 20)

        try:
            def _query(session):
                frames = (
                    session.query(
                        Frame.id,
                        Frame.summary,
                        Frame.created_at,
                        Frame.updated_at,
                        func.count(Message.id).label("message_count"),
                    )
                    .outerjoin(Message, Frame.id == Message.frame_id)
                    .filter(Frame.conversation_id == conversation_id)
                    .group_by(Frame.id)
                    .order_by(desc(Frame.created_at))
                    .limit(limit)
                    .all()
                )

                if not frames:
                    return "No past sessions found."

                lines = []
                for f in frames:
                    created = f.created_at.strftime("%Y-%m-%d %H:%M") if f.created_at else "unknown"
                    summary = f.summary or "(no summary)"
                    lines.append(
                        f"- **Session #{f.id}** ({created}, {f.message_count} messages): {summary}"
                    )
                return "\n".join(lines)

            db = get_db_service()
            return await db.execute(_query)

        except Exception as e:
            logger.error("history_list failed: %s", e, exc_info=True)
            return f"Error: Failed to list sessions: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        limit = args.get("limit", 20)
        return f"List past sessions (limit={limit})"


class HistoryReadTool(BaseTool):
    """Read messages from a specific conversation session."""

    name = "history_read"
    description = (
        "Read messages from a specific past conversation session. "
        "Use history_list first to find the frame_id, then read the session in detail."
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
                        "frame_id": {
                            "type": "integer",
                            "description": "The frame/session ID to read.",
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
                    "required": ["frame_id"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.models import Frame, Message

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return "Error: No conversation context available."

        frame_id = args.get("frame_id")
        if not frame_id:
            return "Error: frame_id is required."

        offset = args.get("offset", 0)
        limit = args.get("limit", 100)

        try:
            def _query(session):
                frame = (
                    session.query(Frame)
                    .filter(Frame.id == frame_id, Frame.conversation_id == conversation_id)
                    .first()
                )
                if not frame:
                    return f"Error: Session {frame_id} not found."

                messages = (
                    session.query(Message)
                    .filter(Message.frame_id == frame_id)
                    .order_by(Message.created_at.asc())
                    .offset(offset)
                    .limit(limit)
                    .all()
                )

                total = session.query(Message).filter(Message.frame_id == frame_id).count()

                lines = []
                if frame.summary:
                    lines.append(f"**Summary**: {frame.summary}\n")
                for msg in messages:
                    name = msg.name or msg.role.capitalize()
                    lines.append(f"**{name}**: {msg.message}")

                result = "\n\n".join(lines)
                if offset + limit < total:
                    result += f"\n\n*Showing {offset+1}–{offset+len(messages)} of {total} messages. Use offset={offset+limit} for more.*"
                return result

            db = get_db_service()
            return await db.execute(_query)

        except Exception as e:
            logger.error("history_read failed: %s", e, exc_info=True)
            return f"Error: Failed to read session: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Read session {args.get('frame_id')}"


class HistorySearchTool(BaseTool):
    """Search past conversation messages by text and/or date range."""

    name = "history_search"
    description = (
        "Search past conversation messages by text content and/or date range. "
        "Searches across all sessions. Use to find when something was discussed."
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
                        "query": {
                            "type": "string",
                            "description": "Text to search for (case-insensitive).",
                        },
                        "after": {
                            "type": "string",
                            "description": "Only include messages after this date (ISO format, e.g. '2024-01-15').",
                        },
                        "before": {
                            "type": "string",
                            "description": "Only include messages before this date (ISO format, e.g. '2024-01-16').",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results (default: 50).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.db.service import get_db_service
        from kurisuassistant.db.models import Frame, Message

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return "Error: No conversation context available."

        query = args.get("query", "")
        after = args.get("after")
        before = args.get("before")
        limit = args.get("limit", 50)

        if not query:
            return "Error: query is required."

        try:
            def _search(session):
                q = (
                    session.query(Message)
                    .join(Frame, Message.frame_id == Frame.id)
                    .filter(Frame.conversation_id == conversation_id)
                    .filter(Message.message.ilike(f"%{query}%"))
                )

                if after:
                    parsed = _parse_date(after)
                    if parsed:
                        q = q.filter(Message.created_at >= parsed)

                if before:
                    parsed = _parse_date(before)
                    if parsed:
                        q = q.filter(Message.created_at <= parsed)

                messages = q.order_by(Message.created_at.desc()).limit(limit).all()

                if not messages:
                    return f"No results found for \"{query}\"."

                lines = []
                for msg in messages:
                    name = msg.name or msg.role.capitalize()
                    created = msg.created_at.strftime("%Y-%m-%d %H:%M") if msg.created_at else ""
                    snippet = msg.message[:200]
                    lines.append(f"- **{name}** (session #{msg.frame_id}, {created}): {snippet}")
                return "\n".join(lines)

            db = get_db_service()
            return await db.execute(_search)

        except Exception as e:
            logger.error("history_search failed: %s", e, exc_info=True)
            return f"Error: Search failed: {e}"

    def describe_call(self, args: Dict[str, Any]) -> str:
        parts = [f"query='{args.get('query')}'"]
        if args.get("after"):
            parts.append(f"after {args['after']}")
        if args.get("before"):
            parts.append(f"before {args['before']}")
        return f"Search history: {', '.join(parts)}"
