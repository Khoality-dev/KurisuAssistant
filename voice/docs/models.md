# Models

## ASR: the cache

`models/manager.py` resolves a model name to a directory under `UVOICE_DATA_DIR/models/`, named after the model with anything outside `[\w\-.]` replaced by `_` (`vinai/PhoWhisper-base` → `vinai_PhoWhisper-base`). A directory holding a `model.bin` is a cached model.

- A standard Whisper size (`tiny` … `large-v3`, `distil-*`, `turbo`) is downloaded through faster-whisper's own `download_model`, already in CTranslate2 form.
- Anything else is taken as a Hugging Face id: `WhisperForConditionalGeneration` and `WhisperProcessor` are downloaded, converted with `ctranslate2.converters.TransformersConverter` at the configured `COMPUTE_TYPE`, and the processor files saved beside the converted weights so `list_models` can show the original name.

Downloads are serialised by one lock. `POST /v1/models/pull` is the only way to add a model from outside; the default model is resolved at startup.

`models/transcriber.py` keeps one `WhisperModel` per name, loaded on first use with `DEVICE`/`COMPUTE_TYPE`, and transcribes with `without_timestamps=True` (faster; timestamps were never used). Language detection looks at the first 30 seconds and can be constrained to a list of codes — the routing mode in the clients (`backend/docs/asr.md`).

### Settings

| Variable | Default | Read as |
| --- | --- | --- |
| `UVOICE_HOST`, `UVOICE_PORT` | `0.0.0.0`, `14213` | bind address |
| `UVOICE_DEVICE` | `auto` | `cuda` when torch sees one, else `cpu`; shared by recognition and synthesis |
| `UVOICE_COMPUTE_TYPE` | `auto` | `float16` on cuda, `int8` on cpu (faster-whisper only) |
| `UVOICE_DEFAULT_MODEL` | `base` | the ASR model fetched (pulled and converted, not loaded) at startup on a thread, and used when a request names none |
| `UVOICE_DATA_DIR` | `voice/data` | the cache root; `/app/data` in the container, the `uvoice-data` volume |
| `HF_TOKEN` | — | for gated Hugging Face models |

Each of these is also read under its older `UASR_*` name.

## TTS: the registry

