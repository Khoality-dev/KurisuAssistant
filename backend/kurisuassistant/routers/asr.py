"""ASR routes: /asr — recognition, orchestrated by ``kurisuassistant/speech``."""

import logging

from fastapi import APIRouter, Body, Depends, Query

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.speech import engines, recognition

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    model: str | None = Query(None),
    initial_prompt: str | None = Query(None),
    _user=Depends(get_authenticated_user)
):
    """Transcribe raw Int16 PCM (16 kHz, mono).

    ``model`` is accepted and ignored: a recognition engine serves the one
    model its container was started with, so the choice is the operator's, not
    the request's. Both clients still send what they have stored.
    """
    return await recognition.transcribe(audio, language=language, initial_prompt=initial_prompt)


@router.post("/asr/detect-language")
async def asr_detect_language(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    model: str | None = Query(None),
    languages: str | None = Query(None),
    _user=Depends(get_authenticated_user)
):
    """Detect the spoken language of a clip without transcribing it.

    ``languages`` — comma-separated codes — is the client's routing table; see
    ``speech/recognition.py`` for what it does with an answer outside it.
    """
    allowed = [code.strip() for code in languages.split(",") if code.strip()] if languages else None
    return await recognition.detect_language(audio, allowed=allowed)


@router.get("/asr/models")
async def asr_models(_user=Depends(get_authenticated_user)):
    """The recognition models this server runs, ``{"object": "list", "data": [...]}``.

    Recognition only: the Android client decodes every entry as a recognition
    model and rejected a response that also listed the synthesis ones (#213).
    """
    return {"object": "list", "data": engines.catalogue("asr")}
