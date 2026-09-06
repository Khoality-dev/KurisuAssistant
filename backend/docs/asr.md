# Automatic Speech Recognition (ASR)

## Provider

faster-whisper (CTranslate2-based), running inside the **universal-voice**
service — not inside the API. The API is a proxy: `routers/asr.py` forwards to
`ASR_API_URL` and returns 502 "The speech service is unavailable." when that
service is not running (it is behind `--profile voice`).

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
- `?mode=fast` — uses `beam_size=1, without_timestamps=True` for faster trigger word detection

## Model Conversion

```bash
python scripts/convert_whisper.py
```

Requires `transformers` + `torch` + `ctranslate2`.

## Frontend Integration

Silero VAD (`@ricky0123/vad-web`) auto-detects speech end → sends PCM to `/asr`. Mic managed by `micStore` (Zustand) — owns ASR lifecycle + two-level interactive state (`interactiveMode` + `interactionActive`).

### Interaction Modes

- **Typing** (default): transcript → input field as dictation, trigger word match → enables interactive mode + activates interaction + auto-sends.
- **Interactive idle** (`interactiveMode && !interactionActive`): call bar shown, mic listening, transcripts displayed but not sent, awaiting trigger word. Uses `mode=fast` for quicker trigger word detection.
- **Interactive active** (`interactiveMode && interactionActive`): all ASR auto-sends, pulse ring on mic. Activation: trigger word match. Deactivation: 30s idle after TTS+streaming finish (stays in interactive mode). Toggle via phone button in top bar. Full exit on: hang up, agent/conversation change. Sound effects on activate/deactivate, auto mic start/stop handled by micStore actions.

## ASR Optimizations

1. **Language hint** — cached in localStorage (`kurisu_asr_language`), auto-detected on first transcription, configurable in Settings. Skips faster-whisper language detection pass.
2. **Fast mode** — `mode=fast` uses `beam_size=1` for interactive idle trigger word detection.
3. **Min duration filter** — audio < 0.5s (8000 samples at 16kHz) skipped client-side.
