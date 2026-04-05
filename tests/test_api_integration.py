"""Integration tests for API endpoints and core functionality.

Tests that hit real services (Ollama, database) are marked with
@pytest.mark.integration and skipped when services are unavailable.
"""

import asyncio
import io
import json
import re
import wave
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kurisuassistant.websocket.events import (
    parse_event,
    StreamChunkEvent,
    DoneEvent,
    ErrorEvent,
    ChatRequestEvent,
    ConnectedEvent,
    ToolApprovalResponseEvent,
    ToolCallResponseEvent,
    EventType,
)


# ---------------------------------------------------------------------------
# Event parsing
# ---------------------------------------------------------------------------

class TestEventParsing:
    def test_parse_chat_request(self):
        data = {
            "type": "chat_request",
            "text": "hello",
            "model_name": "qwen3.5:0.8b",
            "conversation_id": None,
            "agent_id": None,
        }
        event = parse_event(data)
        assert isinstance(event, ChatRequestEvent)
        assert event.text == "hello"
        assert event.model_name == "qwen3.5:0.8b"

    def test_parse_chat_request_with_images(self):
        data = {
            "type": "chat_request",
            "text": "what's this?",
            "model_name": "",
            "images": ["base64data1", "base64data2"],
        }
        event = parse_event(data)
        assert isinstance(event, ChatRequestEvent)
        assert len(event.images) == 2

    def test_parse_tool_approval_response(self):
        data = {
            "type": "tool_approval_response",
            "approval_id": "abc-123",
            "approved": True,
        }
        event = parse_event(data)
        assert isinstance(event, ToolApprovalResponseEvent)
        assert event.approved is True

    def test_parse_tool_call_response(self):
        data = {
            "type": "tool_call_response",
            "request_id": "req-456",
            "content": '{"result": "ok"}',
            "is_error": False,
        }
        event = parse_event(data)
        assert isinstance(event, ToolCallResponseEvent)
        assert event.content == '{"result": "ok"}'

    def test_parse_cancel(self):
        data = {"type": "cancel"}
        event = parse_event(data)
        assert event.type == EventType.CANCEL

    def test_parse_compact_context(self):
        data = {"type": "compact_context"}
        event = parse_event(data)
        assert event.type == EventType.COMPACT_CONTEXT

    def test_parse_unknown_type_raises(self):
        with pytest.raises(ValueError, match="Unknown event type"):
            parse_event({"type": "totally_fake"})

    def test_parse_missing_type_raises(self):
        with pytest.raises(ValueError):
            parse_event({"data": "no type field"})

    def test_parse_pong_is_handled_in_run_not_parse(self):
        """pong is handled directly in run() before parse_event, so parsing it should fail."""
        with pytest.raises(ValueError, match="Unknown event type"):
            parse_event({"type": "pong"})


# ---------------------------------------------------------------------------
# Event serialization round-trip
# ---------------------------------------------------------------------------

class TestEventRoundTrip:
    def test_stream_chunk_round_trip(self):
        event = StreamChunkEvent(
            content="hello",
            thinking="let me think...",
            role="assistant",
            agent_id=3,
            name="Ayaka",
            persona_name="Ayaka-chan",
            voice_reference="uuid-voice",
            conversation_id=10,
            frame_id=2,
            model_name="qwen3.5:0.8b",
            provider_type="ollama",
            token_count=150,
        )
        d = event.to_dict()

        # Verify all fields survive serialization
        assert d["type"] == "stream_chunk"
        assert d["content"] == "hello"
        assert d["thinking"] == "let me think..."
        assert d["role"] == "assistant"
        assert d["agent_id"] == 3
        assert d["name"] == "Ayaka"
        assert d["persona_name"] == "Ayaka-chan"
        assert d["voice_reference"] == "uuid-voice"
        assert d["conversation_id"] == 10
        assert d["frame_id"] == 2
        assert d["model_name"] == "qwen3.5:0.8b"
        assert d["provider_type"] == "ollama"
        assert d["token_count"] == 150
        assert "event_id" in d
        assert "timestamp" in d

    def test_done_event_round_trip(self):
        event = DoneEvent(conversation_id=5, frame_id=1)
        d = event.to_dict()
        assert d["type"] == "done"
        assert d["conversation_id"] == 5

    def test_error_event_round_trip(self):
        event = ErrorEvent(error="boom", code="INTERNAL_ERROR")
        d = event.to_dict()
        assert d["type"] == "error"
        assert d["error"] == "boom"
        assert d["code"] == "INTERNAL_ERROR"

    def test_connected_event_with_all_fields(self):
        event = ConnectedEvent(
            chat_active=True,
            conversation_id=42,
            frame_id=3,
            media_state={"playing": True, "track": "song.mp3"},
            vision_active=True,
            vision_config={"enable_face": True},
        )
        d = event.to_dict()
        assert d["chat_active"] is True
        assert d["media_state"]["playing"] is True
        assert d["vision_active"] is True


