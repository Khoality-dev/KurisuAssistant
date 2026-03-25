"""Agent CRUD routes."""

import io
import json
import logging
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Optional, List

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.core.paths import DATA_DIR
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import AgentRepository
from kurisuassistant.utils.images import upload_image, save_image_from_array, check_image_exists, get_image_path, IMAGES_DIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])

CHARACTER_ASSETS_DIR = DATA_DIR / "character_assets"
VOICE_STORAGE_DIR = DATA_DIR / "voice_storage"


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


from fastapi.security import OAuth2PasswordBearer as _OAuth2
_optional_oauth2 = _OAuth2(tokenUrl="login", auto_error=False)


def _resolve_user(token: Optional[str], header_token: Optional[str]) -> User:
    """Resolve user from query-param or header token (for media endpoints)."""
    from kurisuassistant.core.security import get_current_user
    from kurisuassistant.db.repositories import UserRepository as _UR
    resolved = token or header_token
    if not resolved:
        raise HTTPException(status_code=401, detail="Not authenticated")
    username = get_current_user(resolved)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    db_svc = get_db_service()
    def _get(session):
        user = _UR(session).get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        session.expunge(user)
        return user
    return db_svc.execute_sync(_get)


@router.get("/{agent_id}/voice")
async def get_agent_voice(
    agent_id: int,
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(_optional_oauth2),
):
    """Serve the agent's voice reference audio file.

    Accepts token via Authorization header or query param (for <audio> elements).
    """
    user = _resolve_user(token, header_token)
    db_svc = get_db_service()

    def _get_ref(session):
        agent = AgentRepository(session).get_by_user_and_id(user.id, agent_id)
        if not agent:
            return None
        return agent.voice_reference

    voice_ref = await db_svc.execute(_get_ref)
    if voice_ref is None:
        raise HTTPException(status_code=404, detail="Agent not found or no voice reference")

    voice_path = _find_voice_file(voice_ref)
    if not voice_path:
        raise HTTPException(status_code=404, detail="Voice file not found")

    ext_to_media = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg"}
    media_type = ext_to_media.get(voice_path.suffix, "application/octet-stream")
    return FileResponse(path=voice_path, media_type=media_type)


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



def _find_voice_file(voice_ref: str) -> Optional[Path]:
    """Find the voice file on disk by UUID reference."""
    for ext in (".wav", ".mp3", ".flac", ".ogg"):
        p = VOICE_STORAGE_DIR / f"{voice_ref}{ext}"
        if p.exists():
            return p
    return None


# ─── Export / Import ───

EXPORT_VERSION = 1


def _get_agent_data(session, user_id: int, agent_id: int) -> Optional[dict]:
    """Fetch agent fields needed for export."""
    agent = AgentRepository(session).get_by_user_and_id(user_id, agent_id)
    if not agent:
        return None
    return {
        "name": agent.name,
        "system_prompt": agent.system_prompt or "",
        "model_name": agent.model_name,
        "provider_type": agent.provider_type or "ollama",
        "excluded_tools": agent.excluded_tools,
        "think": agent.think,
        "memory": agent.memory,
        "memory_enabled": agent.memory_enabled,
        "preferred_name": agent.preferred_name,
        "trigger_word": agent.trigger_word,
        "character_config": agent.character_config,
        "voice_reference": agent.voice_reference,
        "avatar_uuid": agent.avatar_uuid,
    }


