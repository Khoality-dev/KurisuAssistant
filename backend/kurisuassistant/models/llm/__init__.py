"""LLM provider abstractions, factory, and adapter."""

from typing import Optional

from .base import BaseLLMProvider, ProviderNotConfigured
from .ollama_provider import OllamaProvider
from .gemini_provider import GeminiProvider
from .nvidia_provider import NvidiaProvider
from .poe_provider import PoeProvider


def create_llm_provider(
    provider_type: str = "ollama",
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> BaseLLMProvider:
    """Factory function to create LLM provider instances.

    Args:
        provider_type: Type of provider ("ollama", "gemini", "nvidia" or "poe")
        api_url: The account's Ollama URL (Ollama only)
        api_key: The account's API key (Gemini/NVIDIA/Poe only)

    Raises:
        ProviderNotConfigured: the account has not stored what the provider needs.

    Returns:
        BaseLLMProvider instance
    """
    if provider_type == "gemini":
        return GeminiProvider(api_key=api_key)
    elif provider_type == "nvidia":
        return NvidiaProvider(api_key=api_key)
    elif provider_type == "poe":
        return PoeProvider(api_key=api_key)
    elif provider_type == "ollama":
        return OllamaProvider(api_url=api_url)
    else:
        raise ValueError(f"Unsupported provider type: {provider_type}")


# Re-export adapter functions for convenience
from .adapter import chat, list_models, generate, pull_model, ensure_model_available


__all__ = [
    "BaseLLMProvider",
    "ProviderNotConfigured",
    "OllamaProvider",
    "GeminiProvider",
    "NvidiaProvider",
    "PoeProvider",
    "create_llm_provider",
    # Adapter functions
    "chat",
    "list_models",
    "generate",
    "pull_model",
    "ensure_model_available",
]
