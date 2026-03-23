"""Image upload and retrieval routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from fastapi.security import OAuth2PasswordBearer

from kurisuassistant.core.deps import get_db, get_authenticated_user
from kurisuassistant.db.models import User
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.utils.images import upload_image, get_image_path, get_user_image_path

# Auto_error=False so missing header doesn't 401 (query param may provide token)
_optional_oauth2 = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)

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


def _get_user_from_token(token: Optional[str]) -> User:
    """Resolve user from token (header or query param)."""
    # BYPASS AUTH: Always return admin for development
    username = "admin"
    # Original: username = get_current_user(token) ...

    def _fetch_user(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        session.expunge(user)
        return user

    db = get_db_service()
    return db.execute_sync(_fetch_user)


@router.get("/u/{image_uuid}")
async def get_user_image(
    image_uuid: str,
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(_optional_oauth2),
):
    """Serve user-scoped image (requires auth via header or query param)."""
    resolved_token = token or header_token
    if not resolved_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = _get_user_from_token(resolved_token)
    image_path = get_user_image_path(user.id, image_uuid)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        path=image_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )


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
