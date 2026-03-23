"""NVIDIA NIM LLM provider implementation.

Uses raw requests to the OpenAI-compatible API at integrate.api.nvidia.com.
Normalizes responses to match Ollama's streaming chunk format.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

import requests

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


class NvidiaProvider(BaseLLMProvider):
    """NVIDIA NIM implementation of BaseLLMProvider."""

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        if api_key is None:
            api_key = os.getenv("NVIDIA_API_KEY", "")

        if not api_key:
            logger.warning("No NVIDIA API key provided")

        self.api_key = api_key
        self.base_url = (base_url or NVIDIA_BASE_URL).rstrip("/")
        logger.info(f"Initialized NVIDIA NIM provider (base_url={self.base_url})")

    def _headers(self, stream: bool = False) -> Dict[str, str]:
        h = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if stream:
            h["Accept"] = "text/event-stream"
        return h

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

        # Clean messages to OpenAI format (strip Ollama-specific fields)
        clean_messages = []
        for msg in messages:
            clean = {"role": msg.get("role", "user"), "content": msg.get("content", "")}
            if msg.get("name"):
                clean["name"] = msg["name"]
            if msg.get("tool_calls"):
                clean["tool_calls"] = msg["tool_calls"]
            if msg.get("tool_call_id"):
                clean["tool_call_id"] = msg["tool_call_id"]
            clean_messages.append(clean)

        payload: Dict[str, Any] = {
            "model": model,
            "messages": clean_messages,
            "stream": stream,
            "max_tokens": min(options.get("num_ctx", 16384), 16384),
        }

        if options.get("temperature") is not None:
            payload["temperature"] = options["temperature"]

        if tools:
            payload["tools"] = tools

        if think:
            payload["chat_template_kwargs"] = {"enable_thinking": True}

        try:
            if stream:
                return self._stream_chat(payload)
            else:
                return self._sync_chat(payload)
        except Exception as e:
            logger.error(f"NVIDIA NIM chat failed (model={model}): {e}", exc_info=True)
            raise

    def _stream_chat(self, payload):
        """Stream chat responses, yielding OllamaStyleChunks."""
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(stream=True),
            json=payload,
            stream=True,
        )
        resp.raise_for_status()

        # Accumulate partial tool call data across chunks
        pending_tool_calls: Dict[int, Dict] = {}

        for line in resp.iter_lines():
            if not line:
                continue
            text = line.decode("utf-8")
            if not text.startswith("data: "):
                continue
            data_str = text[6:]
            if data_str.strip() == "[DONE]":
                break

            try:
                chunk = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            choices = chunk.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            content = delta.get("content", "") or ""
            thinking = delta.get("reasoning_content") or None

            # Handle streaming tool calls (accumulated across chunks)
            tc_deltas = delta.get("tool_calls")
            if tc_deltas:
                for tc in tc_deltas:
                    idx = tc.get("index", 0)
                    if idx not in pending_tool_calls:
                        pending_tool_calls[idx] = {"name": "", "arguments": ""}
                    fn = tc.get("function", {})
                    if fn.get("name"):
                        pending_tool_calls[idx]["name"] = fn["name"]
                    if fn.get("arguments"):
                        pending_tool_calls[idx]["arguments"] += fn["arguments"]

            # Emit tool calls on finish_reason=tool_calls
            finish = choices[0].get("finish_reason")
            tool_calls_list = None
            if finish == "tool_calls" and pending_tool_calls:
                tool_calls_list = []
                for tc_data in pending_tool_calls.values():
                    args = {}
                    try:
                        args = json.loads(tc_data["arguments"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                    tool_calls_list.append(ToolCall(
                        function=ToolCallFunction(name=tc_data["name"], arguments=args)
                    ))
                pending_tool_calls.clear()

            if content or thinking or tool_calls_list:
                yield OllamaStyleChunk(
                    message=OllamaStyleMessage(
                        content=content,
                        thinking=thinking,
                        tool_calls=tool_calls_list,
                    )
                )

    def _sync_chat(self, payload):
        """Non-streaming chat, returns a single OllamaStyleChunk."""
        payload["stream"] = False
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

        choices = data.get("choices", [])
        if not choices:
            return OllamaStyleChunk(message=OllamaStyleMessage(content=""))

        msg = choices[0].get("message", {})
        text = msg.get("content", "") or ""
        tool_calls = None

        if msg.get("tool_calls"):
            tool_calls = []
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                args = {}
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    pass
                tool_calls.append(ToolCall(
                    function=ToolCallFunction(name=fn.get("name", ""), arguments=args)
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
            resp = requests.get(
                f"{self.base_url}/models",
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return [m["id"] for m in data.get("data", [])]
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
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 4096,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"] or ""
        except Exception as e:
            logger.error(f"NVIDIA generate failed (model={model}): {e}", exc_info=True)
            raise

    def ensure_model_available(self, model: str) -> bool:
        """No-op for cloud API."""
        return False

    def pull_model(self, model: str) -> None:
        """No-op for cloud API."""
        pass
