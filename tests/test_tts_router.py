"""Tests for TTS proxy router (kurisuassistant/routers/tts.py)."""

import io
from pathlib import Path
from unittest.mock import MagicMock, patch, mock_open

import pytest
import requests


# ---------------------------------------------------------------------------
# _find_voice_file
# ---------------------------------------------------------------------------

class TestFindVoiceFile:
    def test_returns_path_when_wav_exists(self, tmp_path):
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        wav = voice_dir / "abc123.wav"
        wav.write_bytes(b"RIFF")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            result = _find_voice_file("abc123")
            assert result == wav

    def test_returns_path_for_mp3(self, tmp_path):
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        mp3 = voice_dir / "abc123.mp3"
        mp3.write_bytes(b"\xff\xfb")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            result = _find_voice_file("abc123")
            assert result == mp3

    def test_returns_none_when_not_found(self, tmp_path):
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            assert _find_voice_file("nonexistent") is None


# ---------------------------------------------------------------------------
# POST /tts — synthesize
# ---------------------------------------------------------------------------

class TestSynthesize:
    @patch("kurisuassistant.routers.tts.http_requests.post")
    def test_synthesize_with_preset_voice(self, mock_post, client):
        """When voice has no local file, it's sent as voice_id."""
        mock_resp = MagicMock()
        mock_resp.content = b"fake-wav-data"
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        with patch("kurisuassistant.routers.tts._find_voice_file", return_value=None):
            resp = client.post("/tts", json={
                "text": "hello",
                "voice": "Binh",
                "provider": "vieneu:turbo",
            })

        assert resp.status_code == 200
        assert resp.content == b"fake-wav-data"
        assert resp.headers["content-type"] == "audio/wav"

        # Check the upstream call
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["data"]["text"] == "hello"
        assert call_kwargs[1]["data"]["voice_id"] == "Binh"
        assert call_kwargs[1]["data"]["model"] == "vieneu:turbo"

    @patch("kurisuassistant.routers.tts.http_requests.post")
    def test_synthesize_with_ref_audio(self, mock_post, client, tmp_path):
        """When voice matches a local file, it's uploaded as ref_audio."""
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        wav = voice_dir / "uuid123.wav"
        wav.write_bytes(b"RIFF-fake-wav")

        mock_resp = MagicMock()
        mock_resp.content = b"synthesized-audio"
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            resp = client.post("/tts", json={
                "text": "hello",
                "voice": "uuid123",
            })

        assert resp.status_code == 200
        assert resp.content == b"synthesized-audio"

        # ref_audio should be in files, not voice_id in data
        call_kwargs = mock_post.call_args
        assert "ref_audio" in call_kwargs[1]["files"]
        assert "voice_id" not in call_kwargs[1]["data"]

    @patch("kurisuassistant.routers.tts.http_requests.post")
    def test_synthesize_text_only(self, mock_post, client):
        """Minimal request with just text."""
        mock_resp = MagicMock()
        mock_resp.content = b"audio"
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        resp = client.post("/tts", json={"text": "test"})

        assert resp.status_code == 200
        call_kwargs = mock_post.call_args
        assert call_kwargs[1]["data"]["text"] == "test"
        assert "voice_id" not in call_kwargs[1]["data"]
        assert "model" not in call_kwargs[1]["data"]

    @patch("kurisuassistant.routers.tts.http_requests.post")
    def test_synthesize_upstream_error_returns_502(self, mock_post, client):
        """Connection error to universal-voice returns 502."""
        mock_post.side_effect = requests.ConnectionError("refused")

        resp = client.post("/tts", json={"text": "hello"})

        assert resp.status_code == 502
        assert "TTS service error" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# GET /tts/voices
# ---------------------------------------------------------------------------

class TestListVoices:
    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_voices(self, mock_get, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"id": "Binh", "name": "Binh (nam)", "model": "vieneu:turbo"},
        ]
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        resp = client.get("/tts/voices")

        assert resp.status_code == 200
        body = resp.json()
        assert "voices" in body
        assert body["voices"][0]["id"] == "Binh"

    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_voices_with_model_filter(self, mock_get, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        client.get("/tts/voices", params={"provider": "vieneu:turbo"})

        call_kwargs = mock_get.call_args
        assert call_kwargs[1]["params"]["model"] == "vieneu:turbo"

    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_voices_upstream_error(self, mock_get, client):
        mock_get.side_effect = requests.ConnectionError("refused")

        resp = client.get("/tts/voices")
        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# GET /tts/models
# ---------------------------------------------------------------------------

class TestListModels:
    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_backends_filters_tts(self, mock_get, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "object": "list",
            "data": [
                {"id": "whisper:base", "type": "asr", "loaded": True},
                {"id": "vieneu:turbo", "type": "tts", "loaded": True},
                {"id": "gpt-sovits", "type": "tts", "loaded": None},
                {"id": "vixtts", "type": "tts", "loaded": None},
            ],
        }
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        resp = client.get("/tts/models")

        assert resp.status_code == 200
        body = resp.json()
        backends = body["models"]
        assert len(backends) == 3
        assert all(b["type"] == "tts" for b in backends)
        # ASR model should be filtered out
        assert not any(b["id"] == "whisper:base" for b in backends)

    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_backends_returns_fallback_when_service_down(self, mock_get, client):
        """When universal-voice is unreachable, return fallback models instead of 502."""
        mock_get.side_effect = requests.ConnectionError("refused")

        resp = client.get("/tts/models")
        assert resp.status_code == 200
        backends = resp.json()["models"]
        assert len(backends) == 3
        ids = [b["id"] for b in backends]
        assert "vixtts" in ids
        assert "gpt-sovits" in ids
        assert "vieneu:turbo" in ids

    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_list_backends_returns_fallback_when_empty(self, mock_get, client):
        """When universal-voice returns no TTS models, return fallback."""
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"object": "list", "data": [
            {"id": "whisper:base", "type": "asr", "loaded": True},
        ]}
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        resp = client.get("/tts/models")
        assert resp.status_code == 200
        backends = resp.json()["models"]
        assert len(backends) == 3  # fallback models


# ---------------------------------------------------------------------------
# POST /tts/check
# ---------------------------------------------------------------------------

class TestHealthCheck:
    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_health_ok(self, mock_get, client):
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"status": "ok"}
        mock_resp.raise_for_status = MagicMock()
        mock_get.return_value = mock_resp

        resp = client.post("/tts/check", json={})
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    @patch("kurisuassistant.routers.tts.http_requests.get")
    def test_health_error_returns_ok_false(self, mock_get, client):
        mock_get.side_effect = requests.ConnectionError("refused")

        resp = client.post("/tts/check", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        assert "refused" in body["message"]
