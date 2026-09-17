"""Where the speech engines are, and how the API talks to them.

One engine today: universal-voice, at ``UVOICE_URL`` for synthesis and
``ASR_API_URL`` for recognition — the same service unless an operator points
them apart. #212 adds one engine per synthesis or recognition backend; they are
added here, and the routers do not change.

An engine's answer becomes the client's like this. A refusal — a 400: an
unknown model, an unknown preset voice, text that normalises to nothing —
keeps its status and its reason: both clients show ``detail`` in one sentence,
and the reason is what the user needs. Everything else — unreachable, a
timeout, any other status, a failure inside the engine — is 502 "The speech
service is unavailable." with a log reference, the sentence the clients already
know (#151, #200). Every refusal used to come back as that outage (#215).
"""

import asyncio
import logging
import os
from dataclasses import dataclass

import httpx
from fastapi import HTTPException

from kurisuassistant.core.errors import internal_error
from kurisuassistant.core.http import get_client

logger = logging.getLogger(__name__)

UNAVAILABLE = "The speech service is unavailable."
_DEFAULT_URL = "http://universal-voice:14213"

# The statuses that mean "this request cannot be served", passed through with
# the engine's reason. Only what an engine sends for a request's own fault: a
# 422 is a bug in what this package sent, a 401 or 403 is a deployment's, and a
# 404 is as likely a mis-pointed URL as a missing model — none is the client's
# to act on, so they are outages like a 500, logged with a reference.
_REFUSALS = frozenset({400})

# The most of an engine's reason that reaches a client; it is shown in one line.
_REASON_LIMIT = 300


@dataclass(frozen=True)
class Engine:
    """One process that synthesizes or transcribes, reached over HTTP."""

    name: str
    url: str


def synthesis_engine() -> Engine:
    """Where synthesis and the voice listing go."""
    return Engine("synthesis", os.environ.get("UVOICE_URL", _DEFAULT_URL).rstrip("/"))


def recognition_engine() -> Engine:
    """Where transcription and language detection go."""
    return Engine("recognition", os.environ.get("ASR_API_URL", _DEFAULT_URL).rstrip("/"))


def engines_for(kind: str) -> list[Engine]:
    """The engines that serve models of one ``kind`` — ``"asr"`` or ``"tts"``.

    One each today. Asking every engine for every kind would list a synthesis
    model twice when the two roles are two instances, and would answer an empty
    list, not the 502, when the synthesis engine is down and the recognition one
    is up.
    """
    return [recognition_engine() if kind == "asr" else synthesis_engine()]


def _reason(response: httpx.Response) -> str:
    """The engine's own explanation, as one line for a client to show."""
    try:
        body = response.json()
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if not isinstance(detail, str) or not detail.strip():
        detail = response.text.strip() or f"The speech engine refused the request ({response.status_code})."
    return " ".join(detail.split())[:_REASON_LIMIT]


async def call(engine: Engine, method: str, path: str, *, context: str, **kwargs) -> httpx.Response:
    """One request to ``engine``; its failure becomes the client's as described above.

    ``context`` names the operation in the log. ``kwargs`` go to httpx as they
    are — ``content``, ``data``, ``files``, ``params``, ``headers``, ``timeout``.
    """
    try:
        response = await get_client().request(method, f"{engine.url}{path}", **kwargs)
        response.raise_for_status()
        return response
    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        if status in _REFUSALS:
            reason = _reason(e.response)
            logger.info("%s: the %s engine refused (%s): %s", context, engine.name, status, reason)
            raise HTTPException(status_code=status, detail=reason)
        raise internal_error(e, context, status_code=502, public_detail=UNAVAILABLE)
    except httpx.HTTPError as e:
        raise internal_error(e, context, status_code=502, public_detail=UNAVAILABLE)


async def health(engine: Engine) -> dict:
    """The engine's own health answer, or ``{"ok": False, "message"}`` — never a raise."""
    try:
        response = await get_client().request("GET", f"{engine.url}/health", timeout=5)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError as e:
        logger.error("Speech health check against %s failed: %s", engine.name, e, exc_info=True)
        return {"ok": False, "message": str(e)}


async def _models(engine: Engine, timeout: float) -> list[dict]:
    response = await get_client().request("GET", f"{engine.url}/v1/models", timeout=timeout)
    response.raise_for_status()
    return response.json().get("data", [])


async def catalogue(kind: str, *, context: str, timeout: float = 5) -> list[dict]:
    """The models of one ``kind`` — ``"asr"`` or ``"tts"`` — across its engines.

    Every engine of that kind is asked at once. One that does not answer is
    logged and skipped; when none answers the result is the 502, never an empty
    list — an empty picker reads as "no models installed", and used to be the
    only symptom of a wrong URL (#151).
    """
    asked = engines_for(kind)
    answers = await asyncio.gather(*(_models(engine, timeout) for engine in asked), return_exceptions=True)
    models: list[dict] = []
    failures: list[tuple[Engine, BaseException]] = []
    for engine, answer in zip(asked, answers):
        if isinstance(answer, BaseException):
            failures.append((engine, answer))
        else:
            models.extend(m for m in answer if m.get("type") == kind)
    if failures and len(failures) == len(asked):
        raise internal_error(failures[0][1], context, status_code=502, public_detail=UNAVAILABLE)
    for engine, exc in failures:
        logger.warning("%s: the %s engine did not answer: %s", context, engine.name, exc)
    return models
