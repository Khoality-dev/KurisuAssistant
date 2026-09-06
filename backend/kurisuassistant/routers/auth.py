"""Authentication routes: login, register, and token refresh."""

import logging
import os
import time
from collections import deque
from threading import Lock
from typing import Deque, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel

from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL, provision_user
from kurisuassistant.core.errors import internal_error
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


def _registration_open() -> bool:
    """Whether anyone may create an account on this server.

    Open by default now, because registering no longer grants anything: an
    account is created inactive and stays inactive until the operator activates
    it in the database. Registration is a request, not an entry.

    It was closed by default when a fresh server came with a seeded ``admin``
    account, and leaving it open then handed a working account — with the model
    providers, the GPU and the agent tool loop behind it — to anyone who could
    reach the port. Set ``ALLOW_REGISTRATION=false`` to refuse even the request.

    Read per call rather than at import so it can be flipped without a rebuild.
    """
    return os.getenv("ALLOW_REGISTRATION", "true").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Rate limiting
#
# Deliberately in-process and dependency-free: the server runs a single uvicorn
# worker, so a shared counter buys nothing a local one does not. It exists to
# make online password guessing impractical, not to survive a restart.
#
# Two buckets, because each one alone has a hole (#155):
#
# * **Per address.** The obvious one, and the one a reverse proxy breaks. The
#   socket peer behind a proxy is the proxy, so every caller shares a bucket:
#   ten failures from anyone lock out everyone, and an attacker gets ten
#   attempts shared with legitimate users rather than ten of their own.
#   uvicorn rewrites ``request.client`` from ``X-Forwarded-For`` only for peers
#   named in ``FORWARDED_ALLOW_IPS``, which ``docker-entrypoint.sh`` passes
#   through — so an operator behind a proxy has to name it, and naming nothing
#   is safe (the header is ignored) rather than forgeable.
# * **Per username.** A proxy cannot rewrite it and an attacker spread across
#   many addresses cannot dodge it, so it is the only bound that survives both
#   a shared address and a botnet. The cost is real and deliberate: someone who
#   knows a username can keep that account refused for one window. Its budget is
#   therefore larger than the per-address one, and ``0`` disables it.
#
# Both answer with the same sentence, so which limit tripped says nothing about
# whether the username exists.
# ---------------------------------------------------------------------------

_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", "300"))
_RATE_LIMIT_MAX_ATTEMPTS = int(os.getenv("AUTH_RATE_LIMIT_MAX_ATTEMPTS", "10"))
_RATE_LIMIT_MAX_ATTEMPTS_PER_USER = int(
    os.getenv("AUTH_RATE_LIMIT_MAX_ATTEMPTS_PER_USER", "20")
)

_attempts: Dict[str, Deque[float]] = {}
_attempts_lock = Lock()

# Whether this process has already reported which address the limiter keys on.
_resolved_client_logged = False


def _client_address(request: Request) -> str:
    """The address the limiter counts against.

    Already rewritten from ``X-Forwarded-For`` by uvicorn's proxy-headers
    middleware when the peer is a trusted proxy; otherwise the socket peer.
    """
    return request.client.host if request.client else "unknown"


def _log_resolved_client_once(request: Request, address: str) -> None:
    """Say once, on the first authentication attempt, what the limiter keys on.

    There is nothing to resolve at startup — no client — so the first request
    that reaches a limit is where an operator can be told the truth. The
    entrypoint prints the trusted-proxy list at startup; this prints the result.
    """
    global _resolved_client_logged
    if _resolved_client_logged:
        return
    _resolved_client_logged = True

    trusted = os.getenv("FORWARDED_ALLOW_IPS", "").strip()
    forwarded = request.headers.get("x-forwarded-for")
    if trusted:
        logger.info(
            "Auth rate limiting keys on client address %s (proxy headers trusted from %s, "
            "X-Forwarded-For: %s)",
            address, trusted, forwarded or "<absent>",
        )
    elif forwarded:
        logger.warning(
            "Auth rate limiting keys on the socket peer %s, but this request carried "
            "X-Forwarded-For: %s. If this server is behind a reverse proxy, set "
            "FORWARDED_ALLOW_IPS to the proxy's address or subnet — otherwise every "
            "caller shares one bucket and one attacker locks out everyone (#155).",
            address, forwarded,
        )
    else:
        logger.info("Auth rate limiting keys on the socket peer %s", address)


def _client_key(request: Request, bucket: str) -> str:
    address = _client_address(request)
    _log_resolved_client_once(request, address)
    return f"{bucket}:addr:{address}"


def _username_key(bucket: str, username: str) -> str:
    """Case-folded, so varying the spelling does not buy a fresh budget."""
    return f"{bucket}:user:{username.strip().lower()}"


def _limits_for(request: Request, bucket: str, username: Optional[str]) -> List[Tuple[str, int]]:
    limits: List[Tuple[str, int]] = []
    if _RATE_LIMIT_MAX_ATTEMPTS > 0:
        limits.append((_client_key(request, bucket), _RATE_LIMIT_MAX_ATTEMPTS))
    if username and _RATE_LIMIT_MAX_ATTEMPTS_PER_USER > 0:
        limits.append((_username_key(bucket, username), _RATE_LIMIT_MAX_ATTEMPTS_PER_USER))
    return limits


