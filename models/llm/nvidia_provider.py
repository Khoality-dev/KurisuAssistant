"""NVIDIA NIM LLM provider implementation.

Uses the OpenAI-compatible API at integrate.api.nvidia.com.
Normalizes responses to match Ollama's streaming chunk format.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

from openai import OpenAI

from .base import BaseLLMProvider

logger = logging.getLogger(__name__)

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


# --- Response wrappers to match Ollama's chunk format ---

@dataclass
class ToolCallFunction:
    name: str
    arguments: dict


@dataclass
class ToolCall:
    function: ToolCallFunction


@dataclass
class OllamaStyleMessage:
    content: str = ""
    thinking: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None


@dataclass
class OllamaStyleChunk:
    message: OllamaStyleMessage = field(default_factory=OllamaStyleMessage)


def _convert_tools(tools: List[Dict]) -> Optional[List[Dict]]:
    """Convert Ollama-format tool schemas to OpenAI format."""
    if not tools:
        return None
    # Ollama format is already OpenAI-compatible: {type: "function", function: {name, description, parameters}}
    return tools


class NvidiaProvider(BaseLLMProvider):
    """NVIDIA NIM implementation of BaseLLMProvider."""

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        if api_key is None:
            api_key = os.getenv("NVIDIA_API_KEY", "")

        if not api_key:
            logger.warning("No NVIDIA API key provided")

        self.client = OpenAI(
            api_key=api_key,
            base_url=base_url or NVIDIA_BASE_URL,
        )
        logger.info(f"Initialized NVIDIA NIM provider (base_url={base_url or NVIDIA_BASE_URL})")

    def chat(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        stream: bool = True,
        **kwargs,
    ):
        """Send a chat request to NVIDIA NIM, yielding Ollama-compatible chunks."""
        think = kwargs.get("think", False)
        options = kwargs.get("options", {})

        # Build request params
        params: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": stream,
        }

        if options.get("num_ctx"):
            params["max_tokens"] = min(options["num_ctx"], 16384)
        else:
            params["max_tokens"] = 16384

        if options.get("temperature") is not None:
            params["temperature"] = options["temperature"]

        openai_tools = _convert_tools(tools)
        if openai_tools:
            params["tools"] = openai_tools

        # Enable thinking for models that support it (e.g. qwen3.5)
        if think:
            params["chat_template_kwargs"] = {"enable_thinking": True}

        try:
            if stream:
                return self._stream_chat(params)
            else:
                return self._sync_chat(params)
        except Exception as e:
            logger.error(f"NVIDIA NIM chat failed (model={model}): {e}", exc_info=True)
            raise

    def _stream_chat(self, params):
        """Stream chat responses, yielding OllamaStyleChunks."""
        response = self.client.chat.completions.create(**params)

        for chunk in response:
            if not chunk.choices:
                continue

            delta = chunk.choices[0].delta
            text_content = delta.content or ""
            thinking_content = None
            tool_calls_list = None

            # Handle thinking (some models use <think> tags or reasoning_content)
            reasoning = getattr(delta, 'reasoning_content', None)
            if reasoning:
                thinking_content = reasoning

            # Handle tool calls
            if delta.tool_calls:
                tool_calls_list = []
                for tc in delta.tool_calls:
                    if tc.function and tc.function.name:
                        args = {}
                        if tc.function.arguments:
                            try:
                                args = json.loads(tc.function.arguments)
                            except (json.JSONDecodeError, TypeError):
                                args = {}
                        tool_calls_list.append(ToolCall(
                            function=ToolCallFunction(
                                name=tc.function.name,
                                arguments=args,
                            )
                        ))

            if text_content or thinking_content or tool_calls_list:
                yield OllamaStyleChunk(
                    message=OllamaStyleMessage(
                        content=text_content,
                        thinking=thinking_content,
                        tool_calls=tool_calls_list,
                    )
                )

    def _sync_chat(self, params):
        """Non-streaming chat, returns a single OllamaStyleChunk."""
        params["stream"] = False
        response = self.client.chat.completions.create(**params)

        if not response.choices:
            return OllamaStyleChunk(message=OllamaStyleMessage(content=""))

        msg = response.choices[0].message
        text = msg.content or ""
        tool_calls = None

        if msg.tool_calls:
            tool_calls = []
            for tc in msg.tool_calls:
                args = {}
                if tc.function.arguments:
                    try:
                        args = json.loads(tc.function.arguments)
                    except (json.JSONDecodeError, TypeError):
                        args = {}
                tool_calls.append(ToolCall(
                    function=ToolCallFunction(
                        name=tc.function.name,
                        arguments=args,
                    )
                ))

        return OllamaStyleChunk(
            message=OllamaStyleMessage(
                content=text,
                tool_calls=tool_calls if tool_calls else None,
            )
        )

    def list_models(self) -> List[str]:
        """List available NVIDIA NIM models."""
        try:
            response = self.client.models.list()
            return [m.id for m in response.data]
        except Exception as e:
            logger.error(f"Failed to list NVIDIA models: {e}", exc_info=True)
            return []

    def generate(
        self,
        model: str,
        prompt: str,
        options: Optional[Dict] = None,
        stream: bool = False,
    ) -> str:
        """Generate text using NVIDIA NIM."""
        try:
            response = self.client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4096,
                stream=False,
            )
            return response.choices[0].message.content or ""
        except Exception as e:
            logger.error(f"NVIDIA generate failed (model={model}): {e}", exc_info=True)
            raise

    def ensure_model_available(self, model: str) -> bool:
        """No-op for cloud API."""
        return False

    def pull_model(self, model: str) -> None:
        """No-op for cloud API."""
        pass
