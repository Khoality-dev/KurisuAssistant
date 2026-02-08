"""TTS provider factory, exports, and adapter."""

from typing import Optional
from .base import BaseTTSProvider
from .gpt_sovits_provider import GPTSoVITSProvider
from .index_tts_provider import IndexTTSProvider


# Registry of available TTS providers
_PROVIDERS = {
    "gpt-sovits": GPTSoVITSProvider,
    "index-tts": IndexTTSProvider,
    # Add more providers here as they're implemented:
    # "cosyvoice": CosyVoiceProvider,
    # "fish-speech": FishSpeechProvider,
}


def create_tts_provider(provider_type: str = "gpt-sovits", **kwargs) -> BaseTTSProvider:
    """Factory function to create TTS provider instances.

    Args:
        provider_type: Type of provider ("gpt-sovits", "cosyvoice", etc.)
        **kwargs: Provider-specific initialization parameters

    Returns:
        TTS provider instance

    Raises:
        ValueError: If provider_type is not supported
    """
    provider_class = _PROVIDERS.get(provider_type.lower())
    if provider_class is None:
        raise ValueError(
            f"Unsupported TTS provider: {provider_type}. "
            f"Available providers: {', '.join(_PROVIDERS.keys())}"
        )

    return provider_class(**kwargs)


def list_available_backends() -> list[str]:
    """List all available TTS backend names.

    Returns:
        List of backend names that can be used with create_tts_provider()
    """
    return sorted(_PROVIDERS.keys())


# Re-export adapter functions for convenience
from .adapter import synthesize, list_voices, list_backends, check_health


__all__ = [
    "BaseTTSProvider",
    "GPTSoVITSProvider",
    "IndexTTSProvider",
    "create_tts_provider",
    "list_available_backends",
    # Adapter functions
    "synthesize",
    "list_voices",
    "list_backends",
    "check_health",
]
