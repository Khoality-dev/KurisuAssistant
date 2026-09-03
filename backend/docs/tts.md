# Text-to-Speech (TTS)

## Providers

Configured via `TTS_PROVIDER` env var (default in Docker Compose: `vixtts`), overridable per-request.

- **GPT-SoVITS** (`gpt_sovits_provider.py`): Voice reference path as query param, POSIX format
- **viXTTS** (`vixtts_provider.py`): Voice reference file via multipart/form-data plus language code

## Voice Discovery

Scan `data/voice_storage/` for audio files (.wav/.mp3/.flac/.ogg). Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.

## Text Splitting

Both providers split long text (default 200 chars) by paragraphs → sentences, merge WAV chunks.

## viXTTS Notes

- `vixtts` uses a short uploaded reference clip plus a target `language` value.
- The server keeps the same multipart `/tts/file` shape as the old backend so the assistant can stay simple.
- Extra emotion-related fields may still be sent for compatibility, but the simple viXTTS server does not rely on them.

## Provider Setup

The bundled Docker Compose stack expects a viXTTS checkout at `VIXTTS_ROOT`, defaulting to `/home/khoa/application/viXTTS`.

See [GPT-SoVITS Setup](gpt-sovits.md) for detailed GPT-SoVITS configuration.
