"""Persona CRUD, export and import.

A persona is presentation: a name, a prompt, a voice, a face. It owns no model,
no tools, no memory and no wake word — those are the user's single assistant's,
so switching persona changes who answers without changing what the assistant can
do or remember. See ``routers/assistant.py`` for the other half.

An export is the v3 JSON file, or — with ``?character=true`` — a v4 bundle that
carries the character's files as well (#248, ``character/bundle.py``).
"""

import io
import json
import logging
import sys
import uuid
from pathlib import Path
from typing import List, Optional

import anyio
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from kurisuassistant.character import assets, bundle
from kurisuassistant.character.config_write import (
    cleanup_after_write,
    plan_character_config,
    remove_after_delete,
)
from kurisuassistant.character.locks import persona_lock
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.image_access import owns_image
from kurisuassistant.core.errors import internal_error
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AssistantRepository, PersonaRepository
from kurisuassistant.db.service import get_db_service
from kurisuassistant.routers.portability import (
    BUNDLE_VERSION,
    EXPORT_VERSION,
    KIND_PERSONA,
    RESERVED_AGENT_NAMES,
    deduplicate_name,
    export_filename,
    imported_name,
    parse_export,
)
from kurisuassistant.utils.blob_stream import sweep_incoming, write_stream

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



def _reject_unowned_avatar(session, user_id: int, avatar_uuid) -> None:
    """Refuse an avatar UUID the caller does not own.

    Without this the read-side ownership check in ``routers/images.py`` is
    self-serving: ``avatar_uuid`` is a free-form string, so anyone who learned a
    UUID — from a proxy log, a screenshot, a shared browser — could point their
    own persona at it and then legitimately fetch somebody else's avatar or face
    photo. The UUID has to be yours before you can attach it (#154).

    The message does not distinguish "no such image" from "not yours", for the
    same reason the fetch answers 404 rather than 403.
    """
    if avatar_uuid is None:
        return
    if not owns_image(session, user_id, avatar_uuid):
        raise HTTPException(status_code=400, detail="Unknown image.")

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

    It does not become the default: a persona is optional, and the assistant
    keeps answering new conversations as itself until the user chooses one
    (#302).
    """
    _reject_reserved(body.name)

    # A persona that does not exist yet owns no assets, so a config that names
    # any is refused; null and a config referencing no file pass, normalised.
    character_config = plan_character_config(None, body.character_config).config

    def _create(session):
        persona_repo = PersonaRepository(session)
        _reject_unowned_avatar(session, user.id, body.avatar_uuid)
        persona = persona_repo.create_persona(
            user_id=user.id,
            name=body.name,
            description=body.description,
            system_prompt=body.system_prompt,
            preferred_name=body.preferred_name,
            voice_reference=body.voice_reference,
            avatar_uuid=body.avatar_uuid,
            character_config=character_config,
            enabled=body.enabled,
        )
        return _persona_to_response(persona)

    db = get_db_service()
    try:
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _stop_defaulting_to(session, user_id: int, persona_id: int) -> None:
    """Hand new conversations back to the assistant when their default persona is disabled.

    A disabled persona answers nobody, so leaving it as the default would only
    mean the default silently does nothing; clearing it says what happens (#302).
    """
    assistant_repo = AssistantRepository(session)
    assistant = assistant_repo.get_by_user(user_id)
    if assistant is not None and assistant.default_persona_id == persona_id:
        assistant_repo.update_assistant(assistant, default_persona_id=None)
        logger.info("user %d disabled their default persona; the assistant answers new chats", user_id)


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
    """Update a persona. Omitted fields are untouched; an explicit null clears.

    ``character_config`` goes through the same merge, classification and
    cleanup as the character-config route: merged member by member over what
    is stored, refused before the write when it cannot be classified, and the
    files it no longer names are removed after the write.
    """
    _reject_reserved(body.name)
    fields = _update_fields(body)
    planned: dict = {}

    def _update(session):
        persona_repo = PersonaRepository(session)
        persona = persona_repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        if "character_config" in fields:
            plan = plan_character_config(
                persona_id, fields["character_config"], persona.character_config
            )
            fields["character_config"] = plan.config
            planned["referenced"] = plan.referenced

        if "avatar_uuid" in fields:
            _reject_unowned_avatar(session, user.id, fields["avatar_uuid"])

        new_name = fields.get("name")
        if new_name is not None and new_name != persona.name:
            if persona_repo.get_by_user_and_name(user.id, new_name):
                raise HTTPException(
                    status_code=400, detail=f"A persona named '{new_name}' already exists."
                )

        if fields.get("enabled") is False:
            _stop_defaulting_to(session, user.id, persona_id)

        return _persona_to_response(persona_repo.update_persona(persona, **fields))

    db = get_db_service()
    # Held from the commit through the sweep, so an upload's ref cannot land
    # between them and have its file swept (``character/locks.py``).
    async with persona_lock(persona_id):
        result = await db.execute(_update)
        if "referenced" in planned:
            await cleanup_after_write(persona_id, planned["referenced"])
    return result


@router.delete("/{persona_id}")
async def delete_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Delete a persona, then its character assets.

    Any persona can go, the last one included: the assistant answers without
    one (#302). Deleting the default clears the pointer (the FK is ``SET NULL``),
    so new conversations go back to the assistant rather than to whichever
    persona happens to be next; conversations bound to it go to the assistant too.

    The row goes first and the directory under ``data/character_assets/`` after,
    so a disk failure can strand files for the operator's sweep but never a live
    persona without its assets. Until #234 nothing removed the directory at all.
    """
    def _delete(session):
        persona_repo = PersonaRepository(session)
        personas = persona_repo.list_by_user(user.id)
        if not any(p.id == persona_id for p in personas):
            raise HTTPException(status_code=404, detail="Persona not found")

        persona_repo.delete_by_user_and_id(user.id, persona_id)
        return {"message": "Persona deleted successfully"}

    db = get_db_service()
    async with persona_lock(persona_id):
        result = await db.execute(_delete)
        await remove_after_delete(persona_id)
    return result


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
        persona = PersonaRepository(session).set_enabled(user.id, persona_id, body.enabled)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")
        if not body.enabled:
            _stop_defaulting_to(session, user.id, persona_id)
        return _persona_to_response(persona)

    db = get_db_service()
    return await db.execute(_toggle)


# ─── Export / Import ───


async def _export_source(user_id: int, persona_id: int) -> tuple[dict, Optional[dict]]:
    """The v3 fields of a persona and its stored ``character_config``; 404 when not the caller's."""
    def _get(session):
        persona = PersonaRepository(session).get_by_user_and_id(user_id, persona_id)
        if not persona:
            return None
        meta = {
            "version": EXPORT_VERSION,
            "kind": KIND_PERSONA,
            "name": persona.name,
            "description": persona.description or "",
            "system_prompt": persona.system_prompt or "",
            "preferred_name": persona.preferred_name,
        }
        return meta, persona.character_config

    found = await get_db_service().execute(_get)
    if found is None:
        raise HTTPException(status_code=404, detail="Persona not found")
    return found


@router.get("/{persona_id}/export/size")
async def export_persona_size(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
):
    """How big the character is that ``?character=true`` would carry, before anyone downloads it.

    ``{"character": null}`` for a persona with none. ``bytes`` is every file the
    bundle would hold; ``vrm_bytes`` is the part an import meters against the
    account's quota (the model and its clips — pose art is not metered).
    """
    _meta, config = await _export_source(user.id, persona_id)
    character = await anyio.to_thread.run_sync(bundle.character_files, persona_id, config)
    if character is None:
        return {"character": None}
    return {"character": {
        "kind": character.kind,
        "files": len(character.files),
        "bytes": character.bytes,
        "vrm_bytes": character.vrm_bytes,
    }}


@router.get("/{persona_id}/export")
async def export_persona(
    persona_id: int,
    character: bool = Query(False),
    user: User = Depends(get_authenticated_user),
):
    """Export a persona: the v3 JSON file, or with ``?character=true`` a v4 bundle.

    The JSON file carries no media. The avatar, the voice clip and every URL
    inside the character config name files that exist only on this server, so
    shipping the references without the files gives the importing install
    broken art at best.

    The bundle (``application/zip``) carries the character too: ``persona.json``
    with the config written against a ``{persona_id}`` placeholder and a list
    of its files, and the files under ``character/`` (#248). Avatar and voice
    still stay behind. It is written under the persona's lock, so an upload or
    a sweep cannot change the files halfway through the copy.
    """
    meta, config = await _export_source(user.id, persona_id)
    if not character:
        return StreamingResponse(
            io.BytesIO(json.dumps(meta, ensure_ascii=False, indent=2).encode()),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="{export_filename(meta["name"])}"'
            },
        )

    async with persona_lock(persona_id):
        # Read again under the lock: the config is what decides which files go.
        meta, config = await _export_source(user.id, persona_id)
        files = await anyio.to_thread.run_sync(bundle.character_files, persona_id, config)
        path = await anyio.to_thread.run_sync(bundle.write_bundle, meta, persona_id, config, files)
    return FileResponse(
        path,
        media_type=bundle.MEDIA_TYPE,
        filename=export_filename(meta["name"], ".zip"),
        background=BackgroundTask(lambda: Path(path).unlink(missing_ok=True)),
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

    if isinstance(meta, dict) and meta.get("version") == BUNDLE_VERSION:
        raise HTTPException(
            status_code=400,
            detail="This persona was exported with its character. Import the .zip it came in.",
        )

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


@router.post("/import/bundle")
async def import_persona_bundle(
    request: Request,
    user: User = Depends(get_authenticated_user),
) -> PersonaResponse:
    """Import a persona from a v4 bundle (``application/zip``), streamed as the raw body.

    Everything in the bundle is checked before a persona exists — each file
    against its listed size and digest and the ceiling for its kind, the model
    and clips as an upload would check them (their refs rebuilt from the bytes),
    the config through the same write path as a save — and the model and clips
    are metered against the account's quota in the transaction that creates the
    persona. Only then are the files moved into its directory. A refusal creates
    nothing and leaves nothing on disk. See ``character/bundle.py``.

    Errors: ``400`` not a bundle, a manifest or file that does not hold up, or a
    sub-agent file; ``413`` a file over its kind's ceiling (a bundle has no
    ceiling of its own); ``415`` a model or clip that is not one; ``422`` a config the
    write path refuses (including a URL naming another persona); ``507`` over
    the 3D character quota.
    """
    incoming = bundle.incoming_dir()
    token = uuid.uuid4().hex
    archive_path = incoming / f"{token}.zip"

    def _discard():
        for leftover in incoming.glob(f"{token}*"):
            leftover.unlink(missing_ok=True)

    try:
        await anyio.to_thread.run_sync(lambda: incoming.mkdir(parents=True, exist_ok=True))
        await anyio.to_thread.run_sync(sweep_incoming, incoming)
        # No ceiling on the bundle itself (#248): each file's own ceiling and
        # the account's quota are checked once the manifest is read.
        await write_stream(
            archive_path,
            request.stream(),
            sys.maxsize,
            sys.maxsize,
            too_large=lambda: RuntimeError("unreachable: a bundle has no size ceiling"),
            over_quota=lambda: RuntimeError("unreachable: a bundle has no size ceiling"),
        )

        def _check():
            archive, meta = bundle.open_bundle(archive_path)
            with archive:
                try:
                    fields = parse_export(meta, KIND_PERSONA)
                except ValueError as e:
                    raise HTTPException(status_code=400, detail=str(e))
                character = meta.get("character") if meta.get("version") == BUNDLE_VERSION else None
                staged = bundle.stage_character(archive, character, incoming / token)
            return meta, fields, staged

        meta, fields, staged = await anyio.to_thread.run_sync(_check)
        requested = imported_name(meta, "Imported persona")

        def _create(session):
            repo = PersonaRepository(session)
            taken = [p.name for p in repo.list_by_user(user.id)]
            persona = repo.create_persona(user_id=user.id, name=deduplicate_name(requested, taken), **fields)
            referenced: set = set()
            if staged is not None:
                planned = plan_character_config(
                    persona.id,
                    bundle.for_persona(staged.config, persona.id),
                    stored=bundle.for_persona(staged.stored, persona.id),
                )
                # The new persona is in the list with no config yet, so this is
                # everyone else's usage; the same single-thread measure the
                # upload routes make, so a concurrent upload cannot overshoot it.
                used, _per = assets.account_usage(repo.list_by_user(user.id))
                if used + assets.persona_bytes(planned.config) > assets.QUOTA_BYTES:
                    raise assets.over_quota(used, assets.QUOTA_BYTES)
                repo.update_persona(persona, character_config=planned.config)
                referenced = planned.referenced
            return _persona_to_response(persona), referenced

        try:
            response, referenced = await get_db_service().execute(_create)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        if staged is not None:
            async with persona_lock(response.id):
                try:
                    await anyio.to_thread.run_sync(bundle.place, response.id, staged.staged, referenced)
                except Exception as e:  # noqa: BLE001 — undo the persona rather than leave it without its files
                    await _undo_import(user.id, response.id)
                    raise internal_error(e, f"Error placing an imported persona's files for user {user.username}")
        return response
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error importing a persona bundle for user {user.username}")
    finally:
        await anyio.to_thread.run_sync(_discard)


async def _undo_import(user_id: int, persona_id: int) -> None:
    """Remove a persona whose import failed after its row was committed. Holds its lock already."""
    def _delete(session):
        PersonaRepository(session).delete_by_user_and_id(user_id, persona_id)

    try:
        await get_db_service().execute(_delete)
    finally:
        await remove_after_delete(persona_id)
