"""The synthesis routes over kurisuassistant/speech (#227).

Every synthesis engine speaks the one contract, so these pin that dialect once
— a multipart form with the clip uploaded — and what the clients get back,
including the residency the contract carries: an engine's 503 makes the API
release another engine and try once more.
"""

from unittest.mock import patch

import httpx
import pytest

from tests.speech_fakes import SEAM, calls, client_answering, frames_in, response, wav

GPTSOVITS = "http://gpt-sovits:9880"
VIXTTS = "http://vixtts:19770"


@pytest.fixture(autouse=True)
def engines_configured(monkeypatch):
    """Read per call, so a developer's environment file — loaded by main.py
    when the system tests import the app — must not leak in."""
    monkeypatch.setenv("TTS_ENGINES", f"gpt-sovits={GPTSOVITS},vixtts={VIXTTS}")
    monkeypatch.delenv("TTS_DEFAULT_MODEL", raising=False)
    from kurisuassistant.speech import synthesis

    synthesis._last_used.clear()


@pytest.fixture
def voice(tmp_path, monkeypatch):
    """A reference clip in data/voice_storage/, as a persona's voice is."""
    storage = tmp_path / "voice_storage"
    storage.mkdir()
    clip = storage / "kurisu.wav"
    clip.write_bytes(wav(400))
    monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
    return clip


def urls(engine):
    return [url for _, url, _ in calls(engine)]


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
# The contract's synthesis call
# ---------------------------------------------------------------------------

class TestSynthesize:
    def test_the_clip_is_uploaded_with_the_form_whichever_engine(self, client, voice):
        """One dialect for every engine: the clip goes over as a file, never as
        a path — no engine opens the API's filesystem."""
        engine = client_answering(response(content=wav(100)))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={
                "text": "こんにちは", "voice": "kurisu", "provider": "gpt-sovits", "language": "ja",
            })

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{GPTSOVITS}/synthesize")
        assert kwargs["data"] == {"text": "こんにちは", "language": "ja"}
        assert kwargs["files"]["ref_audio"] == ("kurisu.wav", voice.read_bytes())

    def test_a_name_with_no_file_is_a_preset_voice(self, client, tmp_path, monkeypatch):
        storage = tmp_path / "voice_storage"
        storage.mkdir()
        monkeypatch.setattr("kurisuassistant.routers.tts.VOICE_STORAGE_DIR", storage)
        engine = client_answering(response(content=wav(10)))

        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "Ana Florence", "provider": "vixtts"})

        [(_, url, kwargs)] = calls(engine)
        assert url == f"{VIXTTS}/synthesize"
        assert kwargs["data"]["voice_id"] == "Ana Florence"
        assert kwargs["files"] is None

    def test_no_model_uses_the_default_then_the_first_configured(self, client, voice, monkeypatch):
        engine = client_answering(response(content=wav(10)))
        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "kurisu"})
        assert urls(engine) == [f"{GPTSOVITS}/synthesize"]

        monkeypatch.setenv("TTS_DEFAULT_MODEL", "vixtts")
        engine = client_answering(response(content=wav(10)))
        with patch(SEAM, return_value=engine):
            client.post("/tts", json={"text": "hi", "voice": "kurisu"})
        assert urls(engine) == [f"{VIXTTS}/synthesize"]

    def test_a_model_this_server_does_not_run_names_the_ones_it_does(self, client, voice):
        resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "vieneu:turbo"})

        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "vieneu:turbo" in detail and "gpt-sovits" in detail and "vixtts" in detail

    def test_no_engine_configured_says_what_to_start(self, client, voice, monkeypatch):
        monkeypatch.setenv("TTS_ENGINES", "")

        resp = client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        assert resp.status_code == 502
        assert "TTS_ENGINES" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Chunking, and what a failure becomes
# ---------------------------------------------------------------------------

