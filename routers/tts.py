"""Text-to-speech routes."""

import logging

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from core.deps import get_db, get_authenticated_user
from db.models import User
from tts import synthesize, list_voices, list_backends, check_health

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])


@router.post("")
async def synthesize_speech(
    text: str = Body(..., embed=True),
    voice: str = Body(None, embed=True),
    language: str = Body(None, embed=True),
    provider: str = Body(None, embed=True),
    api_url: str = Body(None, embed=True),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Synthesize speech from text."""
    try:
        audio_data = synthesize(
            text=text,
            voice=voice,
            language=language,
            provider=provider,
            api_url=api_url,
        )

        return Response(
            content=audio_data,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav"
            }
        )
    except Exception as e:
        logger.error(f"Error synthesizing speech for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/voices")
async def list_tts_voices(
    provider: str = None,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List available TTS voices."""
    try:
        voices = list_voices(provider=provider)
        return {"voices": voices}
    except Exception as e:
        logger.error(f"Error listing TTS voices for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/check")
async def check_tts_health(
    provider: str = Body(None, embed=True),
    api_url: str = Body(None, embed=True),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """Check if a TTS server is reachable."""
    result = check_health(provider=provider, api_url=api_url)
    return result


@router.get("/backends")
async def list_tts_backends(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db)
):
    """List available TTS backends."""
    try:
        backends = list_backends()
        return {"backends": backends}
    except Exception as e:
        logger.error(f"Error listing TTS backends for user {user.username}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
