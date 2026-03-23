"""Agent CRUD routes."""

import logging
from pathlib import Path
from typing import Optional, List

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AgentRepository
from kurisuassistant.utils.images import upload_image, save_image_from_array, check_image_exists

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


DEFAULT_MODEL = "gemma3:4b"

# Administrator is a special system agent for routing decisions
ADMINISTRATOR_NAME = "Administrator"
ADMINISTRATOR_PROMPT = """You are the Administrator, a system-level agent that routes conversations to the appropriate agents. You analyze user requests and agent responses to determine the best agent to handle each task."""

# Reserved names that users cannot use for their agents
RESERVED_AGENT_NAMES = {"Administrator", "User"}

# Default user agent
DEFAULT_AGENT_NAME = "Assistant"
DEFAULT_AGENT_PROMPT = """You are a helpful AI assistant. You are knowledgeable, friendly, and always try to provide accurate and useful information."""


def ensure_default_agents(agent_repo: AgentRepository, user_id: int) -> None:
    """Ensure a default Assistant agent exists for a user."""
    agents = agent_repo.list_by_user(user_id)

    # Create default Assistant if no agents exist
    if not agents:
        agent_repo.create_agent(
            user_id=user_id,
            name=DEFAULT_AGENT_NAME,
            system_prompt=DEFAULT_AGENT_PROMPT,
            model_name=DEFAULT_MODEL,
        )


class AgentCreate(BaseModel):
    """Request body for creating an agent."""
    name: str
    system_prompt: str = ""
    model_name: str  # Required - LLM model for this agent
    provider_type: str = "ollama"  # "ollama" or "gemini"
    excluded_tools: Optional[List[str]] = None
    think: bool = False
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


class AgentUpdate(BaseModel):
    """Request body for updating an agent."""
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    voice_reference: Optional[str] = None
    model_name: Optional[str] = None
    provider_type: Optional[str] = None
    excluded_tools: Optional[List[str]] = None
    think: Optional[bool] = None
    memory: Optional[str] = None
    memory_enabled: Optional[bool] = None
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


class AgentResponse(BaseModel):
    """Response body for agent."""
    id: int
    name: str
    system_prompt: str
    voice_reference: Optional[str]
    avatar_uuid: Optional[str]
    model_name: Optional[str]
    provider_type: str = "ollama"
    excluded_tools: Optional[List[str]]
    think: bool
    character_config: Optional[dict] = None
    memory: Optional[str] = None
    memory_enabled: bool = True
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


def _agent_to_response(agent) -> AgentResponse:
    """Convert database Agent to AgentResponse."""
    return AgentResponse(
        id=agent.id,
        name=agent.name,
        system_prompt=agent.system_prompt or "",
        voice_reference=agent.voice_reference,
        avatar_uuid=agent.avatar_uuid,
        model_name=agent.model_name,
        excluded_tools=agent.excluded_tools,
        think=agent.think,
        character_config=getattr(agent, 'character_config', None),
        memory=agent.memory,
        memory_enabled=agent.memory_enabled,
        preferred_name=agent.preferred_name,
        trigger_word=agent.trigger_word,
    )


