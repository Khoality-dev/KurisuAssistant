"""Transcription and language detection endpoints."""

import io
import logging

import numpy as np
import soundfile as sf
from fastapi import APIRouter, Body, File, Form, HTTPException, Query, UploadFile

from universal_voice import config
from universal_voice.models.transcriber import transcriber

logger = logging.getLogger(__name__)

router = APIRouter(tags=["transcription"])

SAMPLE_RATE = 16_000


def _decode_audio_av(raw_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode audio using PyAV (ffmpeg). Handles webm, mp3, ogg, mp4, etc."""
    import av

    container = av.open(io.BytesIO(raw_bytes))
    stream = next(s for s in container.streams if s.type == "audio")
    frames = []
    for frame in container.decode(stream):
        # Resample to mono s16 (int16) at original rate
        frame_np = frame.to_ndarray().flatten().astype(np.float32)
        if frame.format.name not in ("flt", "fltp"):
            frame_np = frame_np / 32768.0
        frames.append(frame_np)
    container.close()
    if not frames:
        raise ValueError("No audio frames decoded")
    return np.concatenate(frames), stream.rate or stream.codec_context.sample_rate


def _decode_audio(raw_bytes: bytes) -> np.ndarray:
    """Decode audio bytes (wav/mp3/flac/ogg/webm) to float32 mono 16kHz."""
    # Try soundfile first (fast, handles wav/flac/ogg)
    try:
        audio, sr = sf.read(io.BytesIO(raw_bytes), dtype="float32")
    except Exception:
        # Fall back to PyAV for webm/mp3/mp4/etc.
        try:
            audio, sr = _decode_audio_av(raw_bytes)
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Could not decode audio. Supported formats: wav, flac, ogg, mp3, webm, mp4.",
            )
    # Convert stereo to mono
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    # Resample if needed
    if sr != SAMPLE_RATE:
        # Simple linear resampling
        duration = len(audio) / sr
        target_len = int(duration * SAMPLE_RATE)
        audio = np.interp(
            np.linspace(0, len(audio) - 1, target_len),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)
    return audio


def _pcm_to_float(pcm_bytes: bytes) -> np.ndarray:
    """Convert raw Int16 PCM bytes to float32 waveform."""
    pcm = np.frombuffer(pcm_bytes, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


# ---------------------------------------------------------------------------
# OpenAI-compatible endpoint
# ---------------------------------------------------------------------------

@router.post("/v1/audio/transcriptions")
async def openai_transcription(
    file: UploadFile = File(...),
    model: str = Form(default=None),
    language: str = Form(default=None),
    response_format: str = Form(default="json"),
):
    """OpenAI-compatible transcription endpoint.

    Accepts multipart form with audio file.
    """
    try:
        raw = await file.read()
        audio = _decode_audio(raw)
        model_name = model or config.DEFAULT_MODEL
        text, detected_lang = transcriber.transcribe(audio, model_name=model_name, language=language)

        if response_format == "text":
            return text

        return {
            "text": text,
            "language": detected_lang,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Transcription error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Simple raw PCM endpoint (Kurisu-compatible)
# ---------------------------------------------------------------------------

@router.post("/asr")
async def asr_raw(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    model: str | None = Query(None),
    language: str | None = Query(None),
    initial_prompt: str | None = Query(None),
):
    """Raw PCM transcription. Accepts Int16 PCM at 16kHz as octet-stream."""
    try:
        waveform = _pcm_to_float(audio)
        model_name = model or config.DEFAULT_MODEL
        text, detected_lang = transcriber.transcribe(
            waveform, model_name=model_name, language=language,
            initial_prompt=initial_prompt,
        )
        return {"text": text, "language": detected_lang}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("ASR error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

@router.post("/v1/audio/detect-language")
async def detect_language(
    file: UploadFile = File(...),
    model: str = Form(default=None),
):
    """Detect the language of an audio file."""
    try:
        raw = await file.read()
        audio = _decode_audio(raw)
        model_name = model or config.DEFAULT_MODEL
        language, confidence, probs = transcriber.detect_language(audio, model_name=model_name)

        # Return top 10 languages
        probabilities = {lang: round(prob, 4) for lang, prob in probs[:10]}

        return {
            "language": language,
            "confidence": round(confidence, 4),
            "probabilities": probabilities,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Language detection error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/asr/detect-language")
async def detect_language_raw(
    audio: bytes = Body(..., media_type="application/octet-stream"),
    model: str | None = Query(None),
    languages: str | None = Query(None),
):
    """Detect language from raw PCM. Optional: constrain to comma-separated language codes."""
    try:
        waveform = _pcm_to_float(audio)
        model_name = model or config.DEFAULT_MODEL
        allowed = [l.strip() for l in languages.split(",") if l.strip()] if languages else None
        language, confidence, probs = transcriber.detect_language(
            waveform, model_name=model_name, allowed_languages=allowed,
        )
        return {"language": language, "confidence": round(confidence, 4)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Language detection error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
