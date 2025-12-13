from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Message
from .base import BaseRepository


class MessageRepository(BaseRepository[Message]):
    """Repository for Message model operations."""

    def __init__(self, session: Session):
        """Initialize MessageRepository with session.

        Args:
            session: SQLAlchemy session instance
        """
        super().__init__(Message, session)

    def create_message(
        self,
        role: str,
        username: str,
        message: str,
        conversation_id: int,
        created_at: Optional[datetime] = None,
        updated_at: Optional[datetime] = None,
    ) -> Message:
        """Create a new message.

        Args:
            role: Message role (user/assistant)
            username: Username who owns the message
            message: Message content
            conversation_id: Conversation ID this message belongs to
            created_at: Creation timestamp (optional)
            updated_at: Update timestamp (optional)

        Returns:
            Created Message instance
        """
        data = {
            "role": role,
            "username": username,
            "message": message,
            "conversation_id": conversation_id,
        }
        if created_at is not None:
            data["created_at"] = created_at
        if updated_at is not None:
            data["updated_at"] = updated_at

        return self.create(**data)

    def get_by_user_and_id(self, username: str, message_id: int) -> Optional[Message]:
        """Get message by username and ID.

        Args:
            username: Username who owns the message
            message_id: Message ID

        Returns:
            Message instance or None if not found
        """
        return self.get_by_filter(username=username, id=message_id)

    def get_by_conversation(
        self,
        username: str,
        conversation_id: int,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Message]:
        """Get messages for a conversation with pagination.

        Args:
            username: Username who owns the messages
            conversation_id: Conversation ID
            limit: Maximum number of messages to return
            offset: Number of messages to skip

        Returns:
            List of Message instances ordered by creation time
        """
        return (
            self.session.query(Message)
            .filter_by(username=username, conversation_id=conversation_id)
            .order_by(Message.created_at)
            .limit(limit)
            .offset(offset)
            .all()
        )

    def get_latest_by_conversation(
        self, username: str, conversation_id: int
    ) -> Optional[Message]:
        """Get the most recent message in a conversation.

        Args:
            username: Username who owns the message
            conversation_id: Conversation ID

        Returns:
            Most recent Message or None if no messages exist
        """
        return (
            self.session.query(Message)
            .filter_by(username=username, conversation_id=conversation_id)
            .order_by(desc(Message.created_at), desc(Message.id))
            .first()
        )

    def count_by_conversation(self, username: str, conversation_id: int) -> int:
        """Count messages in a conversation.

        Args:
            username: Username who owns the messages
            conversation_id: Conversation ID

        Returns:
            Number of messages
        """
        return self.count(username=username, conversation_id=conversation_id)

    def append_to_message(self, message: Message, content: str) -> Message:
        """Append content to an existing message.

        Args:
            message: Message instance to update
            content: Content to append

        Returns:
            Updated Message instance
        """
        new_content = message.message + content
        return self.update(message, message=new_content, updated_at=datetime.utcnow())

    def delete_by_conversation(self, username: str, conversation_id: int) -> int:
        """Delete all messages in a conversation.

        Args:
            username: Username who owns the messages
            conversation_id: Conversation ID

        Returns:
            Number of messages deleted
        """
        return self.delete_by_filter(username=username, conversation_id=conversation_id)
