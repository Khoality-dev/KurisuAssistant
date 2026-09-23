"""Character animation asset routes for video call mode.

Handles keyframe image uploads, diff patch computation, and character asset serving.
User uploads full keyframe images; backend diffs them against the base to extract
patch regions (bounding box + cropped image).

Folder structure:
  data/character_assets/{persona_id}/{pose_id}/base.png
  data/character_assets/{persona_id}/{pose_id}/{part}_{index}.png
  data/character_assets/{persona_id}/edges/{edge_id}.mp4|.webm
  data/character_assets/{persona_id}/vrm/model.vrm
  data/character_assets/{persona_id}/vrma/{clip_id}.vrma
  data/character_assets/{persona_id}/.incoming/        (uploads in flight)

The VRM model and clips stream in (raw body, not ``UploadFile``, which spools
the whole request before the handler — and so before the ownership check —
runs), are validated from their glTF header and JSON chunk, and have their refs
written into ``character_config`` in the transaction that accepts them
(``kurisuassistant/character/assets.py``). Every "commit, then touch the disk"
pair holds the persona's lock (``character/locks.py``).

The directory names are persona ids, and the same ids are embedded in the URLs
inside ``character_config``. Migration 0dacee9f63b8 renamed ``agents`` to
``personas`` without re-keying precisely so that neither has to be rewritten.

Every id and file name a request supplies is joined onto one of these paths, so
each passes ``paths.safe_segment`` first — on upload and on serve alike. What a
saved config is allowed to delete is decided in ``kurisuassistant/character/``,
not here.
"""

import logging
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import anyio
import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from kurisuassistant.character import assets, paths
from kurisuassistant.character.config_write import cleanup_after_write, plan_character_config
from kurisuassistant.character.locks import persona_lock
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.errors import internal_error
from kurisuassistant.utils.blob_stream import sweep_incoming, write_stream
from kurisuassistant.db.models import User
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import PersonaRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/character-assets", tags=["character"])


class MigrateIdsRequest(BaseModel):
    """Request body for migrating old node/edge IDs to new short hex IDs."""
    id_mapping: dict[str, str]  # old_id → new_id


class PatchResult(BaseModel):
    """Result of diffing a keyframe against the base image."""
    image_url: str
    x: int
    y: int
    width: int
    height: int


class UploadBaseResponse(BaseModel):
    """Response for base image upload."""
    asset_id: str
    image_url: str


class ComputePatchResponse(BaseModel):
    """Response for keyframe diff computation."""
    patch: PatchResult


def _pose_dir(persona_id: int, pose_id: str) -> Path:
    """Return the directory for a specific pose's assets."""
    return paths.persona_dir(persona_id) / pose_id


def _edges_dir(persona_id: int) -> Path:
    """Return the directory for a persona's edge transition videos."""
    return paths.persona_dir(persona_id) / "edges"


async def _require_persona(user_id: int, persona_id: int):
    """Confirm the persona belongs to the user and return its ``character_config``. 404 otherwise.

    There is no system-agent escape hatch any more: ``is_system`` is gone, and it
    was the one branch here that served a row nobody owned. The config comes
    back so a serving route reads its ref without a second query.
    """
    db = get_db_service()

    def _get(session):
        persona = PersonaRepository(session).get_by_user_and_id(user_id, persona_id)
        return (persona is not None, persona.character_config if persona is not None else None)

    found, config = await db.execute(_get)
    if not found:
        raise HTTPException(status_code=404, detail="Persona not found")
    return config


async def _read_upload(file: UploadFile, limit: int, what: str) -> bytes:
    """Read an ``UploadFile`` whole, refusing anything over ``limit``.

    One byte past the limit is read so an oversized upload is refused rather
    than silently truncated. These three routes decode what they read, so they
    cannot stream; the ceiling is what keeps a multi-gigabyte body out of memory.
    """
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise assets.too_large(limit, what)
    return data


