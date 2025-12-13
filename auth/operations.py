import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from jose import JWTError, jwt

from db import operations

# Security configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", secrets.token_urlsafe(32))
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS", "30"))


def authenticate_user(username: str, password: str) -> bool:
    """Authenticate user with username and password.

    Delegates to db.operations for actual verification.
    """
    return operations.authenticate_user(username, password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token with expiration.

    Args:
        data: Payload data to encode in the token
        expires_delta: Custom expiration time, defaults to ACCESS_TOKEN_EXPIRE_DAYS

    Returns:
        Encoded JWT token string
    """
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)

    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str) -> Optional[str]:
    """Extract and validate username from JWT token.

    Args:
        token: JWT token string

    Returns:
        Username if valid, None if invalid or expired
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: Optional[str] = payload.get("sub")
        return username
    except JWTError:
        return None
