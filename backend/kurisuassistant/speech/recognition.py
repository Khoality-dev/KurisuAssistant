"""Transcription and language detection.

The clients record raw Int16 PCM at 16 kHz and send it as an octet stream; the
engines take an audio file, so the PCM is wrapped in a WAV header here
(``pcm_to_wav``) and nothing is re-encoded.
"""

import logging

from kurisuassistant.speech import engines
from kurisuassistant.speech.residency import residency
from kurisuassistant.speech.text import pcm_to_wav

logger = logging.getLogger(__name__)


async def transcribe(
    pcm: bytes, *, language: str | None = None, initial_prompt: str | None = None,
) -> dict:
    """``{"text", "language"}`` for one clip of raw PCM."""
    engine = engines.recognition()
    async with residency.serving(engine):
        result = await engine.transcribe(pcm_to_wav(pcm), language=language, initial_prompt=initial_prompt)
    logger.info("ASR: %d bytes of PCM -> %d chars (%s)", len(pcm), len(result["text"]), result["language"])
    return result


async def detect_language(pcm: bytes, *, allowed: list[str] | None = None) -> dict:
    """``{"language", "confidence"}`` without transcribing.

    ``allowed`` is the client's routing table: the languages it has a model
    mapped for. The engines do not take a candidate list, so the answer is
    checked against it here — an answer outside the list is reported as it came,
    and the client falls back to its default model exactly as it does for a
    language it has no mapping for.
    """
    engine = engines.recognition()
    async with residency.serving(engine):
        result = await engine.detect_language(pcm_to_wav(pcm))
    if allowed and result["language"] not in allowed:
        logger.info("ASR detect-language: %s is not one of %s; the client will fall back",
                    result["language"], ",".join(allowed))
    return result