@router.get("")
async def list_agents(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AgentResponse]:
    """List all agents for the current user."""
    def _list(session):
        agent_repo = AgentRepository(session)
        # Ensure default agents exist (Administrator + Assistant)
        ensure_default_agents(agent_repo, user.id)
        agents = agent_repo.list_by_user(user.id)
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
        agent = AgentRepository(session).get_by_user_and_id(user.id, agent_id)
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
            agent = AgentRepository(session).create_agent(
                user_id=user.id,
                name=body.name,
                system_prompt=body.system_prompt,
                model_name=body.model_name,
                provider_type=body.provider_type,
                excluded_tools=body.excluded_tools,
                think=body.think,
                preferred_name=body.preferred_name,
                trigger_word=body.trigger_word,
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
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(
            agent,
            name=body.name,
            system_prompt=body.system_prompt,
            voice_reference=body.voice_reference,
            model_name=body.model_name,
            provider_type=body.provider_type,
            excluded_tools=body.excluded_tools,
            think=body.think,
            memory=body.memory,
            memory_enabled=body.memory_enabled,
            preferred_name=body.preferred_name,
            trigger_word=body.trigger_word,
        )

        return _agent_to_response(agent)

    db = get_db_service()
    return await db.execute(_update)


@router.patch("/{agent_id}/avatar")
async def update_agent_avatar(
    agent_id: int,
    avatar: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Update agent avatar image."""
    # Upload avatar first (non-DB operation)
    avatar_uuid = upload_image(avatar)

    def _update_avatar(session):
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(agent, avatar_uuid=avatar_uuid)
        return _agent_to_response(agent)

    db = get_db_service()
    return await db.execute(_update_avatar)


@router.patch("/{agent_id}/voice")
async def update_agent_voice(
    agent_id: int,
    voice: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Update agent voice reference."""
    import uuid
    from pathlib import Path

    # Get current agent info for validation and cleanup
    db = get_db_service()

    def _get_voice_ref(session):
        agent = AgentRepository(session).get_by_user_and_id(user.id, agent_id)
        if not agent:
            return None, False
        return agent.voice_reference, True

    old_voice_ref, agent_exists = await db.execute(_get_voice_ref)

    if not agent_exists:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Save voice file to voice storage directory
    voice_dir = Path("data") / "voice_storage"
    voice_dir.mkdir(parents=True, exist_ok=True)

    # Get file extension
    ext = Path(voice.filename).suffix.lower() if voice.filename else ".wav"
    if ext not in {".wav", ".mp3", ".flac", ".ogg"}:
        ext = ".wav"

    # Generate UUID filename
    voice_id = str(uuid.uuid4())
    voice_path = voice_dir / f"{voice_id}{ext}"

    # Delete old voice file if it exists
    if old_voice_ref:
        for old_ext in {".wav", ".mp3", ".flac", ".ogg"}:
            old_path = voice_dir / f"{old_voice_ref}{old_ext}"
            if old_path.exists():
                old_path.unlink()
                break

    # Save file
    contents = await voice.read()
    with open(voice_path, "wb") as f:
        f.write(contents)

    # Update agent with voice reference (UUID without extension)
    def _update_voice(session):
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        agent = agent_repo.update_agent(agent, voice_reference=voice_id)
        return _agent_to_response(agent)

    return await db.execute(_update_voice)


@router.delete("/{agent_id}")
async def delete_agent(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete an agent.

    Note: The Administrator agent cannot be deleted as it is required
    for the orchestration system.
    """
    def _delete(session):
        agent_repo = AgentRepository(session)

        # Check if agent exists and get its name
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        deleted = agent_repo.delete_by_user_and_id(user.id, agent_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Agent not found")

        return {"message": "Agent deleted successfully"}

    db = get_db_service()
    return await db.execute(_delete)


from kurisuassistant.core.paths import DATA_DIR
CHARACTER_ASSETS_DIR = DATA_DIR / "character_assets"


class AvatarCandidateResponse(BaseModel):
    uuid: str
    pose_id: str
    score: float


class AvatarFromUuidRequest(BaseModel):
    avatar_uuid: str


@router.get("/{agent_id}/avatar-candidates")
async def get_avatar_candidates(
    agent_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AvatarCandidateResponse]:
    """Detect faces from character pose base images and return cropped candidates."""
    db = get_db_service()

    def _get_config(session):
        agent = AgentRepository(session).get_by_user_and_id(user.id, agent_id)
        if not agent:
            return None
        return agent.character_config

    config = await db.execute(_get_config)
    if config is None:
        # Could be agent not found or no config — check agent exists
        agent_exists = await db.execute(
            lambda s: AgentRepository(s).get_by_user_and_id(user.id, agent_id) is not None
        )
        if not agent_exists:
            raise HTTPException(status_code=404, detail="Agent not found")

    pose_tree = config.get("pose_tree") if config else None
    if not pose_tree or "nodes" not in pose_tree:
        raise HTTPException(status_code=400, detail="Agent has no character config with poses")

    from models.face_recognition import get_provider
    face_provider = get_provider()

    candidates = []
    for node in pose_tree["nodes"]:
        pose_id = node["id"]
        base_path = CHARACTER_ASSETS_DIR / str(agent_id) / pose_id / "base.png"
        if not base_path.exists():
            continue

        image = cv2.imread(str(base_path))
        if image is None:
            continue

        faces = face_provider.detect_and_embed(image)
        for face in faces:
            bbox = face["bbox"]  # [x1, y1, x2, y2]
            x1, y1, x2, y2 = [int(v) for v in bbox]

            # Expand bbox generously for portrait framing
            w = x2 - x1
            h = y2 - y1
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            new_w = w * 2.5
            new_h = h * 3.0
            # Shift center up to include more forehead/hair
            cy -= h * 0.15
            nx1 = max(0, int(cx - new_w / 2))
            ny1 = max(0, int(cy - new_h / 2))
            nx2 = min(image.shape[1], int(cx + new_w / 2))
            ny2 = min(image.shape[0], int(cy + new_h / 2))

            crop = image[ny1:ny2, nx1:nx2]
            if crop.size == 0:
                continue

            crop_uuid = save_image_from_array(crop)
            candidates.append(AvatarCandidateResponse(
                uuid=crop_uuid,
                pose_id=pose_id,
                score=float(face["score"]),
            ))

    return candidates


@router.post("/{agent_id}/avatar-from-uuid")
async def set_avatar_from_uuid(
    agent_id: int,
    body: AvatarFromUuidRequest,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Set agent avatar from an existing image UUID."""
    if not check_image_exists(body.avatar_uuid):
        raise HTTPException(status_code=404, detail="Image not found")

    def _set_avatar(session):
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(agent, avatar_uuid=body.avatar_uuid)
        return _agent_to_response(agent)

    db = get_db_service()
    return await db.execute(_set_avatar)
