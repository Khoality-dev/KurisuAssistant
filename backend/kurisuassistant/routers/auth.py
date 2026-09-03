"""Authentication routes: login, register, and token refresh."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

from kurisuassistant.core.security import (
    create_access_token,
    create_refresh_token,
    verify_password,
    verify_refresh_token,
    hash_password,
)
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import UserRepository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])


def _make_token_response(username: str) -> dict:
    """Create standard auth response with access + refresh tokens."""
    return {
        "access_token": create_access_token({"sub": username}),
        "refresh_token": create_refresh_token({"sub": username}),
        "token_type": "bearer",
    }


@router.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """Authenticate user and return access + refresh tokens."""
    def _login(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(form_data.username)
        if not user or not verify_password(form_data.password, user.password):
            raise HTTPException(status_code=400, detail="Incorrect username or password")
        return user.username

    db = get_db_service()
    username = await db.execute(_login)
    return _make_token_response(username)


@router.post("/register")
async def register(form_data: OAuth2PasswordRequestForm = Depends()):
    """Register a new user account and return tokens."""
    try:
        db = get_db_service()
        await db.execute(lambda s: UserRepository(s).create_user(
            form_data.username, hash_password(form_data.password),
        ))
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
        logger.error(f"Error registering user {form_data.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

    return _make_token_response(form_data.username)


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/auth/refresh")
async def refresh(body: RefreshRequest):
    """Exchange a valid refresh token for a new access token."""
    username = verify_refresh_token(body.refresh_token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Verify user still exists
    def _check(session):
        return UserRepository(session).get_by_username(username) is not None

    db = get_db_service()
    if not await db.execute(_check):
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "access_token": create_access_token({"sub": username}),
        "token_type": "bearer",
    }
