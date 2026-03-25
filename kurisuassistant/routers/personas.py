"""Persona CRUD routes."""

import io
import json
import logging
import uuid
import zipfile
from pathlib import Path
from typing import Optional, List

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import OAuth2PasswordBearer as _OAuth2
from pydantic import BaseModel
from sqlalchemy.orm import Session

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.core.paths import DATA_DIR
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import PersonaRepository
from kurisuassistant.utils.images import (
    upload_image, save_image_from_array, check_image_exists, get_image_path, IMAGES_DIR,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/personas", tags=["personas"])

CHAR_ASSETS_DIR = DATA_DIR / "character_assets"
VOICE_STORAGE_DIR = DATA_DIR / "voice_storage"

RESERVED_PERSONA_NAMES = {"Administrator", "User"}


# ─── Pydantic schemas ───


class PersonaCreate(BaseModel):
    """Request body for creating a persona."""
    name: str
    system_prompt: str = ""
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


class PersonaUpdate(BaseModel):
    """Request body for updating a persona."""
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    voice_reference: Optional[str] = None
    avatar_uuid: Optional[str] = None
    character_config: Optional[dict] = None
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


class PersonaResponse(BaseModel):
    """Response body for persona."""
    id: int
    name: str
    system_prompt: str
    voice_reference: Optional[str]
    avatar_uuid: Optional[str]
    character_config: Optional[dict] = None
    preferred_name: Optional[str] = None
    trigger_word: Optional[str] = None


def _persona_to_response(persona) -> PersonaResponse:
    """Convert database Persona to PersonaResponse."""
    return PersonaResponse(
        id=persona.id,
        name=persona.name,
        system_prompt=persona.system_prompt or "",
        voice_reference=persona.voice_reference,
        avatar_uuid=persona.avatar_uuid,
        character_config=getattr(persona, "character_config", None),
        preferred_name=persona.preferred_name,
        trigger_word=persona.trigger_word,
    )


# ─── CRUD ───


@router.get("")
async def list_personas(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[PersonaResponse]:
    """List all personas for the current user."""
    def _list(session):
        personas = PersonaRepository(session).list_by_user(user.id)
        return [_persona_to_response(p) for p in personas]

    db_svc = get_db_service()
    return await db_svc.execute(_list)


@router.get("/{persona_id}")
async def get_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Get a specific persona by ID."""
    def _get(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        if not persona:
            return None
        return _persona_to_response(persona)

    db_svc = get_db_service()
    result = await db_svc.execute(_get)
    if result is None:
        raise HTTPException(status_code=404, detail="Persona not found")
    return result


@router.post("")
async def create_persona(
    body: PersonaCreate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Create a new persona."""
    if body.name in RESERVED_PERSONA_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{body.name}' is a reserved name and cannot be used for personas.",
        )

    try:
        def _create(session):
            persona = PersonaRepository(session).create_persona(
                user_id=user.id,
                name=body.name,
                system_prompt=body.system_prompt,
                preferred_name=body.preferred_name,
                trigger_word=body.trigger_word,
            )
            return _persona_to_response(persona)

        db_svc = get_db_service()
        return await db_svc.execute(_create)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating persona: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{persona_id}")
async def update_persona(
    persona_id: int,
    body: PersonaUpdate,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Update a persona."""
    if body.name is not None and body.name in RESERVED_PERSONA_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"'{body.name}' is a reserved name and cannot be used for personas.",
        )

    def _update(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        persona = repo.update_persona(
            persona,
            name=body.name,
            system_prompt=body.system_prompt,
            voice_reference=body.voice_reference,
            avatar_uuid=body.avatar_uuid,
            character_config=body.character_config,
            preferred_name=body.preferred_name,
            trigger_word=body.trigger_word,
        )
        return _persona_to_response(persona)

    db_svc = get_db_service()
    return await db_svc.execute(_update)


@router.delete("/{persona_id}")
async def delete_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Delete a persona."""
    def _delete(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        deleted = repo.delete_by_user_and_id(user.id, persona_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Persona not found")

        return {"message": "Persona deleted successfully"}

    db_svc = get_db_service()
    return await db_svc.execute(_delete)


# ─── Avatar ───


@router.patch("/{persona_id}/avatar")
async def update_persona_avatar(
    persona_id: int,
    avatar: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Update persona avatar image."""
    avatar_uuid = upload_image(avatar)

    def _update_avatar(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        persona = repo.update_persona(persona, avatar_uuid=avatar_uuid)
        return _persona_to_response(persona)

    db_svc = get_db_service()
    return await db_svc.execute(_update_avatar)


class AvatarFromUuidRequest(BaseModel):
    avatar_uuid: str


@router.post("/{persona_id}/avatar-from-uuid")
async def set_avatar_from_uuid(
    persona_id: int,
    body: AvatarFromUuidRequest,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Set persona avatar from an existing image UUID."""
    if not check_image_exists(body.avatar_uuid):
        raise HTTPException(status_code=404, detail="Image not found")

    def _set_avatar(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        persona = repo.update_persona(persona, avatar_uuid=body.avatar_uuid)
        return _persona_to_response(persona)

    db_svc = get_db_service()
    return await db_svc.execute(_set_avatar)


# ─── Avatar Candidates ───


class AvatarCandidateResponse(BaseModel):
    uuid: str
    pose_id: str
    score: float


@router.get("/{persona_id}/avatar-candidates")
async def get_avatar_candidates(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> List[AvatarCandidateResponse]:
    """Detect faces from character pose base images and return cropped candidates."""
    db_svc = get_db_service()

    def _get_config(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        if not persona:
            return None
        return persona.character_config

    config = await db_svc.execute(_get_config)
    if config is None:
        persona_exists = await db_svc.execute(
            lambda s: PersonaRepository(s).get_by_user_and_id(user.id, persona_id) is not None
        )
        if not persona_exists:
            raise HTTPException(status_code=404, detail="Persona not found")

    pose_tree = config.get("pose_tree") if config else None
    if not pose_tree or "nodes" not in pose_tree:
        raise HTTPException(status_code=400, detail="Persona has no character config with poses")

    from kurisuassistant.models.face_recognition import get_provider
    face_provider = get_provider()

    candidates = []
    for node in pose_tree["nodes"]:
        pose_id = node["id"]
        base_path = CHAR_ASSETS_DIR / str(persona_id) / pose_id / "base.png"
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


# ─── Voice ───


def _find_voice_file(voice_ref: str) -> Optional[Path]:
    """Find the voice file on disk by UUID reference."""
    for ext in (".wav", ".mp3", ".flac", ".ogg"):
        p = VOICE_STORAGE_DIR / f"{voice_ref}{ext}"
        if p.exists():
            return p
    return None


@router.patch("/{persona_id}/voice")
async def update_persona_voice(
    persona_id: int,
    voice: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Update persona voice reference."""
    db_svc = get_db_service()

    def _get_voice_ref(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        if not persona:
            return None, False
        return persona.voice_reference, True

    old_voice_ref, persona_exists = await db_svc.execute(_get_voice_ref)

    if not persona_exists:
        raise HTTPException(status_code=404, detail="Persona not found")

    # Save voice file to voice storage directory
    voice_dir = VOICE_STORAGE_DIR
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
        for old_ext in (".wav", ".mp3", ".flac", ".ogg"):
            old_path = voice_dir / f"{old_voice_ref}{old_ext}"
            if old_path.exists():
                old_path.unlink()
                break

    # Save file
    contents = await voice.read()
    with open(voice_path, "wb") as f:
        f.write(contents)

    # Update persona with voice reference (UUID without extension)
    def _update_voice(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        persona = repo.update_persona(persona, voice_reference=voice_id)
        return _persona_to_response(persona)

    return await db_svc.execute(_update_voice)


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


@router.get("/{persona_id}/voice")
async def get_persona_voice(
    persona_id: int,
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(_optional_oauth2),
):
    """Serve the persona's voice reference audio file.

    Accepts token via Authorization header or query param (for <audio> elements).
    """
    user = _resolve_user(token, header_token)
    db_svc = get_db_service()

    def _get_ref(session):
        persona = PersonaRepository(session).get_by_user_and_id(user.id, persona_id)
        if not persona:
            return None
        return persona.voice_reference

    voice_ref = await db_svc.execute(_get_ref)
    if voice_ref is None:
        raise HTTPException(status_code=404, detail="Persona not found or no voice reference")

    voice_path = _find_voice_file(voice_ref)
    if not voice_path:
        raise HTTPException(status_code=404, detail="Voice file not found")

    ext_to_media = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg"}
    media_type = ext_to_media.get(voice_path.suffix, "application/octet-stream")
    return FileResponse(path=voice_path, media_type=media_type)


# ─── Export / Import ───


EXPORT_VERSION = 1


def _get_persona_data(session, user_id: int, persona_id: int) -> Optional[dict]:
    """Fetch persona fields needed for export."""
    persona = PersonaRepository(session).get_by_user_and_id(user_id, persona_id)
    if not persona:
        return None
    return {
        "name": persona.name,
        "system_prompt": persona.system_prompt or "",
        "preferred_name": persona.preferred_name,
        "trigger_word": persona.trigger_word,
        "character_config": persona.character_config,
        "voice_reference": persona.voice_reference,
        "avatar_uuid": persona.avatar_uuid,
    }


@router.get("/{persona_id}/export")
async def export_persona(
    persona_id: int,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Export a persona as a ZIP archive with all assets."""
    db_svc = get_db_service()
    persona_data = await db_svc.execute(lambda s: _get_persona_data(s, user.id, persona_id))
    if persona_data is None:
        raise HTTPException(status_code=404, detail="Persona not found")

    safe_name = persona_data["name"].replace(" ", "_").replace("/", "_")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        meta = {k: v for k, v in persona_data.items() if k not in ("voice_reference", "avatar_uuid")}
        meta["version"] = EXPORT_VERSION
        zf.writestr("persona.json", json.dumps(meta, ensure_ascii=False, indent=2))

        avatar_uuid = persona_data.get("avatar_uuid")
        if avatar_uuid:
            avatar_path = get_image_path(avatar_uuid)
            if avatar_path:
                zf.write(avatar_path, f"avatar{avatar_path.suffix}")

        voice_ref = persona_data.get("voice_reference")
        if voice_ref:
            voice_path = _find_voice_file(voice_ref)
            if voice_path:
                zf.write(voice_path, f"voice{voice_path.suffix}")

        assets_dir = CHAR_ASSETS_DIR / str(persona_id)
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


async def _deduplicate_name(db_svc, user_id: int, persona_name: str) -> str:
    """Return a unique persona name for the user."""
    existing_names: List[str] = await db_svc.execute(
        lambda s: [p.name for p in PersonaRepository(s).list_by_user(user_id)]
    )
    original_name = persona_name
    counter = 2
    while persona_name in existing_names or persona_name in RESERVED_PERSONA_NAMES:
        persona_name = f"{original_name} ({counter})"
        counter += 1
    return persona_name


async def _import_from_zip(zf: zipfile.ZipFile, meta: dict, user: User) -> PersonaResponse:
    """Import persona from ZIP archive with binary assets."""
    db_svc = get_db_service()
    persona_name = await _deduplicate_name(db_svc, user.id, meta.get("name", "Imported Persona"))

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

    # --- Create persona record ---
    def _create(session):
        return PersonaRepository(session).create_persona(
            user_id=user.id,
            name=persona_name,
            system_prompt=meta.get("system_prompt", ""),
            character_config=meta.get("character_config"),
            preferred_name=meta.get("preferred_name"),
            trigger_word=meta.get("trigger_word"),
            voice_reference=voice_reference,
            avatar_uuid=avatar_uuid,
        )

    persona = await db_svc.execute(_create)
    new_persona_id = persona.id

    # --- Import character assets ---
    char_prefix = "character_assets/"
    char_files = [n for n in zf.namelist() if n.startswith(char_prefix) and not n.endswith("/")]
    if char_files:
        config = meta.get("character_config")
        if config:
            import re
            config_str = json.dumps(config)
            for old_id in set(re.findall(r'/character-assets/(\d+)/', config_str)):
                config_str = config_str.replace(
                    f"/character-assets/{old_id}/", f"/character-assets/{new_persona_id}/"
                )
            config = json.loads(config_str)

            def _update_config(session):
                p = PersonaRepository(session).get_by_user_and_id(user.id, new_persona_id)
                return PersonaRepository(session).update_persona(p, character_config=config)
            await db_svc.execute(_update_config)

        dest_dir = CHAR_ASSETS_DIR / str(new_persona_id)
        for name in char_files:
            rel = name[len(char_prefix):]
            dest = dest_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))

    def _get_final(session):
        return _persona_to_response(
            PersonaRepository(session).get_by_user_and_id(user.id, new_persona_id)
        )
    return await db_svc.execute(_get_final)


@router.post("/import")
async def import_persona(
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> PersonaResponse:
    """Import a persona from a .zip archive."""
    filename = file.filename or ""
    contents = await file.read()

    if not filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a .zip archive")

    try:
        zf = zipfile.ZipFile(io.BytesIO(contents))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid zip file")

    if "persona.json" not in zf.namelist():
        raise HTTPException(status_code=400, detail="Archive missing persona.json")

    meta = json.loads(zf.read("persona.json"))
    return await _import_from_zip(zf, meta, user)
