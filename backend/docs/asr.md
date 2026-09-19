# Automatic Speech Recognition (ASR)

## Provider

faster-whisper, inside a published **Whisper ASR webservice** container behind
`--profile whisper` — not inside the API and not in an image this repository
builds (#212). `routers/asr.py` goes through `kurisuassistant/speech/`, whose
`engines/whisper.py` knows that engine's dialect and whose `recognition.py`
orchestrates: the clients record raw Int16 PCM, the engine wants a file, so
`pcm_to_wav` puts a header on the samples and nothing is re-encoded.

An engine that is not running, times out, answers any other status or fails
inside is 502 "The speech service is unavailable." with a log reference; a 400
keeps the engine's own reason. With no `ASR_URL` set at all the 502 names the
profile to start, because a deployment without recognition is a configuration,
not an outage. `GET /asr/models` lists recognition models only — the Android
client cannot decode a response that includes a synthesis one (#213).

## Configuration

The engine is one container serving one model, so the model is the operator's
choice rather than the request's:

- `ASR_URL` — where the API sends audio. Defaults to the `whisper` profile's
  container; empty means this deployment has no recognition.
- `ASR_MODEL` — what that container was started with (`tiny` … `large-v3`, or a
  Hugging Face id). The API reads the same variable, only to name the model in
  the clients' picker, so the two cannot disagree about what is running.
- `ASR_DEVICE`, `ASR_IDLE_TIMEOUT` — the engine's, not the API's. The idle
  timeout is the only unloading there is now that no engine runs in a process
  this project controls; the weights come back on the next clip.

## API

`POST /asr` accepts raw Int16 PCM bytes (`application/octet-stream`), optional query params:
- `?language=` — language hint (skips detection pass)
- `?model=` — accepted and ignored. A recognition container serves the one
  model it was started with, so the choice moved to `ASR_MODEL`; both clients
  still send what they have stored and must not be refused for it
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
