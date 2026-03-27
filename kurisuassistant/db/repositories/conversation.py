from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Conversation, Frame, Message
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

    def get_latest_by_agent(self, user_id: int, agent_id: int) -> Optional[Conversation]:
        """Get the most recent conversation containing messages from a specific agent.

        Args:
            user_id: User ID who owns the conversation
            agent_id: Agent ID to filter by

        Returns:
            Most recent matching Conversation or None
        """
        return (
            self.session.query(Conversation)
            .join(Frame, Conversation.id == Frame.conversation_id)
            .join(Message, Frame.id == Message.frame_id)
            .filter(Conversation.user_id == user_id, Message.agent_id == agent_id)
            .order_by(desc(Conversation.updated_at))
            .first()
        )

    def list_by_user(self, user_id: int, limit: int = 50) -> List[dict]:
        """List conversations with metadata for a user.

        Args:
            user_id: User ID to search for
            limit: Maximum number of conversations to return

        Returns:
            List of conversation dictionaries with frame count and last message metadata
        """
        # Subquery: latest message ID per conversation
        latest_msg_subq = (
            self.session.query(
                Frame.conversation_id.label("conv_id"),
                func.max(Message.id).label("max_msg_id"),
            )
            .join(Message, Frame.id == Message.frame_id)
            .group_by(Frame.conversation_id)
            .subquery()
        )

        # Alias for the latest message
        LatestMessage = self.session.query(Message).subquery()

        conversations = (
            self.session.query(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
                func.count(func.distinct(Frame.id)).label("frame_count"),
                LatestMessage.c.message.label("last_message_content"),
                LatestMessage.c.role.label("last_message_role"),
                LatestMessage.c.created_at.label("last_message_at"),
            )
            .outerjoin(Frame, Conversation.id == Frame.conversation_id)
            .outerjoin(
                latest_msg_subq,
                Conversation.id == latest_msg_subq.c.conv_id,
            )
            .outerjoin(
                LatestMessage,
                LatestMessage.c.id == latest_msg_subq.c.max_msg_id,
            )
            .filter(Conversation.user_id == user_id)
            .group_by(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
                LatestMessage.c.message,
                LatestMessage.c.role,
                LatestMessage.c.created_at,
            )
            .order_by(desc(Conversation.updated_at))
            .limit(limit)
            .all()
        )

        result = []
        for conv in conversations:
            frame_count = conv.frame_count or 0

            last_message = None
            if conv.last_message_content is not None:
                content = conv.last_message_content
                last_message = {
                    "content": content[:100] if len(content) > 100 else content,
                    "role": conv.last_message_role,
                    "created_at": (
                        conv.last_message_at.isoformat() + "Z"
                        if conv.last_message_at
                        else None
                    ),
                }

            result.append(
                {
                    "id": conv.id,
                    "title": conv.title or "New conversation",
                    "created_at": conv.created_at.isoformat() + "Z",
                    "updated_at": (
                        conv.updated_at.isoformat() + "Z"
                        if conv.updated_at
                        else conv.created_at.isoformat() + "Z"
                    ),
                    "frame_count": frame_count,
                    "last_message": last_message,
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

    def update_compacted_context(self, conversation: Conversation, compacted_context: str, compacted_up_to_id: int) -> Conversation:
        """Update conversation's compacted context and watermark."""
        return self.update(conversation, compacted_context=compacted_context, compacted_up_to_id=compacted_up_to_id)

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