def _enforce_rate_limit(request: Request, bucket: str, username: Optional[str] = None) -> None:
    """Reject with 429 once a caller exceeds the window's attempt budget.

    Checked against every applicable bucket before any of them is charged, so a
    refused request does not spend the other bucket's budget as well.
    """
    limits = _limits_for(request, bucket, username)
    if not limits:
        return

    now = time.monotonic()
    cutoff = now - _RATE_LIMIT_WINDOW_SECONDS

    with _attempts_lock:
        for key, max_attempts in limits:
            seen = _attempts.setdefault(key, deque())
            while seen and seen[0] < cutoff:
                seen.popleft()

            if len(seen) >= max_attempts:
                retry_after = max(1, int(seen[0] + _RATE_LIMIT_WINDOW_SECONDS - now))
                logger.warning("Rate limiting %s after %d attempts", key, len(seen))
                raise HTTPException(
                    status_code=429,
                    detail="Too many attempts. Try again later.",
                    headers={"Retry-After": str(retry_after)},
                )

        for key, _ in limits:
            _attempts[key].append(now)

        # Keep the table from growing without bound on a long-lived process.
        if len(_attempts) > 1024:
            for stale_key in [k for k, v in _attempts.items() if not v or v[-1] < cutoff]:
                _attempts.pop(stale_key, None)


def _clear_rate_limit(request: Request, bucket: str, username: Optional[str] = None) -> None:
    """Forget a caller's attempts after they succeed."""
    with _attempts_lock:
        _attempts.pop(_client_key(request, bucket), None)
        if username:
            _attempts.pop(_username_key(bucket, username), None)


def _make_token_response(username: str) -> dict:
    """Create standard auth response with access + refresh tokens."""
    return {
        "access_token": create_access_token({"sub": username}),
        "refresh_token": create_refresh_token({"sub": username}),
        "token_type": "bearer",
    }


@router.post("/login")
async def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    """Authenticate user and return access + refresh tokens."""
    _enforce_rate_limit(request, "login", form_data.username)

    def _login(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(form_data.username)
        if not user or not verify_password(form_data.password, user.password):
            raise HTTPException(status_code=400, detail="Incorrect username or password")
        # Refused here as well as on every authenticated request, so the answer
        # to a correct password is the reason rather than a token that fails
        # against everything a moment later.
        if not user.is_active:
            raise HTTPException(status_code=403, detail=ACCOUNT_INACTIVE_DETAIL)
        return user.username

    db = get_db_service()
    username = await db.execute(_login)
    _clear_rate_limit(request, "login", form_data.username)
    return _make_token_response(username)


@router.post("/register")
async def register(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    """Create an account, inactive until the operator activates it.

    The response keeps the token shape an older client expects and adds
    ``pending_activation``. Those tokens open nothing — every authenticated
    route and the chat socket refuse an inactive account — so a client that
    ignores the flag simply meets the same explanation on its next request.
    """
    if not _registration_open():
        logger.warning(
            "Rejected registration for '%s': registration is closed on this server",
            form_data.username,
        )
        raise HTTPException(
            status_code=403,
            detail="Registration is closed on this server. Ask the operator for an account.",
        )

    _enforce_rate_limit(request, "register", form_data.username)

    def _register(session):
        user = UserRepository(session).create_user(
            form_data.username, hash_password(form_data.password),
        )
        # In the same transaction as the account itself: an assistant row and a
        # first persona are what make the account able to chat at all, and a user
        # who lands halfway through has no way to create either. Rolling the whole
        # registration back is recoverable — they can register again.
        provision_user(session, user)
        return user.username

    try:
        db = get_db_service()
        await db.execute(_register)
    except ValueError:
        raise HTTPException(status_code=400, detail="User already exists")
    except Exception as e:
        raise internal_error(e, f"Error registering user {form_data.username}")

    logger.info(
        "Registered '%s'. It is inactive until the operator activates it: "
        "UPDATE users SET is_active = true WHERE username = '%s';",
        form_data.username,
        form_data.username,
    )
    return {
        **_make_token_response(form_data.username),
        "pending_activation": True,
        "detail": ACCOUNT_INACTIVE_DETAIL,
    }


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/auth/refresh")
async def refresh(body: RefreshRequest):
    """Exchange a valid refresh token for a new access token."""
    username = verify_refresh_token(body.refresh_token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Still exists, and still activated: otherwise a deactivated account keeps
    # minting fresh access tokens from a refresh token issued while it worked.
    def _check(session):
        user = UserRepository(session).get_by_username(username)
        if user and not user.is_active:
            raise HTTPException(status_code=403, detail=ACCOUNT_INACTIVE_DETAIL)
        return user is not None

    db = get_db_service()
    if not await db.execute(_check):
        raise HTTPException(status_code=401, detail="User not found")

    return {
        "access_token": create_access_token({"sub": username}),
        "token_type": "bearer",
    }