def _save_image(image: np.ndarray, path: Path) -> None:
    """Save an image array to disk (creates parent dirs, overwrites if exists)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), image)


def _load_image(path: Path) -> Optional[np.ndarray]:
    """Load an image from a specific path."""
    if path.exists():
        return cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    return None


def _compute_diff_patch(base: np.ndarray, variant: np.ndarray) -> Optional[dict]:
    """Compute the bounding box of differing pixels between base and variant.

    Returns dict with {x, y, width, height, patch_image} or None if identical.
    Both images must have the same dimensions.
    """
    if base.shape != variant.shape:
        raise ValueError(
            f"Image dimensions don't match: base={base.shape}, variant={variant.shape}"
        )

    # Compute absolute difference
    diff = cv2.absdiff(base, variant)

    # Convert to grayscale for thresholding (sum across channels)
    if len(diff.shape) == 3:
        diff_gray = np.max(diff, axis=2)
    else:
        diff_gray = diff

    # Threshold — any pixel with difference > 2 is considered changed
    _, mask = cv2.threshold(diff_gray, 2, 255, cv2.THRESH_BINARY)

    # Find bounding box of changed region
    coords = cv2.findNonZero(mask)
    if coords is None:
        return None  # Images are identical

    x, y, w, h = cv2.boundingRect(coords)

    # Crop the variant image to the bounding box
    patch_image = variant[y:y + h, x:x + w]

    return {
        "x": int(x),
        "y": int(y),
        "width": int(w),
        "height": int(h),
        "patch_image": patch_image,
    }


@router.post("/upload-base")
async def upload_base_image(
    persona_id: int,
    pose_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
) -> UploadBaseResponse:
    """Upload a base portrait image for a character pose.

    Saved to ``{persona_id}/{pose_id}/base.png``.  Re-uploading overwrites.
    """
    paths.safe_segment(pose_id, "pose_id")
    await _require_persona(user.id, persona_id)

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    contents = await _read_upload(file, assets.IMAGE_MAX_BYTES, "image")
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image format")

    path = _pose_dir(persona_id, pose_id) / "base.png"
    _save_image(image, path)

    asset_id = f"{persona_id}/{pose_id}/base"
    return UploadBaseResponse(
        asset_id=asset_id,
        image_url=f"/character-assets/{asset_id}",
    )


VALID_PARTS = {"left_eye", "right_eye", "mouth"}


@router.post("/compute-patch")
async def compute_patch(
    persona_id: int,
    pose_id: str,
    part: str,
    index: int,
    keyframe: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
) -> ComputePatchResponse:
    """Upload a keyframe image and compute the diff patch against the pose's base image.

    The keyframe should be the same image as the base but with one region
    modified (e.g., eyes half-closed, mouth open). The backend computes
    the difference, extracts the changed region, and stores it as a patch.

    Saved to ``{persona_id}/{pose_id}/{part}_{index}.png``.
    """
    if part not in VALID_PARTS:
        raise HTTPException(
            status_code=400, detail=f"part must be one of: {', '.join(sorted(VALID_PARTS))}"
        )
    paths.safe_segment(pose_id, "pose_id")

    await _require_persona(user.id, persona_id)

    # Load base image from the pose directory
    base_path = _pose_dir(persona_id, pose_id) / "base.png"
    base = _load_image(base_path)
    if base is None:
        raise HTTPException(status_code=404, detail="Base image not found for this pose")

    # Decode keyframe
    if not keyframe.content_type or not keyframe.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    contents = await _read_upload(keyframe, assets.IMAGE_MAX_BYTES, "image")
    nparr = np.frombuffer(contents, np.uint8)
    variant = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if variant is None:
        raise HTTPException(status_code=400, detail="Invalid keyframe image format")

    # Compute diff
    try:
        result = _compute_diff_patch(base, variant)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if result is None:
        raise HTTPException(
            status_code=400,
            detail="Keyframe is identical to base — no differences found",
        )

    # Save the patch image
    patch_path = _pose_dir(persona_id, pose_id) / f"{part}_{index}.png"
    _save_image(result["patch_image"], patch_path)

    patch_url_path = f"{persona_id}/{pose_id}/{part}_{index}"
    return ComputePatchResponse(
        patch=PatchResult(
            image_url=f"/character-assets/{patch_url_path}",
            x=result["x"],
            y=result["y"],
            width=result["width"],
            height=result["height"],
        )
    )


VALID_VIDEO_TYPES = {"video/mp4", "video/webm"}


@router.post("/upload-video")
async def upload_video(
    persona_id: int,
    edge_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user)
):
    """Upload a transition video for an animation edge.

    Saved to ``{persona_id}/edges/{edge_id}.mp4|.webm``.  Re-uploading overwrites.
    """
    paths.safe_segment(edge_id, "edge_id")
    await _require_persona(user.id, persona_id)

    if not file.content_type or file.content_type not in VALID_VIDEO_TYPES:
        raise HTTPException(status_code=400, detail="File must be video/mp4 or video/webm")

    # Read (bounded) before anything on disk changes, so a refused upload
    # leaves the previous video in place.
    contents = await _read_upload(file, assets.VIDEO_MAX_BYTES, "video")

    ext = ".mp4" if file.content_type == "video/mp4" else ".webm"
    edges = _edges_dir(persona_id)
    edges.mkdir(parents=True, exist_ok=True)

    # Clean up old file with other extension before saving
    for old_ext in (".mp4", ".webm"):
        if old_ext != ext:
            old_path = edges / f"{edge_id}{old_ext}"
            if old_path.exists():
                old_path.unlink()

    path = edges / f"{edge_id}{ext}"
    path.write_bytes(contents)

    asset_url = f"{persona_id}/edges/{edge_id}"
    return {
        "asset_id": asset_url,
        "video_url": f"/character-assets/{asset_url}",
    }


@router.post("/{persona_id}/migrate-ids")
async def migrate_ids(
    persona_id: int,
    body: MigrateIdsRequest,
    user: User = Depends(get_authenticated_user)
):
    """Rename pose folders and edge video files when migrating to new short hex IDs.

    Accepts a mapping of old_id → new_id. Renames:
    - Pose folders: ``{persona_id}/{old_node_id}/`` → ``{persona_id}/{new_node_id}/``
    - Edge video files: replaces old node IDs in filenames under ``edges/``
    """
    id_mapping = body.id_mapping
    for old_id, new_id in id_mapping.items():
        paths.safe_segment(old_id, "id")
        paths.safe_segment(new_id, "id")
    await _require_persona(user.id, persona_id)

    if not id_mapping:
        return {"message": "No IDs to migrate"}

    persona_dir = paths.persona_dir(persona_id)
    if not persona_dir.exists():
        return {"message": "No assets to migrate"}

    # Rename pose folders (old_node_id → new_node_id)
    for old_id, new_id in id_mapping.items():
        old_dir = persona_dir / old_id
        new_dir = persona_dir / new_id
        if old_dir.exists() and old_dir.is_dir():
            if new_dir.exists():
                # Merge into existing (shouldn't happen, but be safe)
                for f in old_dir.iterdir():
                    shutil.move(str(f), str(new_dir / f.name))
                old_dir.rmdir()
            else:
                old_dir.rename(new_dir)
            logger.info("Migrated pose folder: %s → %s", old_id, new_id)

    # Rename edge video files under edges/
    edges_dir = _edges_dir(persona_id)
    if edges_dir.exists():
        for video_file in list(edges_dir.iterdir()):
            if not video_file.is_file():
                continue
            old_name = video_file.stem  # e.g. "edge-pose-xxx-pose-yyy_t0_0"
            new_name = old_name
            for old_id, new_id in id_mapping.items():
                new_name = new_name.replace(old_id, new_id)
            # Also strip "edge-" prefix if present
            if new_name.startswith("edge-"):
                new_name = new_name[5:]
            if new_name != old_name:
                new_path = video_file.with_name(new_name + video_file.suffix)
                video_file.rename(new_path)
                logger.info("Migrated edge video: %s → %s", video_file.name, new_path.name)

    return {"message": f"Migrated {len(id_mapping)} IDs"}


# ─── VRM model and clips (#236) ───
# Declared before the serving routes below: "/{persona_id}/vrm/model" and
# "/{persona_id}/vrma/{clip_id}" have the generic pose route's shape, and FastAPI
# matches in declaration order ("vrm" and "vrma" are reserved segments too, so
# the generic route would refuse them rather than serve them).

_SHA256 = r"^[0-9a-f]{64}$"
_CLIP_ID = r"^[0-9a-f]{8}$"


class _Gone(Exception):
    """The persona was deleted while the bytes were arriving."""


class _OverQuota(Exception):
    """The bytes arrived but no longer fit — measured inside the write transaction."""

    def __init__(self, used: int):
        self.used = used


class ClipUpdate(BaseModel):
    name: Optional[str] = None
    loop: Optional[bool] = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _account_usage(user_id: int) -> tuple[int, list[dict], Optional[dict]]:
    """``(used, per_persona, configs_by_id)`` from the stored refs."""
    def _read(session):
        personas = PersonaRepository(session).list_by_user(user_id)
        used, per = assets.account_usage(personas)
        return used, per, {p.id: p.character_config for p in personas}

    return await get_db_service().execute(_read)


async def _stream_upload(
    user_id: int, persona_id: int, request: Request, max_bytes: int, what: str, reclaimable
) -> tuple[Path, int, str]:
    """Stream the body into the persona's ``.incoming``; returns ``(temp, size, sha256)``.

    The quota check here is advisory — it only saves the transfer of a file
    that could never fit. The binding check is in the write transaction.
    ``reclaimable(config)`` is the bytes this upload would release (the model it
    replaces), counted back in.
    """
    used, _per, configs = await _account_usage(user_id)
    # Checked again here, right before a directory is created: a persona
    # deleted since the route's ownership check must not get a fresh
    # `.incoming` under a directory its delete just removed.
    if persona_id not in configs:
        raise HTTPException(status_code=404, detail="Persona not found")
    remaining = assets.QUOTA_BYTES - used + reclaimable(configs.get(persona_id))
    if remaining <= 0:
        raise assets.over_quota(used, assets.QUOTA_BYTES)

    incoming = paths.persona_dir(persona_id) / paths.INCOMING_DIR_NAME
    await anyio.to_thread.run_sync(lambda: incoming.mkdir(parents=True, exist_ok=True))
    await anyio.to_thread.run_sync(sweep_incoming, incoming)
    temp = incoming / uuid.uuid4().hex
    size, digest = await write_stream(
        temp,
        request.stream(),
        max_bytes,
        remaining,
        too_large=lambda: assets.too_large(max_bytes, what),
        over_quota=lambda: assets.over_quota(used, assets.QUOTA_BYTES),
    )
    return temp, size, digest


def _discard(temp: Path) -> None:
    temp.unlink(missing_ok=True)


def _commit_ref(user_id: int, persona_id: int, size: int, reclaimed, update):
    """The write transaction: re-read, re-measure, record the ref. Runs on the DB thread."""
    def _persist(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user_id, persona_id)
        if persona is None:
            raise _Gone()
        # Measured again here, not trusted from before the stream: every
        # `_persist` runs on the single database thread, so this check and the
        # write below are atomic with respect to every other upload.
        used, _per = assets.account_usage(repo.list_by_user(user_id))
        if used - reclaimed(persona.character_config) + size > assets.QUOTA_BYTES:
            raise _OverQuota(used)
        config = assets.with_vrm(persona.character_config, update)
        repo.update_persona(persona, character_config=config)
        return persona.character_config

    return _persist


def _check_digest(expected: str, actual: str) -> None:
    if expected != actual:
        raise assets.refusal(
            400, "digest_mismatch",
            "The file changed on the way. Try the upload again.",
        )


async def _place(temp: Path, final: Path) -> None:
    def _move():
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(str(temp), str(final))

    await anyio.to_thread.run_sync(_move)


@router.get("/usage")
async def get_character_usage(user: User = Depends(get_authenticated_user)):
    """How much of the account's 3D character storage is used, from the stored refs.

    The shape of ``GET /drive/usage``. Pose art is not metered and not counted.
    """
    used, per, _configs = await _account_usage(user.id)
    return {
        "used_bytes": used,
        "quota_bytes": assets.QUOTA_BYTES,
        "max_model_bytes": assets.MODEL_MAX_BYTES,
        "max_clip_bytes": assets.CLIP_MAX_BYTES,
        "per_persona": per,
    }


@router.put("/{persona_id}/vrm/model")
async def upload_vrm_model(
    persona_id: int,
    request: Request,
    sha256: str = Query(..., pattern=_SHA256),
    filename: Optional[str] = Query(None),
    user: User = Depends(get_authenticated_user),
):
    """Upload (or replace) a persona's VRM model: the raw body, streamed.

    ``?sha256=`` is the digest the client computed; a body that does not hash
    to it is refused (400) and nothing is stored. The file must be a glTF 2.0
    binary with a VRM (0.x) or VRMC_vrm (1.0) extension and a humanoid with
    hips (415 otherwise), within ``CHARACTER_MODEL_MAX_BYTES`` (413) and the
    account's ``CHARACTER_ASSETS_QUOTA_BYTES`` (507). Any kind of persona may
    hold a model: uploading one does not change what shows.

    The ref — url, sha256, bytes, filename, spec version, the faces the model
    has — is written into ``character_config`` in the transaction that accepts
    it, and the file is moved into place after the commit, under the persona's
    lock. Returns the ref's fields, the model's meta and the stored config.
    """
    await _require_persona(user.id, persona_id)
    reclaimed = lambda config: assets.persona_bytes(  # noqa: E731
        {"vrm": {"model": assets.stored_model(config)}}
    )
    temp, size, digest = await _stream_upload(
        user.id, persona_id, request, assets.MODEL_MAX_BYTES, "model", reclaimed
    )
    try:
        _check_digest(sha256, digest)
        info = await anyio.to_thread.run_sync(assets.inspect_model_file, temp)
        ref = {
            "url": assets.model_url(persona_id),
            "sha256": digest,
            "bytes": size,
            "uploaded_at": _now(),
            "filename": assets.display_filename(filename, "model.vrm"),
            "spec_version": info.spec_version,
            "expressions": info.expressions,
        }

        def _update(vrm):
            vrm["model"] = ref

        persona_dir = paths.persona_dir(persona_id)
        final = assets.model_path(persona_dir, digest)
        async with persona_lock(persona_id):
            # Under the lock nothing can delete the persona or change its model,
            # so what is read here stays true until the lock is released.
            previous = assets.stored_model_path(persona_dir, assets.stored_model(
                await _require_persona(user.id, persona_id)
            ))
            # Placed *before* the ref is committed: the file is content-addressed,
            # so no served ref names it until the commit, and once the commit
            # lands every GET resolves the new ref to bytes already in place.
            await _place(temp, final)
            try:
                config = await get_db_service().execute(
                    _commit_ref(user.id, persona_id, size, reclaimed, _update)
                )
            except (_Gone, _OverQuota):
                # Refused inside the transaction: nothing was committed.
                if final != previous:
                    await anyio.to_thread.run_sync(lambda: final.unlink(missing_ok=True))
                raise
            except BaseException:
                # The commit may or may not have landed (a timeout waiting for the
                # database thread says nothing about the thread itself). Keep the
                # new file unless the row says it is unreferenced; if it is, the
                # next config save's sweep reclaims it.
                if final != previous and not await _names_model(user.id, persona_id, digest):
                    await anyio.to_thread.run_sync(lambda: final.unlink(missing_ok=True))
                raise
            if previous is not None and previous != final:
                await anyio.to_thread.run_sync(lambda: previous.unlink(missing_ok=True))
    except FileNotFoundError:
        # The persona was deleted while the bytes arrived: its directory, and
        # the part-file in it, went with it.
        raise HTTPException(status_code=404, detail="Persona not found")
    except _Gone:
        raise HTTPException(status_code=404, detail="Persona not found")
    except _OverQuota as over:
        raise assets.over_quota(over.used, assets.QUOTA_BYTES)
    finally:
        await anyio.to_thread.run_sync(_discard, temp)

    return {
        "model_url": ref["url"],
        "sha256": digest,
        "bytes": size,
        "uploaded_at": ref["uploaded_at"],
        "meta": info.meta,
        "character_config": config,
    }


async def _names_model(user_id: int, persona_id: int, sha256: str) -> bool:
    """Whether the stored model ref names this digest; ``True`` when that cannot be read."""
    try:
        config = await _require_persona(user_id, persona_id)
    except HTTPException:
        return False
    except Exception:  # noqa: BLE001 — unknown means keep the file, never unlink it
        return True
    model = assets.stored_model(config)
    return bool(model) and model.get("sha256") == sha256


@router.delete("/{persona_id}/vrm/model", status_code=204)
async def delete_vrm_model(persona_id: int, user: User = Depends(get_authenticated_user)):
    """Remove a persona's VRM model: the ref, then the file. Its settings stay.

    204 whether or not there was one.
    """
    await _require_persona(user.id, persona_id)

    def _clear(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="Persona not found")
        model = assets.stored_model(persona.character_config)
        if model is None:
            return None

        def _update(vrm):
            vrm["model"] = None

        repo.update_persona(persona, character_config=assets.with_vrm(persona.character_config, _update))
        return assets.stored_model_path(paths.persona_dir(persona_id), model)

    async with persona_lock(persona_id):
        target = await get_db_service().execute(_clear)
        if target is not None:
            await anyio.to_thread.run_sync(lambda: target.unlink(missing_ok=True))
    return Response(status_code=204)


@router.put("/{persona_id}/vrma")
async def upload_vrm_clip(
    persona_id: int,
    request: Request,
    sha256: str = Query(..., pattern=_SHA256),
    name: Optional[str] = Query(None),
    loop: bool = Query(False),
    user: User = Depends(get_authenticated_user),
):
    """Add a VRMA clip to a persona: the raw body, streamed.

    Same digest, size and quota rules as the model, ``CHARACTER_CLIP_MAX_BYTES``
    per file; the file must carry ``VRMC_vrm_animation`` (415 otherwise). The
    clip id is generated here — a request never names a path. Returns the clip
    ref and the stored config.
    """
    await _require_persona(user.id, persona_id)
    nothing = lambda config: 0  # noqa: E731 — a new clip replaces nothing
    temp, size, digest = await _stream_upload(
        user.id, persona_id, request, assets.CLIP_MAX_BYTES, "animation", nothing
    )
    try:
        _check_digest(sha256, digest)
        await anyio.to_thread.run_sync(assets.inspect_clip_file, temp)
        created: dict = {}

        def _update(vrm):
            clips = [c for c in (vrm.get("clips") or []) if isinstance(c, dict)]
            taken = {c.get("id") for c in clips}
            clip_id = uuid.uuid4().hex[:8]
            while clip_id in taken:
                clip_id = uuid.uuid4().hex[:8]
            clip = {
                "id": clip_id,
                "name": assets.display_filename(name, "animation"),
                "url": assets.clip_url(persona_id, clip_id),
                "sha256": digest,
                "bytes": size,
                "loop": bool(loop),
            }
            vrm["clips"] = clips + [clip]
            created.update(clip)

        async with persona_lock(persona_id):
            config = await get_db_service().execute(
                _commit_ref(user.id, persona_id, size, nothing, _update)
            )
            try:
                await _place(temp, assets.clip_path(paths.persona_dir(persona_id), created["id"]))
            except OSError as error:
                logger.error("persona %d: clip accepted but not moved into place: %s", persona_id, error)
                raise internal_error(error, "Error storing the animation")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Persona not found")
    except _Gone:
        raise HTTPException(status_code=404, detail="Persona not found")
    except _OverQuota as over:
        raise assets.over_quota(over.used, assets.QUOTA_BYTES)
    finally:
        await anyio.to_thread.run_sync(_discard, temp)

    return {"clip": dict(created), "character_config": config}


def _clip_id(clip_id: str) -> str:
    """A clip id is eight lowercase hex digits, generated here; anything else names no clip."""
    if not re.fullmatch(_CLIP_ID, clip_id):
        raise HTTPException(status_code=400, detail="Invalid clip_id.")
    return clip_id


@router.patch("/{persona_id}/vrma/{clip_id}")
async def update_vrm_clip(
    persona_id: int,
    clip_id: str,
    body: ClipUpdate,
    user: User = Depends(get_authenticated_user),
):
    """Rename a clip or change whether it loops — the two fields of a clip ref a user edits."""
    _clip_id(clip_id)
    await _require_persona(user.id, persona_id)
    updated: dict = {}

    def _patch(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="Persona not found")
        if not any(c.get("id") == clip_id for c in assets.stored_clips(persona.character_config)):
            raise HTTPException(status_code=404, detail="Clip not found")

        def _update(vrm):
            clips = []
            for clip in vrm.get("clips") or []:
                if isinstance(clip, dict) and clip.get("id") == clip_id:
                    clip = dict(clip)
                    if body.name is not None:
                        clip["name"] = assets.display_filename(body.name, clip.get("name") or "animation")
                    if body.loop is not None:
                        clip["loop"] = body.loop
                    updated.update(clip)
                clips.append(clip)
            vrm["clips"] = clips

        repo.update_persona(persona, character_config=assets.with_vrm(persona.character_config, _update))
        return persona.character_config

    config = await get_db_service().execute(_patch)
    return {"clip": dict(updated), "character_config": config}


@router.delete("/{persona_id}/vrma/{clip_id}", status_code=204)
async def delete_vrm_clip(persona_id: int, clip_id: str, user: User = Depends(get_authenticated_user)):
    """Remove a clip: the ref, then the file.

    409 ``clip_in_use`` while the idle rotation or a reaction still plays it —
    the editor takes those references out first, so a save can never be left
    naming a clip that is gone.
    """
    _clip_id(clip_id)
    await _require_persona(user.id, persona_id)

    def _remove(session):
        repo = PersonaRepository(session)
        persona = repo.get_by_user_and_id(user.id, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="Persona not found")
        config = persona.character_config
        if not any(c.get("id") == clip_id for c in assets.stored_clips(config)):
            raise HTTPException(status_code=404, detail="Clip not found")
        if assets.clip_in_use(config, clip_id):
            raise assets.refusal(
                409, "clip_in_use",
                "That animation still plays while idle or in a reaction. Turn those off first.",
            )

        def _update(vrm):
            vrm["clips"] = [c for c in (vrm.get("clips") or []) if not (isinstance(c, dict) and c.get("id") == clip_id)]

        repo.update_persona(persona, character_config=assets.with_vrm(config, _update))

    async with persona_lock(persona_id):
        await get_db_service().execute(_remove)
        target = assets.clip_path(paths.persona_dir(persona_id), clip_id)
        await anyio.to_thread.run_sync(lambda: target.unlink(missing_ok=True))
    return Response(status_code=204)


def _serve_ref(request: Request, ref: Optional[dict], path: Path, missing: str):
    """Serve a stored VRM file with the ETag its ref recorded at upload.

    ``FileResponse`` answers ``Range`` but not ``If-None-Match``, so without the
    explicit 304 every window open would ship the whole model again. The ETag
    comes from the row, never from hashing the file per request, and it cannot
    be stale: the upload wrote both under one lock.
    """
    if not ref or not isinstance(ref.get("sha256"), str):
        raise HTTPException(status_code=404, detail=missing)
    etag = f'"{ref["sha256"]}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if not path.is_file():
        raise HTTPException(status_code=404, detail=missing)
    return FileResponse(path=path, media_type=assets.MEDIA_TYPE, headers=headers)


@router.get("/{persona_id}/vrm/model")
async def get_vrm_model(persona_id: int, request: Request, user: User = Depends(get_authenticated_user)):
    """Serve a persona's VRM model (``model/gltf-binary``), with ``ETag`` and 304."""
    config = await _require_persona(user.id, persona_id)
    ref = assets.stored_model(config)
    # The file is the one the ref's own sha names, so the bytes and the ETag
    # come from the same row and cannot disagree.
    path = assets.stored_model_path(paths.persona_dir(persona_id), ref)
    if path is None:
        raise HTTPException(status_code=404, detail="Model not found")
    return _serve_ref(request, ref, path, "Model not found")


