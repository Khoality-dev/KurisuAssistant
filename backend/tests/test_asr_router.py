"""The recognition routes over kurisuassistant/speech (#212).

The engine is a published Whisper server: it takes an audio file, not the raw
PCM the clients record, and serves the one model its container was started
with. These pin the dialect the adapter speaks and what the clients get back.
"""

import io
import wave
from unittest.mock import patch

import httpx
import pytest

from tests.speech_fakes import SEAM, WHISPER, calls, client_answering, response

PCM_HEADERS = {"Content-Type": "application/octet-stream"}
CLIP = b"\x00\x01" * 800  # 1600 samples of Int16 PCM


@pytest.fixture(autouse=True)
def engines_configured(monkeypatch):
    """Addresses are read per call, so a developer's environment file — loaded
    by main.py when the system tests import the app — must not leak in."""
    monkeypatch.setenv("ASR_URL", WHISPER)
    monkeypatch.setenv("GPTSOVITS_URL", "http://gpt-sovits:9880")
    monkeypatch.delenv("VIXTTS_URL", raising=False)


def uploaded(kwargs) -> bytes:
    """The bytes of the file this request uploaded."""
    return kwargs["files"]["audio_file"][1]


class TestTranscribe:
    def test_pcm_is_wrapped_in_a_wav_and_uploaded_unchanged(self, client):
        """The clients record Int16 PCM at 16 kHz; the engine wants a file, and
        putting a header on it is the whole difference — no re-encoding."""
        engine = client_answering(response(json={"text": " xin chào ", "language": "vi"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM_HEADERS, params={"language": "vi"})

        assert resp.status_code == 200
        assert resp.json() == {"text": "xin chào", "language": "vi"}
        [(method, url, kwargs)] = calls(engine)
        assert (method, url) == ("POST", f"{WHISPER}/asr")
        with wave.open(io.BytesIO(uploaded(kwargs)), "rb") as w:
            assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
            assert w.readframes(w.getnframes()) == CLIP

    def test_language_and_prompt_reach_the_engine_as_json_output(self, client):
        engine = client_answering(response(json={"text": "hello", "language": "en"}))

        with patch(SEAM, return_value=engine):
            client.post("/asr", content=CLIP, headers=PCM_HEADERS,
                        params={"language": "en", "initial_prompt": "Kurisu"})

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["params"] == {
            "task": "transcribe", "output": "json", "language": "en", "initial_prompt": "Kurisu",
        }

    def test_no_option_means_no_query(self, client):
        """Absent means the engine's own default, not an empty string."""
        engine = client_answering(response(json={"text": "", "language": "en"}))

        with patch(SEAM, return_value=engine):
            client.post("/asr", content=CLIP, headers=PCM_HEADERS)

        [(_, _, kwargs)] = calls(engine)
        assert kwargs["params"] == {"task": "transcribe", "output": "json"}

    def test_the_language_asked_for_is_the_language_reported(self, client):
        """A hint skips detection, so the engine may not report one back."""
        engine = client_answering(response(json={"text": "xin chào"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM_HEADERS, params={"language": "vi"})

        assert resp.json() == {"text": "xin chào", "language": "vi"}

    def test_a_model_the_client_sends_is_accepted_and_ignored(self, client):
        """One model per container: the choice is the operator's now. Both
        clients still send what they have stored, and it must not be an error."""
        engine = client_answering(response(json={"text": "ok", "language": "en"}))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM_HEADERS,
                               params={"model": "vinai/PhoWhisper-base"})

        assert resp.status_code == 200
        [(_, _, kwargs)] = calls(engine)
        assert "model" not in kwargs["params"]

    def test_an_unreachable_engine_is_the_outage_sentence(self, client):
        engine = client_answering(httpx.ConnectError("no route"))

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr", content=CLIP, headers=PCM_HEADERS)

        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("The speech service is unavailable.")

    def test_no_engine_configured_says_what_to_start(self, client, monkeypatch):
        monkeypatch.delenv("ASR_URL", raising=False)

        resp = client.post("/asr", content=CLIP, headers=PCM_HEADERS)

        assert resp.status_code == 502
        assert "recognition engine is configured" in resp.json()["detail"]
        assert "ASR_URL" in resp.json()["detail"]


class TestDetectLanguage:
    def test_the_engines_answer_is_normalised(self, client):
        engine = client_answering(
            response(json={"detected_language": "Vietnamese", "language_code": "vi", "confidence": 0.94321})
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr/detect-language", content=CLIP, headers=PCM_HEADERS)

        assert resp.status_code == 200
        assert resp.json() == {"language": "vi", "confidence": 0.9432}
        [(method, url, _)] = calls(engine)
        assert (method, url) == ("POST", f"{WHISPER}/detect-language")

    def test_an_answer_outside_the_clients_table_is_reported_as_it_came(self, client):
        """The engine takes no candidate list, so a constrained detection cannot
        be asked for. The client falls back to its default model on a language
        it has no mapping for, which is exactly this case."""
        engine = client_answering(
            response(json={"language_code": "ja", "confidence": 0.7})
        )

        with patch(SEAM, return_value=engine):
            resp = client.post("/asr/detect-language", content=CLIP, headers=PCM_HEADERS,
                               params={"languages": "vi,en"})

        assert resp.json() == {"language": "ja", "confidence": 0.7}


class TestModels:
    def test_the_configured_model_is_listed_without_asking_the_engine(self, client, monkeypatch):
        """The backend knows what it configured, so a listing costs no request
        and cannot come back empty because something was briefly unreachable."""
        monkeypatch.setenv("ASR_MODEL", "large-v3")
        engine = client_answering(httpx.ConnectError("never called"))

        with patch(SEAM, return_value=engine):
            resp = client.get("/asr/models")

        assert resp.status_code == 200
        assert resp.json() == {
            "object": "list",
            "data": [{"id": "large-v3", "object": "model", "type": "asr", "name": "large-v3"}],
        }
        assert calls(engine) == []

    def test_recognition_only(self, client):
        """The Android client decodes every entry as a recognition model and
        rejected a response that also listed the synthesis ones (#213)."""
        resp = client.get("/asr/models")

        assert [m["type"] for m in resp.json()["data"]] == ["asr"]
