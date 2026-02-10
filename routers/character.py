"""Character animation asset routes for video call mode.

Handles keyframe image uploads, diff patch computation, and character asset serving.
User uploads full keyframe images; backend diffs them against the base to extract
patch regions (bounding box + cropped image).

Folder structure:
  data/character_assets/{agent_id}/{pose_id}/base.png
  data/character_assets/{agent_id}/{pose_id}/{part}_{index}.png
  data/character_assets/{agent_id}/edges/{edge_id}.mp4|.webm
"""

import logging
import shutil
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.models import User
from db.session import get_session
from db.repositories import AgentRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/character-assets", tags=["character"])

# Storage directory for character assets
CHAR_ASSETS_DIR = Path(__file__).parent.parent / "data" / "character_assets"
CHAR_ASSETS_DIR.mkdir(parents=True, exist_ok=True)


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


def _pose_dir(agent_id: int, pose_id: str) -> Path:
    """Return the directory for a specific pose's assets."""
    return CHAR_ASSETS_DIR / str(agent_id) / pose_id


def _edges_dir(agent_id: int) -> Path:
    """Return the directory for an agent's edge transition videos."""
    return CHAR_ASSETS_DIR / str(agent_id) / "edges"


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
    agent_id: int,
    pose_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> UploadBaseResponse:
    """Upload a base portrait image for a character pose.

    Saved to ``{agent_id}/{pose_id}/base.png``.  Re-uploading overwrites.
    """
    with get_session() as session:
        agent_repo = AgentRepository(session)
        if not agent_repo.get_by_user_and_id(user.id, agent_id):
            raise HTTPException(status_code=404, detail="Agent not found")

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image format")

    path = _pose_dir(agent_id, pose_id) / "base.png"
    _save_image(image, path)

    asset_id = f"{agent_id}/{pose_id}/base"
    return UploadBaseResponse(
        asset_id=asset_id,
        image_url=f"/character-assets/{asset_id}",
    )


VALID_PARTS = {"left_eye", "right_eye", "mouth"}


