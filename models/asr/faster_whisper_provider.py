"""faster-whisper ASR provider (CTranslate2-based)."""

import logging
import os

import numpy as np

from .base import BaseASRProvider

logger = logging.getLogger(__name__)


class FasterWhisperProvider(BaseASRProvider):
    """ASR provider using faster-whisper (CTranslate2)."""

    def __init__(self):
        self._model = None

    def _get_model(self):
        """Lazily load the WhisperModel on first use."""
        if self._model is None:
            from faster_whisper import WhisperModel

            model_name = os.environ.get("ASR_MODEL", "base")
            # Use local finetuned model if it exists and no explicit override
            if model_name == "base" and os.path.exists("data/asr/whisper-ct2"):
                model_name = "data/asr/whisper-ct2"

            device = os.environ.get("ASR_DEVICE", "cpu")

            compute_type = "float16" if device == "cuda" else "int8"

            logger.info(
                "Loading faster-whisper model: %s (device=%s, compute_type=%s)",
                model_name, device, compute_type,
            )
            self._model = WhisperModel(
                model_name, device=device, compute_type=compute_type,
            )
            logger.info("faster-whisper model loaded")
        return self._model

    def transcribe(self, audio: np.ndarray, language: str | None = None) -> tuple[str, str]:
        model = self._get_model()
        kwargs = {}
        if language:
            kwargs["language"] = language
        segments, info = model.transcribe(audio, **kwargs)
        text = "".join(segment.text for segment in segments).strip()
        return text, info.language
