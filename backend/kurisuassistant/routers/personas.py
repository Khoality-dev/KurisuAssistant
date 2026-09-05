"""Persona CRUD, export and import.

A persona is presentation: a name, a prompt, a voice, a face. It owns no model,
no tools, no memory and no wake word — those are the user's single assistant's,
so switching persona changes who answers without changing what the assistant can
do or remember. See ``routers/assistant.py`` for the other half.
"""

import io
import json
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.errors import internal_error
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AssistantRepository, PersonaRepository
from kurisuassistant.db.service import get_db_service
from kurisuassistant.routers.portability import (
    EXPORT_VERSION,
    KIND_PERSONA,
    RESERVED_AGENT_NAMES,
    deduplicate_name,
    export_filename,
    imported_name,
    parse_export,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/personas", tags=["personas"])

# Columns a PATCH may not set to null, because the model or the client contract
# needs a value there. Everything else nullable is clearable by sending null.
_NON_NULLABLE = {"name", "description", "enabled"}


class PersonaCreate(BaseModel):
    """Request body for creating a persona."""
    name: str
    description: str = ""
    system_prompt: str = ""
    preferred_name: Optional[str] = None
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    enabled: bool = True


class PersonaUpdate(BaseModel):
    """Request body for updating a persona.

    Every field is optional and read through ``model_fields_set``: an omitted
    field is left alone, and an explicit ``null`` clears the column. Without that
    distinction there is no way to remove a voice reference or an avatar.
    """
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    preferred_name: Optional[str] = None
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    enabled: Optional[bool] = None


class PersonaResponse(BaseModel):
    """Response body for a persona."""
    id: int
    name: str
    description: str = ""
    system_prompt: str = ""
    preferred_name: Optional[str] = None
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    enabled: bool = True


class PersonaToggleEnabled(BaseModel):
    """Request body for toggling a persona's enabled state."""
    enabled: bool


def _persona_to_response(persona) -> PersonaResponse:
    """Convert a database Persona to a PersonaResponse."""
    return PersonaResponse(
        id=persona.id,
        name=persona.name,
        description=persona.description or "",
        system_prompt=persona.system_prompt or "",
        preferred_name=persona.preferred_name,
        voice_reference=persona.voice_reference,
        avatar_uuid=persona.avatar_uuid,
        character_config=persona.character_config,
        enabled=persona.enabled,
    )


def _reject_reserved(name: Optional[str]) -> None:
    if name is not None and name in RESERVED_AGENT_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{name}' is a reserved name and cannot be used for a persona.",
        )


def _update_fields(body: PersonaUpdate) -> dict:
    """The columns this request actually asked to change."""
    provided = body.model_dump(exclude_unset=True)
    for field, value in provided.items():
        if value is None and field in _NON_NULLABLE:
            raise HTTPException(status_code=400, detail=f"'{field}' cannot be null.")
    return provided


@router.get("")
async def list_personas(
    user: User = Depends(get_authenticated_user),
) -> List[PersonaResponse]:
    """List the user's personas, enabled or not, oldest first."""
    def _list(session):
        return [
            _persona_to_response(p)
            for p in PersonaRepository(session).list_by_user(user.id)
        ]

    db = get_db_service()
    return await db.execute(_list)