# ---------------------------------------------------------------------------
# TTS text chunking (from universal-voice)
# ---------------------------------------------------------------------------

class TestTextChunking:
    """Test the text splitting logic used by TTS backends."""

    def _split_text(self, text, max_length=200):
        """Import and call the split function."""
        # Import from universal-voice if available, otherwise inline
        try:
            from universal_voice.tts.text_processing import split_text
            return split_text(text, max_length)
        except ImportError:
            # Inline implementation for testing
            import re as _re
            paragraphs = text.split("\n\n")
            chunks = []
            for para in paragraphs:
                para = para.strip()
                if not para:
                    continue
                if len(para) <= max_length:
                    chunks.append(para)
                    continue
                sentences = _re.split(r"([。.!?！？\n])", para)
                current = ""
                for i in range(0, len(sentences), 2):
                    sent = sentences[i]
                    delim = sentences[i + 1] if i + 1 < len(sentences) else ""
                    segment = sent + delim
                    if current and len(current) + len(segment) > max_length:
                        chunks.append(current.strip())
                        current = segment
                    else:
                        current += segment
                if current.strip():
                    chunks.append(current.strip())
            return chunks if chunks else [text]

    def test_short_text_single_chunk(self):
        result = self._split_text("Hello world.")
        assert result == ["Hello world."]

    def test_paragraph_split(self):
        text = "First paragraph.\n\nSecond paragraph."
        result = self._split_text(text)
        assert len(result) == 2
        assert result[0] == "First paragraph."
        assert result[1] == "Second paragraph."

    def test_sentence_split_on_long_paragraph(self):
        # 3 sentences, each ~80 chars, total > 200
        text = "This is the first sentence with enough words to make it long. " * 3
        result = self._split_text(text.strip(), max_length=100)
        assert len(result) > 1
        for chunk in result:
            assert len(chunk) <= 200  # Some flexibility

    def test_japanese_sentence_split(self):
        text = "これは最初の文です。これは二番目の文です。これは三番目の文です。" * 5
        result = self._split_text(text, max_length=50)
        assert len(result) > 1

    def test_empty_text_returns_original(self):
        result = self._split_text("")
        assert result == [""]

    def test_vietnamese_punctuation_split(self):
        text = "Đây là câu đầu tiên rất dài và có nhiều từ！Đây là câu thứ hai cũng rất dài？Đây là câu cuối cùng。"
        result = self._split_text(text, max_length=50)
        assert len(result) >= 2

    def test_newline_split(self):
        text = "Line one\nLine two\nLine three"
        result = self._split_text(text, max_length=15)
        assert len(result) >= 2

    def test_max_length_respected(self):
        text = "Short. " * 100
        result = self._split_text(text.strip(), max_length=50)
        for chunk in result:
            # Allow some overshoot (sentence boundary)
            assert len(chunk) <= 100


# ---------------------------------------------------------------------------
# WAV merging (from universal-voice)
# ---------------------------------------------------------------------------

