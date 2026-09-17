# Automatic Speech Recognition (ASR)

## Provider

faster-whisper (CTranslate2-based), running inside the **universal-voice**
service — `../voice` in this repository (#202), not inside the API. The API
orchestrates (#215): `routers/asr.py` goes through `kurisuassistant/speech/engines.py`,
which knows the recognition engine's address (`ASR_API_URL`) and turns its
answer into the client's — a 400 keeps the engine's reason; an engine that is
not running (it is behind `--profile voice`), times out, answers any other
status or fails inside is 502 "The speech service is unavailable." with a log
reference. universal-voice reports every recognition failure as a 500, a model
it does not have included, so today those are all the 502. `GET /asr/models` lists recognition models only: the engine's
catalogue also carries the synthesis models, and the Android client cannot
decode a response that includes one (#213). How the service caches, pulls and
converts models is `voice/docs/models.md`; its routes are `voice/docs/api.md`.

## Configuration

The backend reads **no ASR settings of its own**. `ASR_MODEL` and `ASR_DEVICE`
were documented here for years and are read by nothing — `grep` finds neither in
`kurisuassistant/`. What exists:

- `ASR_API_URL` — where the API sends audio. Defaults to the
  `universal-voice` service on the Compose network.
- The model and device belong to universal-voice, configured by the `UVOICE_*`
  variables the Compose file sets on that service (`UVOICE_DEFAULT_MODEL`
  defaults to `base`, `UVOICE_DEVICE=auto`).
- The client picks a model per request; see the ASR settings in either client.

## API

`POST /asr` accepts raw Int16 PCM bytes (`application/octet-stream`), optional query params:
- `?language=` — language hint (skips detection pass)
- `?model=` — a universal-voice model id from `GET /asr/models`; absent means
  that service's default (`UVOICE_DEFAULT_MODEL`)
- `?initial_prompt=` — passed through to faster-whisper

`POST /asr/detect-language` takes the same body, `?model=` and `?languages=`
(comma-separated codes to choose among), and answers `{"language", "confidence"}`
without transcribing — the first leg of the clients' "routing" mode (below).
The desktop sends the languages it has a model mapped for; the proxy used to
drop the parameter (#216).

There is no `?mode=`. A `mode=fast` parameter was documented here and sent by the
Android client for a long time after the router had stopped reading it (#200).

## Model Conversion

```bash
python scripts/convert_whisper.py
```

Requires `transformers` + `torch` + `ctranslate2`.

## Frontend Integration

Silero VAD (`@ricky0123/vad-web`) auto-detects speech end → sends PCM to `/asr`. Mic managed by `micStore` (Zustand) — owns ASR lifecycle + two-level interactive state (`interactiveMode` + `interactionActive`).

### Model selection

Both clients keep the same two settings and send the result as `?model=`
(#200): **fixed** — one model for everything, blank meaning the server default —
or **routing** — `POST /asr/detect-language` first, then the per-language table
(`kurisu_asr_model_map`) names the model; a language with no mapping, or a
failed detection, falls back to the server default rather than to the fixed
model. Desktop: `micStore.ts`; Android: `CoreService.chooseAsrModel` over the
pure `AsrModelSelection`. Android stored and showed these settings for months
without ever sending them.

### Interaction Modes

- **Typing** (default): transcript → input field as dictation, trigger word match → enables interactive mode + activates interaction + auto-sends.
- **Interactive idle** (`interactiveMode && !interactionActive`): call bar shown, mic listening, transcripts displayed but not sent, awaiting trigger word. Uses `mode=fast` for quicker trigger word detection.
- **Interactive active** (`interactiveMode && interactionActive`): all ASR auto-sends, pulse ring on mic. Activation: trigger word match. Deactivation: 30s idle after TTS+streaming finish (stays in interactive mode). Toggle via phone button in top bar. Full exit on: hang up, agent/conversation change. Sound effects on activate/deactivate, auto mic start/stop handled by micStore actions.

## ASR Optimizations

1. **Language hint** — cached in localStorage (`kurisu_asr_language`), auto-detected on first transcription, configurable in Settings. Skips faster-whisper language detection pass.
2. **Min duration filter** — audio < 0.5s (8000 samples at 16kHz) skipped client-side.

## Failures are shown

A transcription that fails — the service down, a 502 from the API, a model that
does not exist — is one sentence in the chat, the same toast (desktop) or banner
(Android) a failed send gets: `describeSpeechFailure` in `@kurisu/api` and in
`domain/tts/SpeechFailure.kt` pull the API's `detail` out of the response and
otherwise name the kind of failure. Both clients used to log it and stay silent
(#200).
