"""Pure TTS interface - orchestrates TTS calls.

This module provides a clean interface for TTS interactions WITHOUT business logic:
- NO knowledge of users, conversations, or database
- Delegates to tts_providers for TTS API calls
- Handles voice synthesis
"""

import os
import logging
from typing import Optional, Dict

from tts_providers import create_tts_provider, list_available_backends

logger = logging.getLogger(__name__)


# Provider registry - lazily initialized on first use
_providers: Dict[str, object] = {}


def _get_provider(provider_type: Optional[str] = None):
    """Get or create TTS provider instance.

    Args:
        provider_type: Provider type (defaults to TTS_PROVIDER env var or "gpt-sovits")

    Returns:
        TTS provider instance
    """
    global _providers

    if provider_type is None:
        provider_type = os.getenv("TTS_PROVIDER", "gpt-sovits")

    # Create provider if not already in registry
    if provider_type not in _providers:
        logger.info(f"Initializing TTS provider: {provider_type}")
        _providers[provider_type] = create_tts_provider(provider_type)

    return _providers[provider_type]


def synthesize(
    text: str,
    voice: Optional[str] = None,
    language: Optional[str] = None,
    provider: Optional[str] = None,
    **kwargs
) -> bytes:
    """Synthesize speech from text.

    This function is a PURE TTS INTERFACE - it knows nothing about users,
    conversations, or database. All business logic must be handled by the caller.

    Args:
        text: Text to synthesize
        voice: Voice identifier (provider-specific)
        language: Language code (e.g., "en", "ja")
        provider: TTS provider to use (defaults to TTS_PROVIDER env var or "gpt-sovits")
        **kwargs: Additional provider-specific parameters

    Returns:
        Audio data as bytes (WAV format)

    Raises:
        RuntimeError: If synthesis fails
    """
    try:
        tts_provider = _get_provider(provider)
        return tts_provider.synthesize(
            text=text,
            voice=voice,
            language=language,
            **kwargs
        )
    except Exception as e:
        logger.error(f"Error calling TTS provider: {e}", exc_info=True)
        raise


def list_voices(provider: Optional[str] = None) -> list[str]:
    """List available voices from the specified provider.

    Args:
        provider: TTS provider to use (defaults to TTS_PROVIDER env var or "gpt-sovits")

    Returns:
        List of voice names
    """
    try:
        tts_provider = _get_provider(provider)
        return tts_provider.list_voices()
    except Exception as e:
        logger.error(f"Error listing voices from TTS provider: {e}", exc_info=True)
        raise


def list_backends() -> list[str]:
    """List all available TTS backends.

    Returns:
        List of backend names (e.g., ["gpt-sovits", "cosyvoice", "fish-speech"])
    """
    try:
        return list_available_backends()
    except Exception as e:
        logger.error(f"Error listing TTS backends: {e}", exc_info=True)
        raise
