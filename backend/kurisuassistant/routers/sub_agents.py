"""Sub-agent CRUD, export and import.

A sub-agent is a task-only worker the assistant delegates to mid-answer. It runs
its own LLM loop, so it carries its own model, tools and reasoning flags — but it
has no identity: no avatar, no voice, no memory, never bound to a conversation and
never shown as the speaker.

This router lives at ``/sub-agents``. The old ``/agents`` prefix is gone rather
than aliased: a stale client posting ``{"agent_type": "main"}`` there would
otherwise silently create a sub-agent instead of the persona it meant, and never
find out. A 404 is the honest answer.
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
from kurisuassistant.db.repositories import SubAgentRepository
from kurisuassistant.db.service import get_db_service
from kurisuassistant.routers.portability import (
    EXPORT_VERSION,
    KIND_SUB_AGENT,
    RESERVED_AGENT_NAMES,
    deduplicate_name,
    export_filename,
    imported_name,
    parse_export,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sub-agents", tags=["sub-agents"])

# ``model_name`` and ``available_tools`` are clearable: null model means the
# assistant's model, null tools means every tool.
_NON_NULLABLE = {"name", "description", "provider_type", "think",
                 "use_deferred_tools", "enabled"}


class SubAgentCreate(BaseModel):
    """Request body for creating a sub-agent."""
    name: str
    description: str = ""
    system_prompt: str = ""
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None
    think: bool = False
    use_deferred_tools: bool = False
    enabled: bool = True


class SubAgentUpdate(BaseModel):
    """Request body for updating a sub-agent.

    Read through ``model_fields_set``: an omitted field is left alone and an
    explicit ``null`` writes NULL, which is how ``available_tools`` goes back to
    meaning "every tool".
    """
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    model_name: Optional[str] = None
    provider_type: Optional[str] = None
    available_tools: Optional[List[str]] = None
    think: Optional[bool] = None
    use_deferred_tools: Optional[bool] = None
    enabled: Optional[bool] = None


class SubAgentResponse(BaseModel):
    """Response body for a sub-agent."""
    id: int
    name: str
    description: str = ""
    system_prompt: str = ""
    model_name: Optional[str] = None
    provider_type: str = "ollama"
    available_tools: Optional[List[str]] = None
    think: bool = False
    use_deferred_tools: bool = False
    enabled: bool = True


class SubAgentToggleEnabled(BaseModel):
    """Request body for toggling a sub-agent's enabled state."""
    enabled: bool


def _sub_agent_to_response(sub_agent) -> SubAgentResponse:
    """Convert a database SubAgent to a SubAgentResponse."""
    return SubAgentResponse(
        id=sub_agent.id,
        name=sub_agent.name,
        description=sub_agent.description or "",
        system_prompt=sub_agent.system_prompt or "",
        model_name=sub_agent.model_name,
        provider_type=sub_agent.provider_type or "ollama",
        available_tools=sub_agent.available_tools,
        think=sub_agent.think,
        use_deferred_tools=sub_agent.use_deferred_tools,
        enabled=sub_agent.enabled,
    )


def _reject_reserved(name: Optional[str]) -> None:
    if name is not None and name in RESERVED_AGENT_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{name}' is a reserved name and cannot be used for a sub-agent.",
        )


def _update_fields(body: SubAgentUpdate) -> dict:
    """The columns this request actually asked to change."""
    provided = body.model_dump(exclude_unset=True)
    for field, value in provided.items():
        if value is None and field in _NON_NULLABLE:
            raise HTTPException(status_code=400, detail=f"'{field}' cannot be null.")
    return provided


@router.get("")
async def list_sub_agents(
    user: User = Depends(get_authenticated_user),
) -> List[SubAgentResponse]:
    """List the user's sub-agents, enabled or not, oldest first."""
    def _list(session):
        return [
            _sub_agent_to_response(s)
            for s in SubAgentRepository(session).list_by_user(user.id)
        ]

    db = get_db_service()
    return await db.execute(_list)


@router.post("")
async def create_sub_agent(
    body: SubAgentCreate,
    user: User = Depends(get_authenticated_user),
) -> SubAgentResponse:
    """Create a sub-agent."""
    _reject_reserved(body.name)

    def _create(session):
        return _sub_agent_to_response(
            SubAgentRepository(session).create_sub_agent(
                user_id=user.id,
                name=body.name,
                description=body.description,
                system_prompt=body.system_prompt,
                model_name=body.model_name,
                provider_type=body.provider_type,
                available_tools=body.available_tools,
                think=body.think,
                use_deferred_tools=body.use_deferred_tools,
                enabled=body.enabled,
            )
        )

    db = get_db_service()
    try:
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{sub_agent_id}")
async def get_sub_agent(
    sub_agent_id: int,
    user: User = Depends(get_authenticated_user),
) -> SubAgentResponse:
    """Get one of the user's sub-agents."""
    def _get(session):
        sub_agent = SubAgentRepository(session).get_by_user_and_id(user.id, sub_agent_id)
        return _sub_agent_to_response(sub_agent) if sub_agent else None

    db = get_db_service()
    result = await db.execute(_get)
    if result is None:
        raise HTTPException(status_code=404, detail="Sub-agent not found")
    return result


