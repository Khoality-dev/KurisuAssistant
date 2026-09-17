# Text-to-Speech (TTS)

## Providers

Selected per request, and per user in Settings. There is no `TTS_PROVIDER`
variable — that name appeared here but is read by nothing (`grep` over
`kurisuassistant/` and the Compose files finds it only in this document's
history). What the stack does set is `UVOICE_TTS_DEFAULT_MODEL=vixtts` on the
universal-voice service, which is what makes viXTTS the default backend.

The API has no synthesis code of its own, but it does the orchestration
(#215, the first step of #212): `routers/tts.py` resolves the voice reference,
and `kurisuassistant/speech/` — `engines.py` for where the engines are and how
their answers become the client's, `synthesis.py` for one synthesis — drives
the engine. The three backends — `vixtts`, `gpt-sovits`, `vieneu:turbo` — run
inside universal-voice today (#203; `voice/docs/models.md` describes each), the
one engine, at `UVOICE_URL`. Two provider modules named here for years,
`gpt_sovits_provider.py` and `vixtts_provider.py`, do not exist.

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
`detail`, in the chat's error toast (desktop) or banner (Android). Which
sentence depends on whose fault it is (#215): a request the engine refuses with
a 400 — an unknown model, an unknown preset voice, text that normalises to
nothing — comes back with that status and the engine's reason, so the user
reads why; an engine that is unreachable, times out, answers any other status
or fails inside is "The speech service is unavailable." with a 502 and a log
reference, the engine's own text kept out of the response. Every refusal used
to be reported as that outage. GPT-SoVITS asked to speak with no reference clip
is still one: universal-voice reports it as a 500, which step 2 of #212
corrects on the engine's side.

## Voice Discovery

Scan `data/voice_storage/` for audio files (.wav/.mp3/.flac/.ogg). Frontend sends voice names only (no paths/extensions) — backend enforces via `_find_voice_file()`.

## Text Splitting

The API cuts long text at about 200 characters — paragraphs first, then
sentences, Latin and CJK; a single sentence longer than that goes whole — sends
one chunk per request, uploading the reference clip with each (an engine keeps
nothing between requests), and joins the WAVs (`speech/text.py`,
`speech/synthesis.py`). An engine therefore only ever sees one chunk, which is
the shape the per-engine containers of #212 have. viXTTS and GPT-SoVITS carry
the same two functions and would split a whole paragraph the same way; handed
a chunk they answer one piece, so nothing changes on the wire for them, and
that copy goes when the engines take only chunks. VieNeu never split, and now
receives chunks. A chunk an engine refuses is skipped when there are others —
inside the engine a chunk that normalised to nothing was skipped the same way
— and the refusal is the answer only when nothing could be said. Both clients
send one sentence per request, so this is normally one call; five minutes is
the most one request may take.

## viXTTS Notes

- `vixtts` uses a short uploaded reference clip plus a target `language` value.
- The server keeps the same multipart `/tts/file` shape as the old backend so the assistant can stay simple.
- Extra emotion-related fields may still be sent for compatibility, but the simple viXTTS server does not rely on them.

## Provider Setup

Speech is behind the `voice` profile, off unless asked for:

```bash
docker compose --profile voice up -d --build
```

That needs an NVIDIA runtime and nothing else. universal-voice builds from
`../voice`, a package of this repository (#202), and its synthesis backends run
inside it (#203): viXTTS and GPT-SoVITS pull their weights from Hugging Face
into the `uvoice-data` volume on first use — several gigabytes, so the first
start spends minutes before it can speak, and `GET /tts/models` reports each
model's `loaded` state meanwhile. `UVOICE_TTS_PRELOAD` picks which load at
startup; `UVOICE_GPTSOVITS_GPT_WEIGHTS` / `UVOICE_GPTSOVITS_SOVITS_WEIGHTS`
point GPT-SoVITS at a fine-tuned voice. Both are in the environment template;
`voice/docs/models.md` has the rest.

Until #203 viXTTS was a container built from `VIXTTS_ROOT`, a checkout beside
this one (with, until #98, an absolute default under one developer's home
directory), and GPT-SoVITS an unpinned third-party image behind a second
profile, `sovits`, handed each reference clip through a shared volume. Neither
exists any more; `tests/test_deployment_config.py` asserts that no service
builds from outside the repository.
