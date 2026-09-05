"""The OpenAI-dialect providers: NVIDIA NIM and Poe on the shared implementation.

Everything is exercised against fake ``requests`` responses — the payload each
provider sends, the SSE stream it parses back into Ollama-shaped chunks, the way an
error body becomes a readable message, Poe's model filter, and how each validates a
key. No network.
"""

import json
from unittest.mock import patch

import pytest
import requests

from kurisuassistant.models.llm import create_llm_provider
from kurisuassistant.models.llm.base import BaseLLMProvider
from kurisuassistant.models.llm.nvidia_provider import NvidiaProvider
from kurisuassistant.models.llm.poe_provider import PoeProvider, _KEY_CHECK_MODEL


class FakeResponse:
    def __init__(self, status=200, json_data=None, lines=None, reason=""):
        self.status_code = status
        self.reason = reason
        self._json = json_data
        self._lines = lines or []
        self.headers = {}

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json

    @property
    def text(self):
        return json.dumps(self._json) if self._json is not None else ""

    def iter_lines(self):
        for line in self._lines:
            yield line.encode("utf-8") if isinstance(line, str) else line


def sse(*events):
    """SSE lines for the given chunk dicts, terminated by [DONE]."""
    lines = []
    for ev in events:
        lines.append("data: " + json.dumps(ev))
        lines.append("")  # blank separator, as the wire has
    lines.append("data: [DONE]")
    return lines


def delta(content=None, reasoning=None, tool_calls=None, finish=None):
    d = {}
    if content is not None:
        d["content"] = content
    if reasoning is not None:
        d["reasoning_content"] = reasoning
    if tool_calls is not None:
        d["tool_calls"] = tool_calls
    return {"choices": [{"delta": d, "finish_reason": finish}]}


POST = "kurisuassistant.models.llm.openai_compat.requests.post"
GET = "kurisuassistant.models.llm.openai_compat.requests.get"
POE_POST = "kurisuassistant.models.llm.poe_provider.requests.post"

CONVERSATION = [
    {"role": "system", "content": "Be brief."},
    {"role": "user", "content": "Weather in Hanoi?"},
    {"role": "assistant", "content": "", "thinking": "need the tool",
     "tool_calls": [{"function": {"name": "get_weather", "arguments": {"city": "Hanoi"}}}]},
    {"role": "tool", "name": "get_weather", "content": "31C"},
]


def sent_payload(mock_post):
    return mock_post.call_args.kwargs["json"]


# ---------------------------------------------------------------------------
# Payloads
# ---------------------------------------------------------------------------

class TestPayloads:
    def test_nvidia_keeps_its_nim_specific_fields(self):
        with patch(POST, return_value=FakeResponse(json_data={"choices": [{"message": {"content": "ok"}}]})) as post:
            NvidiaProvider(api_key="nv-key").chat(
                "qwen/qwen3", CONVERSATION, tools=[{"type": "function", "function": {"name": "get_weather"}}],
                stream=False, think=True, options={"num_ctx": 4096, "temperature": 0.2},
            )
        payload = sent_payload(post)
        assert payload["max_tokens"] == 4096
        assert payload["chat_template_kwargs"] == {"enable_thinking": True}
        assert payload["temperature"] == 0.2
        assert payload["tools"][0]["function"]["name"] == "get_weather"
        assert payload["stream"] is False
        assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer nv-key"
        assert post.call_args.args[0] == "https://integrate.api.nvidia.com/v1/chat/completions"

    def test_nvidia_caps_max_tokens_at_16k(self):
        with patch(POST, return_value=FakeResponse(json_data={"choices": []})) as post:
            NvidiaProvider(api_key="k").chat("m", CONVERSATION, stream=False, options={"num_ctx": 131072})
        assert sent_payload(post)["max_tokens"] == 16384

    def test_poe_sends_none_of_the_nim_fields(self):
        with patch(POST, return_value=FakeResponse(json_data={"choices": [{"message": {"content": "ok"}}]})) as post:
            PoeProvider(api_key="poe-key").chat(
                "claude-opus-4.8", CONVERSATION, stream=False, think=True, options={"num_ctx": 4096},
            )
        payload = sent_payload(post)
        assert "max_tokens" not in payload, "num_ctx is a context size, not an output cap"
        assert "chat_template_kwargs" not in payload, "Poe has no chat-completions reasoning switch"
        assert post.call_args.args[0] == "https://api.poe.com/v1/chat/completions"
        assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer poe-key"

    def test_poe_passes_an_explicit_output_cap(self):
        with patch(POST, return_value=FakeResponse(json_data={"choices": []})) as post:
            PoeProvider(api_key="k").chat("gpt-5.4", CONVERSATION, stream=False, options={"num_predict": 256})
        assert sent_payload(post)["max_tokens"] == 256

    def test_messages_gain_openai_tool_call_linkage(self):
        with patch(POST, return_value=FakeResponse(json_data={"choices": []})) as post:
            PoeProvider(api_key="k").chat("m", CONVERSATION, stream=False)
        messages = sent_payload(post)["messages"]
        assistant = messages[2]
        tool = messages[3]
        assert assistant["content"] is None, "a tool-call-only turn has null content"
        assert assistant["reasoning_content"] == "need the tool"
        call = assistant["tool_calls"][0]
        assert call["type"] == "function"
        assert json.loads(call["function"]["arguments"]) == {"city": "Hanoi"}
        assert tool["tool_call_id"] == call["id"], "the result points back at its call"
        assert messages[0] == {"role": "system", "content": "Be brief."}

    def test_env_var_is_the_fallback_key(self, monkeypatch):
        monkeypatch.setenv("POE_API_KEY", "from-env")
        assert PoeProvider().api_key == "from-env"
        monkeypatch.setenv("NVIDIA_API_KEY", "nv-env")
        assert NvidiaProvider().api_key == "nv-env"


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------

