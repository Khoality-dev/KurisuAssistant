"""Tests for the ASR routes (kurisuassistant/routers/asr.py over kurisuassistant/speech).

These pin the API's side of the wire contract with universal-voice; the other
end is voice/tests/test_routers.py. Change both in the same PR.
"""

from unittest.mock import patch

import httpx
import pytest

from tests.speech_fakes import ENGINE, SEAM, calls, client_answering, response

PCM = {"Content-Type": "application/octet-stream"}
CLIP = b"\x00\x01" * 800


@pytest.fixture(autouse=True)
def engine_at_the_default_address(monkeypatch):
    """The address is read from the environment per call; a developer's env file
    (loaded by main.py when the system tests import the app) must not leak in."""
    monkeypatch.setenv("UVOICE_URL", ENGINE)
    monkeypatch.setenv("ASR_API_URL", ENGINE)


# ---------------------------------------------------------------------------
# POST /asr
# ---------------------------------------------------------------------------

class TestTranscribe:
    def test_the_pcm_and_every_option_reach_the_engine(self, client):
        engine = client_answering(response(json={"text": "xin chào", "language": "vi"}))

        with patch(SEAM, return_value=engine):
            resp = client.post(
                "/asr", content=CLIP, headers=PCM,
                params={"language": "vi", "model": "whisper:base", "initial_prompt": "Kurisu"},
            )

        assert resp.status_code == 200
        assert resp.json() == {"text": "xin chào", "language": "vi"}
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{ENGINE}/asr")
        assert kwargs["content"] == CLIP
        assert kwargs["headers"]["Content-Type"] == "application/octet-stream"
        assert kwargs["params"] == {"language": "vi", "model": "whisper:base", "initial_prompt": "Kurisu"}

    def test_no_option_means_no_query(self, client):
        """Absent means the engine's default, not an empty string."""
        engine = client_answering(response(json={"text": "", "language": "en"}))

        with patch(SEAM, return_value=engine):
            client.post("/asr", content=CLIP, headers=PCM)

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["params"] == {}

    def test_an_unreachable_engine_is_a_502(self, client):
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM)

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail.startswith("The speech service is unavailable.")
        assert "refused" not in detail
        assert "reference:" in detail

    def test_a_refusal_keeps_the_engines_status_and_reason(self, client):
        """The one mapping for every speech route (#215). universal-voice's
        recognition routes report every failure as a 500 today, so this pins
        what the recognition engines of #212 get when they say 400."""
        engine = client_answering(response(400, json={"detail": "No audio frames decoded"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM)

        assert resp.status_code == 400
        assert resp.json()["detail"] == "No audio frames decoded"

    def test_a_failure_inside_the_engine_is_still_the_outage(self, client):
        engine = client_answering(response(500, json={"detail": "Traceback (most recent call last)"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM)

        assert resp.status_code == 502
        assert "Traceback" not in resp.json()["detail"]


# ---------------------------------------------------------------------------
# POST /asr/detect-language
# ---------------------------------------------------------------------------

class TestDetectLanguage:
    def test_the_clip_and_the_model_reach_the_engine(self, client):
        engine = client_answering(response(json={"language": "ja", "confidence": 0.97}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr/detect-language", content=CLIP, headers=PCM, params={"model": "whisper:base"})

        assert resp.status_code == 200
        assert resp.json() == {"language": "ja", "confidence": 0.97}
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{ENGINE}/asr/detect-language")
        assert kwargs["content"] == CLIP
        assert kwargs["params"] == {"model": "whisper:base"}

    def test_the_languages_constraint_reaches_the_engine(self, client):
        """The desktop's routing mode constrains detection to the languages it
        has a model for; the proxy dropped the parameter (#216)."""
        engine = client_answering(response(json={"language": "vi", "confidence": 0.8}))

        with patch(SEAM, return_value=engine):
            client.post("/asr/detect-language", content=CLIP, headers=PCM, params={"languages": "vi,en"})

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["params"] == {"languages": "vi,en"}

    def test_an_unreachable_engine_is_a_502(self, client):
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr/detect-language", content=CLIP, headers=PCM)

        assert resp.status_code == 502


# ---------------------------------------------------------------------------
# GET /asr/models
# ---------------------------------------------------------------------------

class TestListModels:
    def test_lists_recognition_models_only(self, client):
        """universal-voice's catalogue also carries the synthesis models, with no
        `name`; Android decodes every entry as a recognition model, so one of
        those rejected the whole response (#213)."""
        engine = client_answering(response(json={
            "object": "list",
            "data": [
                {"id": "base", "object": "model", "type": "asr", "name": "base", "size_mb": 145.0, "loaded": True},
                {"id": "vixtts", "object": "model", "type": "tts", "loaded": True},
                {"id": "gpt-sovits", "object": "model", "type": "tts", "loaded": False},
            ],
        }))

        with patch(SEAM, return_value=engine):
            resp = client.get("/asr/models")

        assert resp.status_code == 200
        body = resp.json()
        assert body["object"] == "list"
        assert [m["id"] for m in body["data"]] == ["base"]
        assert all("name" in m for m in body["data"])
        [(method, url, _)] = calls(engine)
        assert (method, url) == ("GET", f"{ENGINE}/v1/models")

    def test_an_unreachable_engine_is_a_502(self, client):
        engine = client_answering(httpx.ConnectError("refused"))

        with patch(SEAM, return_value=engine):
            resp = client.get("/asr/models")

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")

    def test_a_reachable_engine_with_no_recognition_model_lists_none(self, client):
        engine = client_answering(response(json={"object": "list", "data": [
            {"id": "vixtts", "type": "tts", "loaded": True},
        ]}))

        with patch(SEAM, return_value=engine):
            resp = client.get("/asr/models")

        assert resp.status_code == 200
        assert resp.json() == {"object": "list", "data": []}
