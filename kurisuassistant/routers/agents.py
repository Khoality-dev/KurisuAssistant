"""Agent CRUD routes."""

import json
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AgentRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


# Reserved names that users cannot use for their agents
RESERVED_AGENT_NAMES = {"Administrator", "User", "App Guide"}



class AgentCreate(BaseModel):
    """Request body for creating an agent."""
    name: str
    description: str = ""
    system_prompt: str = ""
    model_name: str  # Required - LLM model for this agent
    provider_type: str = "ollama"  # "ollama" or "gemini"
    available_tools: Optional[List[str]] = None
    think: bool = False
    use_deferred_tools: bool = False
    agent_type: str = "main"  # "main" or "sub"
    # Personality fields (merged from Persona)
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    preferred_name: Optional[str] = None


class AgentUpdate(BaseModel):
    """Request body for updating an agent."""
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None
    model_name: Optional[str] = None
    provider_type: Optional[str] = None
    available_tools: Optional[List[str]] = None
    think: Optional[bool] = None
    memory: Optional[str] = None
    memory_enabled: Optional[bool] = None
    use_deferred_tools: Optional[bool] = None
    agent_type: Optional[str] = None
    # Personality fields (merged from Persona)
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    preferred_name: Optional[str] = None


class AgentResponse(BaseModel):
    """Response body for agent."""
    id: int
    name: str
    description: str = ""
    system_prompt: str
    model_name: Optional[str]
    provider_type: str = "ollama"
    available_tools: Optional[List[str]]
    think: bool
    memory: Optional[str] = None
    memory_enabled: bool = True
    enabled: bool = True
    is_system: bool = False
    use_deferred_tools: bool = False
    agent_type: str = "main"
    # Personality fields (merged from Persona)
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    preferred_name: Optional[str] = None


def _agent_to_response(agent) -> AgentResponse:
    """Convert database Agent to AgentResponse."""
    return AgentResponse(
        id=agent.id,
        name=agent.name,
        description=agent.description or "",
        system_prompt=agent.system_prompt or "",
        model_name=agent.model_name,
        provider_type=agent.provider_type or "ollama",
        available_tools=agent.available_tools,
        think=agent.think,
        memory=agent.memory,
        memory_enabled=agent.memory_enabled,
        enabled=agent.enabled,
        is_system=agent.is_system,
        use_deferred_tools=getattr(agent, 'use_deferred_tools', False),
        agent_type=getattr(agent, 'agent_type', 'main'),
        voice_reference=getattr(agent, 'voice_reference', None),
        avatar_uuid=getattr(agent, 'avatar_uuid', None),
        character_config=getattr(agent, 'character_config', None),
        preferred_name=getattr(agent, 'preferred_name', None),
    )


@router.get("")
async def list_agents(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AgentResponse]:
    """List all agents for the current user."""
    def _list(session):
        agent_repo = AgentRepository(session)
        # Return system agents + user's agents
        agents = agent_repo.list_all_for_user(user.id)
        return [_agent_to_response(agent) for agent in agents]

    db = get_db_service()
    return await db.execute(_list)


@router.get("/{agent_id}")
async def get_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Get a specific agent by ID."""
    def _get(session):
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        if not agent:
            # Check if it's a system agent
            from kurisuassistant.db.models import Agent as AgentModel
            agent = session.query(AgentModel).filter_by(id=agent_id, is_system=True).first()
        if not agent:
            return None
        return _agent_to_response(agent)

    db = get_db_service()
    result = await db.execute(_get)
    if result is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return result


@router.post("")
async def create_agent(
    body: AgentCreate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Create a new agent."""
    # Validate name is not reserved
    if body.name in RESERVED_AGENT_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{body.name}' is a reserved name and cannot be used for agents."
        )

    try:
        def _create(session):
            # Check for duplicate name
            existing = AgentRepository(session).get_by_user_and_name(user.id, body.name)
            if existing:
                raise HTTPException(status_code=400, detail=f"An agent named '{body.name}' already exists.")
            agent = AgentRepository(session).create_agent(
                user_id=user.id,
                name=body.name,
                description=body.description,
                system_prompt=body.system_prompt,
                model_name=body.model_name,
                provider_type=body.provider_type,
                available_tools=body.available_tools,
                think=body.think,
                use_deferred_tools=body.use_deferred_tools,
                agent_type=body.agent_type,
                voice_reference=body.voice_reference,
                avatar_uuid=body.avatar_uuid,
                character_config=body.character_config,
                preferred_name=body.preferred_name,
            )
            return _agent_to_response(agent)

        db = get_db_service()
        return await db.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating agent: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{agent_id}")
