"""Abstract base class for TTS providers.

All TTS provider implementations should inherit from this class.
"""

import logging
from abc import ABC, abstractmethod
from typing import Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)


class BaseTTSProvider(ABC):
    """Base class for TTS providers."""

    api_url: str = ""

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

    def check_health(self, api_url: Optional[str] = None) -> dict:
        """Check if the TTS server is reachable.

        Args:
            api_url: Custom URL to check (defaults to provider's configured URL)

        Returns:
            Dict with 'ok' (bool) and 'message' (str)
        """
        url = self._get_health_url(api_url)
        try:
            response = requests.get(url, timeout=5)
            return {"ok": True, "message": f"Connected to {url}"}
        except requests.exceptions.ConnectionError:
            return {"ok": False, "message": f"Cannot connect to {url}"}
        except requests.exceptions.Timeout:
            return {"ok": False, "message": f"Connection timed out: {url}"}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    def _get_health_url(self, api_url: Optional[str] = None) -> str:
        """Get the URL to use for health checks. Override in subclasses."""
        return api_url or self.api_url