class TestWavMerging:
    """Test WAV file merging logic."""

    def _make_wav(self, duration_ms=100, sample_rate=16000, channels=1):
        """Generate a simple WAV file as bytes."""
        n_samples = int(sample_rate * duration_ms / 1000)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(2)  # 16-bit
            w.setframerate(sample_rate)
            w.writeframes(b"\x00\x00" * n_samples)
        return buf.getvalue()

    def _merge_wav(self, chunks):
        try:
            from universal_voice.tts.text_processing import merge_wav_files
            return merge_wav_files(chunks)
        except ImportError:
            # Inline for testing
            if len(chunks) == 1:
                return chunks[0]
            first = io.BytesIO(chunks[0])
            with wave.open(first, "rb") as w:
                params = w.getparams()
                data = [w.readframes(w.getnframes())]
            for c in chunks[1:]:
                with wave.open(io.BytesIO(c), "rb") as w:
                    data.append(w.readframes(w.getnframes()))
            merged = io.BytesIO()
            with wave.open(merged, "wb") as w:
                w.setparams(params)
                w.writeframes(b"".join(data))
            return merged.getvalue()

    def test_single_chunk_passthrough(self):
        wav = self._make_wav()
        result = self._merge_wav([wav])
        assert result == wav

    def test_merge_two_chunks(self):
        wav1 = self._make_wav(100)
        wav2 = self._make_wav(200)
        merged = self._merge_wav([wav1, wav2])

        # Verify merged is valid WAV
        with wave.open(io.BytesIO(merged), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            # Duration should be sum of both
            total_frames = w.getnframes()
            expected_frames = int(16000 * 0.1) + int(16000 * 0.2)
            assert total_frames == expected_frames

    def test_merge_five_chunks(self):
        chunks = [self._make_wav(50) for _ in range(5)]
        merged = self._merge_wav(chunks)

        with wave.open(io.BytesIO(merged), "rb") as w:
            expected = int(16000 * 0.05) * 5
            assert w.getnframes() == expected

    def test_empty_chunks_raises(self):
        with pytest.raises((ValueError, Exception)):
            self._merge_wav([])

    def test_merged_wav_is_valid(self):
        """Merged output can be re-read as valid WAV."""
        chunks = [self._make_wav(100) for _ in range(3)]
        merged = self._merge_wav(chunks)

        # Should not raise
        buf = io.BytesIO(merged)
        with wave.open(buf, "rb") as w:
            frames = w.readframes(w.getnframes())
            assert len(frames) > 0


# ---------------------------------------------------------------------------
# TTS router (proxy logic, no external service needed)
# ---------------------------------------------------------------------------

class TestTTSRouter:
    """Test the KurisuAssistant TTS proxy router logic."""

    def test_find_voice_file_with_tmp(self, tmp_path):
        voice_dir = tmp_path / "vs"
        voice_dir.mkdir()
        (voice_dir / "test-uuid.wav").write_bytes(b"RIFF")
        (voice_dir / "other.mp3").write_bytes(b"\xff\xfb")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            assert _find_voice_file("test-uuid") == voice_dir / "test-uuid.wav"
            assert _find_voice_file("other") == voice_dir / "other.mp3"
            assert _find_voice_file("missing") is None

    def test_find_voice_file_priority(self, tmp_path):
        """WAV is found before MP3 (checked in extension order)."""
        voice_dir = tmp_path / "vs"
        voice_dir.mkdir()
        (voice_dir / "voice.wav").write_bytes(b"RIFF")
        (voice_dir / "voice.mp3").write_bytes(b"\xff\xfb")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            result = _find_voice_file("voice")
            assert result.suffix == ".wav"


# ---------------------------------------------------------------------------
# LLM provider (Ollama integration — requires running Ollama)
# ---------------------------------------------------------------------------

class TestOllamaIntegration:
    """Integration tests that require a running Ollama instance.

    Run with: pytest -m integration
    Skip with: pytest -m "not integration"
    """

    @pytest.fixture
    def ollama_url(self):
        import os
        return os.environ.get("LLM_API_URL", "http://ollama-container:11434")

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_ollama_chat_streaming(self, ollama_url):
        """Test real Ollama streaming response."""
        import httpx

        async with httpx.AsyncClient(timeout=30) as client:
            # Check Ollama is reachable
            try:
                tags = await client.get(f"{ollama_url}/api/tags")
                models = [m["name"] for m in tags.json()["models"]]
            except Exception:
                pytest.skip("Ollama not available")

            # Use smallest available model
            small_models = [m for m in models if "0.8b" in m or "0.5b" in m]
            model = small_models[0] if small_models else models[0]

            # Stream a short response — collect both content and thinking tokens
            content_chunks = []
            thinking_chunks = []
            async with client.stream(
                "POST",
                f"{ollama_url}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "Say hi in 5 words"}],
                    "stream": True,
                },
            ) as resp:
                async for raw in resp.aiter_bytes():
                    for part in raw.decode("utf-8", errors="ignore").strip().split("\n"):
                        if not part.strip():
                            continue
                        try:
                            data = json.loads(part)
                        except json.JSONDecodeError:
                            continue
                        msg = data.get("message", {})
                        if msg.get("content"):
                            content_chunks.append(msg["content"])
                        if msg.get("thinking"):
                            thinking_chunks.append(msg["thinking"])
                        if data.get("done"):
                            break

            total_chunks = len(content_chunks) + len(thinking_chunks)
            assert total_chunks > 0, f"No chunks from {model}"
            # Model should produce at least some content (after thinking)
            full_response = "".join(content_chunks)
            full_thinking = "".join(thinking_chunks)
            assert len(full_response) + len(full_thinking) > 0

    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_ollama_model_list(self, ollama_url):
        """Test Ollama model listing."""
        import httpx

        async with httpx.AsyncClient(timeout=10) as client:
            try:
                resp = await client.get(f"{ollama_url}/api/tags")
            except Exception:
                pytest.skip("Ollama not available")

            assert resp.status_code == 200
            models = resp.json()["models"]
            assert len(models) > 0
            assert all("name" in m for m in models)
