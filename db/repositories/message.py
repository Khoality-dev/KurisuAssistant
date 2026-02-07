from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session, defer
from sqlalchemy import desc, func

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
        message: str,
        frame_id: int,
        created_at: Optional[datetime] = None,
        thinking: Optional[str] = None,
        agent_id: Optional[int] = None,
        raw_input: Optional[str] = None,
        raw_output: Optional[str] = None,
    ) -> Message:
        """Create a new message.

        Args:
            role: Message role (user/assistant/tool)
            message: Message content
            frame_id: Frame ID this message belongs to
            created_at: Creation timestamp (optional)
            thinking: Thinking content (optional, for assistant messages)
            agent_id: Agent ID that sent this message (optional)
            raw_input: JSON string of messages array sent to LLM (optional)
            raw_output: Full concatenated LLM response text (optional)

        Returns:
            Created Message instance
        """
        data = {
            "role": role,
            "message": message,
            "frame_id": frame_id,
        }
        if created_at is not None:
            data["created_at"] = created_at
        if thinking is not None:
            data["thinking"] = thinking
        if agent_id is not None:
            data["agent_id"] = agent_id
        if raw_input is not None:
            data["raw_input"] = raw_input
        if raw_output is not None:
            data["raw_output"] = raw_output

        return self.create(**data)

    def get_by_frame(
        self,
        frame_id: int,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Message]:
        """Get messages for a specific frame with pagination.

        Args:
            frame_id: Frame ID
            limit: Maximum number of messages to return
            offset: Number of messages to skip

        Returns:
            List of Message instances ordered by creation time
        """
        return (
            self.session.query(Message)
            .filter_by(frame_id=frame_id)
            .order_by(Message.created_at)
            .limit(limit)
            .offset(offset)
            .all()
        )

    def get_by_conversation(
        self,
        conversation_id: int,
        limit: int = 20,
        offset: int = 0,
    ) -> List[Message]:
        """Get messages for a conversation (across all frames) with pagination.

        Messages are fetched in reverse chronological order (newest first) for pagination,
        then reversed to return in chronological order (oldest first) for display.

        Heavy columns (raw_input, raw_output) are deferred to avoid loading large
        text blobs that are only needed for the /messages/{id}/raw endpoint.

        Args:
            conversation_id: Conversation ID
            limit: Maximum number of messages to return
            offset: Number of messages to skip from the newest messages

        Returns:
            List of Message instances ordered by creation time (oldest first within the page)
        """
        from ..models import Frame
        # Fetch in reverse order (newest first) with offset, then reverse for display
        # Defer raw_input/raw_output to avoid loading large text blobs
        messages = (
            self.session.query(Message)
            .options(defer(Message.raw_input), defer(Message.raw_output))
            .join(Frame, Message.frame_id == Frame.id)
            .filter(Frame.conversation_id == conversation_id)
            .order_by(desc(Message.created_at))
            .limit(limit)
            .offset(offset)
            .all()
        )
        # Reverse to get chronological order (oldest first) for display
        return list(reversed(messages))

    def get_latest_by_frame(self, frame_id: int) -> Optional[Message]:
        """Get the most recent message in a frame.

        Args:
            frame_id: Frame ID

        Returns:
            Most recent Message or None if no messages exist
        """
        return (
            self.session.query(Message)
            .filter_by(frame_id=frame_id)
            .order_by(desc(Message.created_at), desc(Message.id))
            .first()
        )

    def get_latest_by_conversation(self, conversation_id: int) -> Optional[Message]:
        """Get the most recent message in a conversation (across all frames).

        Args:
            conversation_id: Conversation ID

        Returns:
            Most recent Message or None if no messages exist
        """
        from ..models import Frame
        return (
            self.session.query(Message)
            .join(Frame, Message.frame_id == Frame.id)
            .filter(Frame.conversation_id == conversation_id)
            .order_by(desc(Message.created_at), desc(Message.id))
            .first()
        )

    def count_by_frame(self, frame_id: int) -> int:
        """Count messages in a frame.

        Args:
            frame_id: Frame ID

        Returns:
            Number of messages
        """
        return self.count(frame_id=frame_id)

    def count_by_conversation(self, conversation_id: int) -> int:
        """Count messages in a conversation (across all frames).

        Args:
            conversation_id: Conversation ID

        Returns:
            Number of messages
        """
        from ..models import Frame
        return (
            self.session.query(Message)
            .join(Frame, Message.frame_id == Frame.id)
            .filter(Frame.conversation_id == conversation_id)
            .count()
        )
