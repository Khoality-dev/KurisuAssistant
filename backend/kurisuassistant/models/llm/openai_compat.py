"""Shared implementation for providers that speak the OpenAI chat-completions dialect.

NVIDIA NIM and Poe both expose ``POST /chat/completions`` (server-sent events when
streaming) and ``GET /models`` behind a bearer token, and differ from OpenAI — and
from each other — only in small payload details. Everything they have in common
lives here:

- converting the Ollama-shaped conversation the agents build into OpenAI messages
  (assistant tool calls need ids, tool results need to point back at them);
- parsing the SSE stream back into Ollama-shaped chunks, assembling tool-call
  arguments that arrive in fragments until ``finish_reason`` says they are whole;
- turning an error body into an exception message a user can act on, instead of
  the bare ``402 Client Error`` ``raise_for_status`` would produce.

A concrete provider sets ``PROVIDER_NAME``, ``DEFAULT_BASE_URL`` and ``API_KEY_ENV``
and overrides the hooks it needs: ``_extend_payload`` for provider-specific request
fields, ``_model_filter`` to drop catalogue entries that cannot chat, and
``validate_key`` when listing models does not actually require a valid key.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

import requests

from .base import BaseLLMProvider

logger = logging.getLogger(__name__)


# --- Response wrappers matching Ollama's chunk shape ---------------------------
# The agents read ``chunk.message.content`` / ``.thinking`` / ``.tool_calls`` and
# ``tool_call.function.name`` / ``.arguments`` exactly as the ollama client returns
# them, so every provider hands back these.

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


class OpenAICompatibleProvider(BaseLLMProvider):
    """Base for bearer-token providers with an OpenAI-dialect chat endpoint."""

    #: Human-readable name for log lines and error messages.
    PROVIDER_NAME = "OpenAI-compatible"
    #: ``https://host/v1`` — with the version prefix.
    DEFAULT_BASE_URL = ""
    #: Environment variable consulted when no key is passed explicitly.
    API_KEY_ENV = ""
    #: (connect, read) seconds. The read timeout is between bytes, so a long
    #: generation is fine as long as the stream keeps moving.
    REQUEST_TIMEOUT = (10, 300)

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        if api_key is None:
            api_key = os.getenv(self.API_KEY_ENV, "") if self.API_KEY_ENV else ""
        if not api_key:
            logger.warning("No %s API key provided", self.PROVIDER_NAME)
        self.api_key = api_key
        self.base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        logger.info("Initialized %s provider (base_url=%s)", self.PROVIDER_NAME, self.base_url)

    # -- hooks -------------------------------------------------------------------

    def _extend_payload(self, payload: Dict[str, Any], *, think: bool, options: Dict[str, Any]) -> None:
        """Add provider-specific fields to a chat-completions payload, in place."""

    def _model_filter(self, entry: Dict[str, Any]) -> bool:
        """Whether a ``GET /models`` entry should be offered as a chat model."""
        return True

    # -- request plumbing --------------------------------------------------------

    def _headers(self, stream: bool = False) -> Dict[str, str]:
        h = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if stream:
            h["Accept"] = "text/event-stream"
        return h

    @classmethod
    def _error_message(cls, resp: requests.Response) -> str:
        """``Poe: HTTP 401 authentication_error (invalid_api_key): Incorrect API key provided.``

        The type is the error class, the code (when it says more) the specific
        reason, the message what the user is meant to read.
        """
        detail = ""
        try:
            err = resp.json().get("error")
        except ValueError:
            err = None
        if isinstance(err, dict):
            kind = str(err.get("type") or "")
            code = str(err.get("code") or "")
            if code and code != kind:
                kind = f"{kind} ({code})" if kind else code
            message = err.get("message") or ""
            detail = f" {kind}: {message}".rstrip(": ") if (kind or message) else ""
        elif isinstance(err, str):
            detail = f" {err}"
        elif resp.reason:
            detail = f" {resp.reason}"
        return f"{cls.PROVIDER_NAME}: HTTP {resp.status_code}{detail}"

    def _raise_for_status(self, resp: requests.Response) -> None:
        if not resp.ok:
            raise requests.HTTPError(self._error_message(resp), response=resp)

    # -- message conversion ------------------------------------------------------

    @staticmethod
    def _convert_messages(messages: List[Dict]) -> List[Dict[str, Any]]:
        """Ollama-shaped conversation → OpenAI messages.

        Ollama tool calls carry no id and tool results reference the call by tool
        name; OpenAI needs an id on each call and ``tool_call_id`` on each result.
        """
        clean_messages: List[Dict[str, Any]] = []
        tool_call_counter = 0
        tool_name_to_id: Dict[str, str] = {}

        for msg in messages:
            role = msg.get("role", "user")
            clean: Dict[str, Any] = {"role": role}

            if role == "assistant":
                clean["content"] = msg.get("content", "") or ""
                # Thinking travels as reasoning_content (the Qwen/NIM convention).
                if msg.get("thinking"):
                    clean["reasoning_content"] = msg["thinking"]
                if msg.get("tool_calls"):
                    openai_tcs = []
                    for tc in msg["tool_calls"]:
                        fn = tc.get("function", {})
                        tc_id = f"call_{tool_call_counter}"
                        tool_call_counter += 1
                        tool_name_to_id[fn.get("name", "")] = tc_id
                        args = fn.get("arguments", {})
                        if isinstance(args, dict):
                            args = json.dumps(args)
                        openai_tcs.append({
                            "id": tc_id,
                            "type": "function",
                            "function": {"name": fn.get("name", ""), "arguments": args},
                        })
                    clean["tool_calls"] = openai_tcs
                    # OpenAI wants null content when the turn is only tool calls.
                    if not clean["content"]:
                        clean["content"] = None
            elif role == "tool":
                clean["content"] = msg.get("content", "")
                tool_name = msg.get("name", "")
                clean["tool_call_id"] = tool_name_to_id.get(tool_name, f"call_{tool_call_counter}")
                if not tool_name_to_id.get(tool_name):
                    tool_call_counter += 1
            else:
                clean["content"] = msg.get("content", "")
                if msg.get("name"):
                    clean["name"] = msg["name"]

            clean_messages.append(clean)

        return clean_messages

    def _build_payload(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]],
        stream: bool,
        think: bool,
        options: Dict[str, Any],
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": self._convert_messages(messages),
            "stream": stream,
        }
        if options.get("temperature") is not None:
            payload["temperature"] = options["temperature"]
        if tools:
            payload["tools"] = tools
        self._extend_payload(payload, think=think, options=options)
        return payload

    # -- BaseLLMProvider ---------------------------------------------------------

    def chat(
        self,
        model: str,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        stream: bool = True,
        **kwargs,
    ):
        """Send a chat request, yielding (or returning) Ollama-compatible chunks."""
        think = bool(kwargs.get("think", False))
        options = kwargs.get("options") or {}
        payload = self._build_payload(model, messages, tools, stream, think, options)
        try:
            if stream:
                return self._stream_chat(payload)
            return self._sync_chat(payload)
        except Exception as e:
            logger.error("%s chat failed (model=%s): %s", self.PROVIDER_NAME, model, e, exc_info=True)
            raise

    def _stream_chat(self, payload: Dict[str, Any]) -> Iterator[OllamaStyleChunk]:
        """Stream chat responses, yielding OllamaStyleChunks."""
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(stream=True),
            json=payload,
            stream=True,
            timeout=self.REQUEST_TIMEOUT,
        )
        self._raise_for_status(resp)

        # Tool-call arguments arrive in fragments, keyed by index; a call is complete
        # only when finish_reason says so.
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

    def _sync_chat(self, payload: Dict[str, Any]) -> OllamaStyleChunk:
        """Non-streaming chat, returning a single OllamaStyleChunk."""
        payload["stream"] = False
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
            timeout=self.REQUEST_TIMEOUT,
        )
        self._raise_for_status(resp)
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
                thinking=msg.get("reasoning_content") or None,
                tool_calls=tool_calls if tool_calls else None,
            )
        )

    def _list_models_raw(self) -> List[str]:
        """``GET /models`` → model ids passing ``_model_filter``; raises on failure."""
        resp = requests.get(
            f"{self.base_url}/models",
            headers=self._headers(),
            timeout=self.REQUEST_TIMEOUT,
        )
        self._raise_for_status(resp)
        data = resp.json()
        return [m["id"] for m in data.get("data", []) if "id" in m and self._model_filter(m)]

    def list_models(self) -> List[str]:
        """List chat models; an unreachable or refusing endpoint yields an empty list."""
        try:
            return self._list_models_raw()
        except Exception as e:
            logger.error("Failed to list %s models: %s", self.PROVIDER_NAME, e, exc_info=True)
            return []

    def validate_key(self) -> int:
        # Unlike list_models this lets the refusal through: a bad key must read as
        # invalid, not as "valid, zero models".
        return len(self._list_models_raw())

    def generate(
        self,
        model: str,
        prompt: str,
        options: Optional[Dict] = None,
        stream: bool = False,
    ) -> str:
        """Generate text from a single prompt through the chat endpoint."""
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
                timeout=self.REQUEST_TIMEOUT,
            )
            self._raise_for_status(resp)
            data = resp.json()
            return data["choices"][0]["message"]["content"] or ""
        except Exception as e:
            logger.error("%s generate failed (model=%s): %s", self.PROVIDER_NAME, model, e, exc_info=True)
            raise

    def ensure_model_available(self, model: str) -> bool:
        """No-op for a hosted API."""
        return False

    def pull_model(self, model: str) -> None:
        """No-op for a hosted API."""
        return None