class TestStreaming:
    def test_content_thinking_and_assembled_tool_calls(self):
        lines = sse(
            delta(reasoning="Let me check."),
            delta(content="Sure"),
            delta(content=", one moment."),
            delta(tool_calls=[{"index": 0, "function": {"name": "get_weather", "arguments": '{"ci'}}]),
            delta(tool_calls=[{"index": 0, "function": {"arguments": 'ty": "Hanoi"}'}}]),
            delta(finish="tool_calls"),
        )
        with patch(POST, return_value=FakeResponse(lines=lines)):
            chunks = list(PoeProvider(api_key="k").chat("m", CONVERSATION, stream=True))

        assert chunks[0].message.thinking == "Let me check."
        assert "".join(c.message.content for c in chunks) == "Sure, one moment."
        with_calls = [c for c in chunks if c.message.tool_calls]
        assert len(with_calls) == 1, "fragments are held until finish_reason=tool_calls"
        call = with_calls[0].message.tool_calls[0]
        assert call.function.name == "get_weather"
        assert call.function.arguments == {"city": "Hanoi"}

    def test_keepalives_and_empty_choices_are_skipped(self):
        lines = [": ping", "", "data: {\"choices\": []}", "data: not json"] + sse(delta(content="hi"))
        with patch(POST, return_value=FakeResponse(lines=lines)):
            chunks = list(NvidiaProvider(api_key="k").chat("m", CONVERSATION, stream=True))
        assert [c.message.content for c in chunks] == ["hi"]

    def test_sync_chat_returns_one_chunk_with_tool_calls(self):
        body = {"choices": [{"message": {
            "content": "",
            "reasoning_content": "thinking…",
            "tool_calls": [{"function": {"name": "get_weather", "arguments": '{"city": "Hue"}'}}],
        }}]}
        with patch(POST, return_value=FakeResponse(json_data=body)):
            chunk = PoeProvider(api_key="k").chat("m", CONVERSATION, stream=False)
        assert chunk.message.thinking == "thinking…"
        assert chunk.message.tool_calls[0].function.arguments == {"city": "Hue"}


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

POE_402 = {"error": {"type": "insufficient_credits", "code": "insufficient_credits",
                     "message": "You have run out of points."}}


class TestErrors:
    def test_streaming_error_body_is_surfaced(self):
        with patch(POST, return_value=FakeResponse(status=402, json_data=POE_402)):
            with pytest.raises(requests.HTTPError) as exc:
                list(PoeProvider(api_key="k").chat("m", CONVERSATION, stream=True))
        assert "Poe: HTTP 402 insufficient_credits: You have run out of points." == str(exc.value)

    def test_sync_error_body_is_surfaced(self):
        with patch(POST, return_value=FakeResponse(status=402, json_data=POE_402)):
            with pytest.raises(requests.HTTPError, match="insufficient_credits"):
                PoeProvider(api_key="k").chat("m", CONVERSATION, stream=False)

    def test_error_without_a_body_falls_back_to_the_status(self):
        with patch(POST, return_value=FakeResponse(status=502, reason="Bad Gateway")):
            with pytest.raises(requests.HTTPError, match="NVIDIA NIM: HTTP 502 Bad Gateway"):
                NvidiaProvider(api_key="k").chat("m", CONVERSATION, stream=False)


