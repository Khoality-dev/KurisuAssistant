"""LLM provider abstractions, factory, and adapter."""

from typing import Optional

from .base import BaseLLMProvider
from .ollama_provider import OllamaProvider


def create_llm_provider(provider_type: str = "ollama", api_url: Optional[str] = None) -> BaseLLMProvider:
    """Factory function to create LLM provider instances.

    Args:
        provider_type: Type of provider to create (default: "ollama")
        api_url: Optional API URL to use (defaults to provider's default)

    Returns:
        BaseLLMProvider instance

    Raises:
        ValueError: If provider_type is not supported
    """
    if provider_type == "ollama":
        return OllamaProvider(api_url=api_url)
    else:
        raise ValueError(f"Unsupported provider type: {provider_type}")


# Re-export adapter functions for convenience
from .adapter import chat, list_models, generate, pull_model


__all__ = [
    "BaseLLMProvider",
    "OllamaProvider",
    "create_llm_provider",
    # Adapter functions
    "chat",
    "list_models",
    "generate",
    "pull_model",
]
