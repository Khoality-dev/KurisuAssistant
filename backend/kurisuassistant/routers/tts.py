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

    ``voice`` is a stem in ``data/voice_storage/`` — the clip uploaded to the
    engine to clone — or, when no such file exists, a preset voice id the engine
    knows. ``provider`` is the model id, a name in ``TTS_ENGINES``; absent means
    the server's default engine.
    """
    logger.info("TTS request: text=%d chars, voice=%s, provider=%s, language=%s",
                len(text), voice, provider, language)

    voice_file = _find_voice_file(voice) if voice else None
    if voice_file:
        reference = engines.VoiceReference(voice_file)
        voice_id = None
        logger.info("TTS: cloning from %s", voice_file)
    else:
        reference = None
        voice_id = voice or None
        if voice_id:
            logger.info("TTS: using preset voice_id=%s (no local file found)", voice_id)
        else:
            logger.info("TTS: no voice specified, using the engine default")

    audio = await synthesis.synthesize(
        text, model=provider, reference=reference, voice_id=voice_id, language=language,
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
    """The preset voices the synthesis engines offer, optionally for one model.

    Asked of each engine over the contract's ``GET /voices``; one that cannot
    be asked contributes none rather than failing the listing.
    """
    chosen = [engines.synthesis(provider)] if provider else engines.synthesis_engines()
    voices = []
    for engine in chosen:
        voices.extend({**voice, "model": engine.model_id} for voice in await engine.voices())
    return {"voices": voices}


@router.post("/check")
async def check_tts_health(
    provider: str = Body(None, embed=True),
    _user=Depends(get_authenticated_user)
):
    """Whether the synthesis engine answers, as ``{"ok", "message"}``."""
    return await engines.synthesis(provider).healthy()


@router.get("/models")
async def list_tts_models(
    _user=Depends(get_authenticated_user)
):
    """The synthesis models this server runs.

    502 when it runs none, never an empty list: a hard-coded list of three
    model ids used to be returned as a normal 200, so the picker offered models
    that did not exist and synthesis failed later (#151).
    """
    return {"models": engines.catalogue("tts")}
