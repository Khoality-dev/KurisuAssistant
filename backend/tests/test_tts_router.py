"""The synthesis routes over kurisuassistant/speech (#212).

Two engines, two dialects: GPT-SoVITS takes its parameters in a query and opens
the reference clip by a path it can see itself; viXTTS takes a multipart form
with the clip uploaded. These pin both, and what the clients get back.
"""

from unittest.mock import patch

import httpx
import pytest

from tests.speech_fakes import (
    GPTSOVITS, SEAM, VIXTTS, calls, client_answering, frames_in, response, wav,
)


@pytest.fixture(autouse=True)
def engines_configured(monkeypatch):
    """Addresses are read per call, so a developer's environment file — loaded
    by main.py when the system tests import the app — must not leak in."""
    monkeypatch.setenv("GPTSOVITS_URL", GPTSOVITS)
    monkeypatch.setenv("VIXTTS_URL", VIXTTS)
    monkeypatch.setenv("GPTSOVITS_VOICE_DIR", "/voice_storage")
    monkeypatch.delenv("TTS_DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("GPTSOVITS_DEFAULT_LANGUAGE", raising=False)


@pytest.fixture
def voice(tmp_path, monkeypatch):
    """A reference clip in data/voice_storage/, as a persona's voice is."""
    storage = tmp_path / "voice_storage"
    storage.mkdir()
    clip = storage / "kurisu.wav"
    clip.write_bytes(wav(400))
    monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
    return clip


# ---------------------------------------------------------------------------
# _find_voice_file
# ---------------------------------------------------------------------------

class TestFindVoiceFile:
    @pytest.mark.parametrize("extension", [".wav", ".mp3", ".flac", ".ogg"])
    def test_finds_a_clip_by_stem(self, tmp_path, monkeypatch, extension):
        storage = tmp_path / "voice_storage"
        storage.mkdir()
        (storage / f"abc123{extension}").write_bytes(b"RIFF")
        monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
        from kurisuassistant.routers.tts import _find_voice_file

        assert _find_voice_file("abc123") == storage / f"abc123{extension}"

    def test_returns_none_when_absent(self, tmp_path, monkeypatch):
        storage = tmp_path / "voice_storage"
        storage.mkdir()
        monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
        from kurisuassistant.routers.tts import _find_voice_file

        assert _find_voice_file("nothing") is None


# ---------------------------------------------------------------------------
# GPT-SoVITS
# ---------------------------------------------------------------------------

class TestGPTSoVITS:
    def test_the_clip_goes_over_as_a_path_the_engine_can_open(self, client, voice):
        """This engine opens the file itself, so the stack mounts
        data/voice_storage into it read-only and the path is where it sees it —
        no scratch volume shared between engines."""
        engine = client_answering(response(content=wav(100)))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "こんにちは", "voice": "kurisu", "provider": "gpt-sovits"})

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("GET", f"{GPTSOVITS}/tts")
        assert kwargs["params"]["ref_audio_path"] == "/voice_storage/kurisu.wav"
        assert kwargs["params"]["text"] == "こんにちは"
        assert kwargs["params"]["media_type"] == "wav"
        assert kwargs["params"]["streaming_mode"] == "false"
        assert "files" not in kwargs, "the clip is a path for this engine, never an upload"

    def test_language_defaults_and_aliases(self, client, voice):
        engine = client_answering(response(content=wav(10)))

        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits", "language": "JP"})

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["params"]["text_lang"] == "ja"
        assert kwargs["params"]["prompt_lang"] == "ja"

    def test_without_a_clip_it_says_so_rather_than_failing_as_an_outage(self, client):
        """It clones and has no presets, so a request with no reference is the
        user's to fix and reads as itself, not as "the service is unavailable"."""
        engine = client_answering(httpx.ConnectError("never called"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "provider": "gpt-sovits"})

        assert resp.status_code == 400
        assert "needs a voice reference" in resp.json()["detail"]
        assert calls(engine) == []


# ---------------------------------------------------------------------------
# viXTTS
# ---------------------------------------------------------------------------

class TestViXTTS:
    def test_the_clip_is_uploaded_with_the_form(self, client, voice):
        engine = client_answering(response(content=wav(100)))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={
                "text": "Xin chào", "voice": "kurisu", "provider": "vixtts", "language": "vi",
            })

        assert resp.status_code == 200
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{VIXTTS}/tts/file")
        assert kwargs["data"] == {"text": "Xin chào", "language": "vi"}
        assert kwargs["files"]["spk_audio"][0] == "kurisu.wav"
        assert kwargs["files"]["spk_audio"][1] == voice.read_bytes()

    def test_a_name_with_no_file_is_a_preset_speaker(self, client, tmp_path, monkeypatch):
        storage = tmp_path / "voice_storage"
        storage.mkdir()
        monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
        engine = client_answering(response(content=wav(10)))

        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "Ana Florence", "provider": "vixtts"})

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["data"]["speaker_id"] == "Ana Florence"
        assert kwargs["files"] is None


# ---------------------------------------------------------------------------
# Choosing the engine
# ---------------------------------------------------------------------------

