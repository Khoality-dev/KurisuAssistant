"""ASR routes: /asr."""

import logging

import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from models.asr import transcribe
from core.deps import get_authenticated_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

SAMPLE_RATE = 16_000


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Convert audio to text. Accepts raw Int16 PCM at 16kHz."""
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0
        text, detected_language = transcribe(waveform, language=language)
        return {"text": text, "language": detected_language}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing ASR request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
