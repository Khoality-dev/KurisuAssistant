"""TTS synthesis endpoints — unified API across all TTS models."""

import logging

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from universal_voice.scheduler import scheduler
from universal_voice.tts.registry import tts_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])


@router.post("/synthesize")
async def synthesize(
    text: str = Form(...),
    model: str | None = Form(default=None),
    voice_id: str | None = Form(default=None),
    language: str | None = Form(default=None),
    ref_audio: UploadFile | None = File(default=None),
    ref_text: str | None = Form(default=None),
):
    """Synthesize speech from text.

    Args:
        text: Text to synthesize.
        model: TTS model ID (e.g. "vieneu:turbo", "gpt-sovits", "vixtts").
        voice_id: Preset voice ID (model-specific).
        language: Language code.
        ref_audio: Reference audio file for voice cloning.
        ref_text: Transcript of reference audio.

    Returns:
        WAV audio bytes.
    """
    try:
        tts_model = tts_registry.get_model(model)

        ref_audio_bytes = None
        ref_audio_filename = None
        if ref_audio:
            ref_audio_bytes = await ref_audio.read()
            ref_audio_filename = ref_audio.filename
            logger.info("Synthesize: model=%s, text=%d chars, ref_audio=%d bytes (filename=%s), voice_id=%s",
                        tts_model.model_id, len(text), len(ref_audio_bytes), ref_audio_filename, voice_id)
        else:
            logger.info("Synthesize: model=%s, text=%d chars, no ref_audio, voice_id=%s",
                        tts_model.model_id, len(text), voice_id)

        # Every backend runs in this process now (#203), so a synthesis is
        # seconds of GPU work; off the event loop, or /health stalls with it.
        # The scheduler brings the model in (evicting another if the cap says
        # so) and keeps it there until this returns (#207).
        def synthesize():
            with scheduler.use(tts_model):
                return tts_model.synthesize(
                    text=text,
                    voice_id=voice_id,
                    language=language,
                    ref_audio_bytes=ref_audio_bytes,
                    ref_text=ref_text,
                    ref_audio_filename=ref_audio_filename,
                )

        audio_bytes = await run_in_threadpool(synthesize)

        logger.info("Synthesize: done, %d bytes audio", len(audio_bytes))
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={"Content-Disposition": "attachment; filename=speech.wav"},
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("TTS synthesis error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _list_voices(tts_model) -> list[dict]:
    with scheduler.use(tts_model):
        return tts_model.list_voices()


@router.get("/voices")
async def list_voices(model: str | None = Query(default=None)):
    """List available preset voices, optionally filtered by model."""
    try:
        if model:
            tts_model = tts_registry.get_model(model)
            # list_voices may load the model to read its presets.
            voices = await run_in_threadpool(_list_voices, tts_model)
            for v in voices:
                v["model"] = tts_model.model_id
            return voices

        # Aggregate from all models
        all_voices = []
        for m in tts_registry.list_models():
            tts_model = tts_registry.get_model(m["id"])
            voices = await run_in_threadpool(_list_voices, tts_model)
            for v in voices:
                v["model"] = m["id"]
            all_voices.extend(voices)
        return all_voices
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("TTS list voices error: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
