"""Text-to-speech routes."""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from tts import synthesize, list_voices, list_backends

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])


@router.post("")
async def synthesize_speech(
    text: str = Body(..., embed=True),
    voice: str = Body(None, embed=True),
    language: str = Body(None, embed=True),
    provider: str = Body(None, embed=True),
    api_url: str = Body(None, embed=True),
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Synthesize speech from text.

    Args:
        text: Text to synthesize
        voice: Voice identifier (optional, provider-specific)
        language: Language code (optional, e.g., "en", "ja")
        provider: TTS provider to use (optional, defaults to TTS_PROVIDER env var or "gpt-sovits")
        api_url: Custom TTS server URL (optional, overrides default)

    Returns:
        Audio data as WAV file
    """
    try:
        audio_data = synthesize(
            text=text,
            voice=voice,
            language=language,
            provider=provider,
            api_url=api_url,
        )
        # Save audio_data to disk for debugging
        with open("speech.wav", "wb") as f:
            f.write(audio_data)

        return Response(
            content=audio_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav"
            }
        )
    except Exception as e:
        logger.error(f"Error synthesizing speech for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/voices")
async def list_tts_voices(
    provider: str = None,
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List available TTS voices.

    Args:
        provider: TTS provider to use (optional, defaults to TTS_PROVIDER env var or "gpt-sovits")

    Returns:
        List of voice metadata dictionaries
    """
    try:
        voices = list_voices(provider=provider)
        return {"voices": voices}
    except Exception as e:
        logger.error(f"Error listing TTS voices for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/backends")
async def list_tts_backends(
    username: str = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List available TTS backends.

    Returns:
        List of backend names (e.g., gpt-sovits, cosyvoice, fish-speech)
    """
    try:
        backends = list_backends()
        return {"backends": backends}
    except Exception as e:
        logger.error(f"Error listing TTS backends for user {username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
