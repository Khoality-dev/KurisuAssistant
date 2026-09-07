"""NVIDIA NIM LLM provider.

An OpenAI-dialect endpoint at integrate.api.nvidia.com; the shared implementation
is ``openai_compat.py``. What is specific to NIM: ``max_tokens`` is derived from the
Ollama-style ``num_ctx`` option and capped at 16k, and thinking is switched on
through ``chat_template_kwargs`` (the Qwen convention), with the model's reasoning
coming back as ``reasoning_content``.
"""

from typing import Any, Dict

from .openai_compat import (  # noqa: F401 — the chunk classes used to live here
    OllamaStyleChunk,
    OllamaStyleMessage,
    OpenAICompatibleProvider,
    ToolCall,
    ToolCallFunction,
)

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


class NvidiaProvider(OpenAICompatibleProvider):
    """NVIDIA NIM implementation of BaseLLMProvider."""

    PROVIDER_NAME = "NVIDIA NIM"
    DEFAULT_BASE_URL = NVIDIA_BASE_URL
    API_KEY_ENV = "NVIDIA_API_KEY"

    def _extend_payload(self, payload: Dict[str, Any], *, think: bool, options: Dict[str, Any]) -> None:
        payload["max_tokens"] = min(options.get("num_ctx", 16384), 16384)
        if think:
            payload["chat_template_kwargs"] = {"enable_thinking": True}

    def _extend_embed_payload(self, payload: Dict[str, Any], *, kind: str) -> None:
        # The nv-embedqa family embeds passages and queries asymmetrically and
        # refuses a request that does not say which side this is; bge-m3 accepts
        # the field and ignores it. `truncate` keeps an over-long passage from
        # being a 400 instead of a slightly shorter embedding.
        payload["input_type"] = "query" if kind == "query" else "passage"
        payload["truncate"] = "END"
