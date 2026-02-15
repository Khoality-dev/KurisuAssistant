"""Context querying tools for searching conversation history."""

import json
import logging
from datetime import datetime
from typing import Dict, Any

from sqlalchemy import func

from .base import BaseTool

logger = logging.getLogger(__name__)


class SearchMessagesTool(BaseTool):
    """Search messages in the current conversation by text/regex and/or date range."""

    name = "search_messages"
    description = (
        "Search messages in the current conversation. "
        "Supports text/regex search, date filtering, or both. "
        "Use when the user asks about past messages, wants to find specific content, "
        "or references something from earlier in the conversation."
    )
    requires_approval = False
    risk_level = "low"
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
                            "description": "Text or regex pattern to search for (case-insensitive). Examples: 'hello', 'python|code', '\\d+' for numbers.",
                        },
                        "start_date": {
                            "type": "string",
                            "description": "ISO date or datetime to filter from (e.g. '2024-01-15' or '2024-01-15T10:30:00').",
                        },
                        "end_date": {
                            "type": "string",
                            "description": "ISO date or datetime to filter until (e.g. '2024-01-16' or '2024-01-16T23:59:59').",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of results to return (default: 50).",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from db.session import get_session
        from db.models import Message, Frame, Agent

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return json.dumps({"error": "No conversation context available."})

        query = args.get("query")
        start_date = args.get("start_date")
        end_date = args.get("end_date")
        limit = args.get("limit", 50)

        if not query and not start_date and not end_date:
            return json.dumps({"error": "At least one of 'query' or 'start_date'/'end_date' must be provided."})

        try:
            with get_session() as session:
                q = (
                    session.query(Message)
                    .join(Frame, Message.frame_id == Frame.id)
                    .filter(Frame.conversation_id == conversation_id)
                )

                if query:
                    # PostgreSQL case-insensitive regex match
                    q = q.filter(Message.message.op("~*")(query))

                if start_date:
                    parsed_start = _parse_date(start_date)
                    if parsed_start:
                        q = q.filter(Message.created_at >= parsed_start)

                if end_date:
                    parsed_end = _parse_date(end_date)
                    if parsed_end:
                        q = q.filter(Message.created_at <= parsed_end)

                messages = q.order_by(Message.created_at.asc()).limit(limit).all()

                results = []
                for msg in messages:
                    agent_name = msg.agent.name if msg.agent else None
                    results.append({
                        "role": msg.role,
                        "content": msg.message,
                        "name": agent_name,
                        "frame_id": msg.frame_id,
                        "created_at": msg.created_at.isoformat() + "Z" if msg.created_at else None,
                    })

                return json.dumps(results, ensure_ascii=False)

        except Exception as e:
            logger.error(f"search_messages failed: {e}", exc_info=True)
            return json.dumps({"error": f"Search failed: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        parts = []
        if args.get("query"):
            parts.append(f"query='{args['query']}'")
        if args.get("start_date"):
            parts.append(f"from {args['start_date']}")
        if args.get("end_date"):
            parts.append(f"until {args['end_date']}")
        return f"Search messages: {', '.join(parts)}" if parts else "Search messages"


class GetConversationInfoTool(BaseTool):
    """Get metadata about the current conversation."""

    name = "get_conversation_info"
    description = (
        "Get metadata about the current conversation including title, "
        "creation date, message count, and frame count. "
        "Use when the user asks about the conversation itself."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from db.session import get_session
        from db.models import Conversation, Frame, Message

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return json.dumps({"error": "No conversation context available."})

        try:
            with get_session() as session:
                conversation = session.query(Conversation).filter_by(id=conversation_id).first()
                if not conversation:
                    return json.dumps({"error": "Conversation not found."})

                message_count = (
                    session.query(func.count(Message.id))
                    .join(Frame, Message.frame_id == Frame.id)
                    .filter(Frame.conversation_id == conversation_id)
                    .scalar()
                )

                frame_count = (
                    session.query(func.count(Frame.id))
                    .filter(Frame.conversation_id == conversation_id)
                    .scalar()
                )

                result = {
                    "title": conversation.title,
                    "created_at": conversation.created_at.isoformat() + "Z" if conversation.created_at else None,
                    "updated_at": conversation.updated_at.isoformat() + "Z" if conversation.updated_at else None,
                    "message_count": message_count,
                    "frame_count": frame_count,
                }

                return json.dumps(result, ensure_ascii=False)

        except Exception as e:
            logger.error(f"get_conversation_info failed: {e}", exc_info=True)
            return json.dumps({"error": f"Failed to get conversation info: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        return "Get conversation metadata"


class GetFrameSummariesTool(BaseTool):
    """List past conversation session frames with their summaries."""

    name = "get_frame_summaries"
    description = (
        "List past conversation sessions (frames) with their summaries and timestamps. "
        "Use when the user asks about previous sessions or you need context from earlier conversations."
    )
    requires_approval = False
    risk_level = "low"
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
                            "description": "Maximum number of frames to return (default: 20).",
                        },
                    },
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from db.session import get_session
        from db.models import Frame, Message
        from sqlalchemy import func, desc

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return json.dumps({"error": "No conversation context available."})

        limit = args.get("limit", 20)

        try:
            with get_session() as session:
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
                    .group_by(Frame.id, Frame.summary, Frame.created_at, Frame.updated_at)
                    .order_by(desc(Frame.created_at))
                    .limit(limit)
                    .all()
                )

                results = [
                    {
                        "frame_id": f.id,
                        "summary": f.summary,
                        "created_at": f.created_at.isoformat() + "Z" if f.created_at else None,
                        "updated_at": f.updated_at.isoformat() + "Z" if f.updated_at else None,
                        "message_count": f.message_count or 0,
                    }
                    for f in frames
                ]

                return json.dumps(results, ensure_ascii=False)

        except Exception as e:
            logger.error(f"get_frame_summaries failed: {e}", exc_info=True)
            return json.dumps({"error": f"Failed to get frame summaries: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        limit = args.get("limit", 20)
        return f"List session frames (limit={limit})"


class GetFrameMessagesTool(BaseTool):
    """Get messages from a specific past session frame."""

    name = "get_frame_messages"
    description = (
        "Get messages from a specific past session frame by its ID. "
        "Use after get_frame_summaries to retrieve full conversation content from a particular session."
    )
    requires_approval = False
    risk_level = "low"
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
                            "description": "The frame ID to retrieve messages from.",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Maximum number of messages to return (default: 50).",
                        },
                    },
                    "required": ["frame_id"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        from db.session import get_session
        from db.models import Frame, Message

        conversation_id = args.get("conversation_id")
        if not conversation_id:
            return json.dumps({"error": "No conversation context available."})

        frame_id = args.get("frame_id")
        if not frame_id:
            return json.dumps({"error": "frame_id is required."})

        limit = args.get("limit", 50)

        try:
            with get_session() as session:
                # Verify frame belongs to the conversation
                frame = (
                    session.query(Frame)
                    .filter(Frame.id == frame_id, Frame.conversation_id == conversation_id)
                    .first()
                )
                if not frame:
                    return json.dumps({"error": f"Frame {frame_id} not found in this conversation."})

                messages = (
                    session.query(Message)
                    .filter(Message.frame_id == frame_id)
                    .order_by(Message.created_at)
                    .limit(limit)
                    .all()
                )

                results = [
                    {
                        "role": msg.role,
                        "content": msg.message,
                        "name": msg.name,
                        "created_at": msg.created_at.isoformat() + "Z" if msg.created_at else None,
                    }
                    for msg in messages
                ]

                return json.dumps(results, ensure_ascii=False)

        except Exception as e:
            logger.error(f"get_frame_messages failed: {e}", exc_info=True)
            return json.dumps({"error": f"Failed to get frame messages: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        frame_id = args.get("frame_id", "?")
        return f"Get messages from frame {frame_id}"


def _parse_date(date_str: str) -> datetime | None:
    """Parse an ISO date or datetime string."""
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None
