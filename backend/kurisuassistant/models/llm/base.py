"""Base LLM provider interface.

This module defines the abstract interface that all LLM providers must implement.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Optional, Any


class BaseLLMProvider(ABC):
    """Abstract base class for LLM providers."""

    @abstractmethod
    def chat(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        stream: bool = True,
        **kwargs
    ):
        """Send a chat request to the LLM.

        Args:
            model: Model name/identifier
            messages: List of message dictionaries with role and content
            tools: Optional list of available tools
            stream: Whether to stream the response (default: True)
            **kwargs: Additional provider-specific options

        Returns:
            Response object (varies by provider and stream setting)
        """
        pass

    @abstractmethod
    def list_models(self) -> List[str]:
        """List available models.

        Returns:
            List of model names/identifiers
        """
        pass

    @abstractmethod
    def generate(
        self,
        model: str,
        prompt: str,
        options: Optional[Dict] = None,
        stream: bool = False
    ) -> str:
        """Generate text from a prompt (non-chat interface).

        Args:
            model: Model name/identifier
            prompt: Text prompt
            options: Optional generation parameters
            stream: Whether to stream the response (default: False)

        Returns:
            Generated text
        """
        pass

    @abstractmethod
    def ensure_model_available(self, model: str) -> bool:
        """Ensure a model is available locally.

        Args:
            model: Model name/identifier to check and, if needed, pull

        Returns:
            True if the model was pulled during this call, False if it was already available
        """
        pass

    @abstractmethod
    def pull_model(self, model: str) -> None:
        """Download/pull a model.

        Args:
            model: Model name/identifier to download
        """
        pass

    def validate_key(self) -> int:
        """Check the credentials this provider was built with.

        Returns:
            How many models the credentials unlock

        Raises:
            Exception: when the provider refuses the key

        The default assumes that listing models needs a valid key, which holds for
        Gemini. A provider whose catalogue is public overrides this with an
        authenticated probe, otherwise a bad key would read as "valid, no models".
        """
        return len(self.list_models())
