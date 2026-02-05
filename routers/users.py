"""User profile management routes."""

import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.session import get_session
from db.models import User
from db.repositories import UserRepository
from utils.images import upload_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me")
async def get_user_profile(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Get current user profile."""
    try:
        return {
            "username": user.username,
            "system_prompt": user.system_prompt or "",
            "preferred_name": user.preferred_name or "",
            "user_avatar_uuid": user.user_avatar_uuid,
            "agent_avatar_uuid": user.agent_avatar_uuid
        }
    except Exception as e:
        logger.error(f"Error fetching user profile for {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/me")
async def update_user_profile(
    request: Request,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Update user profile fields (text only)."""
    try:
        body = await request.json()
        system_prompt = body.get("system_prompt")
        preferred_name = body.get("preferred_name")

        if system_prompt is not None or preferred_name is not None:
            with get_session() as session:
                user_repo = UserRepository(session)
                # Re-fetch user within session context
                db_user = user_repo.get_by_id(user.id)
                if not db_user:
                    raise ValueError(f"User {user.username} not found")
                user_repo.update_preferences(db_user, system_prompt, preferred_name)

            return {"status": "ok", "message": "Profile updated successfully"}
        else:
            return {"status": "ok", "message": "No changes"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating user profile for {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/me/avatars")
async def update_user_avatars(
    user_avatar: UploadFile = File(None),
    agent_avatar: UploadFile = File(None),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Update user and/or agent avatar images."""
    try:
        updated_avatars = {}

        with get_session() as session:
            user_repo = UserRepository(session)
            # Re-fetch user within session context
            db_user = user_repo.get_by_id(user.id)
            if not db_user:
                raise HTTPException(status_code=404, detail="User not found")

            # Handle user avatar
            if user_avatar is not None and user_avatar.filename:
                try:
                    file_size = user_avatar.size if hasattr(user_avatar, 'size') else 0
                    if file_size > 0:
                        user_avatar_uuid = upload_image(user_avatar)
                        user_repo.update_avatar(db_user, "user", user_avatar_uuid)
                        updated_avatars["user_avatar_uuid"] = user_avatar_uuid
                    else:
                        user_repo.update_avatar(db_user, "user", None)
                        updated_avatars["user_avatar_uuid"] = None
                except Exception as e:
                    logger.warning(f"Error processing user avatar: {e}")
                    raise HTTPException(status_code=400, detail=f"Invalid user avatar: {e}")

            # Handle agent avatar
            if agent_avatar is not None and agent_avatar.filename:
                try:
                    file_size = agent_avatar.size if hasattr(agent_avatar, 'size') else 0
                    if file_size > 0:
                        agent_avatar_uuid = upload_image(agent_avatar)
                        user_repo.update_avatar(db_user, "agent", agent_avatar_uuid)
                        updated_avatars["agent_avatar_uuid"] = agent_avatar_uuid
                    else:
                        user_repo.update_avatar(db_user, "agent", None)
                        updated_avatars["agent_avatar_uuid"] = None
                except Exception as e:
                    logger.warning(f"Error processing agent avatar: {e}")
                    raise HTTPException(status_code=400, detail=f"Invalid agent avatar: {e}")

            # Get current avatar UUIDs
            user_avatar_uuid, agent_avatar_uuid = user_repo.get_avatars(db_user)

        return {
            "status": "ok",
            "user_avatar_uuid": user_avatar_uuid,
            "agent_avatar_uuid": agent_avatar_uuid
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating avatars for {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
