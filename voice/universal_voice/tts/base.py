"""Abstract base class for TTS models."""

from abc import ABC, abstractmethod
from typing import Optional


class BaseTTSModel(ABC):
    """Base class for all TTS model implementations."""

    @property
    @abstractmethod
    def model_id(self) -> str:
        """Unique model identifier (e.g. 'vieneu:turbo', 'gpt-sovits')."""
        ...

    @abstractmethod
    def synthesize(
        self,
        text: str,
        voice_id: Optional[str] = None,
        language: Optional[str] = None,
        ref_audio_bytes: Optional[bytes] = None,
        ref_text: Optional[str] = None,
        **kwargs,
    ) -> bytes:
        """Synthesize speech from text.

        Args:
            text: Text to synthesize.
            voice_id: Preset voice ID (model-specific).
            language: Language code.
            ref_audio_bytes: Reference audio bytes for voice cloning.
            ref_text: Transcript of reference audio.

        Returns:
            Audio data as WAV bytes.
        """
        ...

    @abstractmethod
    def list_voices(self) -> list[dict]:
        """List available preset voices.

        Returns:
            List of {"id": str, "name": str} dicts.
        """
        ...

    def load(self) -> None:
        """Load the weights now rather than on the first request.

        The lifespan calls this for the models in ``TTS_PRELOAD``; ``synthesize``
        must call it too, so a model that was not pre-loaded still works.
        """
        return None

    def check_health(self) -> dict:
        """Check if the model/service is reachable.

        Returns:
            {"ok": bool, "message": str}
        """
        return {"ok": True, "message": "ok"}

    def is_loaded(self) -> Optional[bool]:
        """Whether the weights are in memory."""
        return None