# ---------------------------------------------------------------------------
# Catalogue and key validation
# ---------------------------------------------------------------------------

POE_CATALOGUE = {"data": [
    {"id": "claude-opus-4.8", "architecture": {"output_modalities": ["text"]}},
    {"id": "gpt-5.4", "architecture": {"output_modalities": ["text"]},
     "supported_endpoints": ["/v1/chat/completions", "/v1/responses"]},
    {"id": "responses-only-bot", "architecture": {"output_modalities": ["text"]},
     "supported_endpoints": ["/v1/responses"]},
    {"id": "veo-4", "architecture": {"output_modalities": ["video"]}, "supported_endpoints": ["/v1/videos"]},
    {"id": "gpt-image-2", "architecture": {"output_modalities": ["image"]}},
    {"id": "no-architecture-field"},
]}


class TestCatalogue:
    def test_poe_offers_only_text_chat_models(self):
        with patch(GET, return_value=FakeResponse(json_data=POE_CATALOGUE)):
            assert PoeProvider(api_key="k").list_models() == ["claude-opus-4.8", "gpt-5.4", "no-architecture-field"]

    def test_nvidia_offers_every_listed_model(self):
        with patch(GET, return_value=FakeResponse(json_data={"data": [{"id": "a"}, {"id": "b"}]})):
            assert NvidiaProvider(api_key="k").list_models() == ["a", "b"]

    def test_list_models_swallows_failures(self):
        with patch(GET, return_value=FakeResponse(status=401, json_data={"error": {"message": "nope"}})):
            assert NvidiaProvider(api_key="bad").list_models() == []


class TestValidateKey:
    def test_poe_rejects_a_key_the_api_refuses(self):
        refused = {"error": {"type": "authentication_error", "code": "invalid_api_key",
                             "message": "Incorrect API key provided."}}
        with patch(POE_POST, return_value=FakeResponse(status=401, json_data=refused)) as post:
            with pytest.raises(PermissionError, match="invalid_api_key"):
                PoeProvider(api_key="bad").validate_key()
        probe = post.call_args.kwargs["json"]
        assert probe["model"] == _KEY_CHECK_MODEL and probe["max_tokens"] == 1

    def test_poe_accepts_a_key_that_gets_past_authentication(self):
        not_found = {"error": {"type": "not_found_error", "message": "no such bot"}}
        with patch(POE_POST, return_value=FakeResponse(status=404, json_data=not_found)), \
             patch(GET, return_value=FakeResponse(json_data=POE_CATALOGUE)):
            assert PoeProvider(api_key="good").validate_key() == 3

    def test_poe_out_of_points_is_still_a_valid_key(self):
        with patch(POE_POST, return_value=FakeResponse(status=402, json_data=POE_402)), \
             patch(GET, return_value=FakeResponse(json_data={"data": [{"id": "x"}]})):
            assert PoeProvider(api_key="good").validate_key() == 1

    def test_nvidia_validation_lets_a_refusal_through(self):
        with patch(GET, return_value=FakeResponse(status=401, json_data={"error": {"message": "nope"}})):
            with pytest.raises(requests.HTTPError, match="401"):
                NvidiaProvider(api_key="bad").validate_key()

    def test_base_default_counts_listed_models(self):
        class Minimal(BaseLLMProvider):
            def chat(self, *a, **k): ...
            def list_models(self): return ["a", "b"]
            def generate(self, *a, **k): ...
            def ensure_model_available(self, model): return False
            def pull_model(self, model): ...

        assert Minimal().validate_key() == 2


class TestFactory:
    def test_builds_poe(self):
        assert isinstance(create_llm_provider("poe", api_key="k"), PoeProvider)

    def test_builds_nvidia(self):
        assert isinstance(create_llm_provider("nvidia", api_key="k"), NvidiaProvider)

    def test_rejects_unknown(self):
        with pytest.raises(ValueError):
            create_llm_provider("claude-direct")
