"""Conversation management routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import (
    ConversationRepository,
    MessageRepository,
    PersonaRepository,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationUpdate(BaseModel):
    """Request body for PATCH /conversations/{id}.

    Both fields are optional and read through ``model_fields_set``. Sending
    ``persona_id: null`` unbinds the conversation, so the next message falls back
    to the assistant's default persona.
    """
    title: Optional[str] = None
    persona_id: Optional[int] = None


@router.get("")
async def list_conversations(
    limit: int = 50,
    persona_id: Optional[int] = Query(
        None,
        description="Filter by persona (returns the latest conversation bound to it)",
    ),
    user: User = Depends(get_authenticated_user)
):
    """List user's conversations. If persona_id is provided, returns the latest
    conversation bound to that persona.
    """
    try:
        def _list(session):
            conv_repo = ConversationRepository(session)
            if persona_id is not None:
                conversation = conv_repo.get_latest_by_persona(user.id, persona_id)
                if conversation:
                    return [{
                        "id": conversation.id,
                        "title": conversation.title or "New conversation",
                        "persona_id": conversation.persona_id,
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
        raise internal_error(e, f"Error listing conversations for user {user.username}")


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: int,
    limit: int = 20,
    offset: int = 0,
    user: User = Depends(get_authenticated_user)
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
                if msg.persona_id:
                    message_dict["persona_id"] = msg.persona_id
                    if msg.persona:
                        message_dict["persona"] = {
                            "id": msg.persona.id,
                            "name": msg.persona.name,
                            "avatar_uuid": msg.persona.avatar_uuid,
                            "voice_reference": msg.persona.voice_reference,
                        }
                messages_array.append(message_dict)

            from kurisuassistant.utils.prompts import build_system_messages
            sys_msgs = build_system_messages(user.system_prompt or "", user.preferred_name)
            sys_words = sum(len(m.get("content", "").split()) for m in sys_msgs)
            system_prompt_token_count = int(sys_words * 1.3)

            return {
                "id": conversation.id,
                "messages": messages_array,
                "persona_id": conversation.persona_id,
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
        raise internal_error(e, f"Error fetching conversation {conversation_id} for user {user.username}")


@router.patch("/{conversation_id}")
async def update_conversation(
    conversation_id: int,
    body: ConversationUpdate,
    user: User = Depends(get_authenticated_user)
):
    """Update a conversation's title, its bound persona, or both.

    Replaces the old ``POST /conversations/{id}``, which only ever renamed. The
    persona half is what the chat header's "this conversation only" switch calls:
    the binding is written here rather than held in client state, so it survives a
    reconnect and applies even if the user switches and then sends nothing.
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")

    if "title" in fields and not (fields["title"] or "").strip():
        raise HTTPException(status_code=400, detail="Title cannot be empty")

    try:
        def _update(session):
            conv_repo = ConversationRepository(session)
            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if not conversation:
                raise HTTPException(status_code=404, detail="Conversation not found")

            if fields.get("persona_id") is not None:
                persona = PersonaRepository(session).get_by_user_and_id(
                    user.id, fields["persona_id"]
                )
                if not persona:
                    raise HTTPException(status_code=404, detail="Persona not found")
                if not persona.enabled:
                    raise HTTPException(
                        status_code=400,
                        detail="That persona is disabled. Enable it before using it here.",
                    )

            conv_repo.update(conversation, **fields)
            return {
                "id": conversation.id,
                "title": conversation.title or "",
                "persona_id": conversation.persona_id,
            }

        db = get_db_service()
        return await db.execute(_update)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error updating conversation {conversation_id} for user {user.username}")


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: int,
    user: User = Depends(get_authenticated_user)
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
        raise internal_error(e, f"Error deleting conversation {conversation_id} for user {user.username}")
