"""The HTTP surface the backend's speech package depends on, driven against
fakes so nothing loads a model."""

import numpy as np
import pytest


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


# --- ASR ------------------------------------------------------------------

def test_asr_raw_pcm_passes_language_model_and_prompt(client, fake_transcriber):
    pcm = (np.zeros(16000, dtype=np.int16)).tobytes()
    r = client.post(
        "/asr",
        content=pcm,
        params={"language": "vi", "model": "vinai_PhoWhisper-base", "initial_prompt": "Kurisu"},
        headers={"Content-Type": "application/octet-stream"},
    )
    assert r.status_code == 200
    assert r.json() == {"text": "hello world", "language": "vi"}
    call = fake_transcriber.calls[0]
    assert call == {"samples": 16000, "model": "vinai_PhoWhisper-base", "language": "vi", "initial_prompt": "Kurisu"}


def test_asr_raw_pcm_without_model_uses_the_default(client, fake_transcriber):
    from universal_voice import config

    pcm = (np.zeros(800, dtype=np.int16)).tobytes()
    r = client.post("/asr", content=pcm, headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 200
    assert fake_transcriber.calls[0]["model"] == config.DEFAULT_MODEL


def test_asr_detect_language_raw_constrains_to_allowed(client, fake_transcriber):
    pcm = (np.zeros(800, dtype=np.int16)).tobytes()
    r = client.post(
        "/asr/detect-language",
        content=pcm,
        params={"languages": "vi, ja"},
        headers={"Content-Type": "application/octet-stream"},
    )
    assert r.status_code == 200
    assert r.json() == {"language": "vi", "confidence": 0.08}
    assert fake_transcriber.calls[0]["allowed"] == ["vi", "ja"]


def test_asr_error_is_a_500_with_the_reason(client, fake_transcriber):
    def boom(*a, **k):
        raise RuntimeError("model exploded")

    fake_transcriber.transcribe = boom
    r = client.post("/asr", content=b"\0\0" * 10, headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 500
    assert "model exploded" in r.json()["detail"]


def test_openai_transcription_accepts_a_wav_upload(client, fake_transcriber):
    import io
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.zeros(8000, dtype=np.float32), 8000, format="WAV")
    r = client.post("/v1/audio/transcriptions", files={"file": ("a.wav", buf.getvalue(), "audio/wav")})
    assert r.status_code == 200
    assert r.json()["text"] == "hello world"
    # 8 kHz input is resampled to the 16 kHz the models expect.
    assert fake_transcriber.calls[0]["samples"] == 16000


def test_undecodable_upload_is_a_400(client, fake_transcriber):
    r = client.post("/v1/audio/transcriptions", files={"file": ("a.bin", b"not audio at all", "application/octet-stream")})
    assert r.status_code == 400


# --- TTS ------------------------------------------------------------------

def test_synthesize_uses_the_default_model_when_none_is_named(client, fake_registry):
    r = client.post("/tts/synthesize", data={"text": "xin chào"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == b"RIFF" + "xin chào".encode()
    model = fake_registry.get_model("fake-a")
    # The scheduler brought the model in before the synthesis ran (#207).
    assert model.calls[0] == {"load": True}
    assert model.calls[1]["text"] == "xin chào"
    assert model.calls[1]["ref_audio_bytes"] is None


def test_synthesize_forwards_ref_audio_and_language_to_the_named_model(client, fake_registry):
    r = client.post(
        "/tts/synthesize",
        data={"text": "hello", "model": "fake-b", "language": "en", "voice_id": "v9", "ref_text": "transcript"},
        files={"ref_audio": ("ref.wav", b"RIFFref", "audio/wav")},
    )
    assert r.status_code == 200
    assert fake_registry.get_model("fake-a").calls == []
    call = fake_registry.get_model("fake-b").calls[-1]
    assert call["ref_audio_bytes"] == b"RIFFref"
    assert call["ref_audio_filename"] == "ref.wav"
    assert call["language"] == "en"
    assert call["voice_id"] == "v9"
    assert call["ref_text"] == "transcript"


def test_unknown_model_is_a_400(client, fake_registry):
    r = client.post("/tts/synthesize", data={"text": "hello", "model": "nope"})
    assert r.status_code == 400
    assert "nope" in r.json()["detail"]


def test_synthesis_failure_is_a_500_with_the_reason(client, fake_registry):
    def boom(*a, **k):
        raise RuntimeError("out of memory")

    fake_registry.get_model("fake-a").synthesize = boom
    r = client.post("/tts/synthesize", data={"text": "hello"})
    assert r.status_code == 500
    assert "out of memory" in r.json()["detail"]


def test_voices_are_tagged_with_their_model(client, fake_registry):
    r = client.get("/tts/voices")
    assert r.status_code == 200
    assert r.json() == [{"id": "v1", "name": "Voice one", "model": "fake-a"}]
    r = client.get("/tts/voices", params={"model": "fake-b"})
    assert r.json() == []


def test_listing_voices_loads_nothing(client, fake_registry):
    """A listing is a settings screen, not a synthesis (#218)."""
    client.get("/tts/voices")
    assert fake_registry.get_model("fake-a").calls == []
    assert fake_registry.get_model("fake-b").calls == []


def test_a_model_whose_presets_are_its_weights_lists_them_through_the_scheduler(client, fake_registry):
    model = fake_registry.get_model("fake-b")
    model.voices_need_weights = True
    client.get("/tts/voices", params={"model": "fake-b"})
    assert model.calls == [{"load": True}]


def test_the_listing_of_everything_omits_an_unloaded_model_whose_presets_are_its_weights(client, fake_registry):
    """Asked for everything, a listing must not bring a model in (and park the
    resident one to make room); asked for that model by name, it may."""
    model = fake_registry.get_model("fake-b")
    model.voices_need_weights = True
    model.is_loaded = lambda: False
    model._voices = [{"id": "p1", "name": "Preset"}]
    assert client.get("/tts/voices").json() == [{"id": "v1", "name": "Voice one", "model": "fake-a"}]
    assert model.calls == []
    model.is_loaded = lambda: True
    assert client.get("/tts/voices").json()[-1] == {"id": "p1", "name": "Preset", "model": "fake-b"}


def test_model_list_covers_asr_and_tts(client, fake_registry, fake_transcriber):
    r = client.get("/v1/models")
    assert r.status_code == 200
    ids = {(m["type"], m["id"]) for m in r.json()["data"]}
    assert ("tts", "fake-a") in ids
    assert ("tts", "fake-b") in ids
    # The fake transcriber reports "base" as loaded even though nothing is cached on disk.
    assert ("asr", "base") in ids
    # Every entry carries its residency (#207) and whether it is busy and can
    # be parked (#218); nothing here went through the scheduler.
    for m in r.json()["data"]:
        assert m["residency"] in {"unloaded", "offloaded", "resident"}
        assert "idle_seconds" in m
        assert m["in_use"] == 0
        assert isinstance(m["can_offload"], bool)
    by_id = {m["id"]: m for m in r.json()["data"]}
    assert by_id["fake-a"]["can_offload"] is True
    assert by_id["base"]["can_offload"] is False


def test_model_list_shows_a_used_model_as_resident(client, fake_registry, fake_transcriber):
    client.post("/tts/synthesize", data={"text": "hi", "model": "fake-b"})
    entry = next(m for m in client.get("/v1/models").json()["data"] if m["id"] == "fake-b")
    assert entry["residency"] == "resident"
    assert entry["idle_seconds"] == 0


# --- residency on request (#218) --------------------------------------------

def test_load_offload_unload_a_synthesis_model_on_request(client, fake_registry):
    model = fake_registry.get_model("fake-b")
    r = client.post("/v1/models/fake-b/load")
    assert r.status_code == 200
    assert r.json() == {"id": "fake-b", "type": "tts", "residency": "resident", "idle_seconds": 0,
                        "in_use": 0, "can_offload": True}
    assert client.post("/v1/models/fake-b/offload").json()["residency"] == "offloaded"
    assert client.post("/v1/models/fake-b/unload").json()["residency"] == "unloaded"
    assert model.calls == [{"load": True}, {"offload": True}, {"unload": True}]


def test_a_recognition_model_it_knows_can_be_loaded_and_dropped(client, fake_registry, fake_transcriber):
    # The fake transcriber reports "base" as loaded, so the instance knows it.
    r = client.post("/v1/models/base/load")
    assert r.status_code == 200
    assert r.json()["type"] == "asr"
    assert r.json()["can_offload"] is False
    assert fake_transcriber.handle("base").ops == ["load"]
    # CTranslate2 cannot offload: the request is honoured by leaving it resident.
    assert client.post("/v1/models/base/offload").json()["residency"] == "resident"
    assert client.post("/v1/models/base/unload").json()["residency"] == "unloaded"


def test_an_unknown_model_is_a_404(client, fake_registry, fake_transcriber):
    for op in ("load", "offload", "unload"):
        r = client.post(f"/v1/models/nope/{op}")
        assert r.status_code == 404, op
        assert "nope" in r.json()["detail"]


def test_an_empty_id_is_a_404_not_the_default_model(client, fake_registry, fake_transcriber):
    """`{model_id:path}` matches the empty string; that must not resolve to the default."""
    for op in ("load", "offload", "unload"):
        assert client.post(f"/v1/models//{op}").status_code == 404, op
    assert fake_registry.get_model("fake-a").calls == []


def test_a_recognition_model_is_one_entry_whatever_spelling_names_it(client, fake_registry, fake_transcriber):
    """`vinai/PhoWhisper-base` and `vinai_PhoWhisper-base` are one cache directory,
    so one scheduler entry and one loaded copy (#218)."""
    fake_transcriber.loaded_models = lambda: ["vinai_PhoWhisper-base"]
    by_name = client.post("/v1/models/vinai/PhoWhisper-base/load").json()
    by_id = client.post("/v1/models/vinai_PhoWhisper-base/offload").json()
    assert by_name["id"] == by_id["id"] == "vinai_PhoWhisper-base"
    assert fake_transcriber.handle("vinai/PhoWhisper-base") is fake_transcriber.handle("vinai_PhoWhisper-base")
    assert fake_transcriber.handle("vinai_PhoWhisper-base").ops == ["load"]


def test_deleting_a_cached_model_goes_through_the_scheduler(client, fake_registry, fake_transcriber, monkeypatch):
    """A direct unload left the entry `resident`, and the next load trusted it."""
    from universal_voice.routers import health as health_router
    from universal_voice.scheduler import scheduler

    monkeypatch.setattr(health_router.model_manager, "delete_model", lambda name: True)
    client.post("/v1/models/base/load")
    handle = fake_transcriber.handle("base")
    with scheduler.use(handle, kind="asr"):
        assert client.delete("/v1/models/base").status_code == 409
    assert client.delete("/v1/models/base").json() == {"status": "deleted", "model": "base"}
    assert handle.ops == ["load", "unload"]
    entry = next(m for m in client.get("/v1/models").json()["data"] if m["id"] == "base")
    assert entry["residency"] == "unloaded"
    # And a load afterwards really loads.
    client.post("/v1/models/base/load")
    assert handle.ops == ["load", "unload", "load"]


def test_a_busy_model_refuses_to_be_parked(client, fake_registry):
    """The scheduler's guarantee, on the wire: 409 and the model untouched."""
    from universal_voice.scheduler import scheduler

    model = fake_registry.get_model("fake-b")
    with scheduler.use(model):
        r = client.post("/v1/models/fake-b/offload")
        assert r.status_code == 409
        assert "in use" in r.json()["detail"]
        assert client.post("/v1/models/fake-b/unload").status_code == 409
    assert model.calls == [{"load": True}]
    assert client.post("/v1/models/fake-b/offload").status_code == 200


# --- engines (#218) -----------------------------------------------------------

def test_an_instance_without_recognition_refuses_asr_and_lists_no_asr_model(client, fake_registry, fake_transcriber, monkeypatch):
    from universal_voice import config

    monkeypatch.setattr(config, "ENGINES", frozenset({"vixtts"}))
    monkeypatch.setattr(config, "ASR_ENABLED", False)
    pcm = (np.zeros(800, dtype=np.int16)).tobytes()
    r = client.post("/asr", content=pcm, headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 404
    assert "not an engine of this instance" in r.json()["detail"]
    assert fake_transcriber.calls == []
    assert client.post("/v1/models/pull", json={"model": "base"}).status_code == 404
    assert client.post("/v1/models/base/load").status_code == 404
    types = {m["type"] for m in client.get("/v1/models").json()["data"]}
    assert types == {"tts"}


def test_an_instance_without_synthesis_refuses_tts(client, fake_registry, monkeypatch):
    from universal_voice import config

    monkeypatch.setattr(config, "ENGINES", frozenset({"whisper"}))
    monkeypatch.setattr(config, "TTS_ENABLED", False)
    r = client.post("/tts/synthesize", data={"text": "hello"})
    assert r.status_code == 404
    assert "not an engine of this instance" in r.json()["detail"]
    assert client.get("/tts/voices").status_code == 404
    assert fake_registry.get_model("fake-a").calls == []