class TestEngineChoice:
    def test_no_model_uses_the_configured_default(self, client, voice, monkeypatch):
        monkeypatch.setenv("TTS_DEFAULT_MODEL", "vixtts")
        engine = client_answering(response(content=wav(10)))

        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        [(_, url, _)] = calls(engine)
        assert url.startswith(VIXTTS)

    def test_no_default_uses_the_first_configured(self, client, voice):
        engine = client_answering(response(content=wav(10)))

        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        [(_, url, _)] = calls(engine)
        assert url.startswith(GPTSOVITS)

    def test_a_model_this_server_does_not_run_names_the_ones_it_does(self, client, voice):
        """A client that still has vieneu:turbo stored gets a sentence it can
        show, not an outage and not silence."""
        resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "vieneu:turbo"})

        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "vieneu:turbo" in detail and "gpt-sovits" in detail and "vixtts" in detail

    def test_no_engine_configured_says_what_to_start(self, client, voice, monkeypatch):
        monkeypatch.delenv("GPTSOVITS_URL", raising=False)
        monkeypatch.delenv("VIXTTS_URL", raising=False)

        resp = client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        assert resp.status_code == 502
        assert "synthesis engine is configured" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Chunking, and what a failure becomes
# ---------------------------------------------------------------------------

class TestChunkingAndFailures:
    def test_long_text_is_several_calls_joined_into_one_wav(self, client, voice):
        text = "\n\n".join(f"Paragraph number {i}." for i in range(3))
        engine = client_answering(response(content=wav(100)), response(content=wav(50)), response(content=wav(25)))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": text, "voice": "kurisu", "provider": "vixtts"})

        assert resp.status_code == 200
        assert len(calls(engine)) == 3
        assert frames_in(resp.content) == 175

    def test_a_refused_chunk_is_skipped_when_others_speak(self, client, voice):
        text = "First paragraph.\n\nSecond paragraph."
        engine = client_answering(
            response(400, json={"detail": "Text is empty after normalisation"}, url=VIXTTS),
            response(content=wav(60)),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": text, "voice": "kurisu", "provider": "vixtts"})

        assert resp.status_code == 200
        assert frames_in(resp.content) == 60

    def test_a_refusal_keeps_its_status_and_reason(self, client, voice):
        engine = client_answering(response(400, json={"detail": "Unsupported language 'xx'"}, url=VIXTTS))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={
                "text": "hi", "voice": "kurisu", "provider": "vixtts", "language": "xx",
            })

        assert resp.status_code == 400
        assert resp.json()["detail"] == "Unsupported language 'xx'"

    def test_an_engines_reason_reaches_the_user_as_a_sentence(self, client, voice):
        """GPT-SoVITS's api_v2 puts its explanation in `message` and the part
        that identifies the problem in `Exception`; both are read, because the
        clients render this as one line and "tts failed" alone says nothing."""
        engine = client_answering(response(
            400, json={"message": "tts failed", "Exception": "/voice_storage/missing.wav not exists"},
            url=GPTSOVITS,
        ))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={
                "text": "hi", "voice": "kurisu", "provider": "gpt-sovits", "language": "ja",
            })

        assert resp.status_code == 400
        assert resp.json()["detail"] == "tts failed: /voice_storage/missing.wav not exists"

    def test_a_body_that_is_not_json_still_becomes_one_line(self, client, voice):
        engine = client_answering(response(400, content=b"  plain\n  text  ", url=VIXTTS))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "vixtts"})

        assert resp.json()["detail"] == "plain text"

    def test_anything_else_is_the_outage_sentence(self, client, voice):
        engine = client_answering(response(500, json={"detail": "CUDA out of memory"}, url=VIXTTS))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "vixtts"})

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")
        assert "CUDA" not in resp.json()["detail"], "an engine's internals are not the user's business"

    def test_an_answer_that_is_not_audio_is_an_outage(self, client, voice):
        engine = client_answering(response(content=b"<html>proxy error</html>", url=VIXTTS))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "vixtts"})

        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# Listings
# ---------------------------------------------------------------------------

class TestListings:
    def test_models_are_what_this_server_configured(self, client):
        resp = client.get("/tts/models")

        assert resp.status_code == 200
        assert [m["id"] for m in resp.json()["models"]] == ["gpt-sovits", "vixtts"]
        assert {m["type"] for m in resp.json()["models"]} == {"tts"}

    def test_models_is_an_error_not_an_empty_list_when_none_is_configured(self, client, monkeypatch):
        """An empty picker reads as "nothing installed" and was the only symptom
        of a wrong address (#151)."""
        monkeypatch.delenv("GPTSOVITS_URL", raising=False)
        monkeypatch.delenv("VIXTTS_URL", raising=False)

        resp = client.get("/tts/models")

        assert resp.status_code == 502

    def test_voices_are_empty_because_both_engines_clone(self, client):
        resp = client.get("/tts/voices")

        assert resp.status_code == 200
        assert resp.json() == {"voices": []}

    def test_check_reports_whether_the_engine_answers(self, client):
        engine = client_answering(response(json={"status": "ok"}, url=VIXTTS))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={"provider": "vixtts"})

        assert resp.json()["ok"] is True

    def test_check_does_not_raise_when_the_engine_is_down(self, client):
        engine = client_answering(httpx.ConnectError("no route"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={"provider": "vixtts"})

        assert resp.status_code == 200
        assert resp.json()["ok"] is False
