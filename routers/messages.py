"""Message routes."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import MessageRepository, ConversationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/messages", tags=["messages"])


@router.get("/{message_id}")
async def get_message(
    message_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Fetch a specific message by its ID."""
    try:
        with get_session() as session:
            msg_repo = MessageRepository(session)
            conv_repo = ConversationRepository(session)

            message = msg_repo.get_by_id(message_id)
            if not message:
                raise HTTPException(status_code=404, detail="Message not found")

            # Verify ownership through frame -> conversation -> user
            if message.frame and message.frame.conversation:
                conversation = conv_repo.get_by_user_and_id(
                    user.id,
                    message.frame.conversation_id
                )
                if not conversation:
                    raise HTTPException(status_code=404, detail="Message not found")
            else:
                raise HTTPException(status_code=404, detail="Message not found")

            result = {
                "id": message.id,
                "role": message.role,
                "content": message.message,
                "conversation_id": message.frame.conversation_id if message.frame else None,
                "created_at": message.created_at.isoformat(),
            }
            if message.thinking:
                result["thinking"] = message.thinking
            return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching message {message_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