@router.post("")
async def create_persona(
    body: PersonaCreate,
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Create a persona.

    The first persona a user creates also becomes their default, so a new
    conversation has someone to bind to.
    """
    _reject_reserved(body.name)

    def _create(session):
        persona_repo = PersonaRepository(session)
        persona = persona_repo.create_persona(
            user_id=user.id,
            name=body.name,
            description=body.description,
            system_prompt=body.system_prompt,
            preferred_name=body.preferred_name,
            voice_reference=body.voice_reference,
            avatar_uuid=body.avatar_uuid,
            character_config=body.character_config,
            enabled=body.enabled,
        )
        _adopt_as_default_if_unset(session, user.id, persona.id)
        return _persona_to_response(persona)

    db = get_db_service()
    try:
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _adopt_as_default_if_unset(session, user_id: int, persona_id: int) -> None:
    """Point the assistant at this persona when it has no default yet.

    A new conversation silently uses ``assistants.default_persona_id`` and there
    is no fallback, so leaving that null after the user has a persona means their
    next chat has nobody to answer it.
    """
    assistant_repo = AssistantRepository(session)
    assistant = assistant_repo.get_or_create_for_user(user_id)
    if assistant.default_persona_id is None:
        assistant_repo.update_assistant(assistant, default_persona_id=persona_id)


@router.get("/{persona_id}")
async def get_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Get one of the user's personas."""
    def _get(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        return _persona_to_response(persona) if persona else None

    db = get_db_service()
    result = await db.execute(_get)
    if result is None:
        raise HTTPException(status_code=404, detail="Persona not found")
    return result


@router.patch("/{persona_id}")
async def update_persona(
    persona_id: int,
    body: PersonaUpdate,
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Update a persona. Omitted fields are untouched; an explicit null clears."""
    _reject_reserved(body.name)
    fields = _update_fields(body)

    def _update(session):
        persona_repo = PersonaRepository(session)
        persona = persona_repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        new_name = fields.get("name")
        if new_name is not None and new_name != persona.name:
            if persona_repo.get_by_user_and_name(user.id, new_name):
                raise HTTPException(
                    status_code=400, detail=f"A persona named '{new_name}' already exists."
                )

        return _persona_to_response(persona_repo.update_persona(persona, **fields))

    db = get_db_service()
    return await db.execute(_update)


@router.delete("/{persona_id}")
async def delete_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Delete a persona.

    The user's last persona cannot be deleted: a new conversation binds to the
    assistant's default persona and has no fallback, so a user with none can no
    longer chat. Deleting the *default* is allowed — the FK clears the pointer and
    the oldest remaining persona takes over, deterministically rather than at random.
    """
    def _delete(session):
        persona_repo = PersonaRepository(session)
        personas = persona_repo.list_by_user(user.id)
        if not any(p.id == persona_id for p in personas):
            raise HTTPException(status_code=404, detail="Persona not found")
        if len(personas) == 1:
            raise HTTPException(
                status_code=400,
                detail="This is your only persona. Create another one before deleting it.",
            )

        assistant_repo = AssistantRepository(session)
        assistant = assistant_repo.get_by_user(user.id)
        was_default = assistant is not None and assistant.default_persona_id == persona_id

        persona_repo.delete_by_user_and_id(user.id, persona_id)

        if was_default:
            replacement = next(p.id for p in personas if p.id != persona_id)
            assistant_repo.update_assistant(assistant, default_persona_id=replacement)
            logger.info(
                "user %d deleted their default persona; default is now %d",
                user.id, replacement,
            )

        return {"message": "Persona deleted successfully"}

    db = get_db_service()
    return await db.execute(_delete)


@router.patch("/{persona_id}/enabled")
async def toggle_persona_enabled(
    persona_id: int,
    body: PersonaToggleEnabled,
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Enable or disable a persona.

    Scoped to the caller: the previous version of this route took an id and no
    user, so any authenticated user could toggle anyone's agent.
    """
    def _toggle(session):
        assistant = AssistantRepository(session).get_by_user(user.id)
        if not body.enabled and assistant and assistant.default_persona_id == persona_id:
            raise HTTPException(
                status_code=400,
                detail="This is your default persona. Make another one the default first.",
            )

        persona = PersonaRepository(session).set_enabled(user.id, persona_id, body.enabled)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")
        return _persona_to_response(persona)

    db = get_db_service()
    return await db.execute(_toggle)


# ─── Export / Import ───


@router.get("/{persona_id}/export")
async def export_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Export a persona as JSON.

    Media is not included. The avatar, the voice clip and every URL inside the
    character config name files that exist only on this server, so shipping the
    references without the files gives the importing install broken art at best
    and, once its asset cleanup runs, deletes the art of whichever persona holds
    the same id at worst.
    """
    def _get(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        if not persona:
            return None
        return {
            "version": EXPORT_VERSION,
            "kind": KIND_PERSONA,
            "name": persona.name,
            "description": persona.description or "",
            "system_prompt": persona.system_prompt or "",
            "preferred_name": persona.preferred_name,
        }

    db = get_db_service()
    meta = await db.execute(_get)
    if meta is None:
        raise HTTPException(status_code=404, detail="Persona not found")

    return StreamingResponse(
        io.BytesIO(json.dumps(meta, ensure_ascii=False, indent=2).encode()),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{export_filename(meta["name"])}"'
        },
    )


@router.post("/import")
async def import_persona(
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Import a persona from a .json file.

    Reads version 3 files and version 2 agent exports, where a ``main`` agent
    becomes a persona and its model, tools and memory are dropped — capability
    belongs to the importing user's own assistant.
    """
    if not (file.filename or "").endswith(".json"):
        raise HTTPException(status_code=400, detail="File must be .json")

    try:
        meta = json.loads(await file.read())
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")

    try:
        fields = parse_export(meta, KIND_PERSONA)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    requested = imported_name(meta, "Imported persona")

    def _create(session):
        persona_repo = PersonaRepository(session)
        taken = [p.name for p in persona_repo.list_by_user(user.id)]
        persona = persona_repo.create_persona(
            user_id=user.id,
            name=deduplicate_name(requested, taken),
            **fields,
        )
        _adopt_as_default_if_unset(session, user.id, persona.id)
        return _persona_to_response(persona)

    db = get_db_service()
    try:
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error importing a persona for user {user.username}")
