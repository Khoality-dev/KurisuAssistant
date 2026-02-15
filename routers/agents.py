"""Agent CRUD routes."""

import logging
from pathlib import Path
from typing import Optional, List

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import AgentRepository
from utils.images import upload_image, save_image_from_array, check_image_exists

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
    """Ensure the Administrator and default Assistant agents exist for a user."""
    agents = agent_repo.list_by_user(user_id)
    agent_names = {agent.name for agent in agents}

    # Always ensure Administrator exists (system agent for routing)
    if ADMINISTRATOR_NAME not in agent_names:
        agent_repo.create_agent(
            user_id=user_id,
            name=ADMINISTRATOR_NAME,
            system_prompt=ADMINISTRATOR_PROMPT,
            model_name=DEFAULT_MODEL,
        )

    # Create default Assistant if no other agents exist (besides Administrator)
    non_admin_agents = [a for a in agents if a.name != ADMINISTRATOR_NAME]
    if not non_admin_agents:
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
    tools: Optional[List[str]] = None
    think: bool = False


class AgentUpdate(BaseModel):
    """Request body for updating an agent."""
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    voice_reference: Optional[str] = None
    model_name: Optional[str] = None
    tools: Optional[List[str]] = None
    think: Optional[bool] = None
    memory: Optional[str] = None


class AgentResponse(BaseModel):
    """Response body for agent."""
    id: int
    name: str
    system_prompt: str
    voice_reference: Optional[str]
    avatar_uuid: Optional[str]
    model_name: Optional[str]
    tools: Optional[List[str]]
    think: bool
    character_config: Optional[dict] = None
    memory: Optional[str] = None


def _agent_to_response(agent) -> AgentResponse:
    """Convert database Agent to AgentResponse."""
    return AgentResponse(
        id=agent.id,
        name=agent.name,
        system_prompt=agent.system_prompt or "",
        voice_reference=agent.voice_reference,
        avatar_uuid=agent.avatar_uuid,
        model_name=agent.model_name,
        tools=agent.tools,
        think=agent.think,
        character_config=getattr(agent, 'character_config', None),
        memory=agent.memory,
    )


@router.get("")
async def list_agents(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AgentResponse]:
    """List all agents for the current user."""
    with get_session() as session:
        agent_repo = AgentRepository(session)

        # Ensure default agents exist (Administrator + Assistant)
        ensure_default_agents(agent_repo, user.id)

        agents = agent_repo.list_by_user(user.id)

        return [_agent_to_response(agent) for agent in agents]


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

        return _agent_to_response(agent)


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
        with get_session() as session:
            agent_repo = AgentRepository(session)
            agent = agent_repo.create_agent(
                user_id=user.id,
                name=body.name,
                system_prompt=body.system_prompt,
                model_name=body.model_name,
                tools=body.tools,
                think=body.think,
            )

            return _agent_to_response(agent)
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

    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Prevent renaming the Administrator agent
        if agent.name == ADMINISTRATOR_NAME and body.name is not None and body.name != ADMINISTRATOR_NAME:
            raise HTTPException(
                status_code=400,
                detail="Cannot rename the Administrator agent."
            )

        # Prevent changing Administrator's system prompt (it uses routing tools)
        if agent.name == ADMINISTRATOR_NAME and body.system_prompt is not None:
            raise HTTPException(
                status_code=400,
                detail="Cannot change the Administrator's system prompt."
            )

        agent = agent_repo.update_agent(
            agent,
            name=body.name,
            system_prompt=body.system_prompt if agent.name != ADMINISTRATOR_NAME else None,
            voice_reference=body.voice_reference,
            model_name=body.model_name,
            tools=body.tools if agent.name != ADMINISTRATOR_NAME else None,  # Admin uses routing tools only
            think=body.think,
            memory=body.memory,
        )

        return _agent_to_response(agent)


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

        return _agent_to_response(agent)


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

    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
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
        if agent.voice_reference:
            for old_ext in {".wav", ".mp3", ".flac", ".ogg"}:
                old_path = voice_dir / f"{agent.voice_reference}{old_ext}"
                if old_path.exists():
                    old_path.unlink()
                    break

        # Save file
        contents = await voice.read()
        with open(voice_path, "wb") as f:
            f.write(contents)

        # Update agent with voice reference (UUID without extension)
        agent = agent_repo.update_agent(agent, voice_reference=voice_id)

        return _agent_to_response(agent)


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
    with get_session() as session:
        agent_repo = AgentRepository(session)

        # Check if agent exists and get its name
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Prevent deletion of Administrator agent
        if agent.name == ADMINISTRATOR_NAME:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete the Administrator agent. It is required for the orchestration system."
            )

        deleted = agent_repo.delete_by_user_and_id(user.id, agent_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Agent not found")

        return {"message": "Agent deleted successfully"}


CHARACTER_ASSETS_DIR = Path(__file__).parent.parent / "data" / "character_assets"


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
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        config = agent.character_config
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

    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(agent, avatar_uuid=body.avatar_uuid)
        return _agent_to_response(agent)
