"""End-to-end streaming tests through the backend pipeline.

Tests the full flow: OllamaProvider.chat() → stream chunks → send_event,
verifying chunking, event ordering, and metadata propagation.

Requires Ollama running. Mark: @pytest.mark.integration
"""

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.websocket.events import StreamChunkEvent, DoneEvent


OLLAMA_URL = os.environ.get("LLM_API_URL", "http://ollama-container:11434")
TEST_MODEL = os.environ.get("TEST_MODEL", "qwen3.5:0.8b")


def make_mock_ws():
    ws = AsyncMock()
    ws.client_state = MagicMock()
    ws.client_state.name = "CONNECTED"
    ws.send_json = AsyncMock()
    ws.receive_json = AsyncMock()
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


def _get_provider():
    """Create OllamaProvider, skip if unreachable."""
    from kurisuassistant.models.llm.ollama_provider import OllamaProvider
    provider = OllamaProvider(api_url=OLLAMA_URL)
    try:
        models = provider.list_models()
        if TEST_MODEL not in models:
            pytest.skip(f"{TEST_MODEL} not available (have: {models[:5]})")
    except Exception:
        pytest.skip("Ollama not available")
    return provider


def _stream_ollama(provider, prompt, model=TEST_MODEL):
    """Stream chat from Ollama, yield (content, thinking) tuples."""
    response = provider.chat(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        stream=True,
    )
    for chunk in response:
        msg = chunk.get("message", {})
        content = msg.get("content", "")
        thinking = msg.get("thinking", "")
        yield content, thinking


# ---------------------------------------------------------------------------
# E2E: Ollama → handler.send_event → verify events
# ---------------------------------------------------------------------------

@pytest.mark.integration
class TestE2EStreaming:

    def test_stream_chunks_have_content(self):
        """Real Ollama produces stream_chunk events with content."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(provider, "Say hello in 10 words."):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=1, frame_id=1,
                        model_name=TEST_MODEL, provider_type="ollama",
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        assert len(collector.chunks) > 0
        assert len(collector.content) + len(collector.thinking) > 0

    def test_all_chunks_carry_metadata(self):
        """Every chunk has conversation_id, frame_id, model_name."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(provider, "Count to 3."):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=42, frame_id=7,
                        model_name=TEST_MODEL, provider_type="ollama",
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        for e in collector.chunks:
            assert e["conversation_id"] == 42
            assert e["frame_id"] == 7
            assert e["model_name"] == TEST_MODEL

    def test_voice_reference_propagated(self):
        """voice_reference survives through stream chunks."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(provider, "Say yes."):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=1, frame_id=1,
                        voice_reference="voice-uuid-123",
                        persona_name="Ayaka",
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        for e in collector.chunks:
            assert e["voice_reference"] == "voice-uuid-123"
            assert e["persona_name"] == "Ayaka"

    def test_done_event_is_last(self):
        """DoneEvent follows all stream chunks."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(provider, "Say OK."):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=99, frame_id=1,
                    ))
            await handler.send_event(DoneEvent(conversation_id=99, frame_id=1))

        asyncio.get_event_loop().run_until_complete(run())

        assert collector.events[-1]["type"] == "done"
        assert collector.events[-1]["conversation_id"] == 99

    def test_long_response_many_chunks(self):
        """Longer prompts produce many stream chunks (proper streaming)."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(
                provider, "Write a 100-word paragraph about the ocean."
            ):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=1, frame_id=1,
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        assert len(collector.chunks) > 10, \
            f"Expected many chunks for streaming, got {len(collector.chunks)}"

    def test_thinking_separated_from_content(self):
        """Thinking tokens in thinking field, content in content field."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(
                provider, "What is 2+2? Think step by step."
            ):
                if content or thinking:
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=1, frame_id=1,
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        # Should have content at minimum
        assert len(collector.content) > 0
        # If model supports thinking, verify it's separated
        if collector.thinking:
            # Thinking should not appear in content
            assert collector.thinking not in collector.content

    def test_mid_stream_disconnect_drops_silently(self):
        """Disconnect mid-stream drops remaining chunks without crash."""
        provider = _get_provider()
        ws = make_mock_ws()
        handler = ChatSessionHandler(ws, user_id=1)

        import asyncio
        async def run():
            chunk_count = 0
            for content, thinking in _stream_ollama(provider, "Tell me a long story."):
                if content or thinking:
                    chunk_count += 1
                    if chunk_count == 5:
                        ws.client_state.name = "DISCONNECTED"
                    await handler.send_event(StreamChunkEvent(
                        content=content, thinking=thinking,
                        role="assistant", conversation_id=1, frame_id=1,
                    ))
            return chunk_count

        total = asyncio.get_event_loop().run_until_complete(run())

        sent = ws.send_json.call_count
        assert sent >= 1  # Some were sent before disconnect
        assert sent < total  # Rest were silently dropped

    def test_response_contains_sentences(self):
        """Real Ollama response forms complete sentences."""
        provider = _get_provider()
        collector = EventCollector()
        handler = ChatSessionHandler(make_mock_ws(), user_id=1)
        handler.send_event = collector.collect

        import asyncio
        async def run():
            for content, thinking in _stream_ollama(
                provider, "Write two sentences about cats."
            ):
                if content:
                    await handler.send_event(StreamChunkEvent(
                        content=content, role="assistant",
                        conversation_id=1, frame_id=1,
                    ))

        asyncio.get_event_loop().run_until_complete(run())

        full = collector.content
        # Should contain at least one sentence-ending punctuation
        assert any(p in full for p in ".!?"), \
            f"Expected sentences but got: {full[:200]}"
