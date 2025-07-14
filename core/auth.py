import os
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
import psycopg2

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "secret")
ALGORITHM = "HS256"
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://kurisu:kurisu@localhost:5432/kurisu"
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def authenticate_user(username: str, password: str) -> bool:
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute("SELECT password FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
        conn.close()
    except Exception:
        return False
    if not row:
        return False
    return verify_password(password, row[0])


def create_access_token(data: dict) -> str:
    """Return a JWT access token that never expires."""
    to_encode = data.copy()
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    return payload.get("sub")
