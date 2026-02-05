"""Agent CRUD routes."""

import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import AgentRepository
from utils.images import upload_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


class AgentCreate(BaseModel):
    """Request body for creating an agent."""
    name: str
    system_prompt: str = ""
    model_name: Optional[str] = None
    tools: Optional[List[str]] = None
    is_main: bool = False


class AgentUpdate(BaseModel):
    """Request body for updating an agent."""
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    voice_reference: Optional[str] = None
    model_name: Optional[str] = None
    tools: Optional[List[str]] = None
    is_main: Optional[bool] = None


class AgentResponse(BaseModel):
    """Response body for agent."""
    id: int
    name: str
    system_prompt: str
    voice_reference: Optional[str]
    avatar_uuid: Optional[str]
    model_name: Optional[str]
    tools: Optional[List[str]]
    is_main: bool


@router.get("")
async def list_agents(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AgentResponse]:
    """List all agents for the current user."""
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agents = agent_repo.list_by_user(user.id)

        return [
            AgentResponse(
                id=agent.id,
                name=agent.name,
                system_prompt=agent.system_prompt or "",
                voice_reference=agent.voice_reference,
                avatar_uuid=agent.avatar_uuid,
                model_name=agent.model_name,
                tools=agent.tools,
                is_main=agent.is_main,
            )
            for agent in agents
        ]


@router.get("/{agent_id}")
async def get_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Get a specific agent by ID."""
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        return AgentResponse(
            id=agent.id,
            name=agent.name,
            system_prompt=agent.system_prompt or "",
            voice_reference=agent.voice_reference,
            avatar_uuid=agent.avatar_uuid,
            model_name=agent.model_name,
            tools=agent.tools,
            is_main=agent.is_main,
        )


@router.post("")
async def create_agent(
    body: AgentCreate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Create a new agent."""
    try:
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.create_agent(
                user_id=user.id,
                name=body.name,
                system_prompt=body.system_prompt,
                model_name=body.model_name,
                tools=body.tools,
                is_main=body.is_main,
            )

            return AgentResponse(
                id=agent.id,
                name=agent.name,
                system_prompt=agent.system_prompt or "",
                voice_reference=agent.voice_reference,
                avatar_uuid=agent.avatar_uuid,
                model_name=agent.model_name,
                tools=agent.tools,
                is_main=agent.is_main,
            )
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
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(
            agent,
            name=body.name,
            system_prompt=body.system_prompt,
            voice_reference=body.voice_reference,
            model_name=body.model_name,
            tools=body.tools,
            is_main=body.is_main,
        )

        return AgentResponse(
            id=agent.id,
            name=agent.name,
            system_prompt=agent.system_prompt or "",
            voice_reference=agent.voice_reference,
            avatar_uuid=agent.avatar_uuid,
            model_name=agent.model_name,
            tools=agent.tools,
            is_main=agent.is_main,
        )


@router.patch("/{agent_id}/avatar")
async def update_agent_avatar(
    agent_id: int,
    avatar: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Update agent avatar image."""
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Upload avatar
        avatar_uuid = upload_image(avatar)

        agent = agent_repo.update_agent(agent, avatar_uuid=avatar_uuid)

        return AgentResponse(
            id=agent.id,
            name=agent.name,
            system_prompt=agent.system_prompt or "",
            voice_reference=agent.voice_reference,
            avatar_uuid=agent.avatar_uuid,
            model_name=agent.model_name,
            tools=agent.tools,
            is_main=agent.is_main,
        )


@router.patch("/{agent_id}/voice")
async def update_agent_voice(
    agent_id: int,
    voice: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Update agent voice reference.

    The uploaded audio file will be saved to the reference/ directory.
    """
    import os
    from pathlib import Path

    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Save voice file to reference directory
        reference_dir = Path("reference")
        reference_dir.mkdir(exist_ok=True)

        # Generate unique filename using agent name
        safe_name = "".join(c for c in agent.name if c.isalnum() or c in "._-")
        voice_filename = f"agent_{agent.id}_{safe_name}"

        # Get file extension
        ext = Path(voice.filename).suffix.lower() if voice.filename else ".wav"
        if ext not in {".wav", ".mp3", ".flac", ".ogg"}:
            ext = ".wav"

        voice_path = reference_dir / f"{voice_filename}{ext}"

        # Save file
        contents = await voice.read()
        with open(voice_path, "wb") as f:
            f.write(contents)

        # Update agent with voice reference (filename without extension)
        agent = agent_repo.update_agent(agent, voice_reference=voice_filename)

        return AgentResponse(
            id=agent.id,
            name=agent.name,
            system_prompt=agent.system_prompt or "",
            voice_reference=agent.voice_reference,
            avatar_uuid=agent.avatar_uuid,
            model_name=agent.model_name,
            tools=agent.tools,
            is_main=agent.is_main,
        )


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete an agent."""
    with get_session() as session:
        agent_repo = AgentRepository(session)
        deleted = agent_repo.delete_by_user_and_id(user.id, agent_id)

        if not deleted:
            raise HTTPException(status_code=404, detail="Agent not found")

        return {"message": "Agent deleted successfully"}
