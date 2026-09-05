"""The user's single assistant: what it can do, and who answers by default.

There is exactly one assistant per user, so it is addressed with no id and has no
POST and no DELETE — it is created at registration and dies with the account. It
owns the capability half of the old agent (model, provider, tools, reasoning,
memory) plus two things that are deliberately not per-persona:

* ``trigger_word`` is a voice wake word. Saying it wakes the assistant; the
  conversation's bound persona answers. It never selects a persona.
* ``default_persona_id`` is who answers in a conversation that has not been bound
  to someone else. A new conversation uses it silently — there is no picker on
  new-chat and no fallback if it is unset.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AssistantRepository, PersonaRepository
from kurisuassistant.db.service import get_db_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/assistant", tags=["assistant"])

# Columns a PATCH may not set to null. ``available_tools``, ``model_name``,
# ``memory``, ``trigger_word`` and ``default_persona_id`` are all clearable, and
# clearing available_tools is the only way to say "every tool".
_NON_NULLABLE = {"provider_type", "think", "use_deferred_tools", "memory_enabled"}


class AssistantResponse(BaseModel):
    """Response body for the assistant."""
    id: int
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None
    think: bool = False
    use_deferred_tools: bool = False
    memory: Optional[str] = None
    memory_enabled: bool = True
    trigger_word: Optional[str] = None
    default_persona_id: Optional[int] = None


class AssistantUpdate(BaseModel):
    """Request body for updating the assistant.

    Read through ``model_fields_set``: an omitted field is left alone and an
    explicit ``null`` writes NULL. ``available_tools`` needs that distinction —
    null means "every tool", so without it the user can never undo a restriction.
    """
    model_name: Optional[str] = None
    provider_type: Optional[str] = None
    available_tools: Optional[List[str]] = None
    think: Optional[bool] = None
    use_deferred_tools: Optional[bool] = None
    memory: Optional[str] = None
    memory_enabled: Optional[bool] = None
    trigger_word: Optional[str] = None
    default_persona_id: Optional[int] = None


def _assistant_to_response(assistant) -> AssistantResponse:
    """Convert a database Assistant to an AssistantResponse."""
    return AssistantResponse(
        id=assistant.id,
        model_name=assistant.model_name,
        provider_type=assistant.provider_type or "ollama",
        available_tools=assistant.available_tools,
        think=assistant.think,
        use_deferred_tools=assistant.use_deferred_tools,
        memory=assistant.memory,
        memory_enabled=assistant.memory_enabled,
        trigger_word=assistant.trigger_word,
        default_persona_id=assistant.default_persona_id,
    )


@router.get("")
async def get_assistant(
    user: User = Depends(get_authenticated_user),
) -> AssistantResponse:
    """Get the user's assistant.

    Created on demand for an account that predates the split and never got a row:
    without one the user cannot chat at all, and there is nothing to ask them.
    """
    def _get(session):
        return _assistant_to_response(
            AssistantRepository(session).get_or_create_for_user(user.id)
        )

    db = get_db_service()
    return await db.execute(_get)


@router.patch("")
async def update_assistant(
    body: AssistantUpdate,
    user: User = Depends(get_authenticated_user),
) -> AssistantResponse:
    """Update the assistant. Omitted fields are untouched; an explicit null clears."""
    fields = body.model_dump(exclude_unset=True)
    for field, value in fields.items():
        if value is None and field in _NON_NULLABLE:
            raise HTTPException(status_code=400, detail=f"'{field}' cannot be null.")

    def _update(session):
        assistant_repo = AssistantRepository(session)
        assistant = assistant_repo.get_or_create_for_user(user.id)

        default_persona_id = fields.get("default_persona_id")
        if default_persona_id is not None:
            persona = PersonaRepository(session).get_by_user_and_id(
                user.id, default_persona_id
            )
            if not persona:
                raise HTTPException(status_code=404, detail="Persona not found")
            if not persona.enabled:
                raise HTTPException(
                    status_code=400,
                    detail="A disabled persona cannot be the default. Enable it first.",
                )

        return _assistant_to_response(assistant_repo.update_assistant(assistant, **fields))

    db = get_db_service()
    return await db.execute(_update)
