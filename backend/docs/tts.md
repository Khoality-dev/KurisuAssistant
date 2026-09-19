# Text-to-Speech (TTS)

## Providers

Selected per request, and per user in Settings. There is no `TTS_PROVIDER`
variable — that name appeared here but is read by nothing; `TTS_DEFAULT_MODEL`
is what picks the engine for a request that names none.

The API has no synthesis code of its own and never loads a model. It does the
orchestration (#212): `routers/tts.py` resolves the voice reference, and
`kurisuassistant/speech/` drives an engine — `engines/` for the adapters and
how their answers become the client's, `synthesis.py` for one synthesis.

| Model id | Engine | The reference clip |
| --- | --- | --- |
| `gpt-sovits` | `legwork7623/gpt-sovits`, `api_v2` on 9880, `--profile gpt-sovits` | a **path** it opens itself, so the stack mounts `data/voice_storage/` into it read-only (`GPTSOVITS_VOICE_DIR`). It only clones, so a request with no clip is a 400 that says so |
| `vixtts` | the owner's viXTTS server on 19770, `VIXTTS_URL` | **uploaded** with the form. With no clip it uses `speaker_id`, one of the built-in XTTS speakers |

`vieneu:turbo` is gone with the process that hosted it. A client that still has
it stored gets a 400 naming the models this server does run, which both clients
show in one sentence. Two provider modules named here for years,
`gpt_sovits_provider.py` and `vixtts_provider.py`, never existed.

## Which model a request asks for

`provider` on `POST /tts` is optional, and **both clients leave it out until the
user picks a model in Settings** ("Default (server)" on desktop, a blank field on
Android). The request then carries no `model`, and the server uses
`TTS_DEFAULT_MODEL`, or the first configured engine when that is unset too. The clients used to fill the gap themselves — desktop
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
reference, the engine's own text kept out of the response. A synthesis asked of
an engine this server does not run, and GPT-SoVITS asked to speak with no
reference clip, are both refused here before any request is made.

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
- The server keeps the multipart `/tts/file` shape, so the adapter stays simple.
- It validates the language itself and refuses an unsupported one with a 400,
  which is why there is no second language table in the backend.

## Provider Setup

Each engine is behind its own profile, off unless asked for:

```bash
docker compose --profile gpt-sovits up -d
```

That needs an NVIDIA runtime and pulls a published image; nothing here is
built (#212). GPT-SoVITS downloads its pretrained weights on first use, so the
first start spends minutes before it can speak. viXTTS has no published image
yet — run it yourself and set `VIXTTS_URL`, which is how any engine running
outside this stack is reached.

Until #203 this was two containers behind a third: viXTTS built from
`VIXTTS_ROOT`, a checkout beside this one (with, until #98, an absolute default
under one developer's home directory), GPT-SoVITS an unpinned third-party tag,
and each reference clip passed through a volume shared between them. #203 then
put every engine in one process with a vendored copy of GPT-SoVITS's inference
code. Both are gone: `tests/test_deployment_config.py` asserts that this
repository builds only the API and that every engine image is pinned.
