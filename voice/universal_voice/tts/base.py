"""Abstract base class for TTS models."""

from abc import ABC, abstractmethod
from typing import Optional


class BaseTTSModel(ABC):
    """Base class for all TTS model implementations."""

    # Whether ``offload`` can park the weights in CPU memory (the scheduler
    # reports it, so the API knows before asking).
    can_offload: bool = False
    # Whether ``list_voices`` needs the weights in memory. It should not: a
    # listing is a settings screen, not a synthesis, and must not bring a
    # model onto the GPU (#218). VieNeu's presets live in its SDK engine.
    voices_need_weights: bool = False

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
        """List available preset voices without loading weights (unless
        ``voices_need_weights``).

        Returns:
            List of {"id": str, "name": str} dicts.
        """
        ...

    def load(self) -> None:
        """Bring the weights onto the device: from disk if nothing is loaded,
        from CPU memory if ``offload`` parked them. Idempotent.

        The scheduler (``scheduler.py``) calls this for a request and for the
        models in ``TTS_PRELOAD``; ``synthesize`` must call it too, so a model
        used outside the scheduler still works.
        """
        return None

    def offload(self) -> bool:
        """Park the weights in CPU memory, freeing the device. Return False
        when the backend cannot (the scheduler then waits for ``unload``)."""
        return False

    def unload(self) -> None:
        """Drop the weights entirely."""
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
