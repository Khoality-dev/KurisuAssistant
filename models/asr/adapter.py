"""Pure ASR adapter — no business logic, no DB knowledge."""

import numpy as np

from . import get_provider


def transcribe(
    audio: np.ndarray,
    language: str | None = None,
    provider: str | None = None,
) -> str:
    """Transcribe audio to text using the configured provider.

    Args:
        audio: Float32 numpy array (16kHz mono).
        language: Optional language hint.
        provider: Provider name override (default from factory).

    Returns:
        Transcribed text.
    """
    asr = get_provider(provider)
    return asr.transcribe(audio, language=language)
