"""Speech, orchestrated here (#212).

The API owns what happens between a client's request and an audio engine:
which engine a request goes to, splitting long text and joining the audio
back, the model and voice listings the clients render, and which errors the
clients see. The engines only synthesize and transcribe.

  engines.py     where the engines are, the one call helper every route uses,
                 and how an engine's answer becomes the client's
  text.py        split_text and merge_wav_files — the chunking every engine
                 depends on
  synthesis.py   one synthesis: the text in chunks, one WAV out

Today there is one engine, universal-voice (``../voice``), reached at
``UVOICE_URL`` for synthesis and ``ASR_API_URL`` for recognition — the same
service unless an operator points them apart. ``routers/asr.py`` and
``routers/tts.py`` are the only callers; the later steps of #212 add engines
in ``engines.py`` and leave the routers alone.
"""
