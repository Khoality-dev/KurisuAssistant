"""ASR routes: /asr — recognition, orchestrated by ``kurisuassistant/speech``."""

import logging

from fastapi import APIRouter, Body, Depends, Query

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.speech import engines

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

_PCM = {"Content-Type": "application/octet-stream"}


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    model: str | None = Query(None),
    initial_prompt: str | None = Query(None),
    _user=Depends(get_authenticated_user)
):
    """Transcribe raw Int16 PCM (16 kHz, mono) on the recognition engine."""
    params = {
        name: value
        for name, value in (("language", language), ("model", model), ("initial_prompt", initial_prompt))
        if value
    }
    response = await engines.call(
        engines.recognition_engine(), "POST", "/asr", context="ASR",
        content=audio, params=params, headers=_PCM, timeout=30,
    )
    return response.json()


@router.post("/asr/detect-language")
async def asr_detect_language(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    model: str | None = Query(None),
    languages: str | None = Query(None),
    _user=Depends(get_authenticated_user)
):
    """Detect the spoken language of a clip without transcribing it.

    ``languages`` — comma-separated codes — constrains the answer to those; the
    desktop's routing mode sends the languages it has a model mapped for. The
    proxy used to drop it (#216).
    """
    params = {name: value for name, value in (("model", model), ("languages", languages)) if value}
    response = await engines.call(
        engines.recognition_engine(), "POST", "/asr/detect-language", context="ASR detect-language",
        content=audio, params=params, headers=_PCM, timeout=30,
    )
    return response.json()


@router.get("/asr/models")
async def asr_models(_user=Depends(get_authenticated_user)):
    """The recognition models across the engines, ``{"object": "list", "data": [...]}``.

    Recognition only. universal-voice's catalogue also lists the synthesis
    models — entries with no ``name`` — and passing it through whole made the
    Android client, which decodes every entry as a recognition model, reject
    the response (#213).
    """
    return {"object": "list", "data": await engines.catalogue("asr", context="ASR models", timeout=10)}