@router.get("/{persona_id}/vrma/{clip_id}")
async def get_vrm_clip(
    persona_id: int, clip_id: str, request: Request, user: User = Depends(get_authenticated_user)
):
    """Serve one of a persona's VRMA clips, with ``ETag`` and 304."""
    _clip_id(clip_id)
    config = await _require_persona(user.id, persona_id)
    ref = next((c for c in assets.stored_clips(config) if c.get("id") == clip_id), None)
    return _serve_ref(
        request, ref, assets.clip_path(paths.persona_dir(persona_id), clip_id), "Clip not found",
    )


# ─── Serving endpoints ───
# Order matters: edges route must come before the generic pose asset route
# so that "edges" is not matched as a pose_id.

@router.get("/{persona_id}/edges/{edge_id}")
async def get_edge_video(
    persona_id: int,
    edge_id: str,
    user: User = Depends(get_authenticated_user)
):
    """Serve a transition video for an animation edge.

    Authenticated and ownership-checked like every other route in this file.
    These two serving routes were not, so any persona's character assets could be
    read by walking the sequential persona ids.
    """
    paths.safe_segment(edge_id, "edge_id")
    await _require_persona(user.id, persona_id)
    edges = _edges_dir(persona_id)
    for ext, media_type in [(".mp4", "video/mp4"), (".webm", "video/webm")]:
        path = edges / f"{edge_id}{ext}"
        if path.exists():
            return FileResponse(
                path=path,
                media_type=media_type,
                headers={"Cache-Control": "no-cache"},
            )
    raise HTTPException(status_code=404, detail="Edge video not found")


