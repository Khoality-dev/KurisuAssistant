from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Frame, Message
from .base import BaseRepository


class FrameRepository(BaseRepository[Frame]):
    """Repository for Frame model operations (context frames)."""

    def __init__(self, session: Session):
        """Initialize FrameRepository with session.

        Args:
            session: SQLAlchemy session instance
        """
        super().__init__(Frame, session)

    def create_frame(self, conversation_id: int) -> Frame:
        """Create a new frame for a conversation.

        Args:
            conversation_id: Conversation ID this frame belongs to

        Returns:
            Created Frame instance
        """
        return self.create(conversation_id=conversation_id)

    def get_by_conversation(self, conversation_id: int) -> List[Frame]:
        """Get all frames for a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            List of Frame instances ordered by creation time
        """
        return (
            self.session.query(Frame)
            .filter_by(conversation_id=conversation_id)
            .order_by(Frame.created_at)
            .all()
        )

    def get_latest_by_conversation(self, conversation_id: int) -> Optional[Frame]:
        """Get the most recent frame in a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            Most recent Frame or None if no frames exist
        """
        return (
            self.session.query(Frame)
            .filter_by(conversation_id=conversation_id)
            .order_by(desc(Frame.created_at), desc(Frame.id))
            .first()
        )

    def list_by_conversation(self, conversation_id: int) -> List[dict]:
        """List frames with message counts for a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            List of dictionaries with frame data and message counts
        """
        frames = (
            self.session.query(
                Frame.id,
                Frame.conversation_id,
                Frame.summary,
                Frame.created_at,
                Frame.updated_at,
                func.count(Message.id).label("message_count"),
            )
            .outerjoin(Message, Frame.id == Message.frame_id)
            .filter(Frame.conversation_id == conversation_id)
            .group_by(Frame.id, Frame.conversation_id, Frame.summary, Frame.created_at, Frame.updated_at)
            .order_by(Frame.created_at)
            .all()
        )

        return [
            {
                "id": frame.id,
                "conversation_id": frame.conversation_id,
                "summary": frame.summary,
                "created_at": frame.created_at.isoformat(),
                "updated_at": frame.updated_at.isoformat() if frame.updated_at else frame.created_at.isoformat(),
                "message_count": frame.message_count or 0,
            }
            for frame in frames
        ]

    def update_summary(self, frame: Frame, summary: str) -> Frame:
        """Update frame's summary text.

        Args:
            frame: Frame instance to update
            summary: Summary text

        Returns:
            Updated Frame instance
        """
        return self.update(frame, summary=summary)

    def update_timestamp(self, frame: Frame) -> Frame:
        """Update frame's updated_at timestamp.

        Args:
            frame: Frame instance to update

        Returns:
            Updated Frame instance
        """
        return self.update(frame, updated_at=datetime.utcnow())

    def delete_by_conversation(self, conversation_id: int) -> int:
        """Delete all frames in a conversation (cascade deletes messages).

        Args:
            conversation_id: Conversation ID

        Returns:
            Number of frames deleted
        """
        return self.delete_by_filter(conversation_id=conversation_id)
