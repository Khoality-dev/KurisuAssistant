from typing import Optional, List
from datetime import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from ..models import Conversation, Message
from .base import BaseRepository


class ConversationRepository(BaseRepository[Conversation]):
    """Repository for Conversation model operations."""

    def __init__(self, session: Session):
        super().__init__(Conversation, session)

    def create_conversation(
        self,
        user_id: int,
        title: str = "New conversation",
        main_agent_id: Optional[int] = None,
    ) -> Conversation:
        """Create a new conversation. ``main_agent_id`` may be left None
        and picked on the first message via trigger-word/random selection.
        """
        return self.create(user_id=user_id, title=title, main_agent_id=main_agent_id)

    def get_by_user_and_id(self, user_id: int, conversation_id: int) -> Optional[Conversation]:
        return self.get_by_filter(user_id=user_id, id=conversation_id)

    def get_latest_by_user(self, user_id: int) -> Optional[Conversation]:
        return (
            self.session.query(Conversation)
            .filter_by(user_id=user_id)
            .order_by(desc(Conversation.id))
            .first()
        )

    def get_latest_by_agent(self, user_id: int, agent_id: int) -> Optional[Conversation]:
        """Most recent conversation where this agent is the main agent."""
        return (
            self.session.query(Conversation)
            .filter(
                Conversation.user_id == user_id,
                Conversation.main_agent_id == agent_id,
            )
            .order_by(desc(Conversation.updated_at))
            .first()
        )

    def list_by_user(self, user_id: int, limit: int = 50) -> List[dict]:
        """List conversations with metadata for a user.

        Each entry: id, title, main_agent_id, created_at, updated_at,
        message_count, last_message.
        """
        latest_msg_subq = (
            self.session.query(
                Message.conversation_id.label("conv_id"),
                func.max(Message.id).label("max_msg_id"),
            )
            .group_by(Message.conversation_id)
            .subquery()
        )

        LatestMessage = self.session.query(Message).subquery()

        msg_count_subq = (
            self.session.query(
                Message.conversation_id.label("conv_id"),
                func.count(Message.id).label("msg_count"),
            )
            .group_by(Message.conversation_id)
            .subquery()
        )

        conversations = (
            self.session.query(
                Conversation.id,
                Conversation.title,
                Conversation.main_agent_id,
                Conversation.created_at,
                Conversation.updated_at,
                func.coalesce(msg_count_subq.c.msg_count, 0).label("message_count"),
                LatestMessage.c.message.label("last_message_content"),
                LatestMessage.c.role.label("last_message_role"),
                LatestMessage.c.created_at.label("last_message_at"),
            )
            .outerjoin(msg_count_subq, Conversation.id == msg_count_subq.c.conv_id)
            .outerjoin(latest_msg_subq, Conversation.id == latest_msg_subq.c.conv_id)
            .outerjoin(LatestMessage, LatestMessage.c.id == latest_msg_subq.c.max_msg_id)
            .filter(Conversation.user_id == user_id)
            .order_by(desc(Conversation.updated_at))
            .limit(limit)
            .all()
        )

        result = []
        for conv in conversations:
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

            result.append({
                "id": conv.id,
                "title": conv.title or "New conversation",
                "main_agent_id": conv.main_agent_id,
                "created_at": conv.created_at.isoformat() + "Z",
                "updated_at": (
                    conv.updated_at.isoformat() + "Z"
                    if conv.updated_at
                    else conv.created_at.isoformat() + "Z"
                ),
                "message_count": int(conv.message_count or 0),
                "last_message": last_message,
            })

        return result

    def update_title(
        self, user_id: int, title: str, conversation_id: Optional[int] = None
    ) -> Optional[Conversation]:
        if conversation_id:
            conversation = self.get_by_user_and_id(user_id, conversation_id)
        else:
            conversation = self.get_latest_by_user(user_id)

        if conversation:
            return self.update(conversation, title=title)
        return None

    def update_timestamp(self, conversation: Conversation) -> Conversation:
        return self.update(conversation, updated_at=datetime.utcnow())

    def update_main_agent(self, conversation: Conversation, agent_id: int) -> Conversation:
        """Persist the main agent pick for a conversation (one-time at first message)."""
        return self.update(conversation, main_agent_id=agent_id)

    def update_compacted_context(
        self, conversation: Conversation, compacted_context: str, compacted_up_to_id: int
    ) -> Conversation:
        return self.update(
            conversation,
            compacted_context=compacted_context,
            compacted_up_to_id=compacted_up_to_id,
        )

    def delete_by_user_and_id(self, user_id: int, conversation_id: int) -> bool:
        rows_deleted = self.delete_by_filter(user_id=user_id, id=conversation_id)
        return rows_deleted > 0
