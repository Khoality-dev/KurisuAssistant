"""Abstract base class for TTS providers.

All TTS provider implementations should inherit from this class.
"""

from abc import ABC, abstractmethod
from typing import Dict, Optional


class BaseTTSProvider(ABC):
    """Base class for TTS providers."""

    @abstractmethod
    def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        language: Optional[str] = None,
        **kwargs
    ) -> bytes:
        """Synthesize speech from text.

        Args:
            text: Text to synthesize
            voice: Voice identifier (provider-specific)
            language: Language code (e.g., "en", "ja")
            **kwargs: Additional provider-specific parameters

        Returns:
            Audio data as bytes (WAV format)
        """
        pass

    @abstractmethod
    def list_voices(self) -> list[str]:
        """List available voices.

        Returns:
            List of voice names
        """
        pass
