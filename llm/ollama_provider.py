"""Ollama LLM provider implementation."""

import logging
import os
from typing import List, Dict, Optional
from ollama import Client as OllamaClient

from .base import BaseLLMProvider

logger = logging.getLogger(__name__)


class OllamaProvider(BaseLLMProvider):
    """Ollama implementation of BaseLLMProvider."""

    def __init__(self, api_url: Optional[str] = None):
        """Initialize Ollama provider.

        Args:
            api_url: Optional Ollama API URL (defaults to LLM_API_URL env var)
        """
        if api_url is None:
            api_url = os.getenv("LLM_API_URL", "http://10.0.0.122:11434")

        logger.info(f"Initializing Ollama provider with URL: {api_url}")
        self.client = OllamaClient(host=api_url)

    def chat(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        stream: bool = True,
        **kwargs
    ):
        """Send a chat request to Ollama.

        Args:
            model: Ollama model name
            messages: List of message dictionaries
            tools: Optional list of tools
            stream: Whether to stream responses
            **kwargs: Additional options passed to Ollama

        Returns:
            Streaming iterator or response object
        """
        try:
            return self.client.chat(
                model=model,
                messages=messages,
                tools=tools or [],
                stream=stream,
                **kwargs
            )
        except Exception as e:
            logger.error(f"Ollama chat request failed (model={model}): {e}", exc_info=True)
            raise

    def list_models(self) -> List[str]:
        """List available Ollama models.

        Returns:
            List of model names
        """
        try:
            resp = self.client.list()
            return [m.model for m in getattr(resp, "models", [])]
        except Exception as e:
            logger.error(f"Failed to list Ollama models: {e}", exc_info=True)
            return []

    def generate(
        self,
        model: str,
        prompt: str,
        options: Optional[Dict] = None,
        stream: bool = False
    ) -> str:
        """Generate text using Ollama's generate API.

        Args:
            model: Ollama model name
            prompt: Text prompt
            options: Optional generation parameters
            stream: Whether to stream (default: False)

        Returns:
            Generated text
        """
        try:
            default_options = {"temperature": 0.7}
            if options:
                default_options.update(options)

            response = self.client.generate(
                model=model,
                prompt=prompt.strip(),
                stream=stream,
                options=default_options,
            )

            return response.response.strip()
        except Exception as e:
            logger.error(f"Ollama generate request failed (model={model}): {e}", exc_info=True)
            raise

    def pull_model(self, model: str) -> None:
        """Pull a model from Ollama registry.

        Args:
            model: Model name to pull
        """
        try:
            self.client.pull(model)
        except Exception as e:
            logger.error(f"Failed to pull Ollama model '{model}': {e}", exc_info=True)
            raise
