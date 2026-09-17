"""TTS routes: /tts — synthesis, orchestrated by ``kurisuassistant/speech``."""

import logging
from pathlib import Path

from fastapi import APIRouter, Body, Depends
from fastapi.responses import Response

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.paths import DATA_DIR
from kurisuassistant.speech import engines, synthesis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])

# Resolved from the package like every other data path (core/paths.py), not from
# the working directory: this was the one `Path("data")` left.
VOICE_STORAGE_DIR = DATA_DIR / "voice_storage"
AUDIO_EXTENSIONS = (".wav", ".mp3", ".flac", ".ogg")


def _find_voice_file(voice_name: str) -> Path | None:
    """Find a voice file by stem name in voice_storage."""
    for ext in AUDIO_EXTENSIONS:
        path = VOICE_STORAGE_DIR / f"{voice_name}{ext}"
        if path.exists():
            return path
    return None


@router.post("")
async def synthesize_speech(
    text: str = Body(..., embed=True),
    voice: str = Body(None, embed=True),
    language: str = Body(None, embed=True),
    provider: str = Body(None, embed=True),
    _user=Depends(get_authenticated_user)
):
    """Synthesize ``text`` and answer one WAV.

    ``voice`` is a stem in ``data/voice_storage/`` — uploaded to the engine as
    the reference clip — or, when no such file exists, a preset voice id the
    engine knows. ``provider`` is the model id (``vixtts``, ``gpt-sovits``,
    ``vieneu:turbo``); absent means the engine's default.
    """
    logger.info("TTS request: text=%d chars, voice=%s, provider=%s, language=%s",
                len(text), voice, provider, language)

    voice_file = _find_voice_file(voice) if voice else None
    if voice_file:
        ref_audio = (voice_file.name, voice_file.read_bytes())
        voice_id = None
        logger.info("TTS: uploading ref_audio from %s", voice_file)
    else:
        ref_audio = None
        voice_id = voice or None
        if voice_id:
            logger.info("TTS: using preset voice_id=%s (no local file found)", voice_id)
        else:
            logger.info("TTS: no voice specified, using model default")

    audio = await synthesis.synthesize(
        text, model=provider, voice_id=voice_id, language=language, ref_audio=ref_audio,
    )
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Content-Disposition": "attachment; filename=speech.wav"},
    )


@router.get("/voices")
async def list_tts_voices(
    provider: str = None,
    _user=Depends(get_authenticated_user)
):
    """The preset voices the synthesis engine offers, optionally for one model."""
    params = {"model": provider} if provider else {}
    response = await engines.call(
        engines.synthesis_engine(), "GET", "/tts/voices", context="TTS voices",
        params=params, timeout=10,
    )
    return {"voices": response.json()}


@router.post("/check")
async def check_tts_health(
    provider: str = Body(None, embed=True),
    _user=Depends(get_authenticated_user)
):
    """The synthesis engine's health answer, or ``{"ok": false, "message"}``."""
    return await engines.health(engines.synthesis_engine())


@router.get("/models")
async def list_tts_models(
    _user=Depends(get_authenticated_user)
):
    """The synthesis models across the engines.

    502 when no engine answers, like ``/tts/voices``; a hard-coded list of
    three model ids used to be returned as a normal 200, so the picker offered
    models that did not exist and synthesis failed later (#151). An empty list
    is what reachable engines that serve no synthesis model get.
    """
    return {"models": await engines.catalogue("tts", context="TTS models")}
