# API

Every route, as the code has it. The backend's `kurisuassistant/speech/` package (behind its `routers/asr.py` and `routers/tts.py`) is the only caller in the stack; the static page at `/` is a debugging aid. The backend passes a 400 from here to its client with the reason, and reports every other failure as its own 502 — so a fault in the request must be a `ValueError` (a 400), not a `RuntimeError` (a 500).

## Health and models

### GET /health

`{"status": "ok"}` as soon as the app is up. Every pull and pre-load runs on a thread (#218 — the default ASR model's pull used to run inline in the lifespan, so nothing answered until it was on disk), so this answers from the first second; `GET /v1/models` says what is ready. The Compose healthcheck polls it.

### GET /v1/models

`{"object": "list", "data": [...]}` — every ASR model in the cache (`type: "asr"`, with `size_mb` and `loaded`), any ASR model loaded that is not in the cache, and every TTS model in the registry (`type: "tts"`, `loaded` true/false) — of the engines this instance runs (`UVOICE_ENGINES`, `docs/models.md`). Every entry carries its residency (#207, #218): `residency` (`resident` / `offloaded` / `unloaded`), `idle_seconds` (null for a model the scheduler has never seen), `in_use` (requests on it right now) and `can_offload` (whether it can be parked in CPU memory at all — false for Whisper and VieNeu). The backend's `GET /asr/models` filters it to `type == "asr"` (#213) and its `GET /tts/models` to `type == "tts"`.

### POST /v1/models/{id}/load, /offload, /unload

Residency on request (#218), for the API that holds the cap across engines (#212): `load` brings the model in and leaves it idle — the resident cap applies exactly as for a request, so another synthesis model may be parked to make room; `offload` parks it in CPU memory; `unload` drops it. Each answers `{"id", "type", "residency", "idle_seconds", "in_use", "can_offload"}`, the state the model is left in. `409` when the model is serving a request — it is never parked under a request, and the caller is told rather than ignored. A model that cannot offload answers `offload` with `residency: "resident"` and `can_offload: false`. `404` for an id this instance does not run (a synthesis model of another instance, a Whisper model not on disk) and for an empty id; `500` with the exception text when a load fails. A recognition model may be named by its listed `id` (`vinai_PhoWhisper-base`) or by the name it was pulled as (`vinai/PhoWhisper-base`, slashes and all): both are one cache directory, one scheduler entry and one loaded copy, and the answer's `id` is the listed one.

### POST /v1/models/pull

`{"model": "vinai/PhoWhisper-base"}` → pulls and, for a Hugging Face id, converts the model; answers `{"status": "ok", "model", "path"}`. Blocking: the request returns when the model is on disk. 404 on an instance without recognition.

### DELETE /v1/models/{model_name}

Unloads and deletes a cached model — the unload through the scheduler, so 409 while it serves a request; 404 when there is none, or on an instance without recognition.

## Recognition

Every route below is `404` — "Recognition is not an engine of this instance" — when `whisper` is not in `UVOICE_ENGINES` (#218); the backend reports that as its 502.

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

Every route below is `404` — "Synthesis is not an engine of this instance" — when `UVOICE_ENGINES` names only `whisper` (#218); the backend reports that as its 502.

### POST /tts/synthesize

Multipart form: `text` (required), `model` (a registry id — `vixtts`, `gpt-sovits`, `vieneu:<mode>`; absent means `UVOICE_TTS_DEFAULT_MODEL`), `voice_id` (a preset of that model), `language`, `ref_audio` (a file, for voice cloning), `ref_text` (its transcript; GPT-SoVITS uses it as the prompt text). Answers `audio/wav`. 400, with the reason, for every request fault the engine can tell apart: an unknown model, an unsupported language, an unknown preset voice, a preset asked of viXTTS when it has none, GPT-SoVITS asked to speak with no `ref_audio` ("requires a voice reference") or with a clip outside 3-10 seconds, text that normalises to nothing. 500 with the backend's message for everything else — which still includes a reference clip the decoder cannot read. The backend forwards a 400 to its client and turns a 500 into its own 502 (#218).

The backend uploads the persona's reference clip from its own `data/voice_storage/` as `ref_audio` on every request, so no voice lives in this service. The synthesis runs off the event loop and is serialised per model; a model not yet loaded is loaded by the first request for it (minutes, on a fresh volume — `docs/models.md`).

### GET /tts/voices

`?model=` → that model's presets; without it, every model's, each tagged with `"model"`. A list of `{"id", "name", "model"}`. Loads nothing (#218): viXTTS reads its presets file from the volume (fetching just that file, a few megabytes, if it is missing), GPT-SoVITS has no presets. VieNeu is the exception — its presets are a method of the SDK engine, which is the weights — so it is listed by name through the scheduler like a synthesis, and in the listing of everything only while it happens to be loaded (a listing of everything must not bring a model in, nor park the resident one to make room).
