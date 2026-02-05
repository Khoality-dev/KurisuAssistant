from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Conversation, Frame
from .base import BaseRepository


class ConversationRepository(BaseRepository[Conversation]):
    """Repository for Conversation model operations."""

    def __init__(self, session: Session):
        """Initialize ConversationRepository with session.

        Args:
            session: SQLAlchemy session instance
        """
        super().__init__(Conversation, session)

    def create_conversation(self, user_id: int, title: str = "New conversation") -> Conversation:
        """Create a new conversation for a user.

        Args:
            user_id: User ID who owns the conversation
            title: Conversation title

        Returns:
            Created Conversation instance
        """
        return self.create(user_id=user_id, title=title)

    def get_by_user_and_id(self, user_id: int, conversation_id: int) -> Optional[Conversation]:
        """Get conversation by user ID and conversation ID.

        Args:
            user_id: User ID who owns the conversation
            conversation_id: Conversation ID

        Returns:
            Conversation instance or None if not found
        """
        return self.get_by_filter(user_id=user_id, id=conversation_id)

    def get_latest_by_user(self, user_id: int) -> Optional[Conversation]:
        """Get the most recent conversation for a user.

        Args:
            user_id: User ID to search for

        Returns:
            Most recent Conversation or None if no conversations exist
        """
        return (
            self.session.query(Conversation)
            .filter_by(user_id=user_id)
            .order_by(desc(Conversation.id))
            .first()
        )

    def list_by_user(self, user_id: int, limit: int = 50) -> List[dict]:
        """List conversations with metadata for a user.

        Args:
            user_id: User ID to search for
            limit: Maximum number of conversations to return

        Returns:
            List of conversation dictionaries with frame count metadata
        """
        conversations = (
            self.session.query(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
                func.count(Frame.id).label("frame_count"),
            )
            .outerjoin(Frame, Conversation.id == Frame.conversation_id)
            .filter(Conversation.user_id == user_id)
            .group_by(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
            )
            .order_by(desc(Conversation.updated_at))
            .limit(limit)
            .all()
        )

        result = []
        for conv in conversations:
            frame_count = conv.frame_count or 0

            result.append(
                {
                    "id": conv.id,
                    "title": conv.title or "New conversation",
                    "created_at": conv.created_at.isoformat(),
                    "updated_at": (
                        conv.updated_at.isoformat()
                        if conv.updated_at
                        else conv.created_at.isoformat()
                    ),
                    "frame_count": frame_count,
                }
            )

        return result

    def update_title(
        self, user_id: int, title: str, conversation_id: Optional[int] = None
    ) -> Optional[Conversation]:
        """Update conversation title.

        Args:
            user_id: User ID who owns the conversation
            title: New title
            conversation_id: Specific conversation ID, or None to update latest

        Returns:
            Updated Conversation or None if not found
        """
        if conversation_id:
            conversation = self.get_by_user_and_id(user_id, conversation_id)
        else:
            conversation = self.get_latest_by_user(user_id)

        if conversation:
            return self.update(conversation, title=title)
        return None

    def update_timestamp(self, conversation: Conversation) -> Conversation:
        """Update conversation's updated_at timestamp.

        Args:
            conversation: Conversation instance to update

        Returns:
            Updated Conversation instance
        """
        return self.update(conversation, updated_at=datetime.utcnow())

    def delete_by_user_and_id(self, user_id: int, conversation_id: int) -> bool:
        """Delete a conversation by user ID and conversation ID.

        Args:
            user_id: User ID who owns the conversation
            conversation_id: Conversation ID to delete

        Returns:
            True if deleted, False if not found
        """
        rows_deleted = self.delete_by_filter(user_id=user_id, id=conversation_id)
        return rows_deleted > 0
