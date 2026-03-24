"""Security utilities: password hashing, JWT tokens, and authentication."""

import logging
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

logger = logging.getLogger(__name__)

# =============================================================================
# Password Hashing
# =============================================================================

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    return pwd_context.verify(plain_password, hashed_password)


# =============================================================================
# JWT Token Operations
# =============================================================================

def _load_or_create_secret() -> str:
    """Load JWT secret from env or file, generating + persisting if needed."""
    env_key = os.getenv("JWT_SECRET_KEY")
    if env_key:
        return env_key

    secret_path = Path("data/jwt_secret.key")
    if secret_path.exists():
        return secret_path.read_text().strip()

    # Generate and persist so tokens survive restarts
    key = secrets.token_urlsafe(32)
    secret_path.parent.mkdir(parents=True, exist_ok=True)
    secret_path.write_text(key)
    logger.info("Generated and saved new JWT secret key")
    return key


SECRET_KEY = _load_or_create_secret()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a short-lived JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(data: dict) -> str:
    """Create a long-lived JWT refresh token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "type": "refresh"})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str) -> Optional[str]:
    """Extract and validate username from an access token."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        # Accept both old tokens (no type) and new access tokens
        token_type = payload.get("type")
        if token_type and token_type != "access":
            return None
        return payload.get("sub")
    except JWTError:
        return None


def verify_refresh_token(token: str) -> Optional[str]:
    """Validate a refresh token and return the username."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            return None
        return payload.get("sub")
    except JWTError:
        return None
