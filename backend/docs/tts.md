# Text-to-Speech (TTS)

## Providers

Selected per request, and per user in Settings. There is no `TTS_PROVIDER`
variable — that name appeared here but is read by nothing; `TTS_DEFAULT_MODEL`
is what picks the engine for a request that names none.

The API has no synthesis code of its own and never loads a model. It does the
orchestration (#212): `routers/tts.py` resolves the voice reference, and
`kurisuassistant/speech/` drives an engine — `engines/` for the adapters and
how their answers become the client's, `synthesis.py` for one synthesis.

Every synthesis engine speaks one contract — `docs/speech-engine-contract.md`:
health, voices, a multipart synthesize with the clip uploaded, release, an idle
timeout — so `engines/standard.py` is the one adapter and an engine is one
`name=url` entry in `TTS_ENGINES` (#227).

| Model id | Engine | Notes |
| --- | --- | --- |
| `gpt-sovits` | `legwork7623/gpt-sovits`, `kurisu` target, `--profile gpt-sovits` | `kurisu_engine.py` in the owner's fork hosts `api_v2` as a child and speaks the contract in front of it. It only clones, so a request with no clip is a 400 that says so. About 35s cold to first audio, 1–2s warm |
| `vixtts` | `legwork7623/vixtts`, `--profile vixtts` | the owner's server, speaking the contract natively. With no clip it uses `voice_id`, one of the built-in XTTS speakers. About 20s cold (a minute the first time, while the weights come off disk), 2s warm |

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
docker compose --profile gpt-sovits up -d            # add --profile vixtts for the second engine
```

That needs an NVIDIA runtime and pulls a published image; nothing here is
built (#212). Each engine downloads its weights on first use, so the first
start spends minutes before it can speak. Each also manages its own GPU
memory: it drops its weights after `TTS_IDLE_TIMEOUT` and when the API asks
(because another engine answered 503, could not load), and reloads them on the
next request — the contract, and the whole of residency (#227).

Until #203 this was two containers behind a third, each with its own dialect
and a shared scratch volume for the clip; #203 put every engine in one process
with a vendored copy of GPT-SoVITS; #223 stopped containers from the API
through a Docker proxy. All gone: `tests/test_deployment_config.py` asserts
that this repository builds only the API, that every engine image is pinned,
and that nothing in the stack touches the Docker socket.
