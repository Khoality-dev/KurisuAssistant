"""Speech: the backend's wrapper around the engine containers (#212).

The API owns everything between a client's speech request and an engine —
which engine serves it, cutting long text and joining the audio back, wrapping
raw PCM for an engine that wants a file, the model listings the clients render,
and which sentence a failure becomes. The engines only synthesize and
transcribe, each in its own container from a published image.

  engines/       standard.py — the one adapter for every synthesis engine,
                 which all speak the contract in docs/speech-engine-contract.md
                 (#227); whisper.py — recognition, its own dialect. __init__
                 says which are configured (TTS_ENGINES, ASR_URL) and picks
                 one for a request.
  text.py        split_text, merge_wav_files, pcm_to_wav
  synthesis.py   one synthesis: the text in chunks, one WAV out — and the only
                 residency the backend has: an engine's 503 (it cannot load)
                 makes it release the least recently used other engine and try
                 once more
  recognition.py transcription and language detection

**Nothing here imports torch, nothing loads a model, and nothing reads the GPU
or touches a container.** The engines carry the weights and manage their own
memory — they drop it when idle and when asked, and say when they cannot load
it — and this package is HTTP and audio headers. There is no ``universal-voice``
service and no vendored inference code (#212), and no Docker proxy (#227).

``routers/asr.py`` and ``routers/tts.py`` are thin over this. A new synthesis
engine is one ``name=url`` entry in ``TTS_ENGINES``; nothing else changes.
"""