@router.patch("/{sub_agent_id}")
async def update_sub_agent(
    sub_agent_id: int,
    body: SubAgentUpdate,
    user: User = Depends(get_authenticated_user),
) -> SubAgentResponse:
    """Update a sub-agent. Omitted fields are untouched; an explicit null clears."""
    _reject_reserved(body.name)
    fields = _update_fields(body)

    def _update(session):
        sub_agent_repo = SubAgentRepository(session)
        sub_agent = sub_agent_repo.get_by_user_and_id(user.id, sub_agent_id)
        if not sub_agent:
            raise HTTPException(status_code=404, detail="Sub-agent not found")

        new_name = fields.get("name")
        if new_name is not None and new_name != sub_agent.name:
            if sub_agent_repo.get_by_user_and_name(user.id, new_name):
                raise HTTPException(
                    status_code=400,
                    detail=f"A sub-agent named '{new_name}' already exists.",
                )

        return _sub_agent_to_response(sub_agent_repo.update_sub_agent(sub_agent, **fields))

    db = get_db_service()
    return await db.execute(_update)


@router.delete("/{sub_agent_id}")
async def delete_sub_agent(
    sub_agent_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Delete a sub-agent. Nothing references one, so there is nothing to repair."""
    def _delete(session):
        deleted = SubAgentRepository(session).delete_by_user_and_id(user.id, sub_agent_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Sub-agent not found")
        return {"message": "Sub-agent deleted successfully"}

    db = get_db_service()
    return await db.execute(_delete)


@router.patch("/{sub_agent_id}/enabled")
async def toggle_sub_agent_enabled(
    sub_agent_id: int,
    body: SubAgentToggleEnabled,
    user: User = Depends(get_authenticated_user),
) -> SubAgentResponse:
    """Enable or disable a sub-agent, scoped to the caller."""
    def _toggle(session):
        sub_agent = SubAgentRepository(session).set_enabled(
            user.id, sub_agent_id, body.enabled
        )
        if not sub_agent:
            raise HTTPException(status_code=404, detail="Sub-agent not found")
        return _sub_agent_to_response(sub_agent)

    db = get_db_service()
    return await db.execute(_toggle)


# ─── Export / Import ───


@router.get("/{sub_agent_id}/export")
async def export_sub_agent(
    sub_agent_id: int,
    user: User = Depends(get_authenticated_user),
):
    """Export a sub-agent as JSON.

    Everything a sub-agent has travels, ``use_deferred_tools`` included — the v2
    exporter omitted it, so an import could never restore it.
    """
    def _get(session):
        sub_agent = SubAgentRepository(session).get_by_user_and_id(user.id, sub_agent_id)
        if not sub_agent:
            return None
        return {
            "version": EXPORT_VERSION,
            "kind": KIND_SUB_AGENT,
            "name": sub_agent.name,
            "description": sub_agent.description or "",
            "system_prompt": sub_agent.system_prompt or "",
            "model_name": sub_agent.model_name,
            "provider_type": sub_agent.provider_type or "ollama",
            "available_tools": sub_agent.available_tools,
            "think": sub_agent.think,
            "use_deferred_tools": sub_agent.use_deferred_tools,
        }

    db = get_db_service()
    meta = await db.execute(_get)
    if meta is None:
        raise HTTPException(status_code=404, detail="Sub-agent not found")

    return StreamingResponse(
        io.BytesIO(json.dumps(meta, ensure_ascii=False, indent=2).encode()),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{export_filename(meta["name"])}"'
        },
    )


@router.post("/import")
async def import_sub_agent(
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
) -> SubAgentResponse:
    """Import a sub-agent from a .json file.

    Reads version 3 files and version 2 agent exports whose ``agent_type`` is
    ``sub``. A version 2 main agent is a persona and is refused here rather than
    quietly turned into a worker.
    """
    if not (file.filename or "").endswith(".json"):
        raise HTTPException(status_code=400, detail="File must be .json")

    try:
        meta = json.loads(await file.read())
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")

    try:
        fields = parse_export(meta, KIND_SUB_AGENT)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    requested = imported_name(meta, "Imported sub-agent")

    def _create(session):
        sub_agent_repo = SubAgentRepository(session)
        taken = [s.name for s in sub_agent_repo.list_by_user(user.id)]
        return _sub_agent_to_response(
            sub_agent_repo.create_sub_agent(
                user_id=user.id,
                name=deduplicate_name(requested, taken),
                **fields,
            )
        )

    db = get_db_service()
    try:
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error(e, f"Error importing a sub-agent for user {user.username}")
