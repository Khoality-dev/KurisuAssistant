"""Image upload and retrieval routes."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from fastapi.security import OAuth2PasswordBearer

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL
from kurisuassistant.core.image_access import references_image
from kurisuassistant.core.security import get_current_user
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
    user: User = Depends(get_authenticated_user)
):
    """Upload image and return UUID.

    The file lands in the uploader's own directory, so it is theirs to fetch back
    immediately — before anything references it.
    """
    image_uuid = upload_image(file, user.id)
    return {"image_uuid": image_uuid, "url": f"/images/{image_uuid}"}


async def _get_user_from_token(token: Optional[str]) -> User:
    """Resolve and verify the caller from an access token (header or query param).

    The token is verified exactly as `get_authenticated_user` verifies it; the
    query-param variant exists only because `<img src=...>` cannot send an
    Authorization header.
    """
    username = get_current_user(token) if token else None
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    def _fetch_user(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        # This router does its own token resolution, so the activation gate in
        # `get_authenticated_user` never sees these calls. A gate with a hole in
        # it is worse than none, because it is trusted.
        if not user.is_active:
            raise HTTPException(status_code=403, detail=ACCOUNT_INACTIVE_DETAIL)
        session.expunge(user)
        return user

    db = get_db_service()
    return await db.execute(_fetch_user)


@router.get("/u/{image_uuid}")
async def get_user_image(
    image_uuid: str,
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(_optional_oauth2)
):
    """Serve user-scoped image (requires auth via header or query param)."""
    resolved_token = token or header_token
    if not resolved_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await _get_user_from_token(resolved_token)
    image_path = get_user_image_path(user.id, image_uuid)
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(
        path=image_path,
        media_type="image/jpeg",
        # Private: the URL is account-scoped, so a shared cache holding the
        # response would hand it to the next caller of the same URL.
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.get("/{image_uuid}")
async def get_image(
    image_uuid: str,
    token: Optional[str] = Query(None),
    header_token: Optional[str] = Depends(_optional_oauth2),
):
    """Serve an avatar or face photo, to the account it belongs to.

    This used to be public — its docstring said so — which put every account
    avatar, persona avatar and face photo one guessed-or-overheard UUID away from
    anybody who could reach the port. UUIDs are not secrets: they travel in API
    responses, through proxy logs and into browser history (#154).

    Auth matches ``/images/u/`` exactly, header or ``?token=``, because the
    callers are ``<img src=...>`` tags that cannot set a header. Ownership is
    settled by the directory for anything uploaded since, and by the referencing
    row for anything older.

    A UUID the caller may not see is **404, not 403**: telling them it exists is
    the same leak in a smaller envelope.
    """
    resolved_token = token or header_token
    if not resolved_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await _get_user_from_token(resolved_token)

    image_path = get_user_image_path(user.id, image_uuid)
    if not image_path:
        legacy_path = get_image_path(image_uuid)
        if legacy_path:
            db = get_db_service()
            owns = await db.execute(
                lambda session: references_image(session, user.id, image_uuid)
            )
            if owns:
                image_path = legacy_path

    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    media_type = "image/jpeg" if image_path.suffix.lower() == ".jpg" else "image/png"

    return FileResponse(
        path=image_path,
        media_type=media_type,
        # Private: a shared cache must not hand one account's avatar to the next
        # request for the same URL now that the URL is account-scoped.
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
