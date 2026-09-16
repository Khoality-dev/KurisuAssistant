"""Transcriber — wraps faster-whisper for inference."""

import logging
import threading

from typing import TYPE_CHECKING

import numpy as np

from universal_voice import config
from universal_voice.models.manager import model_manager

if TYPE_CHECKING:
    from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


class Transcriber:
    """Manages loaded WhisperModel instances and runs transcription."""

    def __init__(self):
        self._models: dict[str, "WhisperModel"] = {}
        self._lock = threading.Lock()

    def _get_model(self, model_name: str | None = None) -> "WhisperModel":
        """Get or lazily load a WhisperModel."""
        # Imported here, like torch in config.py: the routers import this
        # module, and the unit tests import the routers without faster-whisper.
        from faster_whisper import WhisperModel

        name = model_name or config.DEFAULT_MODEL
        if name in self._models:
            return self._models[name]

        with self._lock:
            if name in self._models:
                return self._models[name]

            model_path = model_manager.resolve_model(name)
            logger.info(
                "Loading model: %s (device=%s, compute_type=%s)",
                model_path, config.DEVICE, config.COMPUTE_TYPE,
            )
            whisper_model = WhisperModel(
                model_path,
                device=config.DEVICE,
                compute_type=config.COMPUTE_TYPE,
            )
            self._models[name] = whisper_model
            logger.info("Model loaded: %s", name)
            return whisper_model

    def unload_model(self, model_name: str) -> bool:
        """Unload a model from memory."""
        with self._lock:
            if model_name in self._models:
                del self._models[model_name]
                logger.info("Unloaded model: %s", model_name)
                return True
        return False

    def transcribe(
        self,
        audio: np.ndarray,
        model_name: str | None = None,
        language: str | None = None,
        initial_prompt: str | None = None,
    ) -> tuple[str, str]:
        """Transcribe audio.

        Returns (text, detected_language).
        """
        model = self._get_model(model_name)
        kwargs: dict = {"without_timestamps": True}
        if language:
            kwargs["language"] = language
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt

        segments, info = model.transcribe(audio, **kwargs)
        text = "".join(segment.text for segment in segments).strip()
        return text, language or info.language

    def detect_language(
        self,
        audio: np.ndarray,
        model_name: str | None = None,
        allowed_languages: list[str] | None = None,
    ) -> tuple[str, float, list[tuple[str, float]]]:
        """Detect language from audio.

        Args:
            allowed_languages: If set, only consider these language codes.

        Returns (language, confidence, [(lang, prob), ...]).
        """
        model = self._get_model(model_name)
        target_len = 30 * 16000
        if len(audio) > target_len:
            audio = audio[:target_len]

        language, _top_prob, all_probs = model.detect_language(audio)

        if allowed_languages:
            # Filter to only allowed languages, pick highest probability
            filtered = [(l, p) for l, p in all_probs if l in allowed_languages]
            if filtered:
                language = filtered[0][0]  # all_probs already sorted by probability
                all_probs = filtered

        confidence = next((p for l, p in all_probs if l == language), 0.0)
        return language, confidence, all_probs

    def loaded_models(self) -> list[str]:
        """Return names of currently loaded models."""
        return list(self._models.keys())


transcriber = Transcriber()
