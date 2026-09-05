"""Message routes.

Every route here was dead. Ownership was checked through ``message.frame``, an
attribute the ``Message`` model lost when migration 0caebafdf4cc removed the
``frames`` table and hung messages straight off the conversation — so each handler
raised ``AttributeError`` and answered 500. The desktop client's raw-data viewer and
the Android client's delete-message action both still call these, which is why they
are repaired rather than removed: the conversation id they need has been a column on
the message all along.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import MessageRepository, ConversationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/messages", tags=["messages"])


def _verify_message_ownership(msg_repo, conv_repo, message_id: int, user_id: int):
    """Return the message if the caller owns its conversation, else raise 404.

    A message the caller does not own is reported as missing rather than
    forbidden: message ids are sequential, and a 403 would confirm which ones
    exist.
    """
    message = msg_repo.get_by_id(message_id)
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")

    conversation = conv_repo.get_by_user_and_id(user_id, message.conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Message not found")

    return message


@router.get("/{message_id}")
async def get_message(
    message_id: int,
    user: User = Depends(get_authenticated_user)
):
    """Fetch a specific message by its ID."""
    try:
        def _get(session):
            msg_repo = MessageRepository(session)
            conv_repo = ConversationRepository(session)
            message = _verify_message_ownership(msg_repo, conv_repo, message_id, user.id)
            result = {
                "id": message.id,
                "role": message.role,
                "content": message.message,
                "conversation_id": message.conversation_id,
                "created_at": message.created_at.isoformat() + "Z",
                "has_raw_data": bool(message.raw_input or message.raw_output),
            }
            if message.images:
                result["images"] = message.images
            if message.thinking:
                result["thinking"] = message.thinking
            if message.persona_id:
                result["persona_id"] = message.persona_id
            return result

        db = get_db_service()
        return await db.execute(_get)

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error fetching message {message_id} for user {user.username}")


@router.delete("/{message_id}")
async def delete_message(
    message_id: int,
    user: User = Depends(get_authenticated_user)
):
    """Delete a message and all subsequent messages in the conversation."""
    try:
        def _delete(session):
            msg_repo = MessageRepository(session)
            conv_repo = ConversationRepository(session)
            message = _verify_message_ownership(msg_repo, conv_repo, message_id, user.id)
            conversation_id = message.conversation_id

            # Compacted messages are already folded into the conversation summary,
            # so deleting one leaves the summary asserting something with no source.
            conversation = conv_repo.get_by_user_and_id(user.id, conversation_id)
            if conversation.compacted_up_to_id and message_id <= conversation.compacted_up_to_id:
                raise HTTPException(status_code=400, detail="Cannot delete compacted messages")

            return msg_repo.delete_from_message(message_id, conversation_id)

        db = get_db_service()
        count = await db.execute(_delete)
        return {"deleted": count}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error deleting message {message_id}")


@router.get("/{message_id}/raw")
async def get_message_raw(
    message_id: int,
    user: User = Depends(get_authenticated_user)
):
    """Fetch raw LLM input/output for a message.

    Returns the raw messages array sent to the LLM (raw_input)
    and the full concatenated LLM response (raw_output).
    """
    try:
        def _get_raw(session):
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

            result = {
                "id": message.id,
                "raw_input": raw_input,
                "raw_output": message.raw_output,
            }
            if message.name:
                result["name"] = message.name
            if getattr(message, 'tool_args', None):
                result["tool_args"] = message.tool_args
            return result

        db = get_db_service()
        return await db.execute(_get_raw)

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error fetching raw data for message {message_id}")
