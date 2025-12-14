from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Chunk, Message
from .base import BaseRepository


class ChunkRepository(BaseRepository[Chunk]):
    """Repository for Chunk model operations."""

    def __init__(self, session: Session):
        """Initialize ChunkRepository with session.

        Args:
            session: SQLAlchemy session instance
        """
        super().__init__(Chunk, session)

    def create_chunk(self, conversation_id: int) -> Chunk:
        """Create a new chunk for a conversation.

        Args:
            conversation_id: Conversation ID this chunk belongs to

        Returns:
            Created Chunk instance
        """
        return self.create(conversation_id=conversation_id)

    def get_by_conversation(self, conversation_id: int) -> List[Chunk]:
        """Get all chunks for a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            List of Chunk instances ordered by creation time
        """
        return (
            self.session.query(Chunk)
            .filter_by(conversation_id=conversation_id)
            .order_by(Chunk.created_at)
            .all()
        )

    def get_latest_by_conversation(self, conversation_id: int) -> Optional[Chunk]:
        """Get the most recent chunk in a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            Most recent Chunk or None if no chunks exist
        """
        return (
            self.session.query(Chunk)
            .filter_by(conversation_id=conversation_id)
            .order_by(desc(Chunk.created_at), desc(Chunk.id))
            .first()
        )

    def list_by_conversation(self, conversation_id: int) -> List[dict]:
        """List chunks with message counts for a conversation.

        Args:
            conversation_id: Conversation ID

        Returns:
            List of dictionaries with chunk data and message counts
        """
        chunks = (
            self.session.query(
                Chunk.id,
                Chunk.conversation_id,
                Chunk.created_at,
                Chunk.updated_at,
                func.count(Message.id).label("message_count"),
            )
            .outerjoin(Message, Chunk.id == Message.chunk_id)
            .filter(Chunk.conversation_id == conversation_id)
            .group_by(Chunk.id, Chunk.conversation_id, Chunk.created_at, Chunk.updated_at)
            .order_by(Chunk.created_at)
            .all()
        )

        return [
            {
                "id": chunk.id,
                "conversation_id": chunk.conversation_id,
                "created_at": chunk.created_at.isoformat(),
                "updated_at": chunk.updated_at.isoformat() if chunk.updated_at else chunk.created_at.isoformat(),
                "message_count": chunk.message_count or 0,
            }
            for chunk in chunks
        ]

    def update_timestamp(self, chunk: Chunk) -> Chunk:
        """Update chunk's updated_at timestamp.

        Args:
            chunk: Chunk instance to update

        Returns:
            Updated Chunk instance
        """
        return self.update(chunk, updated_at=datetime.utcnow())

    def delete_by_conversation(self, conversation_id: int) -> int:
        """Delete all chunks in a conversation (cascade deletes messages).

        Args:
            conversation_id: Conversation ID

        Returns:
            Number of chunks deleted
        """
        return self.delete_by_filter(conversation_id=conversation_id)
