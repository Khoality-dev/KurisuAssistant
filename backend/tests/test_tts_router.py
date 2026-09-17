"""Tests for the TTS routes (kurisuassistant/routers/tts.py over kurisuassistant/speech).

These pin the API's side of the wire contract with universal-voice; the other
end is voice/tests/test_routers.py. Change both in the same PR.
"""

from unittest.mock import patch

import httpx
import pytest

from tests.speech_fakes import ENGINE, SEAM, calls, client_answering, frames_in, response, wav


@pytest.fixture(autouse=True)
def engine_at_the_default_address(monkeypatch):
    """The address is read from the environment per call; a developer's env file
    (loaded by main.py when the system tests import the app) must not leak in."""
    monkeypatch.setenv("UVOICE_URL", ENGINE)
    monkeypatch.setenv("ASR_API_URL", ENGINE)


# ---------------------------------------------------------------------------
# _find_voice_file
# ---------------------------------------------------------------------------

class TestFindVoiceFile:
    def test_returns_path_when_wav_exists(self, tmp_path):
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        wav_file = voice_dir / "abc123.wav"
        wav_file.write_bytes(b"RIFF")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            assert _find_voice_file("abc123") == wav_file

    def test_returns_path_for_mp3(self, tmp_path):
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        mp3 = voice_dir / "abc123.mp3"
        mp3.write_bytes(b"\xff\xfb")

        with patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            from kurisuassistant.routers.tts import _find_voice_file
            assert _find_voice_file("abc123") == mp3

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
    def test_synthesize_with_preset_voice(self, client):
        """When voice has no local file, it's sent as voice_id."""
        engine = client_answering(response(content=b"fake-wav-data"))

        with patch(SEAM, return_value=engine), \
             patch("kurisuassistant.routers.tts._find_voice_file", return_value=None):
            resp = client.post("/tts", json={
                "text": "hello",
                "voice": "Binh",
                "provider": "vieneu:turbo",
            })

        assert resp.status_code == 200
        assert resp.content == b"fake-wav-data"
        assert resp.headers["content-type"] == "audio/wav"

        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{ENGINE}/tts/synthesize")
        assert kwargs["data"]["text"] == "hello"
        assert kwargs["data"]["voice_id"] == "Binh"
        assert kwargs["data"]["model"] == "vieneu:turbo"

    def test_synthesize_with_ref_audio(self, client, tmp_path):
        """When voice matches a local file, it's uploaded as ref_audio."""
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        (voice_dir / "uuid123.wav").write_bytes(b"RIFF-fake-wav")
        engine = client_answering(response(content=b"synthesized-audio"))

        with patch(SEAM, return_value=engine), \
             patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            resp = client.post("/tts", json={"text": "hello", "voice": "uuid123"})

        assert resp.status_code == 200
        assert resp.content == b"synthesized-audio"

        # ref_audio goes as a file, and the name is not also sent as a voice_id
        [(_, _, kwargs)] = calls(engine)
        assert kwargs["files"]["ref_audio"] == ("uuid123.wav", b"RIFF-fake-wav")
        assert "voice_id" not in kwargs["data"]

    def test_synthesize_text_only(self, client):
        """Minimal request with just text."""
        engine = client_answering(response(content=b"audio"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "test"})

        assert resp.status_code == 200
        [(_, _, kwargs)] = calls(engine)
        assert kwargs["data"] == {"text": "test"}
        assert kwargs["files"] is None

    def test_synthesize_upstream_error_returns_502(self, client):
        """Connection error to the engine returns 502."""
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hello"})

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert "speech service is unavailable" in detail.lower()
        # The upstream URL and the exception text stay in the log, not the response.
        assert "refused" not in detail
        assert "reference:" in detail

    def test_long_text_goes_over_in_chunks_and_comes_back_as_one_wav(self, client, tmp_path):
        """The API cuts the text and joins the audio; the engine sees one chunk at
        a time, with the reference clip every time — it keeps nothing between
        requests (#215)."""
        voice_dir = tmp_path / "voice_storage"
        voice_dir.mkdir()
        (voice_dir / "clip.wav").write_bytes(b"RIFF-clip")
        paragraphs = ["First paragraph.", "Second paragraph.", "Third paragraph."]
        engine = client_answering(
            response(content=wav(100)), response(content=wav(50)), response(content=wav(25)),
        )

        with patch(SEAM, return_value=engine), \
             patch("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", voice_dir):
            resp = client.post("/tts", json={"text": "\n\n".join(paragraphs), "voice": "clip"})

        assert resp.status_code == 200
        assert frames_in(resp.content) == 175
        sent = calls(engine)
        assert [kwargs["data"]["text"] for _, _, kwargs in sent] == paragraphs
        assert all(kwargs["files"]["ref_audio"] == ("clip.wav", b"RIFF-clip") for _, _, kwargs in sent)

    def test_a_refusal_keeps_the_engines_status_and_reason(self, client):
        """An unknown model is the request's fault — universal-voice's registry
        answers 400 — so the client gets the engine's reason to show, not an
        outage (#215)."""
        reason = "Unknown TTS model: nope. Available: ['vixtts', 'gpt-sovits', 'vieneu:turbo']"
        engine = client_answering(response(400, json={"detail": reason}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hello", "provider": "nope"})

        assert resp.status_code == 400
        assert resp.json()["detail"] == reason

    def test_any_other_status_is_the_outage(self, client):
        """A 404 is as likely a mis-pointed URL as a missing model, so it is not
        the client's to act on: logged with a reference, reported as the outage."""
        engine = client_answering(response(404, json={"detail": "Not Found"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hello"})

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")
        assert "reference:" in resp.json()["detail"]

    def test_a_chunk_the_engine_refuses_is_skipped_when_there_are_others(self, client):
        """Inside the engine a chunk that normalises to nothing was skipped; a
        chunk sent alone comes back as a 400 instead, so the API skips it the
        same way and answers with the rest."""
        engine = client_answering(
            response(content=wav(100)),
            response(400, json={"detail": "Text is empty after normalisation"}),
            response(content=wav(50)),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "First.\n\n...\n\nThird."})

        assert resp.status_code == 200
        assert frames_in(resp.content) == 150
        assert len(calls(engine)) == 3

    def test_the_refusal_is_the_answer_when_nothing_could_be_said(self, client):
        engine = client_answering(
            response(400, json={"detail": "Text is empty after normalisation"}),
            response(400, json={"detail": "Text is empty after normalisation"}),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "...\n\n???"})

        assert resp.status_code == 400
        assert resp.json()["detail"] == "Text is empty after normalisation"

    def test_a_failure_inside_the_engine_is_still_the_outage(self, client):
        """A 500 from the engine is not the request's fault; its text stays in the log."""
        engine = client_answering(response(500, json={"detail": "CUDA out of memory"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hello"})

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail.startswith("The speech service is unavailable.")
        assert "CUDA" not in detail

    def test_chunks_that_cannot_be_joined_are_the_outage(self, client):
        """Two chunks the engine did not answer with WAV. (A single chunk is
        passed through untouched, as the proxy did.)"""
        engine = client_answering(response(content=b"not wav"), response(content=b"still not"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "One.\n\nTwo."})

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")


# ---------------------------------------------------------------------------
# GET /tts/voices
# ---------------------------------------------------------------------------

class TestListVoices:
    def test_list_voices(self, client):
        engine = client_answering(response(json=[
            {"id": "Binh", "name": "Binh (nam)", "model": "vieneu:turbo"},
        ]))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/voices")

        assert resp.status_code == 200
        body = resp.json()
        assert "voices" in body
        assert body["voices"][0]["id"] == "Binh"

    def test_list_voices_with_model_filter(self, client):
        engine = client_answering(response(json=[]))

        with patch(SEAM, return_value=engine):
            client.get("/tts/voices", params={"provider": "vieneu:turbo"})

        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("GET", f"{ENGINE}/tts/voices")
        assert kwargs["params"]["model"] == "vieneu:turbo"

    def test_list_voices_upstream_error(self, client):
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/voices")
        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# GET /tts/models
# ---------------------------------------------------------------------------

class TestListModels:
    def test_list_backends_filters_tts(self, client):
        engine = client_answering(response(json={
            "object": "list",
            "data": [
                {"id": "whisper:base", "type": "asr", "loaded": True},
                {"id": "vieneu:turbo", "type": "tts", "loaded": True},
                {"id": "gpt-sovits", "type": "tts", "loaded": None},
                {"id": "vixtts", "type": "tts", "loaded": None},
            ],
        }))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/models")

        assert resp.status_code == 200
        backends = resp.json()["models"]
        assert len(backends) == 3
        assert all(b["type"] == "tts" for b in backends)
        # ASR model should be filtered out
        assert not any(b["id"] == "whisper:base" for b in backends)

    def test_an_unreachable_service_is_a_502_like_voices(self, client):
        """No fabricated list: three hard-coded ids used to come back as a 200 (#151)."""
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/models")
        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")

    def test_a_reachable_service_with_no_tts_models_lists_none(self, client):
        engine = client_answering(response(json={"object": "list", "data": [
            {"id": "whisper:base", "type": "asr", "loaded": True},
        ]}))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/models")
        assert resp.status_code == 200
        assert resp.json() == {"models": []}


# ---------------------------------------------------------------------------
# POST /tts/check
# ---------------------------------------------------------------------------

class TestHealthCheck:
    def test_health_ok(self, client):
        engine = client_answering(response(json={"status": "ok"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={})
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_health_error_returns_ok_false(self, client):
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        assert "refused" in body["message"]
