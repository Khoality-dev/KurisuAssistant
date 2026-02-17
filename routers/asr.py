"""ASR routes: /asr."""

import logging
import struct
import time
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Body, Depends, HTTPException, Query

from models.asr import transcribe
from core.deps import get_authenticated_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["asr"])

SAMPLE_RATE = 16_000
DEBUG_ASR = True
DEBUG_DIR = Path("data/asr_debug")


def _save_debug_wav(pcm: np.ndarray, sample_rate: int) -> Path:
    """Save raw PCM as a WAV file for debugging."""
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    path = DEBUG_DIR / f"asr_{int(time.time() * 1000)}.wav"
    pcm_bytes = pcm.tobytes()
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_bytes)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, num_channels,
        sample_rate, byte_rate, block_align, bits_per_sample,
        b"data", data_size,
    )
    path.write_bytes(header + pcm_bytes)
    return path


@router.post("/asr")
async def asr_endpoint(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    language: str | None = Query(None),
    _user=Depends(get_authenticated_user),
):
    """Convert audio to text. Accepts raw Int16 PCM at 16kHz."""
    try:
        pcm = np.frombuffer(audio, dtype=np.int16)

        if DEBUG_ASR:
            path = _save_debug_wav(pcm, SAMPLE_RATE)
            logger.info(f"ASR debug: saved {len(audio)} bytes ({len(pcm)} samples, {len(pcm)/SAMPLE_RATE:.2f}s) → {path}")

        waveform = pcm.astype(np.float32) / 32768.0
        text = transcribe(waveform, language=language)

        if DEBUG_ASR:
            logger.info(f"ASR debug: transcribed → '{text}'")

        return {"text": text}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing ASR request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
