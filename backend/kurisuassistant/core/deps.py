"""FastAPI dependencies for authentication and database access."""

from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer

from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL
from kurisuassistant.core.security import get_current_user

# OAuth2 scheme for token-based authentication
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


def get_authenticated_user(token: str = Depends(oauth2_scheme)) -> User:
    """Dependency to get and validate the current user.

    Returns:
        User object of the authenticated user (detached from session)

    Raises:
        HTTPException: 401 if the token is invalid or the user is gone, 403 if
            the account has not been activated.
    """
    username = get_current_user(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    def _get_user(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        # Checked here rather than only at login, so revoking access takes
        # effect on the next request instead of when the token expires.
        if not user.is_active:
            raise HTTPException(status_code=403, detail=ACCOUNT_INACTIVE_DETAIL)
        session.expunge(user)
        return user

    db = get_db_service()
    return db.execute_sync(_get_user)


#: Same scheme, but a missing header is not an error: these routes accept the
#: token as a query parameter instead, so the header may legitimately be absent.
optional_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)


async def resolve_user_from_token(token: Optional[str]) -> User:
    """Verify a token that arrived somewhere other than the header.

    ``<img src=…>``, ``<video src=…>`` and a streamed download in the Electron
    main process cannot set an ``Authorization`` header, so those routes take
    ``?token=``. The verification is the same one :func:`get_authenticated_user`
    does, activation gate included — a gate with a hole in it is worse than
    none, because it is trusted (#154).

    Lives here rather than in a router so there is one copy: the check is
    already duplicated across ``deps``, ``ws`` and ``auth``, and a fifth
    hand-written variant is how one of them ends up out of step.
    """
    username = get_current_user(token) if token else None
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")

    def _get_user(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        if not user.is_active:
            raise HTTPException(status_code=403, detail=ACCOUNT_INACTIVE_DETAIL)
        session.expunge(user)
        return user

    db = get_db_service()
    return await db.execute(_get_user)
