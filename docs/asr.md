# Automatic Speech Recognition (ASR)

## Provider

faster-whisper (CTranslate2-based, much faster than HuggingFace transformers pipeline).

## Configuration

- **Model**: `ASR_MODEL` env var. Defaults to `data/asr/whisper-ct2` (local) or `base` (downloaded)
- **Device**: CPU by default. Override via `ASR_DEVICE` env var (`cuda`/`cpu`)
- **Lazy loading**: Model loaded on first transcription request, not at startup

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
