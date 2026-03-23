"""LLM provider abstractions, factory, and adapter."""

from typing import Optional

from .base import BaseLLMProvider
from .ollama_provider import OllamaProvider
from .gemini_provider import GeminiProvider


def create_llm_provider(
    provider_type: str = "ollama",
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> BaseLLMProvider:
    """Factory function to create LLM provider instances.

    Args:
        provider_type: Type of provider ("ollama" or "gemini")
        api_url: Optional API URL (for Ollama)
        api_key: Optional API key (for Gemini)

    Returns:
        BaseLLMProvider instance
    """
    if provider_type == "gemini":
        return GeminiProvider(api_key=api_key)
    elif provider_type == "ollama":
        return OllamaProvider(api_url=api_url)
    else:
        raise ValueError(f"Unsupported provider type: {provider_type}")


# Re-export adapter functions for convenience
from .adapter import chat, list_models, generate, pull_model, ensure_model_available


__all__ = [
    "BaseLLMProvider",
    "OllamaProvider",
    "GeminiProvider",
    "create_llm_provider",
    # Adapter functions
    "chat",
    "list_models",
    "generate",
    "pull_model",
    "ensure_model_available",
]
