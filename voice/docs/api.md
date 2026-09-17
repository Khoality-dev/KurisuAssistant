# API

Every route, as the code has it. The backend's `kurisuassistant/speech/` package (behind its `routers/asr.py` and `routers/tts.py`) is the only caller in the stack; the static page at `/` is a debugging aid. The backend passes a 400 from here to its client with the reason, and reports every other failure as its own 502 — so a fault in the request must be a `ValueError` (a 400), not a `RuntimeError` (a 500).

## Health and models

### GET /health

`{"status": "ok"}` as soon as the app is up — before the lifespan has finished pre-loading models. The Compose healthcheck polls it.

### GET /v1/models

`{"object": "list", "data": [...]}` — every ASR model in the cache (`type: "asr"`, with `size_mb` and `loaded`), any ASR model loaded that is not in the cache, and every TTS model in the registry (`type: "tts"`, `loaded` true/false/null — null is a remote backend whose state is unknown). The backend's `GET /asr/models` filters it to `type == "asr"` (#213) and its `GET /tts/models` to `type == "tts"`.

### POST /v1/models/pull

`{"model": "vinai/PhoWhisper-base"}` → pulls and, for a Hugging Face id, converts the model; answers `{"status": "ok", "model", "path"}`. Blocking: the request returns when the model is on disk.

### DELETE /v1/models/{model_name}

Unloads and deletes a cached model; 404 when there is none.

## Recognition

Audio is decoded to float32 mono 16 kHz before it reaches faster-whisper. The raw routes take Int16 PCM at 16 kHz already; the upload routes accept wav/flac/ogg via soundfile and fall back to PyAV for mp3/webm/mp4, resampling if needed.

### POST /asr

Body: `application/octet-stream`, Int16 PCM, 16 kHz, mono. Query: `language` (skips detection), `model` (a cache id; absent means `UVOICE_DEFAULT_MODEL`), `initial_prompt` (passed to faster-whisper). Answers `{"text", "language"}`; `language` is the hint when one was given, else what was detected. 500 with the exception text on failure — the backend turns that into its 502.

### POST /asr/detect-language

Same body; query `model` and `languages` (comma-separated; when set, only those are considered and the most probable of them wins). Answers `{"language", "confidence"}`. Only the first 30 seconds are examined.

### POST /v1/audio/transcriptions

OpenAI-shaped multipart: `file`, `model`, `language`, `response_format` (`json` → `{"text", "language"}`; `text` → the string).

### POST /v1/audio/detect-language

Multipart `file`, `model` → `{"language", "confidence", "probabilities"}` (top ten).

## Synthesis

### POST /tts/synthesize

Multipart form: `text` (required), `model` (a registry id — `vixtts`, `gpt-sovits`, `vieneu:<mode>`; absent means `UVOICE_TTS_DEFAULT_MODEL`), `voice_id` (a preset of that model), `language`, `ref_audio` (a file, for voice cloning), `ref_text` (its transcript; GPT-SoVITS uses it as the prompt text). Answers `audio/wav`. 400 for an unknown model or an unsupported language, 500 with the backend's message otherwise — including "requires a voice reference" from GPT-SoVITS when none was sent.

The backend uploads the persona's reference clip from its own `data/voice_storage/` as `ref_audio` on every request, so no voice lives in this service. The synthesis runs off the event loop and is serialised per model; a model not yet loaded is loaded by the first request for it (minutes, on a fresh volume — `docs/models.md`).

### GET /tts/voices

`?model=` → that model's presets; without it, every model's, each tagged with `"model"`. A list of `{"id", "name", "model"}`.