@router.get("/{persona_id}/{pose_id}/{filename}")
async def get_pose_asset(
    persona_id: int,
    pose_id: str,
    filename: str,
    user: User = Depends(get_authenticated_user)
):
    """Serve a pose asset (base image or patch)."""
    paths.safe_segment(pose_id, "pose_id")
    paths.safe_segment(filename, "filename")
    await _require_persona(user.id, persona_id)
    pose = _pose_dir(persona_id, pose_id)
    for ext, media_type in [(".png", "image/png"), (".jpg", "image/jpeg")]:
        path = pose / f"{filename}{ext}"
        if path.exists():
            return FileResponse(
                path=path,
                media_type=media_type,
                headers={"Cache-Control": "no-cache"},
            )
    raise HTTPException(status_code=404, detail="Pose asset not found")


# ─── Config ───

@router.patch("/{persona_id}/character-config")
async def update_character_config(
    persona_id: int,
    config: dict,
    user: User = Depends(get_authenticated_user)
):
    """Save a persona's character config: which system it uses, and that system's settings.

    The body is merged over what is stored, member by member (``kind`` replaced;
    ``pose_tree`` and ``vrm`` kept when absent, cleared when ``null``), so the
    graph editor's autosave cannot erase VRM settings it knows nothing about.
    Files the merged config no longer references are removed — after the row is
    written, and only when the config could be classified. A body without a
    recognised ``kind``, a member that is not the shape the clients write, or a
    member pointing at another persona's assets is refused with 422 — the detail
    names the member and the cause — and nothing on disk is touched
    (``kurisuassistant/character/``).
    """
    await _require_persona(user.id, persona_id)
    planned: dict = {}

    def _update_config(session):
        persona_repo = PersonaRepository(session)
        persona = persona_repo.get_by_user_and_id(user.id, persona_id)

        if not persona:
            raise HTTPException(status_code=404, detail="Persona not found")

        plan = plan_character_config(persona_id, config, persona.character_config)
        planned["referenced"] = plan.referenced
        persona = persona_repo.update_persona(persona, character_config=plan.config)
        return {
            "message": "Character config updated",
            "character_config": persona.character_config,
        }

    db = get_db_service()
    async with persona_lock(persona_id):
        result = await db.execute(_update_config)
        await cleanup_after_write(persona_id, planned["referenced"])
    return result
