# The speech engine contract

Every synthesis engine the backend can talk to is a container that speaks the
routes below, and the backend has one adapter for all of them
(`kurisuassistant/speech/engines/standard.py`). Adding an engine is one entry
in `TTS_ENGINES` — `name=http://host:port` — and nothing else (#227).

The engine owns its own memory. It loads its model when it needs it, drops it
when told to or when idle, and says so. Nothing outside it reads the GPU or
touches its container.

## Routes

### `GET /health`

Always 200 while the process is up. Never loads the model.

```json
{"ok": true, "loaded": false, "engine": "gpt-sovits", "model": "v2"}
```

`loaded` is whether the weights are in memory right now.

### `GET /voices`

The preset voices, `[{"id": "...", "name": "..."}]`; `[]` for an engine that
only clones. Never loads the model.

### `POST /synthesize`

Multipart form:

| Field | |
| --- | --- |
| `text` | required; one chunk, about 200 characters — the backend cuts long text |
| `language` | a code the engine understands; absent means the engine's default |
| `voice_id` | one of `/voices` |
| `ref_audio` | a clip to clone, uploaded; the engine never opens a path |
| `ref_text` | what the clip says, where known |

Answers `audio/wav`, one WAV, any rate. Three failures, and they mean
different things to the backend:

- **400** with `{"detail": "..."}` — the request is at fault: an unsupported
  language, a clip outside the range the engine accepts, no clip for an engine
  that only clones, text that normalises to nothing. The reason is shown to the
  user as one sentence, so write it for them.
- **503** with `{"detail": "..."}` — **the model could not be loaded**: a CUDA
  out-of-memory, the weights missing, the child that hosts them dying. This is
  the memory-pressure signal. The backend answers it by releasing the least
  recently used other engine and trying once more; it never reads the GPU.
- anything else — an outage. The user sees "The speech service is
  unavailable."; the engine's own text stays in the backend log.

A synthesis loads the model if it is not loaded; the request simply takes
longer. The backend allows 120 seconds per chunk.

### `POST /release`

Drop the weights and free the device. `{"ok": true, "loaded": false}` — also
when nothing was loaded. **409** while a synthesis is in flight: an engine in
the middle of a request is never released, and it is the engine that knows.

## Idle

`IDLE_TIMEOUT` (seconds) in the engine's environment: the engine drops its own
weights after that long without a request. `0` never. The backend does not
manage this; it exists so an engine nobody has used overnight is not still
holding the card in the morning.

## What the backend does with all this

- Chooses the engine by the model id the client stored (`TTS_ENGINES` names).
- Cuts text into chunks and joins the WAVs (`speech/text.py`).
- On a 503, releases the LRU other engine(s) and retries once
  (`speech/synthesis.py`). It keeps last-use per engine in memory and nothing
  else — an API restart forgets nothing that matters.
- Tells the clients nothing. They get audio or the failure sentence they
  already handle.

## Engines that speak it

| Engine | Image | Notes |
| --- | --- | --- |
| `gpt-sovits` | `legwork7623/gpt-sovits`, the owner's fork, `kurisu` target | `kurisu_engine.py` in that repository fronts `api_v2` as a child process; release kills the child, which is how a process that cannot unload gives memory back |
| `vixtts` | `legwork7623/vixtts` | `vixtts/server.py` in the viXTTS repository speaks it natively |

Recognition is not covered: the Whisper webservice has its own dialect
(`engines/whisper.py`) and unloads itself.
