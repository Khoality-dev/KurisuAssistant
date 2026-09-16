"""The HTTP surface the backend's asr.py and tts.py proxies depend on, driven
against fakes so nothing loads a model."""

import numpy as np


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
    assert model.calls[0]["text"] == "xin chào"
    assert model.calls[0]["ref_audio_bytes"] is None


def test_synthesize_forwards_ref_audio_and_language_to_the_named_model(client, fake_registry):
    r = client.post(
        "/tts/synthesize",
        data={"text": "hello", "model": "fake-b", "language": "en", "voice_id": "v9", "ref_text": "transcript"},
        files={"ref_audio": ("ref.wav", b"RIFFref", "audio/wav")},
    )
    assert r.status_code == 200
    assert fake_registry.get_model("fake-a").calls == []
    call = fake_registry.get_model("fake-b").calls[0]
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


def test_model_list_covers_asr_and_tts(client, fake_registry, fake_transcriber):
    r = client.get("/v1/models")
    assert r.status_code == 200
    ids = {(m["type"], m["id"]) for m in r.json()["data"]}
    assert ("tts", "fake-a") in ids
    assert ("tts", "fake-b") in ids
    # The fake transcriber reports "base" as loaded even though nothing is cached on disk.
    assert ("asr", "base") in ids
