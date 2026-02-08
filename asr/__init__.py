"""ASR module — factory, registry, and public adapter re-exports."""

from .base import BaseASRProvider
from .faster_whisper_provider import FasterWhisperProvider

_PROVIDERS: dict[str, type[BaseASRProvider]] = {
    "faster-whisper": FasterWhisperProvider,
}

# Singleton instances (lazy-loaded per provider type)
_instances: dict[str, BaseASRProvider] = {}


def get_provider(provider_type: str | None = None) -> BaseASRProvider:
    """Get or create a singleton ASR provider instance."""
    if provider_type is None:
        provider_type = "faster-whisper"
    if provider_type not in _PROVIDERS:
        raise ValueError(f"Unknown ASR provider: {provider_type}")
    if provider_type not in _instances:
        _instances[provider_type] = _PROVIDERS[provider_type]()
    return _instances[provider_type]


# Re-export adapter function for convenience
from .adapter import transcribe  # noqa: E402

__all__ = [
    "BaseASRProvider",
    "FasterWhisperProvider",
    "get_provider",
    "transcribe",
]
