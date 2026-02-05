"""Authentication routes: login and register."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from core.deps import get_db
from core.security import create_access_token, verify_password
from db.session import get_session
from db.repositories import UserRepository

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth"])


@router.post("/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """Authenticate user and return JWT token."""
    with get_session() as session:
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(form_data.username)
        if not user or not verify_password(form_data.password, user.password):
            raise HTTPException(status_code=400, detail="Incorrect username or password")

        token = create_access_token({"sub": form_data.username})
        return {"access_token": token, "token_type": "bearer"}


@router.post("/register")
async def register(form_data: OAuth2PasswordRequestForm = Depends()):
    """Register a new user account."""
    from core.security import hash_password

    try:
        with get_session() as session:
            user_repo = UserRepository(session)
            user_repo.create_user(form_data.username, hash_password(form_data.password))
        return {"status": "ok"}
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
        logger.error(f"Error registering user {form_data.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
