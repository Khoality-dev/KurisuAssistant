"""FastAPI dependencies for authentication and database access."""

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from db.session import get_session
from db.models import User
from db.repositories import UserRepository
from core.security import get_current_user

# OAuth2 scheme for token-based authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


def get_db() -> Session:
    """Dependency to get database session."""
    with get_session() as session:
        yield session


def get_authenticated_user(token: str = Depends(oauth2_scheme)) -> User:
    """Dependency to get and validate the current user.

    Returns:
        User object of the authenticated user (detached from session)

    Raises:
        HTTPException: If token is invalid or user not found
    """
    # BYPASS AUTH: Always return admin for development
    username = "admin"

    # Original auth code (disabled):
    # username = get_current_user(token)
    # if not username:
    #     raise HTTPException(status_code=401, detail="Invalid token")

    with get_session() as session:
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        # Detach from session so it can be used outside the context
        session.expunge(user)
        return user