class TestChunkingAndFailures:
    def test_long_text_is_several_calls_joined_into_one_wav(self, client, voice):
        text = "\n\n".join(f"Paragraph number {i}." for i in range(3))
        engine = client_answering(response(content=wav(100)), response(content=wav(50)), response(content=wav(25)))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": text, "voice": "kurisu"})

        assert resp.status_code == 200
        assert len(calls(engine)) == 3
        assert frames_in(resp.content) == 175

    def test_a_refused_chunk_is_skipped_when_others_speak(self, client, voice):
        engine = client_answering(
            response(400, json={"detail": "Text is empty after normalisation"}),
            response(content=wav(60)),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "First.\n\nSecond.", "voice": "kurisu"})

        assert resp.status_code == 200
        assert frames_in(resp.content) == 60

    def test_a_refusal_keeps_its_status_and_reason(self, client, voice):
        engine = client_answering(response(400, json={"detail": "GPT-SoVITS does not speak 'xx'."}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "language": "xx"})

        assert resp.status_code == 400
        assert resp.json()["detail"] == "GPT-SoVITS does not speak 'xx'."

    def test_anything_else_is_the_outage_sentence(self, client, voice):
        engine = client_answering(response(500, json={"detail": "CUDA error: device-side assert"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")
        assert "CUDA" not in resp.json()["detail"], "an engine's internals are not the user's business"

    def test_an_answer_that_is_not_audio_is_an_outage(self, client, voice):
        engine = client_answering(response(content=b"<html>proxy error</html>"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# Residency, as the contract carries it (#227)
# ---------------------------------------------------------------------------

class TestResidency:
    def test_a_503_releases_the_other_engine_and_tries_once_more(self, client, voice):
        """The engine that cannot load is the memory-pressure signal; the API
        answers by asking the other engine to drop its weights, then retries."""
        engine = client_answering(
            response(503, json={"detail": "GPT-SoVITS could not load its model: CUDA out of memory"}),
            response(json={"ok": True, "loaded": False}, url=VIXTTS),   # vixtts /release
            response(content=wav(80)),                                    # the retry
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits"})

        assert resp.status_code == 200
        assert frames_in(resp.content) == 80
        assert urls(engine) == [f"{GPTSOVITS}/synthesize", f"{VIXTTS}/release", f"{GPTSOVITS}/synthesize"]

    def test_the_least_recently_used_engine_is_released_first(self, client, voice, monkeypatch):
        monkeypatch.setenv("TTS_ENGINES", f"gpt-sovits={GPTSOVITS},vixtts={VIXTTS},third=http://third:1")
        from kurisuassistant.speech import synthesis

        synthesis._last_used.update({"vixtts": 100.0, "third": 50.0})
        engine = client_answering(
            response(503, json={"detail": "cannot load"}),
            response(json={"ok": True}, url="http://third:1"),
            response(content=wav(10)),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits"})

        assert resp.status_code == 200
        assert urls(engine)[1] == "http://third:1/release", "the engine used longest ago goes first"

    def test_a_busy_engine_is_skipped_and_the_next_one_asked(self, client, voice, monkeypatch):
        """409 is the engine saying a synthesis is in flight; never evict
        mid-request, and it is the engine that knows."""
        monkeypatch.setenv("TTS_ENGINES", f"gpt-sovits={GPTSOVITS},vixtts={VIXTTS},third=http://third:1")
        engine = client_answering(
            response(503, json={"detail": "cannot load"}),
            response(409, json={"detail": "1 synthesis in flight"}, url=VIXTTS),
            response(json={"ok": True}, url="http://third:1"),
            response(content=wav(10)),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits"})

        assert resp.status_code == 200
        assert urls(engine) == [
            f"{GPTSOVITS}/synthesize", f"{VIXTTS}/release", "http://third:1/release", f"{GPTSOVITS}/synthesize",
        ]

    def test_still_cannot_load_after_making_room_is_an_outage(self, client, voice):
        engine = client_answering(
            response(503, json={"detail": "cannot load"}),
            response(json={"ok": True}, url=VIXTTS),
            response(503, json={"detail": "still cannot load"}),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits"})

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")
        assert len(calls(engine)) == 3, "one release, one retry, and no more"

    def test_nothing_to_release_is_an_outage_without_a_retry(self, client, voice, monkeypatch):
        monkeypatch.setenv("TTS_ENGINES", f"gpt-sovits={GPTSOVITS}")
        engine = client_answering(response(503, json={"detail": "cannot load"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu"})

        assert resp.status_code == 502
        assert len(calls(engine)) == 1

    def test_an_unreachable_engine_cannot_be_released_and_is_skipped(self, client, voice):
        engine = client_answering(
            response(503, json={"detail": "cannot load"}),
            httpx.ConnectError("no route"),
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts", json={"text": "hi", "voice": "kurisu", "provider": "gpt-sovits"})

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
        monkeypatch.setenv("TTS_ENGINES", "")

        assert client.get("/tts/models").status_code == 502

    def test_voices_come_from_each_engine_tagged_with_its_model(self, client):
        engine = client_answering(
            response(json=[]),
            response(json=[{"id": "Ana Florence", "name": "Ana Florence"}], url=VIXTTS),
        )

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/voices")

        assert resp.status_code == 200
        assert resp.json() == {"voices": [{"id": "Ana Florence", "name": "Ana Florence", "model": "vixtts"}]}

    def test_an_engine_that_cannot_be_asked_contributes_no_voices(self, client):
        engine = client_answering(httpx.ConnectError("no route"))

        with patch(SEAM, return_value=engine):
            resp = client.get("/tts/voices")

        assert resp.status_code == 200
        assert resp.json() == {"voices": []}

    def test_check_reports_whether_the_engine_answers(self, client):
        engine = client_answering(response(json={"ok": True, "loaded": False}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={"provider": "vixtts"})

        assert resp.json()["ok"] is True

    def test_check_does_not_raise_when_the_engine_is_down(self, client):
        engine = client_answering(httpx.ConnectError("no route"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/tts/check", json={"provider": "vixtts"})

        assert resp.status_code == 200
        assert resp.json()["ok"] is False
