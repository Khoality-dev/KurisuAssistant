from typing import List, Optional
from datetime import datetime
from sqlalchemy.orm import Session, defer
from sqlalchemy import desc

from ..models import Message
from .base import BaseRepository


class MessageRepository(BaseRepository[Message]):
    """Repository for Message model operations."""

    def __init__(self, session: Session):
        super().__init__(Message, session)

    def create_message(
        self,
        role: str,
        message: str,
        conversation_id: int,
        created_at: Optional[datetime] = None,
        thinking: Optional[str] = None,
        agent_id: Optional[int] = None,
        name: Optional[str] = None,
        raw_input: Optional[str] = None,
        raw_output: Optional[str] = None,
        images: Optional[List[str]] = None,
        model_name: Optional[str] = None,
        provider_type: Optional[str] = None,
        tool_args: Optional[dict] = None,
        tool_status: Optional[str] = None,
        context_files: Optional[list] = None,
    ) -> Message:
        """Create a new message."""
        data = {
            "role": role,
            "message": message,
            "conversation_id": conversation_id,
        }
        if created_at is not None:
            data["created_at"] = created_at
        if thinking is not None:
            data["thinking"] = thinking
        if agent_id is not None:
            data["agent_id"] = agent_id
        if name is not None:
            data["name"] = name
        if raw_input is not None:
            data["raw_input"] = raw_input
        if raw_output is not None:
            data["raw_output"] = raw_output
        if images is not None:
            data["images"] = images
        if model_name is not None:
            data["model_name"] = model_name
        if provider_type is not None:
            data["provider_type"] = provider_type
        if tool_args is not None:
            data["tool_args"] = tool_args
        if tool_status is not None:
            data["tool_status"] = tool_status
        if context_files is not None:
            data["context_files"] = context_files

        return self.create(**data)

    def get_by_conversation(
        self,
        conversation_id: int,
        limit: int = 20,
        offset: int = 0,
    ) -> List[Message]:
        """Get messages for a conversation with pagination.

        Newest first for pagination, returned oldest first for display.
        Heavy columns (raw_input/raw_output) are deferred.
        """
        messages = (
            self.session.query(Message)
            .options(defer(Message.raw_input), defer(Message.raw_output))
            .filter(Message.conversation_id == conversation_id)
            .order_by(desc(Message.created_at))
            .limit(limit)
            .offset(offset)
            .all()
        )
        return list(reversed(messages))

    def list_by_conversation_after(self, conversation_id: int, message_id: int) -> List[Message]:
        """All messages in a conversation with id > message_id, ordered by creation time."""
        return (
            self.session.query(Message)
            .filter(
                Message.conversation_id == conversation_id,
                Message.id > message_id,
            )
            .order_by(Message.created_at)
            .all()
        )

    def get_latest_by_conversation(self, conversation_id: int) -> Optional[Message]:
        """Most recent message in a conversation."""
        return (
            self.session.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .order_by(desc(Message.created_at), desc(Message.id))
            .first()
        )

    def count_by_conversation(self, conversation_id: int) -> int:
        """Count messages in a conversation."""
        return (
            self.session.query(Message)
            .filter(Message.conversation_id == conversation_id)
            .count()
        )

    def delete_from_message(self, message_id: int, conversation_id: int) -> int:
        """Delete a message and all subsequent messages in the conversation."""
        subquery = (
            self.session.query(Message.id)
            .filter(
                Message.conversation_id == conversation_id,
                Message.id >= message_id,
            )
            .subquery()
        )

        count = (
            self.session.query(Message)
            .filter(Message.id.in_(subquery.select()))
            .delete(synchronize_session="fetch")
        )
        return count
