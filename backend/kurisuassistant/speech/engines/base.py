"""What an engine is, and how its answer becomes the client's.

An engine is a container this project does not build: GPT-SoVITS, viXTTS, a
faster-whisper server. Each speaks its own HTTP dialect, and an adapter here
knows exactly one of them. Nothing in this package imports torch or loads a
model — the engines do that, in their own images (#212).

An engine's failure becomes the client's like this. A refusal — a 400: an
unknown voice, text that normalises to nothing — keeps its status and its
reason: both clients show ``detail`` in one sentence, and the reason is what
the user needs. Everything else — unreachable, a timeout, any other status, a
failure inside the engine — is 502 "The speech service is unavailable." with a
log reference, the sentence the clients already know (#151, #200).
"""

import logging

import httpx
from fastapi import HTTPException

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.http import get_client

logger = logging.getLogger(__name__)

UNAVAILABLE = "The speech service is unavailable."

# The statuses that mean "this request cannot be served", passed through with
# the engine's reason. Only what an engine sends for a request's own fault: a
# 422 is a bug in what this package sent, a 401 or 403 is a deployment's, and a
# 404 is as likely a mis-pointed URL as a missing model — none is the client's
# to act on, so they are outages like a 500, logged with a reference.
_REFUSALS = frozenset({400})

# The most of an engine's reason that reaches a client; it is shown in one line.
_REASON_LIMIT = 300


class Engine:
    """One speech engine, reached over HTTP.

    Subclasses implement the dialect. ``model_id`` is what the clients store
    and send back — renaming one is a client migration.
    """

    #: The id the clients use for this engine.
    model_id: str = ""
    #: "tts" or "asr".
    kind: str = ""

    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} {self.model_id} at {self.url}>"

    async def call(self, method: str, path: str, *, context: str, **kwargs) -> httpx.Response:
        """One request to this engine; its failure becomes the client's.

        ``context`` names the operation in the log. ``kwargs`` go to httpx as
        they are — ``content``, ``data``, ``files``, ``params``, ``timeout``.
        """
        try:
            response = await get_client().request(method, f"{self.url}{path}", **kwargs)
            response.raise_for_status()
            return response
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            if status in _REFUSALS:
                reason = _reason(e.response)
                logger.info("%s: %s refused (%s): %s", context, self.model_id, status, reason)
                raise HTTPException(status_code=status, detail=reason)
            raise internal_error(e, context, status_code=502, public_detail=UNAVAILABLE)
        except httpx.HTTPError as e:
            raise internal_error(e, context, status_code=502, public_detail=UNAVAILABLE)

    async def healthy(self) -> dict:
        """``{"ok": bool, "message": str}``. Never raises."""
        try:
            response = await get_client().request("GET", f"{self.url}{self.health_path}", timeout=5)
            response.raise_for_status()
            return {"ok": True, "message": f"{self.model_id} is reachable"}
        except httpx.HTTPError as e:
            logger.error("Speech health check against %s failed: %s", self.model_id, e, exc_info=True)
            return {"ok": False, "message": str(e)}

    #: Where ``healthy`` looks. Overridden by an engine with no ``/health``.
    health_path = "/health"

    def described(self) -> dict:
        """The entry this engine contributes to a model listing."""
        return {"id": self.model_id, "object": "model", "type": self.kind, "name": self.model_id}


#: Where an engine puts its explanation. FastAPI engines use ``detail``;
#: GPT-SoVITS's api_v2 uses ``message``, and puts the part that actually
#: identifies the problem — the offending path, say — in ``Exception`` beside
#: it, so both are read or the user is told only "tts failed".
_REASON_KEYS = ("detail", "message", "error")
_REASON_EXTRA = ("Exception", "exception")


def _reason(response: httpx.Response) -> str:
    """The engine's own explanation, as one line for a client to show.

    Never the raw body: both clients render this as a sentence, and a client
    showing ``{"message": ...}`` to a user is worse than showing nothing.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    parts = []
    if isinstance(body, dict):
        for key in _REASON_KEYS:
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
                break
        for key in _REASON_EXTRA:
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
                break
    reason = ": ".join(parts)
    if not reason:
        reason = response.text.strip() or f"The speech engine refused the request ({response.status_code})."
    return " ".join(reason.split())[:_REASON_LIMIT]
