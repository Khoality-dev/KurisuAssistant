"""Shared fixtures.

The package reads its settings at import time, so the model cache directory is
pointed at a temporary path before anything under ``universal_voice`` is
imported: a test must never touch a real cache, and must never pull a model.
The app's lifespan (which pre-loads the default models) is not run — the
``client`` fixture deliberately does not enter the ``TestClient`` context.
"""

import os
import tempfile

_DATA_DIR = tempfile.mkdtemp(prefix="uvoice-test-")
os.environ["UVOICE_DATA_DIR"] = _DATA_DIR
os.environ["UVOICE_DEVICE"] = "cpu"
os.environ["UVOICE_COMPUTE_TYPE"] = "int8"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client():
    from universal_voice.main import app

    return TestClient(app)


class FakeTTSModel:
    """A registry entry that records what it was asked and answers WAV bytes."""

    def __init__(self, model_id: str = "fake", voices=None):
        self._id = model_id
        self.calls: list[dict] = []
        self._voices = voices or []

    @property
    def model_id(self) -> str:
        return self._id

    def synthesize(self, text, voice_id=None, language=None, ref_audio_bytes=None, ref_text=None, **kwargs):
        self.calls.append({
            "text": text, "voice_id": voice_id, "language": language,
            "ref_audio_bytes": ref_audio_bytes, "ref_text": ref_text, **kwargs,
        })
        return b"RIFF" + text.encode()

    def list_voices(self):
        return [dict(v) for v in self._voices]

    def check_health(self):
        return {"ok": True, "message": "fake"}

    def is_loaded(self):
        return True


class FakeRegistry:
    def __init__(self, *models: FakeTTSModel, default: str | None = None):
        self._models = {m.model_id: m for m in models}
        self._default = default or (models[0].model_id if models else None)

    def get_model(self, model_id=None):
        name = model_id or self._default
        if name not in self._models:
            raise ValueError(f"Unknown TTS model: {name}")
        return self._models[name]

    def list_models(self):
        return [{"id": m.model_id, "object": "model", "type": "tts", "loaded": True} for m in self._models.values()]


@pytest.fixture
def fake_registry(monkeypatch):
    registry = FakeRegistry(FakeTTSModel("fake-a", voices=[{"id": "v1", "name": "Voice one"}]), FakeTTSModel("fake-b"))
    import universal_voice.routers.tts as tts_router
    import universal_voice.routers.health as health_router

    monkeypatch.setattr(tts_router, "tts_registry", registry)
    monkeypatch.setattr(health_router, "tts_registry", registry)
    return registry


class FakeTranscriber:
    def __init__(self):
        self.calls: list[dict] = []

    def transcribe(self, audio, model_name=None, language=None, initial_prompt=None):
        self.calls.append({"samples": len(audio), "model": model_name, "language": language, "initial_prompt": initial_prompt})
        return "hello world", language or "en"

    def detect_language(self, audio, model_name=None, allowed_languages=None):
        self.calls.append({"samples": len(audio), "model": model_name, "allowed": allowed_languages})
        probs = [("en", 0.9), ("vi", 0.08), ("ja", 0.02)]
        if allowed_languages:
            probs = [(l, p) for l, p in probs if l in allowed_languages]
        return probs[0][0], probs[0][1], probs

    def loaded_models(self):
        return ["base"]

    def unload_model(self, name):
        return False


@pytest.fixture
def fake_transcriber(monkeypatch):
    fake = FakeTranscriber()
    import universal_voice.routers.transcription as transcription_router
    import universal_voice.routers.health as health_router

    monkeypatch.setattr(transcription_router, "transcriber", fake)
    monkeypatch.setattr(health_router, "transcriber", fake)
    return fake
