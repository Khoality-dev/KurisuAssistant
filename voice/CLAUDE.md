# CLAUDE.md

The speech service: **universal-voice**, the one container `--profile voice` starts. Recognition (faster-whisper) and every synthesis backend — viXTTS, GPT-SoVITS, VieNeu — run in this process (#203); the backend's `routers/asr.py` and `routers/tts.py` proxy to it over the Compose network (port 14213, never published, no authentication of its own — the API authenticates and this trusts the network). It was its own repository, universal-asr, until #202, with viXTTS and GPT-SoVITS as further containers behind it: Kurisu was its only consumer, a backend release tag could not pin any of the three, and every change to the speech contract needed a PR in each repository.

This is the `voice/` package of the KurisuAssistant monorepo (see the root `CLAUDE.md`). Run the commands below from `voice/`. `docker compose` is **not** run here: the service is a member of `backend/docker-compose.yml`, built from `../voice`, so `cd ../backend && docker compose --profile voice up -d --build` is how it starts, and `backend/docs/tts.md` / `backend/docs/asr.md` describe how the API and the clients use it.

## Documentation Index

- [API](docs/api.md) — every route, its request and response, and which backend proxy calls it.
- [Models](docs/models.md) — the ASR model cache (pull, convert, list, delete), the TTS registry, the three backends and where their weights come from.
- [vendor/gpt_sovits/PATCHES.md](vendor/gpt_sovits/PATCHES.md) — what was taken from upstream GPT-SoVITS, at which commit, and every line changed.

## Layout

```
universal_voice/
  main.py              the app; the lifespan pre-loads the default ASR model, and the TTS_PRELOAD models on a thread
  config.py            every setting, read from the environment once at import
  routers/
    transcription.py   /asr, /asr/detect-language (raw PCM), /v1/audio/* (OpenAI-shaped uploads)
    tts.py             /tts/synthesize, /tts/voices
    health.py          /health, /v1/models (+ pull, delete)
  models/
    manager.py         resolve a Whisper model name to a local CTranslate2 directory: cached, pulled, or converted
    transcriber.py     loaded WhisperModel instances, transcription, language detection
  tts/
    base.py            BaseTTSModel: load / synthesize / list_voices / check_health / is_loaded
    registry.py        the model ids the clients see, lazily built
    text_processing.py split_text (200 chars, paragraphs then sentences) and merge_wav_files
    vixtts_model.py    XTTS-v2 fine-tune through coqui-tts, plus the Vietnamese tokenizer patch
    gpt_sovits_model.py GPT-SoVITS v2 through the vendored inference code
    vieneu_model.py    the vieneu SDK
    vendor.py          puts vendor/gpt_sovits on sys.path when GPT-SoVITS first loads
  static/index.html    a debugging page: transcribe, detect language, manage models
vendor/gpt_sovits/     upstream GPT-SoVITS inference code at a pinned commit; PATCHES.md is the record
scripts/               run at image build: fetch_gpt_sovits_assets.py (large dictionaries, checksummed), prewarm.py (dictionaries, caches, NLTK data)
tests/                 fakes for the registry and the transcriber; nothing loads a model
```

## Key facts

- **Configuration is environment only** — `config.py`, `UVOICE_*`. The ASR settings are still read under their old `UASR_*` names as a fallback, because environment files from before the service fronted synthesis set those. The Compose file in `backend/` is what sets them in a deployment; `docs/models.md` lists them.
- **Heavy imports are lazy** — torch (`config.py`), faster-whisper (`models/transcriber.py`), coqui-tts, the vendored GPT-SoVITS tree and vieneu (`tts/*_model.py`) are imported inside the function that first needs them. That is what lets the routers import on a bare runner; `requirements-ci.txt` is the list of what the tests need, and `tests/test_tts_backends.py` fails if any of those libraries is imported at module level.
- **Weights are not in the image.** viXTTS and GPT-SoVITS pull theirs from Hugging Face on first use into `UVOICE_DATA_DIR/tts/` — the `uvoice-data` volume in the stack, several gigabytes, re-downloadable. The models in `UVOICE_TTS_PRELOAD` (default: the default model) load at startup on a thread, so `/health` answers while they do; the others load on their first request. The image does carry everything GPT-SoVITS's text frontends would otherwise fetch at first use (`scripts/prewarm.py`), so a container with no outbound network still speaks once it has weights.
- **One GPU, one process, serialised.** Each backend holds a lock around its inference; the routers call into them through `run_in_threadpool`, so a synthesis never blocks the event loop and `/health` stays responsive.
- **The wire contract with the backend** is `POST /asr` (Int16 PCM, 16 kHz, mono, as `application/octet-stream`; `?language`, `?model`, `?initial_prompt`), `POST /asr/detect-language`, `GET /v1/models`, `POST /tts/synthesize` (multipart: `text`, `model`, `voice_id`, `language`, `ref_audio`, `ref_text`), `GET /tts/voices`, `GET /health`. `backend/tests/test_tts_router.py` and this package's `tests/test_routers.py` pin the two ends; change both in the same PR. The model ids — `vixtts`, `gpt-sovits`, `vieneu:<mode>` — are stored in both clients' settings; renaming one is a client migration.
- **Every synthesis backend goes through `split_text`** at 200 characters and `merge_wav_files`; a backend never sees a whole paragraph.
- **Vendored code is patched in place and recorded.** Four changes to upstream GPT-SoVITS, each marked `PATCHED` and listed in `vendor/gpt_sovits/PATCHES.md`; update that file with any further one. The vendored tree introduces top-level module names (`text`, `module`, `utils`, `tools`, `AR`, …) — they are put on `sys.path` only when GPT-SoVITS loads, never at import.

## Tests

```bash
pip install -r requirements-ci.txt
python -m pytest tests -q
```

CI: `.github/workflows/voice-test.yml`, scoped to `voice/**`. The tests drive the routes against fakes; anything that needs a GPU is run by hand against the container (`docker compose --profile voice up -d --build` from `backend/`, then `docker compose exec universal-voice curl -s -F text=... localhost:14213/tts/synthesize -o out.wav`).