@router.get("/{agent_id}/export")
async def export_agent(
    agent_id: int,
    format: str = "zip",
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Export an agent. format=zip includes all assets; format=json is metadata only."""
    db_svc = get_db_service()
    agent_data = await db_svc.execute(lambda s: _get_agent_data(s, user.id, agent_id))
    if agent_data is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    safe_name = agent_data["name"].replace(" ", "_").replace("/", "_")

    if format == "json":
        meta = {k: v for k, v in agent_data.items() if k not in ("voice_reference", "avatar_uuid", "character_config")}
        meta["version"] = EXPORT_VERSION
        return StreamingResponse(
            io.BytesIO(json.dumps(meta, ensure_ascii=False, indent=2).encode()),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )

    # ZIP export — full archive with assets
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        meta = {k: v for k, v in agent_data.items() if k not in ("voice_reference", "avatar_uuid")}
        meta["version"] = EXPORT_VERSION
        zf.writestr("agent.json", json.dumps(meta, ensure_ascii=False, indent=2))

        avatar_uuid = agent_data.get("avatar_uuid")
        if avatar_uuid:
            avatar_path = get_image_path(avatar_uuid)
            if avatar_path:
                zf.write(avatar_path, f"avatar{avatar_path.suffix}")

        voice_ref = agent_data.get("voice_reference")
        if voice_ref:
            voice_path = _find_voice_file(voice_ref)
            if voice_path:
                zf.write(voice_path, f"voice{voice_path.suffix}")

        assets_dir = CHARACTER_ASSETS_DIR / str(agent_id)
        if assets_dir.exists():
            for file_path in assets_dir.rglob("*"):
                if file_path.is_file():
                    arc_name = "character_assets/" + file_path.relative_to(assets_dir).as_posix()
                    zf.write(file_path, arc_name)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.zip"'},
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
    """Import agent from JSON metadata (no binary assets)."""
    db_svc = get_db_service()
    agent_name = await _deduplicate_name(db_svc, user.id, meta.get("name", "Imported Agent"))

    def _create(session):
        return AgentRepository(session).create_agent(
            user_id=user.id,
            name=agent_name,
            system_prompt=meta.get("system_prompt", ""),
            model_name=meta.get("model_name"),
            provider_type=meta.get("provider_type", "ollama"),
            excluded_tools=meta.get("excluded_tools"),
            think=meta.get("think", False),
            preferred_name=meta.get("preferred_name"),
            trigger_word=meta.get("trigger_word"),
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


async def _import_from_zip(zf: zipfile.ZipFile, meta: dict, user: User) -> AgentResponse:
    """Import agent from ZIP archive with binary assets."""
    db_svc = get_db_service()
    agent_name = await _deduplicate_name(db_svc, user.id, meta.get("name", "Imported Agent"))

    # --- Import avatar ---
    avatar_uuid = None
    for name in zf.namelist():
        if name.startswith("avatar"):
            ext = Path(name).suffix
            avatar_uuid = str(uuid.uuid4())
            (IMAGES_DIR / f"{avatar_uuid}{ext}").write_bytes(zf.read(name))
            break

    # --- Import voice ---
    voice_reference = None
    for name in zf.namelist():
        if name.startswith("voice"):
            ext = Path(name).suffix
            if ext not in {".wav", ".mp3", ".flac", ".ogg"}:
                ext = ".wav"
            voice_reference = str(uuid.uuid4())
            VOICE_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
            (VOICE_STORAGE_DIR / f"{voice_reference}{ext}").write_bytes(zf.read(name))
            break

    # --- Create agent record ---
    def _create(session):
        return AgentRepository(session).create_agent(
            user_id=user.id,
            name=agent_name,
            system_prompt=meta.get("system_prompt", ""),
            model_name=meta.get("model_name"),
            provider_type=meta.get("provider_type", "ollama"),
            excluded_tools=meta.get("excluded_tools"),
            think=meta.get("think", False),
            character_config=meta.get("character_config"),
            preferred_name=meta.get("preferred_name"),
            trigger_word=meta.get("trigger_word"),
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
        )

    agent = await db_svc.execute(_create)
    new_agent_id = agent.id

    # --- Import memory ---
    memory = meta.get("memory")
    memory_enabled = meta.get("memory_enabled", True)
    if memory is not None or not memory_enabled:
        def _update_mem(session):
            a = AgentRepository(session).get_by_user_and_id(user.id, new_agent_id)
            return AgentRepository(session).update_agent(a, memory=memory, memory_enabled=memory_enabled)
        await db_svc.execute(_update_mem)

    # --- Import character assets ---
    char_prefix = "character_assets/"
    char_files = [n for n in zf.namelist() if n.startswith(char_prefix) and not n.endswith("/")]
    if char_files:
        config = meta.get("character_config")
        if config:
            import re
            config_str = json.dumps(config)
            for old_id in set(re.findall(r'/character-assets/(\d+)/', config_str)):
                config_str = config_str.replace(f"/character-assets/{old_id}/", f"/character-assets/{new_agent_id}/")
            config = json.loads(config_str)

            def _update_config(session):
                a = AgentRepository(session).get_by_user_and_id(user.id, new_agent_id)
                return AgentRepository(session).update_agent(a, character_config=config)
            await db_svc.execute(_update_config)

        dest_dir = CHARACTER_ASSETS_DIR / str(new_agent_id)
        for name in char_files:
            rel = name[len(char_prefix):]
            dest = dest_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))

    def _get_final(session):
        return _agent_to_response(AgentRepository(session).get_by_user_and_id(user.id, new_agent_id))
    return await db_svc.execute(_get_final)


@router.post("/import")
async def import_agent(
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> AgentResponse:
    """Import an agent from a .zip archive or .json file."""
    filename = file.filename or ""
    contents = await file.read()

    if filename.endswith(".json"):
        try:
            meta = json.loads(contents)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON file")
        return await _import_from_json(meta, user)

    if filename.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(contents))
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="Invalid zip file")
        if "agent.json" not in zf.namelist():
            raise HTTPException(status_code=400, detail="Archive missing agent.json")
        meta = json.loads(zf.read("agent.json"))
        return await _import_from_zip(zf, meta, user)

    raise HTTPException(status_code=400, detail="File must be .zip or .json")


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

    from kurisuassistant.models.face_recognition import get_provider
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