`tts/registry.py` builds the model list on first access. Each entry is a `BaseTTSModel` (`tts/base.py`): `load()`, `synthesize(text, voice_id, language, ref_audio_bytes, ref_text, **kwargs) -> wav bytes`, `list_voices()`, `check_health()`, `is_loaded()`. The ids are what the clients store in their settings; do not rename one without a migration on both clients. All three run in this process (#203); each serialises its own inference with a lock.

| Id | Runs through | Weights | Reference audio | Languages |
| --- | --- | --- | --- | --- |
| `vixtts` | coqui-tts 0.27 (`tts/vixtts_model.py`) | `capleaf/viXTTS` (config, model, vocab) plus `speakers_xtts.pth` from `coqui/XTTS-v2`, into `tts/vixtts/` | conditioning latents, cached by content hash (`UVOICE_VIXTTS_SPEAKER_CACHE_SIZE`); without one, a preset speaker (`voice_id`, else the first) — `list_voices` is XTTS-v2's 58 presets | XTTS-v2's 17 plus `vi` (default). Vietnamese is normalised with vinorm first. |
| `gpt-sovits` | the vendored upstream code (`tts/gpt_sovits_model.py`, `vendor/gpt_sovits`) | the v2 pretrained pair plus Chinese RoBERTa and HuBERT from `lj1995/GPT-SoVITS`, into `tts/gpt-sovits/`; or a fine-tuned pair via `UVOICE_GPTSOVITS_GPT_WEIGHTS` / `UVOICE_GPTSOVITS_SOVITS_WEIGHTS` | required; written once per distinct clip to a temp path keyed by hash, because upstream caches the encoded prompt by path. `ref_text` (the clip's transcript) is passed through as the prompt text when given | upstream's v2 codes (`ja`, `en`, `zh`, `ko`, `yue`, `auto`, `all_*`); `UVOICE_GPTSOVITS_DEFAULT_LANGUAGE` (`ja`) when the request has none. `text_split_method=cut5`, `batch_size=20`. v2 only — see PATCHES.md. |
| `vieneu:<mode>` | the `vieneu` SDK (`tts/vieneu_model.py`); `turbo` runs its GGUF backbone through llama-cpp-python, on the CPU | fetched by the SDK | encoded to `ref_codes`, cached by content hash; presets via `list_voices` | Vietnamese. `mode` is `UVOICE_TTS_MODE`, part of the id. It never loaded in the old container — llama-cpp-python was missing and the pre-load swallowed the error. |

Every backend goes through `text_processing.split_text` (200 characters; paragraphs first, then sentence punctuation including `。！？`) and `merge_wav_files`, so long text is many short syntheses — though the backend already sends one chunk per request (#215).

### Which engines an instance runs

`UVOICE_ENGINES` (#218) names them: `whisper` (recognition) and the synthesis engines `vixtts`, `gpt-sovits`, `vieneu` — engine names, not model ids: VieNeu's model id is `vieneu:<mode>`. Every one by default. One image started with a single name is one engine container, which is how #212 splits the service. A backend not named is not registered — not listed by `GET /v1/models`, unknown to `POST /tts/synthesize` (400) and to the residency routes (404) — and not preloaded. When `UVOICE_TTS_DEFAULT_MODEL` is not run, "the default" for a request that names none is the first the instance runs, in the order `vixtts`, `gpt-sovits`, `vieneu`; `UVOICE_TTS_PRELOAD`, when unset, means that same default, so an engine-only instance preloads the one model it has (set, it is taken as given, and an engine name in it stands for that engine's model id; a name the instance does not run is skipped with a log line, not an error). Without `whisper` every recognition route, the pull and the delete answer 404; with only `whisper`, every synthesis route does. A name that is not an engine, or an empty value, fails the process at import, so a typo is a container that does not start rather than one that silently runs everything or nothing.

### The Vietnamese tokenizer patch

XTTS-v2 was not trained on Vietnamese, so coqui-tts's `VoiceBpeTokenizer` raises for `vi`. The old container installed thinhlpg/TTS, a fork whose whole difference was two lines: a 250-character limit for `vi` and `basic_cleaners` (lower-case, collapse whitespace) as its preprocessing. `vixtts_model._teach_tokenizer_vietnamese` applies the same two things to the class at load time — so the maintained fork from PyPI can be used, at a version whose `transformers` requirement is compatible with GPT-SoVITS in the same process. `tests/test_tts_backends.py` pins what the patch does and does not touch.

### First use

Weights are pulled on first use into `UVOICE_DATA_DIR/tts/` — the `uvoice-data` volume — so the first `docker compose up` with the profile spends minutes downloading (viXTTS about 2 GB, GPT-SoVITS about 2 GB) before the first synthesis. The models in `UVOICE_TTS_PRELOAD` do this at startup on a thread; `GET /v1/models` shows `loaded: false` until they finish, and a request for one waits on its lock. GPT-SoVITS's g2pW model (Chinese input only) is fetched on the first Chinese sentence, into the same volume.

### Residency

One process holds every model, on a GPU it shares with Ollama and the vision
pipeline, so a model nobody is using should not sit on it (#207).
`scheduler.py` keeps each registered model — the three synthesis backends and
every loaded Whisper model — in one of three states:

| State | Where the weights are | Time to the next request |
| --- | --- | --- |
| `resident` | on the device | none |
| `offloaded` | CPU memory (`model.to("cpu")`) | seconds |
| `unloaded` | nowhere | tens of seconds, from the volume |

Three rules move a model between them. A request brings its model to
`resident` and holds it there until it returns, so a model in use is never
parked. At most `UVOICE_TTS_MAX_RESIDENT` synthesis models are resident at
once (default 1): bringing another in offloads the least recently used one
first, unless every resident model is in use, in which case the cap is
exceeded rather than a request refused. A sweeper thread parks a model idle for
`UVOICE_OFFLOAD_AFTER_SECONDS` (default 5 min) and drops one idle for
`UVOICE_UNLOAD_AFTER_SECONDS` (default 30 min); Whisper models count against
neither cap but follow the same idle rules. VieNeu (ONNX sessions, a llama.cpp
backbone) and CTranslate2's Whisper cannot offload; they stay resident until
the unload threshold. `TTS_PRELOAD` loads through the same scheduler, so a
pre-loaded model is parked like any other once it has been idle long enough.

The state is visible: `GET /v1/models` carries `residency`, `idle_seconds`,
`in_use` and `can_offload` for every entry. The heavy calls run outside the
scheduler's own lock, serialised per model, and the in-use check is repeated
under that per-model lock, so a request that arrives while the sweeper is
deciding always wins.

The same three moves are available on request (#218) —
`POST /v1/models/{id}/load|offload|unload`, `docs/api.md` — for the API, which
holds the cap across engines once each runs in its own container (#212). The
sweeper lets a busy model be; a caller asking to park one is refused with a
409 instead, because it is deciding what sits on the GPU and needs to know.
`load` on request goes through the same cap as a request's load.

### Settings

| Variable | Default |
| --- | --- |
| `UVOICE_ENGINES` | `whisper,vixtts,gpt-sovits,vieneu` — which engines this instance runs (#218) |
| `UVOICE_TTS_DEFAULT_MODEL` | `vixtts` — used when a request names no `model`; when this instance does not run it, the first it runs of `vixtts`, `gpt-sovits`, `vieneu` |
| `UVOICE_TTS_MAX_RESIDENT` | `1` synthesis model on the device at once; `0` for no cap |
| `UVOICE_OFFLOAD_AFTER_SECONDS` | `300` — idle seconds before a model is parked in CPU memory; `0` never |
| `UVOICE_UNLOAD_AFTER_SECONDS` | `1800` — idle seconds before a model is dropped; `0` never |
| `UVOICE_TTS_PRELOAD` | the instance's default model — comma-separated ids (or engine names) to load at startup |
| `UVOICE_TTS_MODE` | `turbo` — the VieNeu engine mode, part of its model id |
| `UVOICE_VIXTTS_MODEL_ID`, `UVOICE_VIXTTS_BASE_MODEL_ID` | `capleaf/viXTTS`, `coqui/XTTS-v2` |
| `UVOICE_VIXTTS_SPEAKER_CACHE_SIZE` | `8` cloned voices kept as latents |
| `UVOICE_GPTSOVITS_PRETRAINED_REPO` | `lj1995/GPT-SoVITS` |
| `UVOICE_GPTSOVITS_GPT_WEIGHTS`, `UVOICE_GPTSOVITS_SOVITS_WEIGHTS` | empty — a fine-tuned pair instead of the pretrained one; paths inside the container |
| `UVOICE_GPTSOVITS_DEFAULT_LANGUAGE` | `ja` |
