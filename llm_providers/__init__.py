"""LLM provider abstractions and factory."""

from .base import BaseLLMProvider
from .ollama_provider import OllamaProvider


def create_llm_provider(provider_type: str = "ollama") -> BaseLLMProvider:
    """Factory function to create LLM provider instances.

    Args:
        provider_type: Type of provider to create (default: "ollama")

    Returns:
        BaseLLMProvider instance

    Raises:
        ValueError: If provider_type is not supported
    """
    if provider_type == "ollama":
        return OllamaProvider()
    else:
        raise ValueError(f"Unsupported provider type: {provider_type}")


__all__ = ["BaseLLMProvider", "OllamaProvider", "create_llm_provider"]
