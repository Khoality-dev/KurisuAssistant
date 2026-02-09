"""Character animation asset routes for video call mode.

Handles keyframe image uploads, diff patch computation, and character asset serving.
User uploads full keyframe images; backend diffs them against the base to extract
patch regions (bounding box + cropped image).
"""

import logging
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

# Storage directory for character assets (base images + patches)
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


def _save_image(image: np.ndarray, asset_id: str, ext: str = ".png") -> None:
    """Save an image array to disk with the given asset ID (overwrites if exists)."""
    path = CHAR_ASSETS_DIR / f"{asset_id}{ext}"
    cv2.imwrite(str(path), image)


def _load_image(asset_id: str) -> Optional[np.ndarray]:
    """Load an image from disk by asset ID."""
    for ext in [".png", ".jpg"]:
        path = CHAR_ASSETS_DIR / f"{asset_id}{ext}"
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
    file: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> UploadBaseResponse:
    """Upload a base portrait image for a character pose.

    Asset ID is deterministic: ``{agent_id}_base``.  Re-uploading overwrites
    the existing file so the URL stays stable.
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

    asset_id = f"{agent_id}_base"
    _save_image(image, asset_id, ".png")

    return UploadBaseResponse(
        asset_id=asset_id,
        image_url=f"/character-assets/{asset_id}",
    )


VALID_PARTS = {"left_eye", "right_eye", "mouth"}


@router.post("/compute-patch")
async def compute_patch(
    base_asset_id: str,
    agent_id: int,
    part: str,
    index: int,
    keyframe: UploadFile = File(...),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> ComputePatchResponse:
    """Upload a keyframe image and compute the diff patch against a base image.

    The keyframe should be the same image as the base but with one region
    modified (e.g., eyes half-closed, mouth open). The backend computes
    the difference, extracts the changed region, and stores it as a patch.

    Asset ID is deterministic: ``{agent_id}_{part}_{index}``.
    """
    if part not in VALID_PARTS:
        raise HTTPException(
            status_code=400, detail=f"part must be one of: {', '.join(sorted(VALID_PARTS))}"
        )

    with get_session() as session:
        agent_repo = AgentRepository(session)
        if not agent_repo.get_by_user_and_id(user.id, agent_id):
            raise HTTPException(status_code=404, detail="Agent not found")

    # Load base image
    base = _load_image(base_asset_id)
    if base is None:
        raise HTTPException(status_code=404, detail="Base image not found")

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

    # Save the patch image with deterministic ID
    patch_asset_id = f"{agent_id}_{part}_{index}"
    _save_image(result["patch_image"], patch_asset_id, ".png")

    return ComputePatchResponse(
        patch=PatchResult(
            image_url=f"/character-assets/{patch_asset_id}",
            x=result["x"],
            y=result["y"],
            width=result["width"],
            height=result["height"],
        )
    )


@router.get("/{asset_id}")
async def get_character_asset(asset_id: str):
    """Serve a character asset image (base or patch)."""
    for ext in [".png", ".jpg"]:
        path = CHAR_ASSETS_DIR / f"{asset_id}{ext}"
        if path.exists():
            media_type = "image/png" if ext == ".png" else "image/jpeg"
            return FileResponse(
                path=path,
                media_type=media_type,
                headers={"Cache-Control": "no-cache"},
            )

    raise HTTPException(status_code=404, detail="Asset not found")


def _extract_asset_ids(config: Optional[dict]) -> set[str]:
    """Extract all character asset IDs referenced in a config."""
    ids = set()
    if not config or "pose_tree" not in config:
        return ids
    for node in config.get("pose_tree", {}).get("nodes", []):
        pc = node.get("pose_config")
        if not pc:
            continue
        url = pc.get("base_image_url", "")
        if url.startswith("/character-assets/"):
            ids.add(url.split("/")[-1])
        for part in ("left_eye", "right_eye", "mouth"):
            for patch in pc.get(part, {}).get("patches", []):
                purl = patch.get("image_url", "")
                if purl.startswith("/character-assets/"):
                    ids.add(purl.split("/")[-1])
    return ids


def _delete_assets(asset_ids: set[str]) -> None:
    """Delete asset files from disk."""
    for asset_id in asset_ids:
        for ext in (".png", ".jpg"):
            path = CHAR_ASSETS_DIR / f"{asset_id}{ext}"
            if path.exists():
                path.unlink()
                logger.info("Deleted orphaned character asset: %s", path.name)


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

        old_ids = _extract_asset_ids(agent.character_config)
        agent = agent_repo.update_agent(agent, character_config=config)
        new_ids = _extract_asset_ids(config)

        orphaned = old_ids - new_ids
        if orphaned:
            _delete_assets(orphaned)

        return {"message": "Character config updated", "character_config": agent.character_config}
