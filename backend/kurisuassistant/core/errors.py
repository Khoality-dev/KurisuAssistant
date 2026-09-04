"""Turning an unexpected exception into a response that says nothing useful to an attacker.

Routers used to end their handlers with ``detail=str(e)``, which put the raw
exception text in the response body. That text is rarely harmless: a SQLAlchemy
error carries the failing SQL and often its parameters, an httpx error carries
the internal service URL, and a filesystem error carries absolute server paths.

The exception still reaches the log in full, with its traceback. What the caller
gets is a generic sentence and a short reference, so a user can quote it and an
operator can find the matching log line.
"""

import logging
import uuid
from typing import Optional

from fastapi import HTTPException

logger = logging.getLogger(__name__)

GENERIC_MESSAGE = "Something went wrong on the server."


def new_reference() -> str:
    """A short id shared between the log line and the response."""
    return uuid.uuid4().hex[:12]


def log_internal_error(exc: BaseException, context: str) -> str:
    """Log an unexpected exception with a fresh reference, and return it."""
    reference = new_reference()
    logger.error("[%s] %s: %s", reference, context, exc, exc_info=True)
    return reference


def internal_error(
    exc: BaseException,
    context: str,
    status_code: int = 500,
    public_detail: Optional[str] = None,
) -> HTTPException:
    """Log ``exc`` and build the exception to raise.

    ``detail`` stays a plain string: clients read it directly to show a message,
    so making it an object would change the response shape for every error.

    Usage::

        except Exception as e:
            raise internal_error(e, "listing conversations")
    """
    reference = log_internal_error(exc, context)
    message = public_detail or GENERIC_MESSAGE
    return HTTPException(status_code=status_code, detail=f"{message} (reference: {reference})")
