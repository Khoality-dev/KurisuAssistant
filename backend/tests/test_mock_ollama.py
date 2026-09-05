"""The mock Ollama itself, driven by the real ``ollama`` client and by
``OllamaProvider`` — the two things the backend actually uses to talk to Ollama.

If the mock drifts from what the client's pydantic models accept, these fail
before any system test does.
"""

import httpx
import ollama
import pytest

from kurisuassistant.models.llm.ollama_provider import OllamaProvider
from tests.mock_ollama import DEFAULT_MODEL, MockOllamaServer, Reply, ToolCall

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]


def ask(text: str):
    return [{"role": "user", "content": text}]


class TestCatalogue:
    def test_lists_the_default_model(self, mock_ollama):
        resp = ollama.Client(host=mock_ollama.url).list()
        assert [m.model for m in resp.models] == [DEFAULT_MODEL]

    def test_show_describes_a_known_model_and_404s_an_unknown_one(self, mock_ollama):
        client = ollama.Client(host=mock_ollama.url)
        shown = client.show(DEFAULT_MODEL)
        assert shown.capabilities and "tools" in shown.capabilities
        assert shown.modelinfo["mock.context_length"] == 8192
        with pytest.raises(ollama.ResponseError) as exc:
            client.show("nope:latest")
        assert exc.value.status_code == 404

    def test_pull_adds_a_model_and_delete_removes_it(self, mock_ollama):
        client = ollama.Client(host=mock_ollama.url)
        client.pull("tiny:1b")
        assert "tiny:1b" in [m.model for m in client.list().models]
        client.delete("tiny:1b")
        assert "tiny:1b" not in [m.model for m in client.list().models]
        assert mock_ollama.state.requests_to("/api/pull")[0]["model"] == "tiny:1b"

    def test_bare_names_mean_latest(self, mock_ollama):
        assert mock_ollama.state.has_model("mock-model")
        chunk = ollama.Client(host=mock_ollama.url).chat("mock-model", ask("hi"), stream=False)
        assert chunk.message.content == "You said: hi"

    def test_auto_pull_off_refuses_unknown_models(self):
        with MockOllamaServer(auto_pull=False) as strict:
            client = ollama.Client(host=strict.url)
            with pytest.raises(ollama.ResponseError) as exc:
                client.pull("tiny:1b")
            assert exc.value.status_code == 404
            with pytest.raises(ollama.ResponseError):
                client.chat("tiny:1b", ask("hi"), stream=False)

    def test_version_and_root(self, mock_ollama):
        assert httpx.get(f"{mock_ollama.url}/api/version").json()["version"].endswith("mock")
        assert httpx.get(f"{mock_ollama.url}/").text == "Ollama is running"


class TestDefaultReplies:
    def test_streams_word_by_word_and_finishes_with_counts(self, mock_ollama):
        chunks = list(ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("one two three"), stream=True))
        text = "".join(c.message.content for c in chunks)
        assert text == "You said: one two three"
        assert len([c for c in chunks if c.message.content]) == 5, "one chunk per word"
        final = chunks[-1]
        assert final.done and final.done_reason == "stop"
        assert final.prompt_eval_count == 3 and final.eval_count == 5

    def test_think_adds_a_thinking_chunk_first(self, mock_ollama):
        chunks = list(ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("hi"), stream=True, think=True))
        thinking = [c for c in chunks if c.message.thinking]
        assert thinking and chunks.index(thinking[0]) < chunks.index([c for c in chunks if c.message.content][0])

    def test_call_directive_becomes_a_tool_call_when_the_tool_is_offered(self, mock_ollama):
        chunk = ollama.Client(host=mock_ollama.url).chat(
            DEFAULT_MODEL, ask('call get_weather {"city": "Hanoi"}'), tools=TOOLS, stream=False)
        call = chunk.message.tool_calls[0]
        assert call.function.name == "get_weather"
        assert call.function.arguments == {"city": "Hanoi"}

    def test_call_directive_for_an_unoffered_tool_is_declined_in_words(self, mock_ollama):
        chunk = ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("call get_weather {}"), stream=False)
        assert chunk.message.tool_calls is None
        assert "No tool named get_weather" in chunk.message.content

    def test_a_tool_result_is_acknowledged(self, mock_ollama):
        conversation = ask("weather?") + [{"role": "tool", "name": "get_weather", "content": "31C"}]
        chunk = ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, conversation, stream=False)
        assert chunk.message.content == "The tool returned: 31C"

    def test_generate(self, mock_ollama):
        out = ollama.Client(host=mock_ollama.url).generate(DEFAULT_MODEL, "ping", stream=False)
        assert out.response == "You said: ping"


