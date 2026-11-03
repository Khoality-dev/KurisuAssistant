"""Face recognition module — factory and public exports."""

from .base import BaseFaceRecognitionProvider
from .insightface_provider import InsightFaceProvider

_PROVIDERS: dict[str, type[BaseFaceRecognitionProvider]] = {
    "insightface": InsightFaceProvider,
}

_instances: dict[str, BaseFaceRecognitionProvider] = {}


def get_provider(provider_type: str | None = None) -> BaseFaceRecognitionProvider:
    """Get or create a singleton face recognition provider instance."""
    if provider_type is None:
        provider_type = "insightface"
    if provider_type not in _PROVIDERS:
        raise ValueError(f"Unknown face recognition provider: {provider_type}")
    if provider_type not in _instances:
        _instances[provider_type] = _PROVIDERS[provider_type]()
    return _instances[provider_type]


__all__ = [
    "BaseFaceRecognitionProvider",
    "InsightFaceProvider",
    "get_provider",
]
