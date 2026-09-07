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
            api_url = os.getenv("LLM_API_URL", "http://localhost:11434")

        logger.info(f"Initializing Ollama provider with URL: {api_url}")
        self.client = OllamaClient(host=api_url)

    def ensure_model_available(self, model: str) -> bool:
        """Ensure a model exists locally before use.

        Returns:
            True if the model had to be pulled, False if it already existed
        """
        try:
            available_models = self.list_models()
            if model in available_models:
                return False

            logger.info(f"Model '{model}' not found locally. Pulling from Ollama registry.")
            self.pull_model(model)
            return True
        except Exception as e:
            logger.error(f"Failed to ensure Ollama model '{model}' is available: {e}", exc_info=True)
            raise

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
            self.ensure_model_available(model)
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

    def embed(self, model: str, texts: List[str], *, kind: str = "passage") -> List[List[float]]:
        """``POST /api/embed`` — Ollama embeds passages and queries the same way."""
        try:
            self.ensure_model_available(model)
            response = self.client.embed(model=model, input=list(texts))
            return [list(map(float, vector)) for vector in response.embeddings]
        except Exception as e:
            logger.error(f"Ollama embed request failed (model={model}): {e}", exc_info=True)
            raise

    def list_models(self) -> List[str]:
        """List available Ollama models.

        Raises when the host cannot be reached: an empty list means "this
        server has no models", which is not what an unreachable host means,
        and the two were indistinguishable to a first-run user (#151).

        Returns:
            List of model names
        """
        resp = self.client.list()
        return [m.model for m in getattr(resp, "models", [])]

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
            self.ensure_model_available(model)
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
