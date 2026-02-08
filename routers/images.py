"""Image upload and retrieval routes."""

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from utils.images import upload_image, get_image_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/images", tags=["images"])


@router.post("")
async def create_image(
    file: UploadFile = File(...),
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Upload image and return UUID."""
    image_uuid = upload_image(file)
    return {"image_uuid": image_uuid, "url": f"/images/{image_uuid}"}


@router.get("/{image_uuid}")
async def get_image(image_uuid: str):
    """Serve image publicly."""
    image_path = get_image_path(image_uuid)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    media_type = "image/jpeg" if image_path.suffix.lower() == ".jpg" else "image/png"

    return FileResponse(
        path=image_path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )
