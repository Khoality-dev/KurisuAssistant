"""Speech: the backend's wrapper around the engine containers (#212).

The API owns everything between a client's speech request and an engine —
which engine serves it, cutting long text and joining the audio back, wrapping
raw PCM for an engine that wants a file, the model listings the clients render,
and which sentence a failure becomes. The engines only synthesize and
transcribe, each in its own container from a published image.

  engines/       one adapter per engine, each knowing that engine's HTTP
                 dialect: gptsovits.py, vixtts.py, whisper.py. __init__ says
                 which are configured and picks one for a request.
  text.py        split_text, merge_wav_files, pcm_to_wav
  synthesis.py   one synthesis: the text in chunks, one WAV out
  recognition.py transcription and language detection

**Nothing here imports torch, and nothing loads a model.** That is the point of
the split: the engines carry the weights and the CUDA, in images this project
does not build, and this package is HTTP and audio headers. There is no
``universal-voice`` service any more and no vendored inference code — the
engines existed as containers all along (#212).

``routers/asr.py`` and ``routers/tts.py`` are thin over this. A new engine is a
new adapter and one address; the routers do not change.
"""
