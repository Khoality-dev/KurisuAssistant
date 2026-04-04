"""TTS routes: /tts — proxies to universal-voice service."""

import logging
import os
from pathlib import Path

import requests as http_requests
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from kurisuassistant.core.deps import get_authenticated_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])

UVOICE_URL = os.environ.get("UVOICE_URL", "http://universal-voice:14213").rstrip("/")
VOICE_STORAGE_DIR = Path("data") / "voice_storage"
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
    _user=Depends(get_authenticated_user),
):
    """Proxy TTS synthesis to universal-voice.

    Reads voice reference from local voice_storage and forwards
    as ref_audio upload to universal-voice.
    """
    try:
        data: dict = {"text": text}
        if provider:
            data["model"] = provider
        if language:
            data["language"] = language

        files = {}
        voice_file = _find_voice_file(voice) if voice else None

        if voice_file:
            files["ref_audio"] = open(voice_file, "rb")
        elif voice:
            # No local file — treat as preset voice_id
            data["voice_id"] = voice

        try:
            r = http_requests.post(
                f"{UVOICE_URL}/tts/synthesize",
                data=data,
                files=files or None,
                timeout=120,
            )
            r.raise_for_status()
        finally:
            for f in files.values():
                if hasattr(f, "close"):
                    f.close()

        return Response(
            content=r.content,
            media_type="audio/wav",
            headers={"Content-Disposition": "attachment; filename=speech.wav"},
        )
    except http_requests.RequestException as e:
        logger.error("TTS service error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"TTS service error: {e}")


@router.get("/voices")
async def list_tts_voices(
    provider: str = None,
    _user=Depends(get_authenticated_user),
):
    """Proxy voice listing to universal-voice."""
    try:
        params = {}
        if provider:
            params["model"] = provider
        r = http_requests.get(f"{UVOICE_URL}/tts/voices", params=params, timeout=10)
        r.raise_for_status()
        return {"voices": r.json()}
    except http_requests.RequestException as e:
        logger.error("TTS voices error: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"TTS service error: {e}")


@router.post("/check")
async def check_tts_health(
    provider: str = Body(None, embed=True),
    _user=Depends(get_authenticated_user),
):
    """Proxy health check to universal-voice."""
    try:
        r = http_requests.get(f"{UVOICE_URL}/health", timeout=5)
        r.raise_for_status()
        return r.json()
    except http_requests.RequestException as e:
        logger.error("TTS health error: %s", e, exc_info=True)
        return {"ok": False, "message": str(e)}


# Returned when universal-voice is unreachable
_FALLBACK_TTS_MODELS = [
    {"id": "vixtts", "object": "model", "type": "tts", "loaded": None},
    {"id": "gpt-sovits", "object": "model", "type": "tts", "loaded": None},
    {"id": "vieneu:turbo", "object": "model", "type": "tts", "loaded": None},
]


@router.get("/models")
async def list_tts_models(
    _user=Depends(get_authenticated_user),
):
    """List available TTS models from universal-voice, with fallback."""
    try:
        r = http_requests.get(f"{UVOICE_URL}/v1/models", timeout=5)
        r.raise_for_status()
        models = r.json().get("data", [])
        tts_models = [m for m in models if m.get("type") == "tts"]
        if tts_models:
            return {"models": tts_models}
    except http_requests.RequestException as e:
        logger.warning("TTS service unavailable, returning fallback models: %s", e)

    return {"models": _FALLBACK_TTS_MODELS}