@router.post("/compute-patch")
async def compute_patch(
    agent_id: int,
    pose_id: str,
    part: str,
    index: int,
    keyframe: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> ComputePatchResponse:
    """Upload a keyframe image and compute the diff patch against the pose's base image.

    The keyframe should be the same image as the base but with one region
    modified (e.g., eyes half-closed, mouth open). The backend computes
    the difference, extracts the changed region, and stores it as a patch.

    Saved to ``{agent_id}/{pose_id}/{part}_{index}.png``.
    """
    if part not in VALID_PARTS:
        raise HTTPException(
            status_code=400, detail=f"part must be one of: {', '.join(sorted(VALID_PARTS))}"
        )

    with get_session() as session:
        agent_repo = AgentRepository(session)
        if not agent_repo.get_by_user_and_id(user.id, agent_id):
            raise HTTPException(status_code=404, detail="Agent not found")

    # Load base image from the pose directory
    base_path = _pose_dir(agent_id, pose_id) / "base.png"
    base = _load_image(base_path)
    if base is None:
        raise HTTPException(status_code=404, detail="Base image not found for this pose")

    # Decode keyframe
    if not keyframe.content_type or not keyframe.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    contents = await keyframe.read()
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
    patch_path = _pose_dir(agent_id, pose_id) / f"{part}_{index}.png"
    _save_image(result["patch_image"], patch_path)

    patch_url_path = f"{agent_id}/{pose_id}/{part}_{index}"
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
    agent_id: int,
    edge_id: str,
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Upload a transition video for an animation edge.

    Saved to ``{agent_id}/edges/{edge_id}.mp4|.webm``.  Re-uploading overwrites.
    """
    with get_session() as session:
        agent_repo = AgentRepository(session)
        if not agent_repo.get_by_user_and_id(user.id, agent_id):
            raise HTTPException(status_code=404, detail="Agent not found")

    if not file.content_type or file.content_type not in VALID_VIDEO_TYPES:
        raise HTTPException(status_code=400, detail="File must be video/mp4 or video/webm")

    ext = ".mp4" if file.content_type == "video/mp4" else ".webm"
    edges = _edges_dir(agent_id)
    edges.mkdir(parents=True, exist_ok=True)

    # Clean up old file with other extension before saving
    for old_ext in (".mp4", ".webm"):
        if old_ext != ext:
            old_path = edges / f"{edge_id}{old_ext}"
            if old_path.exists():
                old_path.unlink()

    contents = await file.read()
    path = edges / f"{edge_id}{ext}"
    path.write_bytes(contents)

    asset_url = f"{agent_id}/edges/{edge_id}"
    return {
        "asset_id": asset_url,
        "video_url": f"/character-assets/{asset_url}",
    }


# ─── Serving endpoints ───
# Order matters: edges route must come before the generic pose asset route
# so that "edges" is not matched as a pose_id.

@router.get("/{agent_id}/edges/{edge_id}")
async def get_edge_video(agent_id: int, edge_id: str):
    """Serve a transition video for an animation edge."""
    edges = _edges_dir(agent_id)
    for ext, media_type in [(".mp4", "video/mp4"), (".webm", "video/webm")]:
        path = edges / f"{edge_id}{ext}"
        if path.exists():
            return FileResponse(
                path=path,
                media_type=media_type,
                headers={"Cache-Control": "no-cache"},
            )
    raise HTTPException(status_code=404, detail="Edge video not found")


@router.get("/{agent_id}/{pose_id}/{filename}")
async def get_pose_asset(agent_id: int, pose_id: str, filename: str):
    """Serve a pose asset (base image or patch)."""
    pose = _pose_dir(agent_id, pose_id)
    for ext, media_type in [(".png", "image/png"), (".jpg", "image/jpeg")]:
        path = pose / f"{filename}{ext}"
        if path.exists():
            return FileResponse(
                path=path,
                media_type=media_type,
                headers={"Cache-Control": "no-cache"},
            )
    raise HTTPException(status_code=404, detail="Pose asset not found")


# ─── Cleanup helpers ───

def _extract_referenced_paths(config: Optional[dict]) -> set[str]:
    """Extract all referenced asset paths from a character config.

    Returns paths relative to the /character-assets/ URL prefix, without extensions.
    E.g. {"1/pose-default/base", "1/pose-default/left_eye_0", "1/edges/edge-abc"}
    """
    paths = set()
    if not config or "pose_tree" not in config:
        return paths
    pose_tree = config.get("pose_tree", {})
    for node in pose_tree.get("nodes", []):
        pc = node.get("pose_config")
        if not pc:
            continue
        url = pc.get("base_image_url", "")
        if url.startswith("/character-assets/"):
            paths.add(url[len("/character-assets/"):])
        for part_key in ("left_eye", "right_eye", "mouth"):
            for patch in pc.get(part_key, {}).get("patches", []):
                purl = patch.get("image_url", "")
                if purl.startswith("/character-assets/"):
                    paths.add(purl[len("/character-assets/"):])
    for edge in pose_tree.get("edges", []):
        # Support both video_urls (array) and legacy video_url (string)
        vurl = edge.get("video_url", "")
        if vurl and vurl.startswith("/character-assets/"):
            paths.add(vurl[len("/character-assets/"):])
        for vurl in edge.get("video_urls", []):
            if vurl and vurl.startswith("/character-assets/"):
                paths.add(vurl[len("/character-assets/"):])
    return paths


def _file_to_ref_path(file_path: Path, agent_id: int) -> str:
    """Convert a disk file path to the reference path (relative, no extension).

    E.g. data/character_assets/1/pose-default/base.png → "1/pose-default/base"
    Uses forward slashes (POSIX) to match URL paths regardless of OS.
    """
    agent_dir = CHAR_ASSETS_DIR / str(agent_id)
    rel = file_path.relative_to(agent_dir).with_suffix('')
    return f"{agent_id}/{rel.as_posix()}"


def _cleanup_agent_assets(agent_id: int, referenced_paths: set[str]) -> None:
    """Delete unreferenced files under an agent's asset directory and clean up empty dirs."""
    agent_dir = CHAR_ASSETS_DIR / str(agent_id)
    if not agent_dir.exists():
        return

    for file_path in agent_dir.rglob("*"):
        if not file_path.is_file():
            continue
        ref_path = _file_to_ref_path(file_path, agent_id)
        if ref_path not in referenced_paths:
            file_path.unlink()
            logger.debug("Deleted orphaned character asset: %s", file_path)

    # Clean up empty directories (bottom-up)
    for dir_path in sorted(agent_dir.rglob("*"), reverse=True):
        if dir_path.is_dir() and not any(dir_path.iterdir()):
            dir_path.rmdir()
            logger.debug("Removed empty directory: %s", dir_path)


@router.patch("/{agent_id}/character-config")
async def update_character_config(
    agent_id: int,
    config: dict,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
):
    """Update an agent's character animation config (pose tree).

    Automatically cleans up orphaned asset files when the config changes
    (e.g., old base images and patches no longer referenced).
    """
    with get_session() as session:
        agent_repo = AgentRepository(session)
        agent = agent_repo.get_by_user_and_id(user.id, agent_id)

        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        agent = agent_repo.update_agent(agent, character_config=config)
        new_refs = _extract_referenced_paths(config)
        _cleanup_agent_assets(agent_id, new_refs)

        return {"message": "Character config updated", "character_config": agent.character_config}
