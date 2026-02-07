"""ASR routes: /asr."""

import logging

import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException

from core.deps import oauth2_scheme
from core.security import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

# ASR model is initialized in main.py and passed to this router
asr_model = None
SAMPLE_RATE = 16_000


def set_asr_model(model):
    """Set the ASR model from main.py."""
    global asr_model
    asr_model = model


@router.post("/asr", tags=["asr"])
async def asr(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    token: str = Depends(oauth2_scheme),
):
    """Convert audio to text using Whisper."""
    if not get_current_user(token):
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)
        waveform = pcm.astype(np.float32) / 32768.0
        result = asr_model(waveform)
        text = result["text"]
        return {"text": text}
    except Exception as e:
        logger.error(f"Error processing ASR request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
