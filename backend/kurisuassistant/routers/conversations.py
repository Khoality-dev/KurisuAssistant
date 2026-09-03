"""Conversation management routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import ConversationRepository, MessageRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("")
async def list_conversations(
    limit: int = 50,
    agent_id: Optional[int] = Query(
        None,
        description="Filter by main_agent_id (returns latest conversation with this main agent)",
    ),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """List user's conversations. If agent_id is provided, returns the latest
    conversation whose ``main_agent_id`` matches.
    """
    try:
        def _list(session):
            conv_repo = ConversationRepository(session)
            if agent_id is not None:
                conversation = conv_repo.get_latest_by_agent(user.id, agent_id)
                if conversation:
                    return [{
                        "id": conversation.id,
                        "title": conversation.title or "New conversation",
                        "main_agent_id": conversation.main_agent_id,
                        "created_at": conversation.created_at.isoformat() + "Z",
                        "updated_at": (
                            conversation.updated_at.isoformat() + "Z"
                            if conversation.updated_at
                            else conversation.created_at.isoformat() + "Z"
                        ),
                    }]
                return []
            return conv_repo.list_by_user(user.id, limit)

        db = get_db_service()
        return await db.execute(_list)
    except Exception as e:
        logger.error(f"Error listing conversations for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: int,
    limit: int = 20,
    offset: int = 0,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Get conversation details with messages."""
    try:
        def _get(session):
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
                    "created_at": msg.created_at.isoformat() + "Z",
                    "has_raw_data": bool(msg.raw_input or msg.raw_output),
                }
                if msg.name:
                    message_dict["name"] = msg.name
                if msg.images:
                    message_dict["images"] = msg.images
                if msg.thinking:
                    message_dict["thinking"] = msg.thinking
                if getattr(msg, 'model_name', None):
                    message_dict["model_name"] = msg.model_name
                if getattr(msg, 'provider_type', None):
                    message_dict["provider_type"] = msg.provider_type
                if getattr(msg, 'tool_args', None):
                    message_dict["tool_args"] = msg.tool_args
                if getattr(msg, 'tool_status', None):
                    message_dict["tool_status"] = msg.tool_status
                if getattr(msg, 'context_files', None):
                    message_dict["context_files"] = msg.context_files
                if msg.agent_id:
                    message_dict["agent_id"] = msg.agent_id
                    if msg.agent:
                        message_dict["agent"] = {
                            "id": msg.agent.id,
                            "name": msg.agent.name,
                            "avatar_uuid": msg.agent.avatar_uuid,
                            "voice_reference": msg.agent.voice_reference,
                        }
                messages_array.append(message_dict)

            from kurisuassistant.utils.prompts import build_system_messages
            sys_msgs = build_system_messages(user.system_prompt or "", user.preferred_name)
            sys_words = sum(len(m.get("content", "").split()) for m in sys_msgs)
            system_prompt_token_count = int(sys_words * 1.3)

            return {
                "id": conversation.id,
                "messages": messages_array,
                "main_agent_id": conversation.main_agent_id,
                "created_at": conversation.created_at.isoformat() + "Z",
                "title": conversation.title or "",
                "total_messages": total_messages,
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(messages_array) < total_messages,
                "compacted_up_to_id": conversation.compacted_up_to_id or 0,
                "compacted_context": conversation.compacted_context or "",
                "system_prompt_token_count": system_prompt_token_count,
            }

        db = get_db_service()
        return await db.execute(_get)

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
    db: Session = Depends(get_db),
):
    """Update conversation title."""
    try:
        payload = await request.json()
        title = payload.get("title")

        if not title:
            raise HTTPException(status_code=400, detail="Title is required")

        db = get_db_service()
        await db.execute(
            lambda s: ConversationRepository(s).update_title(user.id, title, conversation_id)
        )

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
    db: Session = Depends(get_db),
):
    """Delete conversation and all its messages."""
    try:
        db = get_db_service()
        result = await db.execute(
            lambda s: ConversationRepository(s).delete_by_user_and_id(user.id, conversation_id)
        )

        if result:
            return {"message": "Conversation deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Conversation not found")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting conversation {conversation_id} for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


