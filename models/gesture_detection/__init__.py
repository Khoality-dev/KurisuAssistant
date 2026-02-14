"""Gesture detection module — factory and public exports."""

from .base import BaseGestureDetector
from .mediapipe_provider import MediaPipeGestureDetector

_PROVIDERS: dict[str, type[BaseGestureDetector]] = {
    "mediapipe": MediaPipeGestureDetector,
}

_instances: dict[str, BaseGestureDetector] = {}


def get_provider(provider_type: str | None = None) -> BaseGestureDetector:
    """Get or create a singleton gesture detector instance."""
    if provider_type is None:
        provider_type = "mediapipe"
    if provider_type not in _PROVIDERS:
        raise ValueError(f"Unknown gesture detection provider: {provider_type}")
    if provider_type not in _instances:
        _instances[provider_type] = _PROVIDERS[provider_type]()
    return _instances[provider_type]


__all__ = [
    "BaseGestureDetector",
    "MediaPipeGestureDetector",
    "get_provider",
]
