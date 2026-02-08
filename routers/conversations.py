"""Conversation management routes."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import ConversationRepository, MessageRepository, FrameRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
async def list_conversations(
    limit: int = 50,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List user's conversations."""
    try:
        with get_session() as session:
            conv_repo = ConversationRepository(session)
            return conv_repo.list_by_user(user.id, limit)
    except Exception as e:
        logger.error(f"Error listing conversations for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: int,
    limit: int = 20,
    offset: int = 0,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Get conversation details with messages."""
    try:
        with get_session() as session:
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            total_messages = msg_repo.count_by_conversation(conversation_id)
            messages = msg_repo.get_by_conversation(conversation_id, limit, offset)

            messages_array = []
            for msg in messages:
                message_dict = {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.message,
                    "frame_id": msg.frame_id,
                    "created_at": msg.created_at.isoformat(),
                    "has_raw_data": bool(msg.raw_input or msg.raw_output),
                }
                if msg.name:
                    message_dict["name"] = msg.name
                if msg.thinking:
                    message_dict["thinking"] = msg.thinking
                if msg.agent_id:
                    message_dict["agent_id"] = msg.agent_id
                    # Include agent info if available (eager loaded)
                    if msg.agent:
                        message_dict["agent"] = {
                            "id": msg.agent.id,
                            "name": msg.agent.name,
                            "avatar_uuid": msg.agent.avatar_uuid,
                            "voice_reference": msg.agent.voice_reference,
                        }
                messages_array.append(message_dict)

            return {
                "id": conversation.id,
                "messages": messages_array,
                "created_at": conversation.created_at.isoformat(),
                "title": conversation.title or "",
                "total_messages": total_messages,
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(messages_array) < total_messages,
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{conversation_id}")
async def update_conversation(
    conversation_id: int,
    request: Request,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Update conversation title."""
    try:
        payload = await request.json()
        title = payload.get("title")

        if not title:
            raise HTTPException(status_code=400, detail="Title is required")

        with get_session() as session:
            conv_repo = ConversationRepository(session)
            conv_repo.update_title(user.id, title, conversation_id)

        return {"message": "Conversation title updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Delete conversation and all its messages."""
    try:
        with get_session() as session:
            conv_repo = ConversationRepository(session)
            result = conv_repo.delete_by_user_and_id(user.id, conversation_id)

        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}/frames")
async def list_frames(
    conversation_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List all frames in a conversation with metadata."""
    try:
        with get_session() as session:
            conv_repo = ConversationRepository(session)
            frame_repo = FrameRepository(session)

            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            frames = frame_repo.list_by_conversation(conversation_id)
            return {"frames": frames}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing frames for conversation {conversation_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
