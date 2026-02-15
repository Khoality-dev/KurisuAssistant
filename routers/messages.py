"""Message routes."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import MessageRepository, ConversationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/messages", tags=["messages"])


def _verify_message_ownership(msg_repo, conv_repo, message_id: int, user_id: int):
    """Verify user owns the message. Returns the message or raises 404."""
    message = msg_repo.get_by_id(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    if message.frame and message.frame.conversation:
        conversation = conv_repo.get_by_user_and_id(
            user_id,
            message.frame.conversation_id
        )
        if not conversation:
            raise HTTPException(status_code=404, detail="Message not found")
    else:
        raise HTTPException(status_code=404, detail="Message not found")

    return message


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

            message = _verify_message_ownership(msg_repo, conv_repo, message_id, user.id)

            result = {
                "id": message.id,
                "role": message.role,
                "content": message.message,
                "conversation_id": message.frame.conversation_id if message.frame else None,
                "created_at": message.created_at.isoformat() + "Z",
                "has_raw_data": bool(message.raw_input or message.raw_output),
            }
            if message.thinking:
                result["thinking"] = message.thinking
            return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching message {message_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{message_id}")
async def delete_message(
    message_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete a message and all subsequent messages in the conversation."""
    try:
        with get_session() as session:
            msg_repo = MessageRepository(session)
            conv_repo = ConversationRepository(session)

            message = _verify_message_ownership(msg_repo, conv_repo, message_id, user.id)
            conversation_id = message.frame.conversation_id

            count = msg_repo.delete_from_message(message_id, conversation_id)
            session.commit()

            return {"deleted": count}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting message {message_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{message_id}/raw")
async def get_message_raw(
    message_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Fetch raw LLM input/output for a message.

    Returns the raw messages array sent to the LLM (raw_input)
    and the full concatenated LLM response (raw_output).
    """
    try:
        with get_session() as session:
            msg_repo = MessageRepository(session)
            conv_repo = ConversationRepository(session)

            message = _verify_message_ownership(msg_repo, conv_repo, message_id, user.id)

            # Parse raw_input from JSON string back to object
            raw_input = None
            if message.raw_input:
                try:
                    raw_input = json.loads(message.raw_input)
                except json.JSONDecodeError:
                    raw_input = message.raw_input

            return {
                "id": message.id,
                "raw_input": raw_input,
                "raw_output": message.raw_output,
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching raw data for message {message_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