class TestScripting:
    def test_scripted_replies_are_consumed_in_order_then_defaults_resume(self, mock_ollama):
        mock_ollama.state.script(Reply(content="First."), Reply(content="Second."))
        client = ollama.Client(host=mock_ollama.url)
        assert client.chat(DEFAULT_MODEL, ask("a"), stream=False).message.content == "First."
        assert client.chat(DEFAULT_MODEL, ask("b"), stream=False).message.content == "Second."
        assert client.chat(DEFAULT_MODEL, ask("c"), stream=False).message.content == "You said: c"

    def test_scripted_tool_calls_and_thinking_stream_in_ollama_shape(self, mock_ollama):
        mock_ollama.state.script(Reply(thinking="Need the tool.", tool_calls=[ToolCall("get_weather", {"city": "Hue"})]))
        chunks = list(ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("weather in Hue"), tools=TOOLS, stream=True))
        assert "".join(c.message.thinking or "" for c in chunks) == "Need the tool."
        calls = [tc for c in chunks if c.message.tool_calls for tc in c.message.tool_calls]
        assert [(tc.function.name, tc.function.arguments) for tc in calls] == [("get_weather", {"city": "Hue"})]

    def test_chunking_and_delay_are_honoured(self, mock_ollama):
        mock_ollama.state.script(Reply(content="a b c d e f", words_per_chunk=3, delay_ms=1))
        chunks = [c for c in ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("x"), stream=True) if c.message.content]
        assert [c.message.content for c in chunks] == ["a b c ", "d e f"]

    def test_scripted_error_surfaces_as_a_response_error(self, mock_ollama):
        mock_ollama.state.script(Reply(status=500, error="the model fell over"))
        with pytest.raises(ollama.ResponseError) as exc:
            ollama.Client(host=mock_ollama.url).chat(DEFAULT_MODEL, ask("x"), stream=False)
        assert exc.value.status_code == 500 and "fell over" in str(exc.value)

    def test_requests_are_recorded_with_what_was_sent(self, mock_ollama):
        ollama.Client(host=mock_ollama.url).chat(
            DEFAULT_MODEL, ask("hi"), tools=TOOLS, stream=False, think=True, options={"num_ctx": 4096})
        req = mock_ollama.state.requests_to("/api/chat")[0]
        assert req["model"] == DEFAULT_MODEL
        assert req["messages"][-1]["content"] == "hi"
        assert req["tools"][0]["function"]["name"] == "get_weather"
        assert req["think"] is True
        assert req["options"]["num_ctx"] == 4096

    def test_http_control_surface_mirrors_the_python_one(self, mock_ollama):
        base = mock_ollama.url
        httpx.post(f"{base}/_mock/replies", json={"replies": [{"content": "Scripted over HTTP."}]}).raise_for_status()
        assert httpx.get(f"{base}/_mock/state").json()["queued_replies"] == 1
        chunk = ollama.Client(host=base).chat(DEFAULT_MODEL, ask("x"), stream=False)
        assert chunk.message.content == "Scripted over HTTP."
        assert len(httpx.get(f"{base}/_mock/requests").json()["requests"]) == 1
        httpx.delete(f"{base}/_mock/requests")
        assert httpx.get(f"{base}/_mock/requests").json()["requests"] == []
        httpx.post(f"{base}/_mock/reset")
        assert httpx.get(f"{base}/_mock/state").json() == {
            "models": [DEFAULT_MODEL], "auto_pull": True, "queued_replies": 0, "requests": 0}


class TestThroughOllamaProvider:
    """The backend's own provider, unmodified, against the mock."""

    def test_list_and_stream(self, mock_ollama):
        provider = OllamaProvider(api_url=mock_ollama.url)
        assert provider.list_models() == [DEFAULT_MODEL]
        chunks = list(provider.chat(DEFAULT_MODEL, ask("hello there"), stream=True))
        assert "".join(c.message.content for c in chunks) == "You said: hello there"

    def test_ensure_model_available_pulls_a_new_model_once(self, mock_ollama):
        provider = OllamaProvider(api_url=mock_ollama.url)
        assert provider.ensure_model_available("fresh:7b") is True
        assert provider.ensure_model_available("fresh:7b") is False
        assert len(mock_ollama.state.requests_to("/api/pull")) == 1

    def test_generate_returns_stripped_text(self, mock_ollama):
        mock_ollama.state.script(Reply(content="  A summary.  "))
        assert OllamaProvider(api_url=mock_ollama.url).generate(DEFAULT_MODEL, "summarise") == "A summary."

    def test_non_streaming_chat_returns_the_whole_message(self, mock_ollama):
        mock_ollama.state.script(Reply(content="Whole.", thinking="brief"))
        resp = OllamaProvider(api_url=mock_ollama.url).chat(DEFAULT_MODEL, ask("x"), stream=False)
        assert resp.message.content == "Whole." and resp.message.thinking == "brief"
