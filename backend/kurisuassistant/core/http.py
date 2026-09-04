"""Shared async HTTP client for outbound calls to sibling services.

The speech routers used to proxy through the synchronous ``requests`` library
from inside ``async def`` handlers. Every such call blocked the event loop for
its whole duration — up to two minutes for synthesis — which froze token
streaming for every other connected client, because the server runs a single
uvicorn worker.

One client is shared so connections are reused: synthesis is called once per
sentence, so a fresh pool per request would mean a fresh TCP and TLS handshake
per sentence.
"""

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Generous default: synthesis of a long sentence legitimately takes a while.
# Callers that want a tighter bound pass their own.
DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0)

_client: Optional[httpx.AsyncClient] = None


def get_client() -> httpx.AsyncClient:
    """Return the shared client, creating it on first use."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
    return _client


async def close_client() -> None:
    """Close the shared client. Called from the application's shutdown hook."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        logger.info("Shared HTTP client closed")
    _client = None