async def update_agent(
    agent_id: int,
    body: AgentUpdate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Update an agent."""
    # Validate new name is not reserved (if name is being changed)
    if body.name is not None and body.name in RESERVED_AGENT_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{body.name}' is a reserved name and cannot be used for agents."
        )

    def _update(session):
        agent_repo = AgentRepository(session)
        # Try user's agent first, then system agent
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        if not agent:
            # Check if it's a system agent
            from kurisuassistant.db.models import Agent as AgentModel
            agent = session.query(AgentModel).filter_by(id=agent_id, is_system=True).first()
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        # System agents cannot be renamed
        if agent.is_system and body.name is not None:
            raise HTTPException(status_code=400, detail="System agent names cannot be changed")
        # Check for duplicate name
        if body.name is not None and body.name != agent.name:
            existing = agent_repo.get_by_user_and_name(user.id, body.name)
            if existing:
                raise HTTPException(status_code=400, detail=f"An agent named '{body.name}' already exists.")

        # Build kwargs, using sentinel for available_tools to distinguish
        # "not provided" (omit) from "explicitly null" (clear to all)
        update_kwargs = dict(
            name=body.name,
            description=body.description,
            system_prompt=body.system_prompt,
            model_name=body.model_name,
            provider_type=body.provider_type,
            think=body.think,
            memory=body.memory,
            memory_enabled=body.memory_enabled,
            use_deferred_tools=body.use_deferred_tools,
            agent_type=body.agent_type,
            voice_reference=body.voice_reference,
            avatar_uuid=body.avatar_uuid,
            character_config=body.character_config,
            preferred_name=body.preferred_name,
        )
        if "available_tools" in body.model_fields_set:
            update_kwargs["available_tools"] = body.available_tools

        agent = agent_repo.update_agent(agent, **update_kwargs)

        return _agent_to_response(agent)

    db = get_db_service()
    return await db.execute(_update)


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete an agent. System agents (is_system=True) cannot be deleted."""
    def _delete(session):
        agent_repo = AgentRepository(session)

        # Check if agent exists
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # System agents cannot be deleted
        if agent.is_system:
            raise HTTPException(status_code=400, detail="System agents cannot be deleted")

        deleted = agent_repo.delete_by_user_and_id(user.id, agent_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Agent not found")

        return {"message": "Agent deleted successfully"}

    db = get_db_service()
    return await db.execute(_delete)


class AgentToggleEnabled(BaseModel):
    """Request body for toggling agent enabled state."""
    enabled: bool


@router.patch("/{agent_id}/enabled")
async def toggle_agent_enabled(
    agent_id: int,
    body: AgentToggleEnabled,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Toggle an agent's enabled state."""
    def _toggle(session):
        agent_repo = AgentRepository(session)
        agent = agent_repo.toggle_enabled(agent_id, body.enabled)
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        return _agent_to_response(agent)

    db = get_db_service()
    return await db.execute(_toggle)


# ─── Export / Import ───

EXPORT_VERSION = 2  # v2: Merged persona fields into agent


def _get_agent_data(session, user_id: int, agent_id: int) -> Optional[dict]:
    """Fetch agent fields needed for export."""
    agent = AgentRepository(session).get_by_user_and_id(user_id, agent_id)
    if not agent:
        return None
    return {
        "name": agent.name,
        "description": agent.description or "",
        "system_prompt": agent.system_prompt or "",
        "model_name": agent.model_name,
        "provider_type": agent.provider_type or "ollama",
        "available_tools": agent.available_tools,
        "think": agent.think,
        "memory": agent.memory,
        "memory_enabled": agent.memory_enabled,
        "agent_type": getattr(agent, 'agent_type', 'main'),
        "voice_reference": getattr(agent, 'voice_reference', None),
        "avatar_uuid": getattr(agent, 'avatar_uuid', None),
        "character_config": getattr(agent, 'character_config', None),
        "preferred_name": getattr(agent, 'preferred_name', None),
    }


@router.get("/{agent_id}/export")
async def export_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Export an agent as JSON metadata."""
    from fastapi.responses import StreamingResponse
    import io

    db_svc = get_db_service()
    agent_data = await db_svc.execute(lambda s: _get_agent_data(s, user.id, agent_id))
    if agent_data is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    safe_name = agent_data["name"].replace(" ", "_").replace("/", "_")

    meta = dict(agent_data)
    meta["version"] = EXPORT_VERSION
    return StreamingResponse(
        io.BytesIO(json.dumps(meta, ensure_ascii=False, indent=2).encode()),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
    )


async def _deduplicate_name(db_svc, user_id: int, agent_name: str) -> str:
    """Return a unique agent name for the user."""
    existing_names: List[str] = await db_svc.execute(
        lambda s: [a.name for a in AgentRepository(s).list_by_user(user_id)]
    )
    original_name = agent_name
    counter = 2
    while agent_name in existing_names or agent_name in RESERVED_AGENT_NAMES:
        agent_name = f"{original_name} ({counter})"
        counter += 1
    return agent_name


async def _import_from_json(meta: dict, user: User) -> AgentResponse:
    """Import agent from JSON metadata."""
    db_svc = get_db_service()
    agent_name = await _deduplicate_name(db_svc, user.id, meta.get("name", "Imported Agent"))

    def _create(session):
        return AgentRepository(session).create_agent(
            user_id=user.id,
            name=agent_name,
            description=meta.get("description", ""),
            system_prompt=meta.get("system_prompt", ""),
            model_name=meta.get("model_name"),
            provider_type=meta.get("provider_type", "ollama"),
            available_tools=meta.get("available_tools"),
            think=meta.get("think", False),
            agent_type=meta.get("agent_type", "main"),
            voice_reference=meta.get("voice_reference"),
            avatar_uuid=meta.get("avatar_uuid"),
            character_config=meta.get("character_config"),
            preferred_name=meta.get("preferred_name"),
        )

    agent = await db_svc.execute(_create)
    new_agent_id = agent.id

    memory = meta.get("memory")
    memory_enabled = meta.get("memory_enabled", True)
    if memory is not None or not memory_enabled:
        def _update_mem(session):
            a = AgentRepository(session).get_by_user_and_id(user.id, new_agent_id)
            return AgentRepository(session).update_agent(a, memory=memory, memory_enabled=memory_enabled)
        await db_svc.execute(_update_mem)

    def _get_final(session):
        return _agent_to_response(AgentRepository(session).get_by_user_and_id(user.id, new_agent_id))
    return await db_svc.execute(_get_final)


@router.post("/import")
async def import_agent(
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Import an agent from a .json file."""
    filename = file.filename or ""
    contents = await file.read()

    if not filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="File must be .json")

    try:
        meta = json.loads(contents)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    return await _import_from_json(meta, user)
