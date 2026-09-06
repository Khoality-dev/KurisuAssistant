"""Streaming through the backend pipeline: ``OllamaProvider.chat()`` against the
mock Ollama → chunks → ``ChatSessionHandler.send_event`` → what the socket sees.

Exercises the real provider and the real ``ollama`` client; only the model is a
mock, so nothing here is skipped and nothing costs money.
"""

from unittest.mock import AsyncMock, MagicMock

from kurisuassistant.models.llm.ollama_provider import OllamaProvider
from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.websocket.events import StreamChunkEvent, DoneEvent
from tests.mock_ollama import DEFAULT_MODEL, Reply


def make_mock_ws():
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = "CONNECTED"
    ws.send_json = AsyncMock()
    ws.receive = AsyncMock()
    ws.close = AsyncMock()
    return ws


class EventCollector:
    """Collects events for assertions."""

    def __init__(self):
        self.events: list[dict] = []

    async def collect(self, event):
        self.events.append(event.to_dict())

    @property
    def chunks(self):
        return [e for e in self.events if e["type"] == "stream_chunk"]

    @property
    def content(self):
        return "".join(e.get("content", "") for e in self.chunks)

    @property
    def thinking(self):
        return "".join(e.get("thinking", "") or "" for e in self.chunks)


def stream(provider, prompt, model=DEFAULT_MODEL, **kwargs):
    """Stream chat, yielding (content, thinking) tuples the way the agent reads them."""
    for chunk in provider.chat(model=model, messages=[{"role": "user", "content": prompt}], stream=True, **kwargs):
        msg = chunk.message
        yield msg.content or "", getattr(msg, "thinking", None) or ""


async def relay(provider, prompt, collector, **event_fields):
    """Forward every chunk through a handler's send_event, as the agent loop does."""
    handler = ChatSessionHandler(make_mock_ws(), user_id=1)
    handler.send_event = collector.collect
    for content, thinking in stream(provider, prompt):
        if content or thinking:
            await handler.send_event(StreamChunkEvent(content=content, thinking=thinking, role="assistant", **event_fields))
    return handler


class TestE2EStreaming:

    async def test_stream_chunks_have_content(self, mock_ollama):
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "Say hello in 10 words.", collector,
                    conversation_id=1, model_name=DEFAULT_MODEL, provider_type="ollama")
        assert len(collector.chunks) > 0
        assert collector.content == "You said: Say hello in 10 words."

    async def test_all_chunks_carry_metadata(self, mock_ollama):
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "Count to 3.", collector,
                    conversation_id=42, model_name=DEFAULT_MODEL, provider_type="ollama")
        for e in collector.chunks:
            assert e["conversation_id"] == 42
            assert e["model_name"] == DEFAULT_MODEL
            assert e["provider_type"] == "ollama"

    async def test_voice_reference_propagated(self, mock_ollama):
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "Say yes.", collector,
                    conversation_id=1, voice_reference="voice-uuid-123", persona_name="Nova")
        for e in collector.chunks:
            assert e["voice_reference"] == "voice-uuid-123"
            assert e["persona_name"] == "Nova"

    async def test_done_event_is_last(self, mock_ollama):
        collector = EventCollector()
        handler = await relay(OllamaProvider(api_url=mock_ollama.url), "Say OK.", collector, conversation_id=99)
        await handler.send_event(DoneEvent(conversation_id=99))
        assert collector.events[-1]["type"] == "done"
        assert collector.events[-1]["conversation_id"] == 99

    async def test_long_response_many_chunks(self, mock_ollama):
        mock_ollama.state.script(Reply(content=" ".join(["wave"] * 40) + "."))
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "Write a paragraph about the ocean.", collector, conversation_id=1)
        assert len(collector.chunks) > 10, f"Expected many chunks for streaming, got {len(collector.chunks)}"

    async def test_thinking_separated_from_content(self, mock_ollama):
        mock_ollama.state.script(Reply(thinking="2 plus 2 is 4.", content="4."))
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "What is 2+2? Think step by step.", collector, conversation_id=1)
        assert collector.content == "4."
        assert collector.thinking == "2 plus 2 is 4."
        assert collector.thinking not in collector.content

    async def test_mid_stream_disconnect_drops_silently(self, mock_ollama):
        mock_ollama.state.script(Reply(content=" ".join(["word"] * 12)))
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        total = 0
        for content, thinking in stream(OllamaProvider(api_url=mock_ollama.url), "Tell me a long story."):
            if content or thinking:
                total += 1
                if total == 5:
                    ws.client_state.name = "DISCONNECTED"
                await handler.send_event(StreamChunkEvent(content=content, thinking=thinking, role="assistant", conversation_id=1))

        sent = ws.send_json.call_count
        assert sent >= 1  # Some were sent before disconnect
        assert sent < total  # Rest were silently dropped

    async def test_response_contains_sentences(self, mock_ollama):
        mock_ollama.state.script(Reply(content="Cats nap in the sun. Cats purr when content."))
        collector = EventCollector()
        await relay(OllamaProvider(api_url=mock_ollama.url), "Write two sentences about cats.", collector, conversation_id=1)
        full = collector.content
        assert any(p in full for p in ".!?"), f"Expected sentences but got: {full[:200]}"
        assert full.count(".") == 2
