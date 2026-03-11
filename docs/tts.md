# Text-to-Speech (TTS)

## Providers

Configured via `TTS_PROVIDER` env var (default: `gpt-sovits`), overridable per-request.

- **GPT-SoVITS** (`gpt_sovits_provider.py`): Voice reference path as query param, POSIX format
- **INDEX-TTS** (`index_tts_provider.py`): Voice reference file via multipart/form-data

## Voice Discovery

Scan `data/voice_storage/` for audio files (.wav/.mp3/.flac/.ogg). Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.

## Text Splitting

Both providers split long text (default 200 chars) by paragraphs → sentences, merge WAV chunks.

## INDEX-TTS Emotion

Additional parameters for emotion control:
- `emo_audio` — emotion reference audio
- `emo_vector` — 8 emotion dimensions
- `emo_text` — emotion description text
- `emo_alpha` (0-1) — emotion blending strength

## Provider Setup

See [GPT-SoVITS Setup](gpt-sovits.md) for detailed GPT-SoVITS configuration.
