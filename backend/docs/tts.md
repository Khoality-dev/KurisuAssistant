# Text-to-Speech (TTS)

## Providers

Selected per request, and per user in Settings. There is no `TTS_PROVIDER`
variable — that name appeared here but is read by nothing (`grep` over
`kurisuassistant/` and the Compose files finds it only in this document's
history). What the stack does set is `UVOICE_TTS_DEFAULT_MODEL=vixtts` on the
universal-voice service, which is what makes viXTTS the default backend.

- **GPT-SoVITS** (`gpt_sovits_provider.py`): Voice reference path as query param, POSIX format
- **viXTTS** (`vixtts_provider.py`): Voice reference file via multipart/form-data plus language code

## Which model a request asks for

`provider` on `POST /tts` is optional, and **both clients leave it out until the
user picks a model in Settings** ("Default (server)" on desktop, a blank field on
Android). The request then carries no `model`, and universal-voice answers with
`UVOICE_TTS_DEFAULT_MODEL`. The clients used to fill the gap themselves — desktop
with `vixtts`, Android with `gpt-sovits`, a backend that needs a reference clip
and is not normally running — so a fresh Android install could not speak at all,
and the Settings list it would have chosen from came from `GET /tts/backends`, a
route that does not exist (#200). The list is `GET /tts/models` on both clients.

A synthesis that fails is shown, not logged: one sentence carrying the API's
`detail`, in the chat's error toast (desktop) or banner (Android).

## Voice Discovery

Scan `data/voice_storage/` for audio files (.wav/.mp3/.flac/.ogg). Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.

## Text Splitting

Both providers split long text (default 200 chars) by paragraphs → sentences, merge WAV chunks.

## viXTTS Notes

- `vixtts` uses a short uploaded reference clip plus a target `language` value.
- The server keeps the same multipart `/tts/file` shape as the old backend so the assistant can stay simple.
- Extra emotion-related fields may still be sent for compatibility, but the simple viXTTS server does not rely on them.

## Provider Setup

Speech is behind the `voice` profile, off unless asked for:

```bash
VIXTTS_ROOT=/path/to/viXTTS UVOICE_ROOT=/path/to/universal-asr \
  docker compose --profile voice up -d --build
```

Both variables fall back to a placeholder that names the variable
(`/VIXTTS_ROOT-is-not-set`), so forgetting one fails on a path that says what to
set. It cannot be `${VAR:?message}`: Compose interpolates every service in the
file, including ones a profile has switched off, so a `:?` here would break the
plain `docker compose up`. They used to default to absolute paths under one
developer's home directory, which is why a fresh install could not start (#98).
The viXTTS tree is a working copy of the upstream model, not a repository this
project distributes; running speech locally means obtaining it yourself, and
cloud providers are the supported path otherwise.

See [GPT-SoVITS Setup](gpt-sovits.md) for detailed GPT-SoVITS configuration.
